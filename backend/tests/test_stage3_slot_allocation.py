import json
import os
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://test:test@localhost:5432/testdb",
)
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

import pytest

from app.domains.polymarket_auto_live import console_profile
from app.domains.polymarket_auto_live.console_profile import (
    ConsoleWalletPosition,
    ConsoleWalletPositionsSnapshot,
    enrich_console_wallet_positions_authoritatively,
    read_console_wallet_positions_snapshot,
)
from app.domains.polymarket_auto_live.engine import (
    _exit_has_meaningful_remaining_exposure,
    _exit_releases_replacement_slot,
    _poll_exit_settlement,
    _read_stage1_wallet_positions_snapshot,
    _stage1_wallet_snapshot_lineage_outputs,
    _validate_stage3_wallet_snapshot_freshness,
    build_console_affordable_buy_allocation,
    build_console_trade_amount_breakdown,
)
from app.domains.polymarket_auto_live.schemas import (
    BullpenAutoLiveDecision,
    BullpenAutoLiveOrderPlan,
)
from app.domains.polymarket_auto_live.scanner import ScannedMarket
from app.domains.polymarket_auto_live.stage3_slots import classify_economic_slots


def _position(
    market_id: str,
    *,
    condition_id: str | None = None,
    side: str = "YES",
    exposure_usd: float = 5.0,
    current_value_usd: float | None = None,
    classification: str = "active",
    is_claimable: bool = False,
) -> ConsoleWalletPosition:
    return ConsoleWalletPosition(
        market_id=market_id,
        slug=market_id,
        condition_id=condition_id,
        market_title=market_id,
        market_url=None,
        side=side,
        shares=10.0,
        average_price_cents=50.0,
        exposure_usd=exposure_usd,
        current_price_cents=50.0,
        current_value_usd=(
            current_value_usd if current_value_usd is not None else exposure_usd
        ),
        current_yes_odds=50.0,
        current_no_odds=50.0,
        close_time=None,
        theme="test",
        is_claimable=is_claimable,
        classification=classification,
        classification_reason=classification,
    )


def _sell_decision(*, response: object, shares: float = 10.0):
    order_plan = BullpenAutoLiveOrderPlan(
        id="exit-order",
        action="sell",
        side="YES",
        status="submitted",
        market_id="rank-out-market",
        market_title="Rank out",
        order_size_usd=5.0,
        shares=shares,
        limit_price_cents=50.0,
        max_slippage_cents=2.0,
        dry_run=False,
        detail="submitted",
        execution_response=json.dumps(response) if isinstance(response, dict) else str(response),
        created_at="2026-07-20T00:00:00+00:00",
    )
    return BullpenAutoLiveDecision.model_construct(
        id="decision-1",
        run_id="run-1",
        created_at="2026-07-20T00:00:00+00:00",
        updated_at="2026-07-20T00:00:00+00:00",
        market_id="rank-out-market",
        market_title="Rank out",
        side="YES",
        decision="EXIT",
        risk_status="Ready",
        price_cents=50.0,
        fair_probability_pct=50.0,
        edge_pp=0.0,
        score=0.0,
        confidence="Medium",
        evidence_status="Moderate",
        reason="exit",
        summary="exit",
        order_plan=order_plan,
        exit_state="EVENT_EXIT_PLANNED",
        exit_signals=[],
    )


def test_economic_slot_classifier_excludes_non_active_and_deduplicates_market_side():
    allocation = classify_economic_slots(
        [
            _position("live-market", condition_id="condition-1", exposure_usd=5.0),
            _position("saved-market", condition_id="condition-1", exposure_usd=4.0),
            _position(
                "claimable-market",
                classification="positive_payout_claimable",
                is_claimable=True,
                current_value_usd=4.0,
            ),
            _position(
                "resolved-market",
                classification="resolved_zero_payout",
                current_value_usd=0.0,
            ),
            _position("dust-market", exposure_usd=0.001, current_value_usd=0.001),
        ],
        dust_threshold_usd=0.01,
    )

    assert allocation.raw_position_count == 5
    assert allocation.economically_active_position_count == 1
    assert allocation.occupied_market_ids == {"live-market"}
    assert len(allocation.deduplicated_occupied_market_ids) == 1
    reasons = " ".join(str(row["reason"]) for row in allocation.excluded_position_records)
    assert "duplicate" in reasons
    assert "positive-payout claimable" in reasons
    assert "resolved zero-payout" in reasons
    assert "dust threshold" in reasons


