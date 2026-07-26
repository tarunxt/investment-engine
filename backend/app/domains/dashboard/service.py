from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from time import monotonic
from typing import Any, TypeVar

from sqlalchemy import desc, select

from app.domains.dashboard.schemas import (
    DashboardBullpenSection,
    DashboardFxRate,
    DashboardHistoryPoint,
    DashboardHolding,
    DashboardIndMoneySection,
    DashboardIndMoneySnapshot,
    DashboardSectionMeta,
    DashboardSummaryResponse,
    DashboardZerodhaSection,
    DashboardZerodhaSnapshot,
)
from app.domains.fx_rates.service import load_persisted_usd_inr_rate
from app.domains.indmoney_us.models import IndMoneyUsPortfolioSnapshot
from app.domains.polymarket.runtime_broker import get_bullpen_runtime_broker
from app.domains.zerodha.models import ZerodhaCredential, ZerodhaPortfolioSnapshot
from app.infrastructure.database.session import AsyncSessionLocal
from app.core.request_timing import add_redis_duration

DASHBOARD_HISTORY_LIMIT = 12
DASHBOARD_TOP_HOLDINGS_LIMIT = 4

T = TypeVar("T")
logger = logging.getLogger(__name__)


def _number(value: Any, default: float = 0) -> float:
    if isinstance(value, bool):
        return default
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    return parsed


