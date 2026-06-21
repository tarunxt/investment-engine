import json
import os
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://test:test@localhost:5432/testdb",
)
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

import pytest
from pydantic import ValidationError

from app.domains.polymarket_auto_live.config import auto_live_backend_allows_execution
from app.domains.polymarket_auto_live.engine import (
    BullpenAutoLiveEngine,
    PositionSnapshot,
)
from app.domains.polymarket_auto_live.llm import run_llm_consensus
from app.domains.polymarket_auto_live.rules import RuleEvaluation, evaluate_market_rules
from app.domains.polymarket_auto_live.scanner import (
    ScannedMarket,
    _evaluate_filter_reasons,
)
from app.domains.polymarket_auto_live.schemas import (
    BullpenAutoLiveBotCardSummary,
    BullpenAutoLiveDecision,
    BullpenAutoLiveLlmOutput,
    BullpenAutoLiveOrderPlan,
    BullpenAutoLiveRun,
    BullpenAutoLiveSettings,
    BullpenAutoLiveState,
    BullpenAutoLiveSummary,
)
from app.domains.trading_bots.service import (
    build_trading_bots_overview,
    build_trading_bots_summary,
)


def test_auto_live_settings_enforce_cross_field_validation():
    with pytest.raises(ValidationError, match="max_single_trade_pct_bankroll"):
        BullpenAutoLiveSettings(
            max_single_trade_pct_bankroll=7,
            max_single_market_pct_bankroll=6,
        )

    with pytest.raises(ValidationError, match="allow_live_execution"):
        BullpenAutoLiveSettings(
            allow_live_execution=True,
            limit_orders_only=False,
        )


def test_auto_live_backend_execution_flag_defaults_false(monkeypatch):
    monkeypatch.delenv("BULLPEN_AUTO_LIVE_ALLOW_EXECUTION", raising=False)
    assert auto_live_backend_allows_execution() is False

    monkeypatch.setenv("BULLPEN_AUTO_LIVE_ALLOW_EXECUTION", "true")
    assert auto_live_backend_allows_execution() is True

    monkeypatch.setenv("BULLPEN_AUTO_LIVE_ALLOW_EXECUTION", "FALSE")
    assert auto_live_backend_allows_execution() is False


def test_market_rules_extract_resolution_criteria_and_deadline():
    market = _market(
        description=(
            'This market will resolve to "Yes" if candidate X wins the election '
            "by November 6, 2026, 11:59 PM ET. Otherwise, it resolves to No."
        ),
        close_time="2026-11-07T05:00:00+00:00",
    )

    result = evaluate_market_rules(
        market,
        now=datetime(2026, 11, 1, 12, 0, tzinfo=UTC),
    )

    assert result.fail_reason is None
    assert result.outcome_clear is True
    assert result.ambiguous is False
    assert result.expired is False
    assert result.yes_definition == "candidate X wins the election by November 6, 2026, 11:59 PM ET"
    assert result.deadline_et == "2026-11-06 11:59:00 PM ET"
    assert result.hours_remaining is not None
    assert result.hours_remaining > 0


def test_market_rules_fail_without_resolution_criteria():
    result = evaluate_market_rules(
        _market(description=None),
        now=datetime(2026, 6, 21, 12, 0, tzinfo=UTC),
    )

    assert result.outcome_clear is False
    assert result.ambiguous is True
    assert result.fail_reason == "Resolution criteria are unavailable."


def test_candidate_filter_reasons_block_sports_and_low_liquidity():
    market = _market(
        question="Will the Lakers win the NBA Finals?",
        theme="Sports",
        liquidity_usd=250,
    )

    reasons = _evaluate_filter_reasons(market, min_liquidity_usd=1_000)

    assert "Excluded sports market." in reasons
    assert any("Excluded low-liquidity market" in reason for reason in reasons)


def test_candidate_filter_reasons_block_unclear_social_count_market():
    market = _market(
        question="How many tweets will candidate X post this week?",
        slug="candidate-x-10-tweets",
        outcome_labels=["0-10", "11-20", "21+"],
        current_yes_odds=None,
        current_no_odds=None,
    )

    reasons = _evaluate_filter_reasons(market, min_liquidity_usd=0)

    assert "Excluded tweet-count or social-post-count market." in reasons
    assert "Excluded unclear non-binary market." in reasons


