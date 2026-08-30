from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from types import SimpleNamespace

from app.domains.bullpen008.engine import stable_hash
from app.domains.bullpen008.execution import execute_certified_action
from app.domains.bullpen008.alerts import evaluate_held_position_alerts
from app.domains.bullpen008.planning import (
    build_action_plan,
    derive_execution_status,
    preflight_execution_plan,
    verify_action_plan,
)
from app.domains.bullpen008.schemas import Bullpen008Settings
from app.domains.polymarket_auto_live.advisory_lock import acquire_bullpen_account_execution_advisory_lock_sync

NOW = datetime(2026, 8, 30, 12, tzinfo=UTC)


def certificate(*, certified: bool = True) -> dict[str, object]:
    payload: dict[str, object] = {
        "portfolio_certified": certified,
        "account_identity": "0x008",
        "inputs_hash": "inputs",
        "target_portfolio_hash": "target",
        "cluster_map_version": "v3",
        "optimizer_version": "v3",
    }
    payload["certificate_hash"] = stable_hash(payload)
    return payload


def allocation(market_id: str, target: float, **updates: object) -> dict[str, object]:
    row: dict[str, object] = {
        "market_id": market_id,
        "condition_id": f"condition-{market_id}",
        "slug": f"market-{market_id}",
        "question": f"Market {market_id}",
        "chosen_side": "YES",
        "strict_cluster_id": f"strict-{market_id}",
        "common_catalyst_cluster_id": f"catalyst-{market_id}",
        "current_odds": 85,
        "llm_odds": 88,
        "edge_pp": 3,
        "risk_score": 2,
        "target_exposure_usd": target,
        "deadline": (NOW + timedelta(days=10)).isoformat(),
        "quote_timestamp": NOW.isoformat(),
    }
    row.update(updates)
    return row


def cluster(row: dict[str, object]) -> dict[str, object]:
    return {**row, "adjudication_status": "resolved"}


def position(market_id: str, exposure: float, **updates: object) -> dict[str, object]:
    row: dict[str, object] = {
        "market_id": market_id,
        "condition_id": f"condition-{market_id}",
        "slug": f"market-{market_id}",
        "market_title": f"Market {market_id}",
        "side": "YES",
        "shares": exposure / 0.85,
        "exposure_usd": exposure,
        "current_value_usd": exposure,
        "current_yes_odds": 85,
        "classification": "active",
        "claimable": False,
        "quote_timestamp": NOW.isoformat(),
    }
    row.update(updates)
    return row


def wallet(positions: list[dict[str, object]], cash: float = 50, **updates: object) -> dict[str, object]:
    row: dict[str, object] = {
        "account_identity": "0x008",
        "fetched_at": NOW.isoformat(),
        "positions": positions,
        "balance": {"available_balance_usd": cash, "account_value_usd": cash + sum(float(p.get("current_value_usd") or 0) for p in positions)},
        "open_orders": [],
    }
    row.update(updates)
    return row


def make_plan(
    allocations: list[dict[str, object]],
    positions: list[dict[str, object]],
    *,
    cash: float = 50,
    cert: dict[str, object] | None = None,
    pending: list[dict[str, object]] | None = None,
    settings: Bullpen008Settings | None = None,
    now: datetime = NOW,
    stage4_completed_at: datetime = NOW,
) -> dict[str, object]:
    return build_action_plan(
        run_id="b008-run",
        stage4_allocations=allocations,
        stage4_certificate=cert or certificate(),
        stage3_rows=[cluster(row) for row in allocations],
        wallet_snapshot=wallet(positions, cash),
        pending_orders=pending or [],
        settings=settings or Bullpen008Settings(),
        stage4_completed_at=stage4_completed_at,
        now=now,
    )


def test_stage5_cannot_add_market_or_override_side_or_target() -> None:
    target = allocation("only", 15, chosen_side="NO")
    plan = make_plan([target], [position("only", 5, side="NO")])
    assert [row["market_id"] for row in plan["buys"]] == ["only"]
    buy = plan["buys"][0]
    assert buy["side"] == "NO"
    assert buy["target_exposure_usd"] == 15
    assert buy["estimated_usd"] == 10
    assert {row["market_id"] for row in plan["buys"]} <= {"only"}