def _optional_number(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _holding_symbol(holding: dict[str, Any]) -> str:
    return str(holding.get("tradingsymbol") or holding.get("symbol") or "Unknown")


def _top_holdings(
    holdings: Any,
    *,
    total_value: float,
) -> list[DashboardHolding]:
    if not isinstance(holdings, list):
        return []

    normalized: list[DashboardHolding] = []
    for raw in holdings:
        if not isinstance(raw, dict):
            continue
        current_value = _number(
            raw.get("market_value", raw.get("current_value")),
        )
        invested_value = _number(raw.get("invested_value"))
        pnl = _number(raw.get("pnl", raw.get("total_pnl")))
        pnl_percent = _number(
            raw.get("pnl_percent", raw.get("total_pnl_percent")),
        )
        weight = _optional_number(
            raw.get("weight_percent", raw.get("portfolio_weight_percent"))
        )
        if weight is None and total_value > 0:
            weight = current_value / total_value * 100
        normalized.append(
            DashboardHolding(
                symbol=_holding_symbol(raw),
                company_name=(
                    str(raw["company_name"])
                    if raw.get("company_name") is not None
                    else None
                ),
                current_value=current_value,
                invested_value=invested_value,
                pnl=pnl,
                pnl_percent=pnl_percent,
                weight_percent=weight,
            )
        )

    normalized.sort(key=lambda holding: holding.current_value, reverse=True)
    return normalized[:DASHBOARD_TOP_HOLDINGS_LIMIT]


async def _load_zerodha(user_id: int) -> DashboardZerodhaSection:
    async with AsyncSessionLocal() as db:
        credential_row = (
            await db.execute(
                select(
                    ZerodhaCredential.login_time,
                    ZerodhaCredential.expires_at,
                ).where(ZerodhaCredential.user_id == user_id)
            )
        ).one_or_none()
        latest = (
            await db.execute(
                select(
                    ZerodhaPortfolioSnapshot.snapshot_date,
                    ZerodhaPortfolioSnapshot.captured_at,
                    ZerodhaPortfolioSnapshot.source,
                    ZerodhaPortfolioSnapshot.holdings_count,
                    ZerodhaPortfolioSnapshot.holdings_market_value,
                    ZerodhaPortfolioSnapshot.holdings_pnl,
                    ZerodhaPortfolioSnapshot.holdings_day_change_value,
                    ZerodhaPortfolioSnapshot.available_margin,
                    ZerodhaPortfolioSnapshot.holdings_invested_value,
                    ZerodhaPortfolioSnapshot.dashboard_top_holdings,
                )
                .where(ZerodhaPortfolioSnapshot.user_id == user_id)
                .order_by(
                    desc(ZerodhaPortfolioSnapshot.snapshot_date),
                    desc(ZerodhaPortfolioSnapshot.captured_at),
                )
                .limit(1)
            )
        ).one_or_none()
        history_rows = (
            await db.execute(
                select(
                    ZerodhaPortfolioSnapshot.captured_at,
                    ZerodhaPortfolioSnapshot.holdings_market_value,
                    ZerodhaPortfolioSnapshot.available_margin,
                )
                .where(ZerodhaPortfolioSnapshot.user_id == user_id)
                .order_by(
                    desc(ZerodhaPortfolioSnapshot.snapshot_date),
                    desc(ZerodhaPortfolioSnapshot.captured_at),
                )
                .limit(DASHBOARD_HISTORY_LIMIT)
            )
        ).all()

    now = datetime.now(UTC)
    connected = bool(credential_row and credential_row.expires_at > now)
    if latest is None:
        return DashboardZerodhaSection(
            connected=connected,
            login_time=credential_row.login_time if credential_row else None,
            expires_at=credential_row.expires_at if credential_row else None,
        )

    return DashboardZerodhaSection(
        connected=connected,
        login_time=credential_row.login_time if credential_row else None,
        expires_at=credential_row.expires_at if credential_row else None,
        snapshot=DashboardZerodhaSnapshot(
            snapshot_date=latest.snapshot_date,
            captured_at=latest.captured_at,
            source=latest.source,
            holdings_count=latest.holdings_count,
            holdings_market_value=latest.holdings_market_value,
            holdings_invested_value=latest.holdings_invested_value,
            holdings_pnl=latest.holdings_pnl,
            holdings_day_change_value=latest.holdings_day_change_value,
            available_margin=latest.available_margin,
            top_holdings=_top_holdings(
                latest.dashboard_top_holdings,
                total_value=latest.holdings_market_value,
            ),
            history=[
                DashboardHistoryPoint(
                    captured_at=row.captured_at,
                    value=row.holdings_market_value + row.available_margin,
                )
                for row in reversed(history_rows)
            ],
        ),
    )


async def _load_indmoney(user_id: int) -> DashboardIndMoneySection:
    async with AsyncSessionLocal() as db:
        latest = (
            await db.execute(
                select(
                    IndMoneyUsPortfolioSnapshot.snapshot_date,
                    IndMoneyUsPortfolioSnapshot.captured_at,
                    IndMoneyUsPortfolioSnapshot.source,
                    IndMoneyUsPortfolioSnapshot.parse_status,
                    IndMoneyUsPortfolioSnapshot.holdings_count,
                    IndMoneyUsPortfolioSnapshot.wallet_balance,
                    IndMoneyUsPortfolioSnapshot.current_value,
                    IndMoneyUsPortfolioSnapshot.invested_value,
                    IndMoneyUsPortfolioSnapshot.day_return_value,
                    IndMoneyUsPortfolioSnapshot.day_return_percent,
                    IndMoneyUsPortfolioSnapshot.total_return_value,
                    IndMoneyUsPortfolioSnapshot.total_return_percent,
                    IndMoneyUsPortfolioSnapshot.dashboard_top_holdings,
                )
                .where(IndMoneyUsPortfolioSnapshot.user_id == user_id)
                .order_by(
                    desc(IndMoneyUsPortfolioSnapshot.captured_at),
                    desc(IndMoneyUsPortfolioSnapshot.id),
                )
                .limit(1)
            )
        ).one_or_none()
        history_rows = (
            await db.execute(
                select(
                    IndMoneyUsPortfolioSnapshot.captured_at,
                    IndMoneyUsPortfolioSnapshot.current_value,
                    IndMoneyUsPortfolioSnapshot.wallet_balance,
                )
                .where(IndMoneyUsPortfolioSnapshot.user_id == user_id)
                .order_by(
                    desc(IndMoneyUsPortfolioSnapshot.captured_at),
                    desc(IndMoneyUsPortfolioSnapshot.id),
                )
                .limit(DASHBOARD_HISTORY_LIMIT)
            )
        ).all()

    if latest is None:
        return DashboardIndMoneySection()

    return DashboardIndMoneySection(
        snapshot=DashboardIndMoneySnapshot(
            snapshot_date=latest.snapshot_date,
            captured_at=latest.captured_at,
            source=latest.source,
            parse_status=latest.parse_status,
            holdings_count=latest.holdings_count,
            wallet_balance=latest.wallet_balance,
            current_value=latest.current_value,
            invested_value=latest.invested_value,
            day_return_value=latest.day_return_value,
            day_return_percent=latest.day_return_percent,
            total_return_value=latest.total_return_value,
            total_return_percent=latest.total_return_percent,
            top_holdings=_top_holdings(
                latest.dashboard_top_holdings,
                total_value=latest.current_value or 0,
            ),
            history=[
                DashboardHistoryPoint(
                    captured_at=row.captured_at,
                    value=(row.current_value or 0) + (row.wallet_balance or 0),
                )
                for row in reversed(history_rows)
            ],
        )
    )


def _summary_mapping(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {}
    summary = payload.get("summary")
    return summary if isinstance(summary, dict) else {}


def _position_rows(payload: Any) -> list[Any]:
    if not isinstance(payload, dict):
        return []
    rows = payload.get("positions")
    if isinstance(rows, list):
        return rows
    nested = payload.get("data")
    if isinstance(nested, dict) and isinstance(nested.get("positions"), list):
        return nested["positions"]
    return []


async def _load_bullpen(_user_id: int) -> DashboardBullpenSection:
    # This is a passive cache read by design. Initial page rendering must never
    # launch the Bullpen CLI, refresh credentials, or contact Polymarket.
    redis_started_at = monotonic()
    try:
        snapshot = await get_bullpen_runtime_broker().read_cached_positions_snapshot()
    finally:
        add_redis_duration((monotonic() - redis_started_at) * 1000)
    if snapshot is None:
        raise RuntimeError("No cached Bullpen positions snapshot")

    summary = _summary_mapping(snapshot.payload)
    positions = _position_rows(snapshot.payload)
    fetched_at = datetime.fromisoformat(snapshot.fetched_at)
    return DashboardBullpenSection(
        active_count=int(
            _number(summary.get("active_count"), default=float(len(positions)))
        ),
        claimable_count=int(_number(summary.get("claimable_count"))),
        claimable_value=_number(summary.get("claimable_value")),
        cash_balance=_optional_number(summary.get("cash_balance")),
        total_value=_optional_number(summary.get("total_value")),
        unrealized_pnl=_optional_number(summary.get("unrealized_pnl")),
        wallet_value=_optional_number(summary.get("wallet_value")),
        fetched_at=fetched_at,
    )


async def _load_fx(_user_id: int) -> DashboardFxRate:
    assessment = await load_persisted_usd_inr_rate()
    return DashboardFxRate(
        value=assessment.value,
        source=assessment.source,
        as_of=assessment.as_of,
        age_seconds=assessment.age_seconds,
        stale_after_seconds=assessment.stale_after_seconds,
        status=assessment.status,
    )


async def _timed_section(
    name: str,
    loader: Callable[[int], Awaitable[T]],
    user_id: int,
) -> tuple[str, T | None, DashboardSectionMeta]:
    started = monotonic()
    try:
        value = await loader(user_id)
        fresh_at = None
        snapshot = getattr(value, "snapshot", None)
        if snapshot is not None:
            fresh_at = getattr(snapshot, "captured_at", None)
        if isinstance(value, DashboardBullpenSection):
            fresh_at = value.fetched_at
        if isinstance(value, DashboardFxRate):
            fresh_at = value.as_of
        return (
            name,
            value,
            DashboardSectionMeta(
                status="ok",
                duration_ms=round((monotonic() - started) * 1000, 2),
                fresh_at=fresh_at,
            ),
        )
    except Exception:
        logger.exception("Dashboard summary section %s is unavailable", name)
        return (
            name,
            None,
            DashboardSectionMeta(
                status="unavailable",
                duration_ms=round((monotonic() - started) * 1000, 2),
                error="Section is temporarily unavailable.",
            ),
        )


async def build_dashboard_summary(
    user_id: int,
    *,
    include_singleton_bullpen: bool = True,
) -> DashboardSummaryResponse:
    loaders = [
        _timed_section("zerodha", _load_zerodha, user_id),
        _timed_section("indmoney_us", _load_indmoney, user_id),
        _timed_section("fx", _load_fx, user_id),
    ]
    if include_singleton_bullpen:
        loaders.append(_timed_section("bullpen", _load_bullpen, user_id))
    results = await asyncio.gather(*loaders)
    values = {name: value for name, value, _meta in results}
    sections = {name: meta for name, _value, meta in results}
    if not include_singleton_bullpen:
        values["bullpen"] = None
        sections["bullpen"] = DashboardSectionMeta(
            status="unavailable",
            duration_ms=0,
            error="Bullpen runtime is restricted to the singleton system account.",
        )
    fx = values["fx"]
    if not isinstance(fx, DashboardFxRate):
        fx = DashboardFxRate(
            stale_after_seconds=36 * 60 * 60,
            status="unavailable",
        )
    return DashboardSummaryResponse(
        generated_at=datetime.now(UTC),
        usd_inr_rate=fx.value if fx.status == "valid" else None,
        usd_inr_source=fx.source,
        usd_inr_as_of=fx.as_of,
        usd_inr_age_seconds=fx.age_seconds,
        usd_inr_status=fx.status,
        fx=fx,
        zerodha=values["zerodha"],
        indmoney_us=values["indmoney_us"],
        bullpen=values["bullpen"],
        sections=sections,
    )