@pytest.mark.anyio
async def test_trading_bots_summary_returns_four_cards_in_order(monkeypatch):
    async def fake_bullpen_state():
        return _fake_polymarket_state()

    async def fake_direct_state():
        return _fake_polymarket_state(
            running=False,
            mode="mock",
            doctor_ok=False,
            doctor_message="Direct execution not configured",
            tracked_accounts=[],
            next_poll_at=None,
        )

    auto_live_summary = BullpenAutoLiveSummary(
        state=BullpenAutoLiveState(
            running=True,
            status="running",
            mode="dry-run",
            last_run_at="2026-06-21T10:00:00+00:00",
            next_run_at="2026-06-21T10:01:00+00:00",
            last_action="Dry-run cycle completed safely.",
        ),
        settings=BullpenAutoLiveSettings(auto_live_enabled=True),
        bot_card=BullpenAutoLiveBotCardSummary(
            status="running",
            mode="dry-run",
            invested_usd=0,
            current_value_usd=0,
            pnl_usd=0,
            return_pct=None,
            active_positions=0,
            trades_today=0,
            last_run_at="2026-06-21T10:00:00+00:00",
            next_run_at="2026-06-21T10:01:00+00:00",
            guardrails_summary="Max single trade: 2.00% | Cash reserve: 40.00%",
            strategy_summary="Auto-Live strategy",
            risk_summary="Auto-Live risk",
        ),
    )

    class FakeBot:
        def __init__(self, state):
            self._state = state

        async def get_state(self):
            return await self._state()

    class FakeSummaryBot:
        async def get_summary(self):
            return auto_live_summary

    async def fake_get_bullpen_bot(user_id: int):
        return FakeBot(fake_bullpen_state)

    async def fake_get_direct_bot(user_id: int):
        return FakeBot(fake_direct_state)

    async def fake_get_auto_live_bot(user_id: int):
        return FakeSummaryBot()

    monkeypatch.setattr(
        "app.domains.trading_bots.service.polymarket_bot_manager.get_bot",
        fake_get_bullpen_bot,
    )
    monkeypatch.setattr(
        "app.domains.trading_bots.service.polymarket_direct_bot_manager.get_bot",
        fake_get_direct_bot,
    )
    monkeypatch.setattr(
        "app.domains.trading_bots.service.polymarket_auto_live_bot_manager.get_bot",
        fake_get_auto_live_bot,
    )

    summary = await build_trading_bots_summary(user_id=7)
    overview = await build_trading_bots_overview(user_id=7)

    assert [card.id for card in summary.cards] == [
        "bullpen-x-polymarket",
        "polymarket-direct",
        "bullpen-x-ai",
        "bullpen-ai-auto-live",
    ]
    assert summary.cards[0].name == "Bullpen x Polymarket"
    assert summary.cards[1].status == "not-configured"
    assert summary.cards[2].source == "placeholder"
    assert summary.cards[3].route == "/console/trading-bots/bullpen-ai-auto-live"

    assert len(overview.bots) == 4
    assert overview.bots[0].href == "/console/polymarket-bot"
    assert overview.bots[3].next_scheduled_run == "2026-06-21T10:01:00+00:00"


def _market(
    *,
    question: str = "Will candidate X win?",
    description: str | None = (
        'This market will resolve to "Yes" if candidate X wins. Otherwise, it resolves to No.'
    ),
    close_time: str | None = "2026-06-30T23:59:00+00:00",
    theme: str = "Politics",
    liquidity_usd: float | None = 5_000,
    slug: str | None = "candidate-x-win",
    outcome_labels: list[str] | None = None,
    current_yes_odds: float | None = 54,
    current_no_odds: float | None = 46,
) -> ScannedMarket:
    return ScannedMarket(
        market_id=slug or "market-1",
        question=question,
        market_url="https://polymarket.com/event/test-market",
        slug=slug,
        close_time=close_time,
        theme=theme,
        current_yes_odds=current_yes_odds,
        current_no_odds=current_no_odds,
        volume_usd=10_000,
        liquidity_usd=liquidity_usd,
        description=description,
        outcome_labels=outcome_labels or ["Yes", "No"],
        event_slug="test-market",
        best_bid_cents=53,
        best_ask_cents=55,
        spread_cents=2,
        raw={},
    )


def _fake_polymarket_state(
    *,
    running: bool = True,
    mode: str = "live-read",
    doctor_ok: bool = True,
    doctor_message: str = "ok",
    tracked_accounts: list | None = None,
    next_poll_at: str | None = "2026-06-21T10:05:00+00:00",
):
    return SimpleNamespace(
        running=running,
        paused=False,
        mode=mode,
        session_started_at="2026-06-21T09:00:00+00:00",
        started_at="2026-06-21T09:00:00+00:00",
        last_poll_at="2026-06-21T10:00:00+00:00",
        next_poll_at=next_poll_at,
        last_error=None,
        tracked_accounts=tracked_accounts or [SimpleNamespace(id="acct-1")],
        open_positions=[
            SimpleNamespace(cost_basis=10.0, shares=5),
            SimpleNamespace(cost_basis=0.0, shares=0),
        ],
        trade_history=[],
        metrics=SimpleNamespace(total_pnl=2.5),
        config=SimpleNamespace(
            fixed_copy_trade_size=1.0,
            max_live_exposure_per_market=5.0,
            max_live_daily_loss=10.0,
            max_live_trades_per_day=25,
            require_manual_confirmation=False,
        ),
        live=SimpleNamespace(
            balance=SimpleNamespace(
                account_value_usd=12.5,
                message="ready",
            ),
            source_status=SimpleNamespace(last_live_read_error=None),
            doctor=SimpleNamespace(ok=doctor_ok, message=doctor_message),
            max_live_trade_size=1.0,
            pending_confirmations=[],
            emergency_stopped=False,
            live_trades_today=1,
            recent_decisions=[],
        ),
    )


def _fake_evidence_packet():
    return SimpleNamespace(
        built_at="2026-06-21T10:00:00+00:00",
        queries=["candidate x"],
        warnings=[],
        results=[],
    )


