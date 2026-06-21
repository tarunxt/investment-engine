import os
from datetime import UTC, datetime
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
from app.domains.polymarket_auto_live.rules import evaluate_market_rules
from app.domains.polymarket_auto_live.scanner import (
    ScannedMarket,
    _evaluate_filter_reasons,
)
from app.domains.polymarket_auto_live.schemas import (
    BullpenAutoLiveBotCardSummary,
    BullpenAutoLiveLlmOutput,
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
    provider_error_rate: float = 0,
):
    outputs = [
        BullpenAutoLiveLlmOutput(
            provider="openai",
            model="gpt-4o-mini",
            llm_yes_odds=fair_yes,
            llm_no_odds=fair_no,
            confidence="High",
            evidence_status="Strong",
            event_state="scheduled_not_occurred",
            key_evidence=["Confirmed evidence"],
            red_flags=[],
            rationale="Strong enough to test Auto-Live execution wiring.",
            completed_at="2026-06-21T10:00:00+00:00",
        )
    ]
    consensus = SimpleNamespace(
        fair_yes_probability_pct=fair_yes,
        fair_no_probability_pct=fair_no,
        average_yes=fair_yes,
        median_yes=fair_yes,
        trimmed_mean_yes=fair_yes,
        min_yes=fair_yes,
        max_yes=fair_yes,
        spread_yes=0,
        disagreement_level="Low",
        adjudication_required=False,
        confidence="High",
        evidence_status="Strong",
        event_state="scheduled_not_occurred",
        provider_error_rate=provider_error_rate,
    )
    return outputs, consensus


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