@pytest.mark.parametrize("kind", ["invalid", "expired"])
def test_invalid_or_expired_stage4_certificate_blocks_buys(kind: str) -> None:
    cert = certificate()
    now = NOW
    completed = NOW
    if kind == "invalid":
        cert["inputs_hash"] = "tampered"
    else:
        now = NOW + timedelta(hours=1)
    plan = make_plan([allocation("buy", 10)], [], cert=cert, now=now, stage4_completed_at=completed)
    assert plan["buys"] == []
    codes = {row["reason_code"] for row in plan["blocked_untradeable"]}
    assert any("STAGE4_NOT_CERTIFIED" in code or "TARGET_EXPIRED" in code for code in codes)
    assert plan["plan_certificate"]["plan_certified"] is False


def test_stage4_account_identity_mismatch_blocks_buys() -> None:
    cert = certificate()
    cert["account_identity"] = "0x007"
    cert["certificate_hash"] = stable_hash(
        {key: value for key, value in cert.items() if key != "certificate_hash"}
    )
    plan = make_plan([allocation("buy", 10)], [], cert=cert)
    assert plan["buys"] == []
    assert plan["blocked_untradeable"][0]["reason_code"] == (
        "STAGE4_ACCOUNT_IDENTITY_MISMATCH"
    )
    assert plan["target_account_matches"] is False


def test_stage3_ambiguity_freezes_buys_and_fails_plan_certificate() -> None:
    row = allocation("ambiguous", 10)
    unresolved = {**row, "adjudication_status": "unresolved"}
    plan = build_action_plan(
        run_id="b008-run",
        stage4_allocations=[row],
        stage4_certificate=certificate(),
        stage3_rows=[unresolved],
        wallet_snapshot=wallet([]),
        pending_orders=[],
        settings=Bullpen008Settings(),
        stage4_completed_at=NOW,
        now=NOW,
    )
    assert plan["buys"] == []
    assert "STAGE3_INCOMPLETE" in plan["blocked_untradeable"][0]["reason_code"]
    assert plan["plan_certificate"]["plan_certified"] is False


def test_gap_ordering_cash_ledger_and_dependent_buy() -> None:
    rows = [allocation("sell", 0), allocation("buy", 20)]
    plan = make_plan(rows, [position("sell", 20)], cash=0)
    assert plan["full_exits"][0]["priority"] < plan["buys"][0]["priority"]
    assert plan["buys"][0]["dependency_ids"] == [plan["full_exits"][0]["action_id"]]
    assert plan["buys"][0]["allowed_after_confirmed_exit_action_id"] == plan["full_exits"][0]["action_id"]
    assert min(row["cash_usd"] for row in plan["cash_ledger"]) >= 0
    assert plan["metrics"]["expected_post_plan_cash"] == 0
    assert verify_action_plan(plan)


def test_claim_cancel_sell_trim_buy_hold_action_order() -> None:
    rows = [
        allocation("claim", 0), allocation("exit", 0), allocation("trim", 10),
        allocation("buy", 10), allocation("hold", 5),
    ]
    positions = [
        position("claim", 5, claimable=True, classification="claimable"),
        position("exit", 5), position("trim", 20), position("hold", 5),
    ]
    pending = [{"market_id": "hold", "side": "YES", "action": "BUY", "status": "submitted", "current_order_usd": 1, "stale": True, "remote_order_id": "o-1"}]
    plan = make_plan(rows, positions, pending=pending)
    assert [len(plan[key]) for key in ("claims", "order_cancellations", "full_exits", "trims", "buys", "holds")] == [1, 1, 1, 1, 1, 1]
    priorities = [plan[key][0]["priority"] for key in ("claims", "order_cancellations", "full_exits", "trims", "buys", "holds")]
    assert priorities == sorted(priorities)


def test_pending_buy_from_any_profile_consumes_gap_and_cluster_capacity() -> None:
    rows = [allocation("m", 20)]
    pending = [{"profile": "bullpen007", "market_id": "m", "side": "YES", "action": "BUY", "status": "submitted", "current_order_usd": 10}]
    plan = make_plan(rows, [position("m", 5)], pending=pending)
    assert plan["buys"][0]["estimated_usd"] == 5