def _fake_llm_consensus(
    *,
    fair_yes: float = 72,
    fair_no: float = 28,
    average_yes: float | None = None,
    median_yes: float | None = None,
    trimmed_mean_yes: float | None = None,
    min_yes: float | None = None,
    max_yes: float | None = None,
    spread_yes: float = 0,
    disagreement_level: str = "Low",
    adjudication_required: bool = False,
    confidence: str = "High",
    evidence_status: str = "Strong",
    event_state: str = "scheduled_not_occurred",
    provider_error_rate: float = 0,
):
    outputs = [
        BullpenAutoLiveLlmOutput(
            provider="openai",
            model="gpt-4o-mini",
            llm_yes_odds=fair_yes,
            llm_no_odds=fair_no,
            confidence=confidence,
            evidence_status=evidence_status,
            event_state=event_state,
            key_evidence=["Confirmed evidence"],
            red_flags=[],
            rationale="Strong enough to test Auto-Live execution wiring.",
            completed_at="2026-06-21T10:00:00+00:00",
        )
    ]
    consensus = SimpleNamespace(
        fair_yes_probability_pct=fair_yes,
        fair_no_probability_pct=fair_no,
        average_yes=fair_yes if average_yes is None else average_yes,
        median_yes=fair_yes if median_yes is None else median_yes,
        trimmed_mean_yes=fair_yes if trimmed_mean_yes is None else trimmed_mean_yes,
        min_yes=fair_yes if min_yes is None else min_yes,
        max_yes=fair_yes if max_yes is None else max_yes,
        spread_yes=spread_yes,
        disagreement_level=disagreement_level,
        adjudication_required=adjudication_required,
        confidence=confidence,
        evidence_status=evidence_status,
        event_state=event_state,
        provider_error_rate=provider_error_rate,
    )
    return outputs, consensus


def _fake_rules(
    *,
    hours_remaining: float = 72,
    fail_reason: str | None = None,
    deadline_et: str = "2026-06-24 08:00:00 PM ET",
) -> RuleEvaluation:
    return RuleEvaluation(
        yes_definition=None if fail_reason else "candidate X wins by the deadline",
        resolution_criteria=(
            None
            if fail_reason
            else 'This market will resolve to "Yes" if candidate X wins by the deadline.'
        ),
        deadline_et=deadline_et,
        hours_remaining=hours_remaining,
        outcome_clear=fail_reason is None,
        expired=False,
        ambiguous=fail_reason is not None,
        fail_reason=fail_reason,
    )


def _fake_live_controls(
    *,
    unlocked: bool = True,
    unlock_mode: str = "manual",
    locked_reason: str | None = None,
    emergency_stopped: bool = False,
    doctor_ok: bool = True,
    doctor_message: str = "Bullpen doctor passed",
    balance_status: str = "ready",
    balance_message: str = "Balance ready",
):
    return SimpleNamespace(
        unlocked=unlocked,
        unlock_mode=unlock_mode,
        locked_reason=locked_reason,
        emergency_stopped=emergency_stopped,
        doctor=SimpleNamespace(ok=doctor_ok, message=doctor_message),
        balance=SimpleNamespace(status=balance_status, message=balance_message),
    )


def _historical_decision(
    *,
    decision_id: str,
    realized_pnl_usd: float | None,
    executed_at: str,
    order_status: str = "submitted",
) -> BullpenAutoLiveDecision:
    order_plan = BullpenAutoLiveOrderPlan.model_construct(
        id=f"{decision_id}-order",
        action="buy",
        side="YES",
        order_type="limit",
        status=order_status,
        market_id="historical-market",
        market_title="Historical market",
        order_size_usd=5.0,
        shares=10.0,
        limit_price_cents=50.0,
        refreshed_market_price_cents=50.0,
        max_slippage_cents=2.0,
        dry_run=False,
        detail="Historical order",
        execution_response="ok",
        created_at=executed_at,
        executed_at=executed_at,
    )
    return BullpenAutoLiveDecision.model_construct(
        id=decision_id,
        run_id="historical-run",
        created_at=executed_at,
        updated_at=executed_at,
        market_id="historical-market",
        market_title="Historical market",
        market_url="https://example.com/historical",
        slug="historical-market",
        close_time="2026-06-30T00:00:00+00:00",
        theme="Politics",
        side="YES",
        decision="BUY_NEW",
        risk_status="Ready",
        price_cents=50.0,
        current_yes_odds=50.0,
        current_no_odds=50.0,
        fair_probability_pct=60.0,
        fair_yes_probability_pct=60.0,
        fair_no_probability_pct=40.0,
        edge_pp=10.0,
        score=10.0,
        confidence="High",
        evidence_status="Strong",
        event_state="scheduled_not_occurred",
        adjudication_required=False,
        disagreement_level="Low",
        current_exposure_usd=0.0,
        target_exposure_usd=0.0,
        realized_pnl_usd=realized_pnl_usd,
        hours_remaining=24.0,
        key_evidence=[],
        red_flags=[],
        rationale="Historical order",
        reason="Historical order",
        summary="Historical order",
        order_plan=order_plan,
        llm_outputs=[],
        stage_results=[],
        guardrail_checks=[],
    )