def test_ten_genuine_active_positions_leave_no_slot_for_an_eleventh_buy():
    allocation = classify_economic_slots(
        [_position(f"market-{index}", condition_id=f"condition-{index}") for index in range(10)],
        dust_threshold_usd=0.01,
    )
    breakdown = build_console_trade_amount_breakdown(
        available_balance_usd=100.0,
        occupied_position_count=len(allocation.occupied_market_ids),
        max_positions=10,
    )

    assert allocation.economically_active_position_count == 10
    assert breakdown["available_slots"] == 0
    assert breakdown["order_usd"] == 0.0


def test_affordable_buy_allocation_funds_highest_ranked_minimum_orders():
    allocation = build_console_affordable_buy_allocation(
        available_balance_usd=3.44,
        available_slots=7,
        eligible_candidate_count=6,
        min_order_usd=1.0,
        max_order_usd=25.0,
    )

    assert allocation == {
        "cash_in_hand_usd": 3.44,
        "gross_cash_in_hand_usd": 3.44,
        "balance_buffer_usd": 1.0,
        "spendable_cash_usd": 2.44,
        "available_slots": 7,
        "eligible_candidate_count": 6,
        "cash_affordable_buy_count": 2,
        "affordable_slot_count": 2,
        "affordable_buy_count": 2,
        "min_order_usd": 1.0,
        "max_order_usd": 25.0,
        "initial_order_usd": 1.22,
    }


def test_affordable_buy_allocation_never_bypasses_slot_or_max_order_guards():
    allocation = build_console_affordable_buy_allocation(
        available_balance_usd=100.0,
        available_slots=2,
        eligible_candidate_count=8,
        min_order_usd=1.0,
        max_order_usd=5.0,
    )

    assert allocation["affordable_buy_count"] == 2
    assert allocation["initial_order_usd"] == 5.0


def test_stage1_wallet_lineage_outputs_redact_paths_and_local_identity():
    snapshot = ConsoleWalletPositionsSnapshot(
        positions=[],
        source="live-cli",
        fetched_at="2026-07-27T00:00:00+00:00",
        raw_position_count=0,
        credential_artifact={
            "path": "/Users/private/.config/bullpen/credentials.json.enc",
            "inode": 11,
            "mtime_ns": 22,
            "size": 33,
        },
        account_identity="0xabc",
        position_classifier_version=3,
        freshness_state="fresh",
        diagnostics={
            "caller_source": "auto-live-stage1",
            "snapshot_producer_source": "portfolio-refresh",
            "produced_by_another_refresh": True,
            "refresh_lock_wait_ms": 12.5,
            "effective_home": "/Users/private",
            "unix_user": "private-user",
            "pid": 123,
            "credential_artifact": {
                "path": "/Users/private/.config/bullpen/credentials.json.enc",
                "inode": 11,
            },
        },
    )

    outputs = _stage1_wallet_snapshot_lineage_outputs(snapshot)

    assert outputs["wallet_source"] == "live-cli"
    assert outputs["wallet_snapshot_fetched_at"] == snapshot.fetched_at
    assert outputs["wallet_snapshot_freshness_state"] == "fresh"
    assert outputs["wallet_account_identity"] == "0xabc"
    assert outputs["wallet_position_classifier_version"] == 3
    assert outputs["wallet_credential_artifact_inode"] == 11
    assert outputs["wallet_credential_artifact_mtime_ns"] == 22
    assert outputs["wallet_credential_artifact_size"] == 33
    assert outputs["wallet_snapshot_diagnostics"] == {
        "caller_source": "auto-live-stage1",
        "snapshot_producer_source": "portfolio-refresh",
        "produced_by_another_refresh": True,
        "refresh_lock_wait_ms": 12.5,
    }
    frozen = json.dumps(outputs)
    assert '"path"' not in frozen
    assert "effective_home" not in frozen
    assert "unix_user" not in frozen
    assert "/Users/private" not in frozen