def test_pending_order_blocks_a_buy_that_would_exceed_cluster_capacity() -> None:
    row = allocation("m", 10)
    plan = make_plan([row], [])
    result = preflight_execution_plan(
        plan=plan,
        stage4_certificate=certificate(),
        live_wallet_snapshot=wallet([]),
        quotes_by_market={
            "m": {
                "current_odds": 85,
                "spread_cents": 1,
                "liquidity_usd": 100,
                "open": True,
            }
        },
        pending_orders=[
            {
                "profile": "bullpen007",
                "market_id": "m",
                "action": "BUY",
                "status": "submitted",
                "current_order_usd": 15,
            }
        ],
        settings=Bullpen008Settings(),
        execution_mode="live",
    )
    assert "CAPACITY_REVALIDATED" in result["actions"][0]["blocker_codes"]


def test_missing_bid_dust_and_expired_not_claimable_are_distinct() -> None:
    settings = Bullpen008Settings(dust_threshold_usd=1)
    rows = [
        allocation("bid", 0, current_odds=0),
        allocation("dust", 0.5),
        allocation("expired", 0, deadline=(NOW - timedelta(days=1)).isoformat()),
    ]
    positions = [position("bid", 5), position("dust", 0.75), position("expired", 5)]
    plan = make_plan(rows, positions, settings=settings)
    codes = {row["reason_code"] for row in plan["blocked_untradeable"]}
    assert {"BID_UNAVAILABLE", "EXPIRED_NOT_CLAIMABLE"} <= codes
    assert "DUST_POSITION" in codes


def test_expired_nonclaimable_hold_can_certify_a_no_buy_plan() -> None:
    settings = Bullpen008Settings()
    row = allocation(
        "expired-hold",
        10,
        deadline=(NOW - timedelta(days=1)).isoformat(),
        locked_resolution_hold=True,
    )
    plan = make_plan([row], [position("expired-hold", 10)], settings=settings)
    assert plan["buys"] == []
    assert plan["blocked_untradeable"][0]["reason_code"] == (
        "EXPIRED_NOT_CLAIMABLE"
    )
    assert plan["plan_certificate"]["plan_certified"] is True


def test_preflight_blocks_odds_slippage_spread_emergency_and_wallet_change() -> None:
    row = allocation("m", 10)
    planned_wallet = wallet([])
    plan = build_action_plan(
        run_id="b008-run", stage4_allocations=[row], stage4_certificate=certificate(),
        stage3_rows=[cluster(row)], wallet_snapshot=planned_wallet, pending_orders=[],
        settings=Bullpen008Settings(), stage4_completed_at=NOW, now=NOW,
    )
    live = wallet([], cash=45)
    result = preflight_execution_plan(
        plan=plan, stage4_certificate=certificate(), live_wallet_snapshot=live,
        quotes_by_market={"m": {"current_odds": 79, "spread_cents": 8, "liquidity_usd": 100, "open": True}},
        pending_orders=[], settings=Bullpen008Settings(), execution_mode="live", emergency_stop=True,
    )
    blockers = set(result["actions"][0]["blocker_codes"])
    assert {"EMERGENCY_STOP", "WALLET_VERSION", "BUY_ODDS_AT_LEAST_80", "SPREAD"} <= blockers


def test_account_identity_mismatch_blocks_action() -> None:
    row = allocation("m", 10)
    plan = make_plan([row], [])
    result = preflight_execution_plan(
        plan=plan, stage4_certificate=certificate(), live_wallet_snapshot=wallet([], account_identity="0xother"),
        quotes_by_market={"m": {"current_odds": 85, "spread_cents": 1, "liquidity_usd": 100, "open": True}},
        pending_orders=[], settings=Bullpen008Settings(), execution_mode="shadow",
    )
    assert "ACCOUNT_IDENTITY" in result["actions"][0]["blocker_codes"]