async def _execute_auto_live(
    monkeypatch,
    *,
    market: ScannedMarket | None = None,
    settings: BullpenAutoLiveSettings | None = None,
    rules: RuleEvaluation | None = None,
    llm_consensus: tuple[list[BullpenAutoLiveLlmOutput], object] | None = None,
    live_controls=None,
    positions: list[PositionSnapshot] | None = None,
    historical_decisions: list[BullpenAutoLiveDecision] | None = None,
    refreshed_price_cents: float | None = None,
    refreshed_spread_cents: float | None = 2,
    runtime_settings=None,
    balance_after_order_status: str = "ready",
    allow_execution_env: bool = False,
):
    fixed_now = datetime(2026, 6, 21, 12, 0, tzinfo=UTC)
    market = market or _market()
    settings = settings or BullpenAutoLiveSettings()
    rules = rules or _fake_rules()
    llm_consensus = llm_consensus or _fake_llm_consensus()
    live_controls = live_controls or _fake_live_controls()
    positions = positions or []
    historical_decisions = historical_decisions or []
    executor_calls: list[tuple[str, dict[str, object]]] = []

    async def fake_scan_candidate_markets(**kwargs):
        return SimpleNamespace(
            source_label="test",
            source_url="https://example.com",
            accepted=[market],
            rejected=[],
        )

    async def fake_refresh_execution_quote(**kwargs):
        side = kwargs["side"]
        current_price_cents = refreshed_price_cents
        if current_price_cents is None:
            current_price_cents = (
                market.current_yes_odds if side == "YES" else market.current_no_odds
            )
        return SimpleNamespace(
            market=market,
            current_price_cents=current_price_cents,
            spread_cents=refreshed_spread_cents,
        )

    async def fake_refresh_live_controls(**kwargs):
        return live_controls

    async def fake_refresh_runtime_execution_settings(**kwargs):
        return runtime_settings or SimpleNamespace(
            auto_live_enabled=settings.auto_live_enabled,
            dry_run=settings.dry_run,
            allow_live_execution=settings.allow_live_execution,
            emergency_stop=settings.emergency_stop,
            paused=False,
            running=True,
        )

    async def fake_refresh_balance():
        return SimpleNamespace(
            status=balance_after_order_status,
            available_balance_usd=50.0,
            account_value_usd=50.0,
            message="Balance ready"
            if balance_after_order_status == "ready"
            else "Balance unavailable",
        )

    class RecordingExecutor:
        async def execute(self, *args, **kwargs):
            executor_calls.append(("execute", {"args": args, "kwargs": kwargs}))
            return "unused-execute"

        async def buy_limit(self, **kwargs):
            executor_calls.append(("buy_limit", kwargs))
            return "buy-limit-submitted"

        async def sell_limit(self, **kwargs):
            executor_calls.append(("sell_limit", kwargs))
            return "sell-limit-submitted"

    monkeypatch.setenv(
        "BULLPEN_AUTO_LIVE_ALLOW_EXECUTION",
        "true" if allow_execution_env else "false",
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.utc_now",
        lambda: fixed_now,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.utc_now_iso",
        lambda: fixed_now.isoformat(),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.scan_candidate_markets",
        fake_scan_candidate_markets,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.evaluate_market_rules",
        lambda *_args, **_kwargs: rules,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.build_evidence_packet",
        lambda *args, **kwargs: _fake_evidence_packet(),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.run_llm_consensus",
        lambda *args, **kwargs: llm_consensus,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_execution_quote",
        fake_refresh_execution_quote,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_live_controls",
        fake_refresh_live_controls,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_runtime_execution_settings",
        fake_refresh_runtime_execution_settings,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_balance",
        fake_refresh_balance,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.bullpen_module.BullpenLiveExecutor",
        lambda: RecordingExecutor(),
    )

    result = await BullpenAutoLiveEngine().execute(
        user_id=7,
        settings=settings,
        state=BullpenAutoLiveState(running=True),
        run=_run_snapshot(dry_run=settings.dry_run),
        positions=positions,
        historical_decisions=historical_decisions,
    )
    return result, executor_calls


def _run_snapshot(*, dry_run: bool = True) -> BullpenAutoLiveRun:
    return BullpenAutoLiveRun(
        id="run-1",
        triggered_by="manual",
        status="running",
        dry_run=dry_run,
        started_at="2026-06-21T10:00:00+00:00",
        summary="Queued",
    )


