from __future__ import annotations

import asyncio
from datetime import UTC, date, datetime
from time import monotonic
from types import SimpleNamespace

import pytest
from fastapi import Response

from app.domains.dashboard import service
from app.domains.dashboard import router as dashboard_router
from app.domains.dashboard.schemas import (
    DashboardBullpenSection,
    DashboardFxRate,
    DashboardHistoryPoint,
    DashboardHolding,
    DashboardIndMoneySection,
    DashboardSectionMeta,
    DashboardSummaryResponse,
    DashboardZerodhaSection,
    DashboardZerodhaSnapshot,
)
from app.domains.auth.models import UserRole


def _summary_fixture() -> DashboardSummaryResponse:
    now = datetime.now(UTC)
    holdings = [
        DashboardHolding(
            symbol=f"HOLDING-{index}",
            company_name=f"Company {index}",
            current_value=10_000 - index,
            invested_value=9_000 - index,
            pnl=1_000,
            pnl_percent=11.1,
            weight_percent=25,
        )
        for index in range(4)
    ]
    history = [
        DashboardHistoryPoint(captured_at=now, value=100_000 + index)
        for index in range(12)
    ]
    return DashboardSummaryResponse(
        generated_at=now,
        usd_inr_rate=86.125,
        usd_inr_source="verified-fixture",
        usd_inr_as_of=now,
        usd_inr_age_seconds=0,
        usd_inr_status="valid",
        fx=DashboardFxRate(
            value=86.125,
            source="verified-fixture",
            as_of=now,
            age_seconds=0,
            stale_after_seconds=36 * 60 * 60,
            status="valid",
        ),
        zerodha=DashboardZerodhaSection(
            connected=True,
            snapshot=DashboardZerodhaSnapshot(
                snapshot_date=date.today(),
                captured_at=now,
                source="scheduled",
                holdings_count=300,
                holdings_market_value=100_000,
                holdings_invested_value=90_000,
                holdings_pnl=10_000,
                holdings_day_change_value=500,
                available_margin=1_000,
                top_holdings=holdings,
                history=history,
            ),
        ),
        indmoney_us=DashboardIndMoneySection(),
        bullpen=DashboardBullpenSection(
            active_count=3,
            total_value=45,
            fetched_at=now,
        ),
        sections={
            "zerodha": DashboardSectionMeta(
                status="ok",
                duration_ms=10,
                fresh_at=now,
            ),
            "indmoney_us": DashboardSectionMeta(
                status="ok",
                duration_ms=11,
            ),
            "bullpen": DashboardSectionMeta(
                status="ok",
                duration_ms=12,
                fresh_at=now,
            ),
            "fx": DashboardSectionMeta(
                status="ok",
                duration_ms=1,
                fresh_at=now,
            ),
        },
    )


@pytest.mark.anyio
async def test_dashboard_summary_loads_sections_concurrently_and_degrades_one(
    monkeypatch,
):
    async def load_zerodha(_user_id: int):
        await asyncio.sleep(0.05)
        return DashboardZerodhaSection(connected=True)

    async def load_indmoney(_user_id: int):
        await asyncio.sleep(0.05)
        raise RuntimeError("database detail must not escape")

    async def load_bullpen(_user_id: int):
        await asyncio.sleep(0.05)
        return DashboardBullpenSection()

    async def load_fx(_user_id: int):
        await asyncio.sleep(0.05)
        return DashboardFxRate(
            value=84.25,
            source="verified-fixture",
            as_of=datetime.now(UTC),
            age_seconds=0,
            stale_after_seconds=36 * 60 * 60,
            status="valid",
        )

    monkeypatch.setattr(service, "_load_zerodha", load_zerodha)
    monkeypatch.setattr(service, "_load_indmoney", load_indmoney)
    monkeypatch.setattr(service, "_load_bullpen", load_bullpen)
    monkeypatch.setattr(service, "_load_fx", load_fx)

    started = monotonic()
    summary = await service.build_dashboard_summary(user_id=17)
    elapsed = monotonic() - started

    assert elapsed < 0.12
    assert summary.zerodha is not None
    assert summary.indmoney_us is None
    assert summary.bullpen is not None
    assert summary.sections["indmoney_us"].status == "unavailable"
    assert summary.sections["indmoney_us"].error == (
        "Section is temporarily unavailable."
    )


@pytest.mark.anyio
async def test_load_bullpen_prefers_display_snapshot_without_mutating_cache(
    monkeypatch,
):
    fetched_at = datetime.now(UTC)
    display_snapshot = SimpleNamespace(
        payload={
            "summary": {
                "active_count": 13,
                "claimable_count": 0,
                "claimable_value": 0,
                "cash_balance": 4.44,
                "total_value": 68.64,
                "unrealized_pnl": -0.81,
                "wallet_value": 68.64,
            },
            "positions": [{"id": index} for index in range(13)],
        },
        fetched_at=fetched_at.isoformat(),
    )

    class Broker:
        async def read_display_positions_snapshot(self, *, delete_invalid: bool):
            assert delete_invalid is False
            return display_snapshot

        async def read_cached_positions_snapshot(self, *, delete_invalid: bool):
            raise AssertionError("display snapshot should be preferred")

    monkeypatch.setattr(service, "get_bullpen_runtime_broker", lambda: Broker())

    result = await service._load_bullpen(17)

    assert result.active_count == 13
    assert result.claimable_count == 0
    assert result.cash_balance == 4.44
    assert result.total_value == 68.64
    assert result.fetched_at == fetched_at


def test_dashboard_summary_response_stays_below_150kb_and_excludes_raw_data():
    payload = _summary_fixture().model_dump_json().encode()

    assert len(payload) < 150_000
    assert b"raw_text" not in payload
    assert b"raw_markdown" not in payload
    assert b"audit" not in payload
    assert b"prompt" not in payload
    assert b"order_history" not in payload


def test_top_holdings_and_history_have_hard_schema_budgets():
    summary = _summary_fixture()

    assert len(summary.zerodha.snapshot.top_holdings) == 4
    assert len(summary.zerodha.snapshot.history) == 12
    with pytest.raises(ValueError):
        DashboardZerodhaSnapshot(
            **{
                **summary.zerodha.snapshot.model_dump(),
                "top_holdings": summary.zerodha.snapshot.top_holdings * 2,
            }
        )


@pytest.mark.anyio
async def test_dashboard_summary_etag_is_private_and_revalidates(monkeypatch):
    summary = _summary_fixture()

    async def build_summary(
        _user_id: int,
        *,
        include_singleton_bullpen: bool,
    ):
        assert include_singleton_bullpen is True
        return summary

    monkeypatch.setattr(dashboard_router, "build_dashboard_summary", build_summary)
    first_response = Response()
    result = await dashboard_router.get_dashboard_summary(
        response=first_response,
        current_user=SimpleNamespace(id=19, role=UserRole.ADMIN),
        if_none_match=None,
    )

    assert result is summary
    assert first_response.headers["cache-control"].startswith("private, no-cache")
    assert first_response.headers["vary"] == "Authorization, Cookie"
    etag = first_response.headers["etag"]

    not_modified = await dashboard_router.get_dashboard_summary(
        response=Response(),
        current_user=SimpleNamespace(id=19, role=UserRole.ADMIN),
        if_none_match=etag,
    )
    assert not_modified.status_code == 304
    assert not_modified.headers["etag"] == etag