class FakeAdapter:
    def __init__(self, *, submit: object = None, reconcile: object = None, existing: object = None) -> None:
        self.submit_result = submit or {"remote_order_id": "remote-1"}
        self.reconcile_result = reconcile or {"status": "Reconciled", "filled_shares": 10}
        self.existing_result = existing
        self.submit_calls = 0

    async def find_existing(self, **_: object):
        return self.existing_result

    async def submit(self, **_: object):
        self.submit_calls += 1
        if isinstance(self.submit_result, BaseException):
            raise self.submit_result
        return self.submit_result

    async def reconcile(self, **_: object):
        if isinstance(self.reconcile_result, BaseException):
            raise self.reconcile_result
        return self.reconcile_result


def execute_with(adapter: FakeAdapter, *, existing_intent: dict[str, object] | None = None):
    row = allocation("m", 10)
    plan = make_plan([row], [])
    action = plan["buys"][0]
    events: list[str] = []

    async def persist_intent(_: dict[str, object]) -> None:
        events.append("intent")

    async def persist_transition(_: dict[str, object], status: str, __: dict[str, object]) -> None:
        events.append(status)

    result = asyncio.run(
        execute_certified_action(
            action=action, plan=plan, stage4_certificate=certificate(),
            preflight={"status": "Ready", "blocker_codes": []}, adapter=adapter,
            persist_intent=persist_intent, persist_transition=persist_transition,
            existing_intent=existing_intent,
        )
    )
    return result, events


def test_durable_intent_is_persisted_before_remote_submission_and_reconciles() -> None:
    adapter = FakeAdapter()
    result, events = execute_with(adapter)
    assert events[:2] == ["intent", "Submitting"]
    assert result["status"] == "Reconciled"
    assert adapter.submit_calls == 1


def test_timeout_after_submission_is_recoverable_and_not_blindly_retried() -> None:
    adapter = FakeAdapter(submit=TimeoutError("unknown remote outcome"))
    result, events = execute_with(adapter)
    assert result["status"] == "Recoverable"
    assert result["retryable"] is False
    assert "Recoverable" in events


def test_restart_with_remote_id_reconciles_without_duplicate_submission() -> None:
    adapter = FakeAdapter(reconcile={"status": "PartiallyFilled", "filled_shares": 2})
    row = allocation("m", 10)
    plan = make_plan([row], [])
    action = plan["buys"][0]
    from app.domains.bullpen008.execution import build_durable_intent
    existing = build_durable_intent(action=action, plan=plan)
    existing["remote_order_id"] = "remote-existing"
    result, _ = execute_with(adapter, existing_intent=existing)
    assert result["status"] == "PartiallyFilled"
    assert result["resumed_without_resubmit"] is True
    assert adapter.submit_calls == 0


def test_persistence_failure_before_submission_never_calls_remote_adapter() -> None:
    row = allocation("m", 10)
    plan = make_plan([row], [])
    adapter = FakeAdapter()

    async def fail_persistence(_: dict[str, object]) -> None:
        raise RuntimeError("database unavailable")

    async def transition(_: dict[str, object], __: str, ___: dict[str, object]) -> None:
        raise AssertionError("no transition is possible without a durable intent")

    with pytest.raises(RuntimeError, match="database unavailable"):
        asyncio.run(
            execute_certified_action(
                action=plan["buys"][0],
                plan=plan,
                stage4_certificate=certificate(),
                preflight={"status": "Ready", "blocker_codes": []},
                adapter=adapter,
                persist_intent=fail_persistence,
                persist_transition=transition,
            )
        )
    assert adapter.submit_calls == 0


def test_remote_discovery_prevents_duplicate_delivery_and_ambiguous_retry() -> None:
    found = FakeAdapter(
        existing={"remote_order_id": "remote-found"},
        reconcile={"status": "Reconciled", "filled_shares": 10},
    )
    result, _ = execute_with(found)
    assert result["status"] == "Reconciled"
    assert result["resumed_without_resubmit"] is True
    assert found.submit_calls == 0

    ambiguous = FakeAdapter(existing={"status": "accepted-but-id-unknown"})
    result, _ = execute_with(ambiguous)
    assert result["status"] == "Recoverable"
    assert result["blocker_code"] == "AMBIGUOUS_REMOTE_RESULT"
    assert ambiguous.submit_calls == 0