@pytest.mark.anyio
async def test_auto_live_live_request_falls_back_to_simulation_when_env_blocks(monkeypatch):
    market = _market(current_yes_odds=54, current_no_odds=46)
    monkeypatch.setenv("BULLPEN_AUTO_LIVE_ALLOW_EXECUTION", "false")

    async def fake_scan_candidate_markets(**kwargs):
        return SimpleNamespace(
            source_label="test",
            source_url="https://example.com",
            accepted=[market],
            rejected=[],
        )

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.scan_candidate_markets",
        fake_scan_candidate_markets,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.build_evidence_packet",
        lambda *args, **kwargs: _fake_evidence_packet(),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.run_llm_consensus",
        lambda *args, **kwargs: _fake_llm_consensus(),
    )
    async def fake_refresh_execution_quote(**kwargs):
        return SimpleNamespace(
            market=market,
            current_price_cents=54,
            spread_cents=2,
        )

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_execution_quote",
        fake_refresh_execution_quote,
    )

    result = await BullpenAutoLiveEngine().execute(
        user_id=7,
        settings=BullpenAutoLiveSettings(
            auto_live_enabled=True,
            dry_run=False,
            allow_live_execution=True,
            require_manual_confirmation=False,
        ),
        state=BullpenAutoLiveState(running=True),
        run=_run_snapshot(dry_run=False),
        positions=[],
        historical_decisions=[],
    )

    assert result.run.dry_run is True
    assert result.run.live_execution_requested is True
    assert result.run.orders_submitted == 0
    assert result.state.dry_run is True
    assert result.state.live_armed is False
    assert result.state.live_execution_allowed is False
    assert result.decisions[0].order_plan is not None
    assert result.decisions[0].order_plan.status == "skipped"
    assert "simulation only" in result.decisions[0].order_plan.detail.lower()


@pytest.mark.anyio
async def test_auto_live_exit_sells_the_held_side_not_the_new_signal_side(monkeypatch):
    market = _market(current_yes_odds=70, current_no_odds=30)
    now = datetime(2026, 6, 21, 10, 0, tzinfo=UTC)

    async def fake_scan_candidate_markets(**kwargs):
        return SimpleNamespace(
            source_label="test",
            source_url="https://example.com",
            accepted=[market],
            rejected=[],
        )

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.scan_candidate_markets",
        fake_scan_candidate_markets,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.build_evidence_packet",
        lambda *args, **kwargs: _fake_evidence_packet(),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.run_llm_consensus",
        lambda *args, **kwargs: _fake_llm_consensus(fair_yes=82, fair_no=18),
    )
    async def fake_refresh_execution_quote(**kwargs):
        return SimpleNamespace(
            market=market,
            current_price_cents=30,
            spread_cents=2,
        )

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_execution_quote",
        fake_refresh_execution_quote,
    )

    result = await BullpenAutoLiveEngine().execute(
        user_id=7,
        settings=BullpenAutoLiveSettings(
            auto_live_enabled=True,
            dry_run=True,
        ),
        state=BullpenAutoLiveState(running=True),
        run=_run_snapshot(),
        positions=[
            PositionSnapshot(
                market_id=market.market_id,
                slug=market.slug,
                market_title=market.question,
                market_url=market.market_url,
                theme=market.theme,
                side="NO",
                exposure_usd=12,
                shares=20,
                average_price_cents=40,
                opened_at=now,
                updated_at=now,
            )
        ],
        historical_decisions=[],
    )

    assert result.decisions[0].decision == "EXIT"
    assert result.decisions[0].order_plan is not None
    assert result.decisions[0].order_plan.side == "NO"
    assert result.decisions[0].order_plan.refreshed_market_price_cents == 30


@pytest.mark.anyio
async def test_auto_live_pauses_live_mode_when_bullpen_doctor_fails(monkeypatch):
    market = _market()
    monkeypatch.setenv("BULLPEN_AUTO_LIVE_ALLOW_EXECUTION", "true")

    async def fake_scan_candidate_markets(**kwargs):
        return SimpleNamespace(
            source_label="test",
            source_url="https://example.com",
            accepted=[market],
            rejected=[],
        )

    async def fake_refresh_live_controls(**kwargs):
        return SimpleNamespace(
            unlocked=True,
            unlock_mode="manual",
            locked_reason=None,
            emergency_stopped=False,
            doctor=SimpleNamespace(ok=False, message="Bullpen doctor failed"),
            balance=SimpleNamespace(status="ready", message="Balance ready"),
        )

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.scan_candidate_markets",
        fake_scan_candidate_markets,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.build_evidence_packet",
        lambda *args, **kwargs: _fake_evidence_packet(),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.run_llm_consensus",
        lambda *args, **kwargs: _fake_llm_consensus(),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_live_controls",
        fake_refresh_live_controls,
    )

    result = await BullpenAutoLiveEngine().execute(
        user_id=7,
        settings=BullpenAutoLiveSettings(
            auto_live_enabled=True,
            dry_run=False,
            allow_live_execution=True,
            require_manual_confirmation=False,
            pause_if_doctor_fails=True,
        ),
        state=BullpenAutoLiveState(running=True),
        run=_run_snapshot(dry_run=False),
        positions=[],
        historical_decisions=[],
    )

    assert result.run.status == "failed"
    assert result.state.paused is True
    assert result.state.doctor_status == "fail"
    assert result.state.live_execution_allowed is False
    assert result.decisions[0].order_plan is None
    assert "doctor failed" in result.run.summary.lower()