def test_stage3_buy_state_accepts_fresh_coalesced_redis_and_rejects_cached():
    request_started_at = datetime.now(UTC)
    fresh_snapshot = ConsoleWalletPositionsSnapshot(
        positions=[],
        source="redis-cache",
        freshness_state="fresh",
        fetched_at=(request_started_at + timedelta(seconds=1)).isoformat(),
        raw_position_count=0,
        diagnostics={"produced_by_another_refresh": True},
        account_identity="wallet-a",
        credential_artifact={"inode": 11, "mtime_ns": 22, "size": 33},
        position_classifier_version=3,
    )

    lineage = _validate_stage3_wallet_snapshot_freshness(
        snapshot=fresh_snapshot,
        request_started_at=request_started_at,
    )

    assert lineage["wallet_source"] == "redis-cache"
    assert lineage["wallet_snapshot_freshness_state"] == "fresh"
    assert lineage["wallet_account_identity"] == "wallet-a"

    cached_snapshot = ConsoleWalletPositionsSnapshot(
        positions=[],
        source="redis-cache",
        freshness_state="cached",
        fetched_at=(request_started_at + timedelta(seconds=1)).isoformat(),
        raw_position_count=0,
        diagnostics={},
    )
    with pytest.raises(RuntimeError, match="fetched-after-request"):
        _validate_stage3_wallet_snapshot_freshness(
            snapshot=cached_snapshot,
            request_started_at=request_started_at,
        )


@pytest.mark.anyio
async def test_stage1_snapshot_forces_fresh_read_and_preserves_legacy_patch(
    monkeypatch,
):
    import app.domains.polymarket_auto_live.engine as engine

    calls: list[dict[str, object]] = []
    expected_snapshot = ConsoleWalletPositionsSnapshot(
        positions=[],
        source="live-cli",
        fetched_at=datetime.now(UTC).isoformat(),
        raw_position_count=0,
        diagnostics={},
    )

    async def read_snapshot(**kwargs):
        calls.append(kwargs)
        return expected_snapshot

    monkeypatch.setattr(
        engine,
        "read_console_wallet_positions_snapshot",
        read_snapshot,
    )
    snapshot = await _read_stage1_wallet_positions_snapshot()
    assert snapshot is expected_snapshot
    assert calls == [
        {
            "force_fresh": True,
            "caller_source": "auto-live-stage1",
            "max_age_seconds": 0,
        }
    ]

    legacy_position = _position("legacy-market")

    async def legacy_reader():
        return [legacy_position]

    monkeypatch.setattr(
        engine,
        "read_console_wallet_positions",
        legacy_reader,
    )
    compatibility_snapshot = await _read_stage1_wallet_positions_snapshot()
    assert compatibility_snapshot.positions == [legacy_position]
    assert compatibility_snapshot.diagnostics == {
        "test_compatibility_reader": True
    }


@pytest.mark.anyio
async def test_open_market_enrichment_keeps_stage1_stage3_and_sell_invariant(
    monkeypatch,
):
    raw_position = _position(
        "open-market",
        condition_id="condition-open",
        classification="positive_payout_claimable",
        is_claimable=True,
    )
    raw_position = ConsoleWalletPosition(
        **{
            **raw_position.__dict__,
            "raw_claimable_flag": True,
            "upstream_redeemable": True,
            "expected_payout_usdc": 5.0,
            "close_time": "2026-07-20T00:00:00+00:00",
        }
    )
    open_market = ScannedMarket(
        market_id="open-market",
        question="Open market",
        market_url=None,
        slug="open-market",
        close_time="2026-07-30T00:00:00+00:00",
        theme="test",
        current_yes_odds=50.0,
        current_no_odds=50.0,
        volume_usd=1000.0,
        liquidity_usd=500.0,
        description=None,
        outcome_labels=["Yes", "No"],
        event_slug=None,
        best_bid_cents=49.0,
        best_ask_cents=51.0,
        spread_cents=2.0,
        force_include=True,
        raw={
            "active": True,
            "closed": False,
            "archived": False,
            "conditionId": "condition-open",
        },
    )

    async def fetch_market(slug: str):
        assert slug == "open-market"
        return open_market

    monkeypatch.setattr(console_profile, "fetch_market_by_slug", fetch_market)
    stage1_positions, _ = await enrich_console_wallet_positions_authoritatively(
        [raw_position]
    )
    stage3_positions, _ = await enrich_console_wallet_positions_authoritatively(
        [raw_position]
    )
    sell_positions, _ = await enrich_console_wallet_positions_authoritatively(
        [raw_position]
    )

    allocations = [
        classify_economic_slots(rows, dust_threshold_usd=0.01)
        for rows in (stage1_positions, stage3_positions, sell_positions)
    ]
    assert [rows[0].classification for rows in (
        stage1_positions,
        stage3_positions,
        sell_positions,
    )] == ["active", "active", "active"]
    assert [allocation.occupied_market_ids for allocation in allocations] == [
        {"open-market"},
        {"open-market"},
        {"open-market"},
    ]


