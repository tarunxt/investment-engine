from __future__ import annotations

import asyncio

import pytest

from app.domains.polymarket import runtime_broker as runtime_broker_module
from app.domains.polymarket import runtime_positions_refresh as positions_refresh


WALLET = "0x" + ("1" * 40)
OTHER_WALLET = "0x" + ("2" * 40)


def _diagnostics(*, caller_source: str) -> runtime_broker_module.BullpenCommandDiagnostics:
    return runtime_broker_module.BullpenCommandDiagnostics(
        command_category="positions",
        pid=1,
        effective_home="/tmp",
        caller_source=caller_source,
        snapshot_producer_source=caller_source,
    )


def _snapshot(
    *,
    positions: list[dict[str, object]],
    wallet: str = WALLET,
    source: str = "live-cli",
    freshness_state: str = "fresh",
    auth_checked_at: str | None = "2026-08-14T05:00:00+00:00",
) -> runtime_broker_module.BullpenPositionsSnapshot:
    return runtime_broker_module.BullpenPositionsSnapshot(
        payload={"positions": positions},
        fetched_at="2026-08-14T05:00:01+00:00",
        account_identity=wallet,
        auth_checked_at=auth_checked_at,
        source=source,
        freshness_state=freshness_state,
        diagnostics=_diagnostics(caller_source=source),
    )


def _position(*, condition_suffix: str) -> dict[str, object]:
    return {
        "condition_id": "0x" + (condition_suffix * 64),
        "market": f"Live market {condition_suffix}",
        "outcome": "No",
        "shares": 3.0,
        "current_price": 0.9,
        "current_value": 2.7,
        "redeemable": False,
    }


def test_stage1_keeps_nonempty_authenticated_execution_snapshot(monkeypatch) -> None:
    canonical = _snapshot(positions=[_position(condition_suffix="a")])
    public_called = False

    async def fake_original(_broker, **_kwargs):
        return canonical

    async def fake_public(_broker, *, caller_source: str):
        nonlocal public_called
        public_called = True
        return _snapshot(
            positions=[_position(condition_suffix="b")],
            source="redis-cache",
            freshness_state="cached",
            auth_checked_at=None,
        )

    monkeypatch.setattr(
        positions_refresh,
        "_ORIGINAL_GET_POSITIONS_SNAPSHOT",
        fake_original,
    )
    monkeypatch.setattr(
        positions_refresh,
        "_refresh_public_wallet_snapshot",
        fake_public,
    )

    result = asyncio.run(
        positions_refresh._get_positions_snapshot_with_ui_read_fallback(
            object(),
            force_fresh=True,
            caller_source="auto-live-stage1",
            max_age_seconds=0,
        )
    )

    assert result is canonical
    assert public_called is False


def test_stage1_replaces_false_empty_execution_snapshot_with_same_wallet_public_positions(
    monkeypatch,
) -> None:
    canonical = _snapshot(positions=[])
    public = _snapshot(
        positions=[
            _position(condition_suffix="a"),
            _position(condition_suffix="b"),
        ],
        source="redis-cache",
        freshness_state="cached",
        auth_checked_at=None,
    )

    async def fake_original(_broker, **_kwargs):
        return canonical

    async def fake_public(_broker, *, caller_source: str):
        assert caller_source == "auto-live-stage1"
        return public

    monkeypatch.setattr(
        positions_refresh,
        "_ORIGINAL_GET_POSITIONS_SNAPSHOT",
        fake_original,
    )
    monkeypatch.setattr(
        positions_refresh,
        "_refresh_public_wallet_snapshot",
        fake_public,
    )

    result = asyncio.run(
        positions_refresh._get_positions_snapshot_with_ui_read_fallback(
            object(),
            force_fresh=True,
            caller_source="auto-live-stage1",
            max_age_seconds=0,
        )
    )

    assert len(result.payload["positions"]) == 2
    assert result.account_identity == WALLET
    assert result.source == "redis-cache"
    assert result.freshness_state == "cached"
    assert result.auth_checked_at is None
    assert result.diagnostics.error_classification == "stage1_analysis_public_fallback"
    assert (
        result.diagnostics.snapshot_producer_source
        == "polymarket-public-data-api-stage1-analysis"
    )


def test_stage1_public_fallback_rejects_account_identity_mismatch(monkeypatch) -> None:
    canonical = _snapshot(positions=[])
    public = _snapshot(
        positions=[_position(condition_suffix="a")],
        wallet=OTHER_WALLET,
        source="redis-cache",
        freshness_state="cached",
        auth_checked_at=None,
    )

    async def fake_original(_broker, **_kwargs):
        return canonical

    async def fake_public(_broker, *, caller_source: str):
        return public

    monkeypatch.setattr(
        positions_refresh,
        "_ORIGINAL_GET_POSITIONS_SNAPSHOT",
        fake_original,
    )
    monkeypatch.setattr(
        positions_refresh,
        "_refresh_public_wallet_snapshot",
        fake_public,
    )

    with pytest.raises(runtime_broker_module.BullpenRuntimeCommandError) as exc_info:
        asyncio.run(
            positions_refresh._get_positions_snapshot_with_ui_read_fallback(
                object(),
                force_fresh=True,
                caller_source="auto-live-stage1",
                max_age_seconds=0,
            )
        )

    assert exc_info.value.classification == "account_identity_mismatch"