def test_auto_live_llm_consensus_matches_requested_statistics(monkeypatch):
    yes_values = [70, 28, 70, 70, 90, 10, 25, 40, 25, 20, 65, 65, 55]
    targets = [(f"provider-{index}", f"model-{index}") for index in range(len(yes_values))]

    class FakeProvider:
        def __init__(self, provider_name: str, yes_value: float) -> None:
            self.provider_name = provider_name
            self.yes_value = yes_value

        def generate(self, *, prompt: str, model: str):
            return SimpleNamespace(
                content=json.dumps(
                    {
                        "markets": [
                            {
                                "llm_yes_odds": self.yes_value,
                                "llm_no_odds": 100 - self.yes_value,
                                "confidence": "High",
                                "evidence_status": "Strong",
                                "event_state": "scheduled_not_occurred",
                                "key_evidence": ["Fact"],
                                "red_flags": [],
                                "rationale": "Consensus test payload",
                            }
                        ]
                    }
                ),
                provider=self.provider_name,
                model=model,
            )

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.llm.resolve_auto_live_llm_targets",
        lambda: targets,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.llm.ProviderFactory.create",
        lambda provider_name: FakeProvider(
            provider_name,
            yes_values[int(provider_name.rsplit("-", 1)[-1])],
        ),
    )

    outputs, consensus = run_llm_consensus(
        _market(),
        _fake_rules(),
        _fake_evidence_packet(),
    )

    assert len(outputs) == len(yes_values)
    assert consensus.average_yes == pytest.approx(48.69, abs=0.01)
    assert consensus.median_yes == 55
    assert consensus.min_yes == 10
    assert consensus.max_yes == 90
    assert consensus.spread_yes == 80
    assert consensus.disagreement_level == "High"
    assert consensus.adjudication_required is True


@pytest.mark.anyio
async def test_auto_live_high_llm_disagreement_blocks_trade(monkeypatch):
    result, _ = await _execute_auto_live(
        monkeypatch,
        settings=BullpenAutoLiveSettings(
            max_llm_spread_pp=30,
            half_size_llm_spread_pp=15,
        ),
        llm_consensus=_fake_llm_consensus(
            fair_yes=55,
            fair_no=45,
            average_yes=48.69,
            median_yes=55,
            trimmed_mean_yes=52.14,
            min_yes=10,
            max_yes=90,
            spread_yes=80,
            disagreement_level="High",
            adjudication_required=True,
        ),
    )

    assert result.decisions[0].decision == "SKIP"
    assert result.decisions[0].risk_status == "Blocked"
    assert "llm spread is above the configured maximum" in result.decisions[0].reason.lower()


@pytest.mark.anyio
async def test_auto_live_weak_evidence_blocks_trade(monkeypatch):
    result, _ = await _execute_auto_live(
        monkeypatch,
        settings=BullpenAutoLiveSettings(min_evidence_status="Moderate"),
        llm_consensus=_fake_llm_consensus(
            fair_yes=72,
            fair_no=28,
            evidence_status="Low",
        ),
    )

    assert result.decisions[0].decision == "SKIP"
    assert "evidence is below the configured minimum" in result.decisions[0].reason.lower()


@pytest.mark.anyio
async def test_auto_live_conflicting_evidence_blocks_trade(monkeypatch):
    result, _ = await _execute_auto_live(
        monkeypatch,
        llm_consensus=_fake_llm_consensus(
            fair_yes=72,
            fair_no=28,
            event_state="conflicting",
        ),
    )

    assert result.decisions[0].decision == "SKIP"
    assert "evidence is conflicting" in result.decisions[0].reason.lower()


@pytest.mark.anyio
async def test_auto_live_edge_below_minimum_blocks_trade(monkeypatch):
    result, _ = await _execute_auto_live(
        monkeypatch,
        settings=BullpenAutoLiveSettings(min_score=0),
        llm_consensus=_fake_llm_consensus(fair_yes=56, fair_no=44),
    )

    assert result.decisions[0].decision == "SKIP"
    assert "edge 2.00 is below the minimum 15.00." in result.decisions[0].reason.lower()


@pytest.mark.anyio
async def test_auto_live_score_below_minimum_blocks_trade(monkeypatch):
    result, _ = await _execute_auto_live(
        monkeypatch,
        settings=BullpenAutoLiveSettings(
            min_evidence_status="Low",
            min_confidence="Low",
        ),
        llm_consensus=_fake_llm_consensus(
            fair_yes=70,
            fair_no=30,
            confidence="Low",
            evidence_status="Moderate",
        ),
    )

    assert result.decisions[0].decision == "SKIP"
    assert "Score 7.04 is below the minimum 8.00." in result.decisions[0].reason


@pytest.mark.anyio
async def test_auto_live_deadline_too_close_blocks_new_trade(monkeypatch):
    result, _ = await _execute_auto_live(
        monkeypatch,
        rules=_fake_rules(hours_remaining=4, deadline_et="2026-06-21 04:00:00 PM ET"),
    )

    assert result.decisions[0].decision == "SKIP"
    assert "too close to the deadline" in result.decisions[0].reason.lower()


@pytest.mark.anyio
async def test_auto_live_market_exposure_cap_blocks_buy_new(monkeypatch):
    result, _ = await _execute_auto_live(
        monkeypatch,
        settings=BullpenAutoLiveSettings(
            bankroll_usd=100,
            max_single_trade_pct_bankroll=0.5,
            max_single_market_pct_bankroll=0.5,
        ),
    )

    assert result.decisions[0].decision == "SKIP"
    assert "order size is below the minimum order usd" in result.decisions[0].reason.lower()