@pytest.mark.anyio
async def test_filled_exit_releases_slot_and_unfilled_exit_does_not():
    async def refresh_balance():
        return SimpleNamespace(status="ready", available_balance_usd=20.0)

    class FilledExecutor:
        async def poll_order(self, **_kwargs):
            return {
                "status": "filled",
                "filledShares": 10.0,
                "remainingShares": 0.0,
            }

    class OpenExecutor:
        async def poll_order(self, **_kwargs):
            return {"status": "open", "remainingShares": 10.0}

    class PartialExecutor:
        async def poll_order(self, **_kwargs):
            return {
                "status": "partially_filled",
                "filledShares": 9.99,
                "remainingShares": 0.01,
            }

    import app.domains.polymarket_auto_live.engine as engine

    original_refresh_balance = engine.refresh_balance
    engine.refresh_balance = refresh_balance
    try:
        filled = _sell_decision(response={"orderId": "filled-1", "status": "submitted"})
        await _poll_exit_settlement(
            decisions=[filled],
            baseline_balance_usd=20.0,
            executor=FilledExecutor(),
            timeout_seconds=1,
            interval_seconds=0.01,
        )
        assert filled.order_plan.status == "filled"
        assert _exit_releases_replacement_slot(filled.order_plan, dust_threshold_usd=0.01)

        unfilled = _sell_decision(response={"orderId": "open-1", "status": "submitted"})
        await _poll_exit_settlement(
            decisions=[unfilled],
            baseline_balance_usd=20.0,
            executor=OpenExecutor(),
            timeout_seconds=1,
            interval_seconds=0.01,
        )
        assert unfilled.order_plan.status == "timed_out"
        assert not _exit_releases_replacement_slot(
            unfilled.order_plan,
            dust_threshold_usd=0.01,
        )

        partial = _sell_decision(
            response={"orderId": "partial-1", "status": "submitted"},
        )
        await _poll_exit_settlement(
            decisions=[partial],
            baseline_balance_usd=20.0,
            executor=PartialExecutor(),
            timeout_seconds=1,
            interval_seconds=0.01,
            dust_threshold_usd=0.01,
        )
        assert partial.order_plan.status == "partially_filled"
        assert _exit_has_meaningful_remaining_exposure(
            partial.order_plan,
            dust_threshold_usd=0.01,
        ) is False
        assert _exit_releases_replacement_slot(
            partial.order_plan,
            dust_threshold_usd=0.01,
        )
    finally:
        engine.refresh_balance = original_refresh_balance


@pytest.mark.anyio
async def test_forced_stage3_snapshot_bypasses_cache_and_records_live_source(monkeypatch):
    calls: list[dict[str, object]] = []

    class FakeBroker:
        async def get_positions_snapshot(self, **kwargs):
            calls.append(kwargs)
            return SimpleNamespace(
                payload=[],
                source="live-cli",
                fetched_at="2026-07-20T00:00:02+00:00",
                diagnostics=SimpleNamespace(
                    model_dump=lambda **_kwargs: {"cache_status": "bypass"}
                ),
            )

    monkeypatch.setattr(console_profile, "get_bullpen_runtime_broker", lambda: FakeBroker())
    snapshot = await read_console_wallet_positions_snapshot(
        force_fresh=True,
        caller_source="auto-live-stage3-post-exit",
        max_age_seconds=0,
    )

    assert len(calls) == 1
    assert calls[0]["force_fresh"] is True
    assert calls[0]["caller_source"] == "auto-live-stage3-post-exit"
    assert calls[0]["max_age_seconds"] == 0
    assert isinstance(calls[0]["timeout_seconds"], int)
    assert snapshot.source == "live-cli"
    assert snapshot.fetched_at > "2026-07-20T00:00:01+00:00"