def test_reconciliation_failure_keeps_remote_id_and_is_safely_retryable() -> None:
    adapter = FakeAdapter(reconcile=TimeoutError("poll timeout"))
    result, _ = execute_with(adapter)
    assert result["status"] == "Recoverable"
    assert result["blocker_code"] == "RECONCILIATION_FAILED"
    assert result["remote_order_id"] == "remote-1"
    assert result["retryable"] is True


def test_terminal_statuses_never_call_zero_intents_finished_in_live_mode() -> None:
    status, reason = derive_execution_status(
        counters={"planned": 20, "durable_intents": 0, "submitted": 0, "blocked": 0, "failed": 0},
        execution_mode="live",
    )
    assert status == "failed"
    assert reason == "Failed before intent creation."
    assert derive_execution_status(counters={"planned": 1, "durable_intents": 1, "reconciled": 1}, execution_mode="live")[0] == "completed"
    assert derive_execution_status(counters={"planned": 2, "durable_intents": 2, "reconciled": 1, "blocked": 1}, execution_mode="live")[0] == "partial"
    assert derive_execution_status(
        counters={"planned": 1}, execution_mode="live", cancelled=True
    )[0] == "cancelled"


def test_phase2_migration_and_tables_are_additive_and_008_only() -> None:
    source = Path("alembic/versions/0a1b2c3d4e5f_add_bullpen008_phase2_tables.py").read_text()
    assert 'down_revision: str | Sequence[str] | None = "f9a0b1c2d3e4"' in source
    for table in ("bullpen008_action_plans", "bullpen008_execution_intents", "bullpen008_execution_attempts", "bullpen008_execution_events", "bullpen008_alerts"):
        assert f'"{table}"' in source
    assert "polymarket_auto_live_order_intents" not in source


def test_manual_dispatch_returns_a_persisted_run_on_ambiguous_publish_timeout() -> None:
    source = Path("app/domains/bullpen008/router.py").read_text()
    assert "asyncio.to_thread" in source
    assert "asyncio.shield(publish), timeout=5" in source
    assert 'dispatch_status = "publish-timeout-ambiguous"' in source
    assert 'celery_task_id = f"bullpen008:{record.id}"' in source


def test_008_alerts_distinguish_sources_deduplicate_and_recover_with_hysteresis() -> None:
    positions = [position("m", 5, current_yes_odds=79, current_no_odds=21)]
    stage2 = [{"market_id": "m", "llm_yes_probability": 78, "llm_no_probability": 22}]
    first = evaluate_held_position_alerts(
        positions=positions, stage2_rows=stage2, active_episodes=set(), episode_versions={}
    )
    assert first["alerts"][0]["breach_type"] == "both"
    duplicate = evaluate_held_position_alerts(
        positions=positions, stage2_rows=stage2, active_episodes={("m", "YES")}, episode_versions={("m", "YES"): 1}
    )
    assert duplicate["alerts"] == []
    not_recovered = evaluate_held_position_alerts(
        positions=[position("m", 5, current_yes_odds=81)],
        stage2_rows=[{"market_id": "m", "llm_yes_probability": 81}],
        active_episodes={("m", "YES")},
    )
    assert not_recovered["recoveries"] == []
    recovered = evaluate_held_position_alerts(
        positions=[position("m", 5, current_yes_odds=82)],
        stage2_rows=[{"market_id": "m", "llm_yes_probability": 83}],
        active_episodes={("m", "YES")},
    )
    assert recovered["recoveries"][0]["market_id"] == "m"


def test_account_wide_execution_lock_is_exclusive_and_recoverable(monkeypatch: pytest.MonkeyPatch) -> None:
    import app.domains.polymarket_auto_live.advisory_lock as advisory_lock_module
    monkeypatch.setattr(advisory_lock_module, "sync_engine", SimpleNamespace(dialect=SimpleNamespace(name="sqlite")))
    first = acquire_bullpen_account_execution_advisory_lock_sync("0x008")
    assert first is not None
    try:
        assert acquire_bullpen_account_execution_advisory_lock_sync("0x008") is None
    finally:
        first.release()
    second = acquire_bullpen_account_execution_advisory_lock_sync("0x008")
    assert second is not None
    second.release()