@pytest.mark.anyio
async def test_auto_live_theme_exposure_cap_blocks_trade(monkeypatch):
    now = datetime(2026, 6, 21, 12, 0, tzinfo=UTC)
    result, _ = await _execute_auto_live(
        monkeypatch,
        positions=[
            PositionSnapshot(
                market_id="other-market",
                slug="other-market",
                market_title="Other market",
                market_url="https://example.com/other-market",
                theme="Politics",
                side="YES",
                exposure_usd=20,
                shares=40,
                average_price_cents=50,
                opened_at=now,
                updated_at=now,
            )
        ],
    )

    assert result.decisions[0].decision == "SKIP"
    assert "target exposure is zero after kelly and capacity caps" in result.decisions[0].reason.lower()


@pytest.mark.anyio
async def test_auto_live_open_exposure_cap_blocks_trade(monkeypatch):
    now = datetime(2026, 6, 21, 12, 0, tzinfo=UTC)
    result, _ = await _execute_auto_live(
        monkeypatch,
        positions=[
            PositionSnapshot(
                market_id="market-a",
                slug="market-a",
                market_title="Market A",
                market_url="https://example.com/market-a",
                theme="Theme A",
                side="YES",
                exposure_usd=60,
                shares=120,
                average_price_cents=50,
                opened_at=now,
                updated_at=now,
            )
        ],
    )

    assert result.decisions[0].decision == "SKIP"
    assert "target exposure is zero after kelly and capacity caps" in result.decisions[0].reason.lower()


@pytest.mark.anyio
async def test_auto_live_cash_reserve_breach_blocks_trade(monkeypatch):
    now = datetime(2026, 6, 21, 12, 0, tzinfo=UTC)
    result, _ = await _execute_auto_live(
        monkeypatch,
        positions=[
            PositionSnapshot(
                market_id="market-a",
                slug="market-a",
                market_title="Market A",
                market_url="https://example.com/market-a",
                theme="Theme A",
                side="YES",
                exposure_usd=60,
                shares=120,
                average_price_cents=50,
                opened_at=now,
                updated_at=now,
            )
        ],
    )

    assert result.decisions[0].decision == "SKIP"
    assert "target exposure is zero after kelly and capacity caps" in result.decisions[0].reason.lower()
    stage5 = next(
        stage for stage in result.decisions[0].stage_results if stage.stage_number == 5
    )
    assert stage5.outputs["remaining_cash_reserve_capacity"] == 0


@pytest.mark.anyio
async def test_auto_live_daily_loss_stop_blocks_execution(monkeypatch):
    result, executor_calls = await _execute_auto_live(
        monkeypatch,
        settings=BullpenAutoLiveSettings(
            auto_live_enabled=True,
            dry_run=False,
            allow_live_execution=True,
            require_manual_confirmation=False,
            max_daily_loss_pct_bankroll=3,
        ),
        historical_decisions=[
            _historical_decision(
                decision_id="loss-day",
                realized_pnl_usd=-5.0,
                executed_at="2026-06-21T11:00:00+00:00",
            )
        ],
        allow_execution_env=True,
    )

    assert result.run.status == "failed"
    assert result.state.paused is True
    assert result.state.live_execution_allowed is False
    assert result.decisions[0].order_plan is None
    assert executor_calls == []
    assert "daily loss stop is hit" in result.run.summary.lower()


@pytest.mark.anyio
async def test_auto_live_weekly_loss_stop_blocks_execution(monkeypatch):
    result, executor_calls = await _execute_auto_live(
        monkeypatch,
        settings=BullpenAutoLiveSettings(
            auto_live_enabled=True,
            dry_run=False,
            allow_live_execution=True,
            require_manual_confirmation=False,
            max_weekly_loss_pct_bankroll=8,
        ),
        historical_decisions=[
            _historical_decision(
                decision_id="loss-week",
                realized_pnl_usd=-9.0,
                executed_at="2026-06-18T12:00:00+00:00",
            )
        ],
        allow_execution_env=True,
    )

    assert result.run.status == "failed"
    assert result.state.paused is True
    assert result.decisions[0].order_plan is None
    assert executor_calls == []
    assert "weekly loss stop is hit" in result.run.summary.lower()


@pytest.mark.anyio
async def test_auto_live_emergency_stop_blocks_execution(monkeypatch):
    result, executor_calls = await _execute_auto_live(
        monkeypatch,
        settings=BullpenAutoLiveSettings(
            auto_live_enabled=True,
            dry_run=False,
            allow_live_execution=True,
            require_manual_confirmation=False,
            emergency_stop=True,
        ),
        allow_execution_env=True,
    )

    assert result.decisions[0].decision == "SKIP"
    assert result.state.live_execution_allowed is False
    assert executor_calls == []
    assert "emergency stop is active" in result.decisions[0].reason.lower()


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("pause_if_balance_unavailable", "expect_paused", "expect_order_plan"),
    [(True, True, False), (False, False, True)],
)
async def test_auto_live_balance_unavailable_blocks_or_pauses(
    monkeypatch,
    pause_if_balance_unavailable: bool,
    expect_paused: bool,
    expect_order_plan: bool,
):
    result, executor_calls = await _execute_auto_live(
        monkeypatch,
        settings=BullpenAutoLiveSettings(
            auto_live_enabled=True,
            dry_run=False,
            allow_live_execution=True,
            require_manual_confirmation=False,
            pause_if_balance_unavailable=pause_if_balance_unavailable,
        ),
        live_controls=_fake_live_controls(balance_status="unavailable", balance_message="Balance unavailable"),
        allow_execution_env=True,
    )

    assert result.run.status == "failed"
    assert result.state.paused is expect_paused
    assert result.state.balance_status == "fail"
    assert result.state.live_execution_allowed is False
    assert executor_calls == []
    if expect_order_plan:
        assert result.decisions[0].order_plan is not None
        assert "balance is not ready" in result.decisions[0].order_plan.detail.lower()
    else:
        assert result.decisions[0].order_plan is None


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("pause_if_doctor_fails", "expect_paused", "expect_order_plan"),
    [(True, True, False), (False, False, True)],
)
async def test_auto_live_doctor_failure_blocks_or_pauses(
    monkeypatch,
    pause_if_doctor_fails: bool,
    expect_paused: bool,
    expect_order_plan: bool,
):
    result, executor_calls = await _execute_auto_live(
        monkeypatch,
        settings=BullpenAutoLiveSettings(
            auto_live_enabled=True,
            dry_run=False,
            allow_live_execution=True,
            require_manual_confirmation=False,
            pause_if_doctor_fails=pause_if_doctor_fails,
        ),
        live_controls=_fake_live_controls(doctor_ok=False, doctor_message="Bullpen doctor failed"),
        allow_execution_env=True,
    )

    assert result.run.status == "failed"
    assert result.state.paused is expect_paused
    assert result.state.doctor_status == "fail"
    assert result.state.live_execution_allowed is False
    assert executor_calls == []
    if expect_order_plan:
        assert result.decisions[0].order_plan is not None
        assert "doctor failed" in result.decisions[0].order_plan.detail.lower()
    else:
        assert result.decisions[0].order_plan is None


@pytest.mark.anyio
async def test_auto_live_dry_run_creates_decisions_without_live_executor_calls(monkeypatch):
    result, executor_calls = await _execute_auto_live(
        monkeypatch,
        settings=BullpenAutoLiveSettings(
            auto_live_enabled=True,
            dry_run=True,
            allow_live_execution=False,
        ),
        allow_execution_env=True,
    )

    assert result.decisions[0].decision == "BUY_NEW"
    assert result.decisions[0].order_plan is not None
    assert result.decisions[0].order_plan.status == "skipped"
    assert executor_calls == []


@pytest.mark.anyio
async def test_auto_live_live_execution_uses_limit_order_executor_only_after_guardrails_pass(monkeypatch):
    result, executor_calls = await _execute_auto_live(
        monkeypatch,
        settings=BullpenAutoLiveSettings(
            auto_live_enabled=True,
            dry_run=False,
            allow_live_execution=True,
            require_manual_confirmation=False,
        ),
        allow_execution_env=True,
    )

    assert result.run.status == "completed"
    assert result.run.orders_submitted == 1
    assert result.decisions[0].order_plan is not None
    assert result.decisions[0].order_plan.status == "submitted"
    assert [call[0] for call in executor_calls] == ["buy_limit"]


@pytest.mark.anyio
async def test_auto_live_logs_submitted_and_skipped_decisions_with_reasons(monkeypatch):
    logged_messages: list[tuple[str, str]] = []

    def capture(level: str):
        def _log(message: str, *args, **kwargs):
            rendered = message % args if args else message
            logged_messages.append((level, rendered))

        return _log

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.logger",
        SimpleNamespace(
            info=capture("info"),
            warning=capture("warning"),
        ),
    )

    live_result, _ = await _execute_auto_live(
        monkeypatch,
        settings=BullpenAutoLiveSettings(
            auto_live_enabled=True,
            dry_run=False,
            allow_live_execution=True,
            require_manual_confirmation=False,
        ),
        allow_execution_env=True,
    )
    skipped_result, _ = await _execute_auto_live(
        monkeypatch,
        settings=BullpenAutoLiveSettings(
            max_llm_spread_pp=30,
            half_size_llm_spread_pp=15,
        ),
        llm_consensus=_fake_llm_consensus(
            fair_yes=55,
            fair_no=45,
            average_yes=48.69,
            median_yes=55,
            trimmed_mean_yes=52.14,
            min_yes=10,
            max_yes=90,
            spread_yes=80,
            disagreement_level="High",
            adjudication_required=True,
        ),
    )

    decision_logs = [
        (level, message)
        for level, message in logged_messages
        if "Auto-Live decision" in message
    ]

    assert live_result.decisions[0].order_plan is not None
    assert live_result.decisions[0].order_plan.status == "submitted"
    assert skipped_result.decisions[0].decision == "SKIP"
    assert any(
        level == "info"
        and "action=BUY_NEW" in message
        and "order_status=submitted" in message
        for level, message in decision_logs
    )
    assert any(
        level == "warning"
        and "action=SKIP" in message
        and "llm spread is above the configured maximum" in message.lower()
        for level, message in decision_logs
    )


def test_auto_live_domain_never_uses_bypass_trade_risk_flag():
    source = "\n".join(
        path.read_text()
        for path in Path("backend/app/domains/polymarket_auto_live").glob("*.py")
    )
    assert "bypass_trade_risk=True" not in source
