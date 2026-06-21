import os
from types import SimpleNamespace

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://test:test@localhost:5432/testdb",
)
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

import pytest
from pydantic import ValidationError

from app.domains.polymarket_auto_live.bot import BullpenAutoLiveBot
from app.domains.polymarket_auto_live.schemas import (
    BullpenAutoLiveBotCardSummary,
    BullpenAutoLiveDecision,
    BullpenAutoLiveRun,
    BullpenAutoLiveSettings,
    BullpenAutoLiveSettingsUpdate,
    BullpenAutoLiveState,
    BullpenAutoLiveSummary,
)
from app.domains.polymarket_auto_live.storage import JsonModelStore, JsonObjectStore
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


@pytest.mark.anyio
async def test_auto_live_bot_persists_settings_runs_and_state(tmp_path):
    settings_store = JsonObjectStore(
        tmp_path / "polymarket-auto-live-settings.json",
        BullpenAutoLiveSettings,
    )
    state_store = JsonObjectStore(
        tmp_path / "polymarket-auto-live-state.json",
        BullpenAutoLiveState,
    )
    run_store = JsonModelStore(
        tmp_path / "polymarket-auto-live-runs.json",
        BullpenAutoLiveRun,
    )
    decision_store = JsonModelStore(
        tmp_path / "polymarket-auto-live-decisions.json",
        BullpenAutoLiveDecision,
    )

    bot = BullpenAutoLiveBot(
        settings_store=settings_store,
        state_store=state_store,
        run_store=run_store,
        decision_store=decision_store,
    )
    await bot.init()

    initial_state = await bot.get_state()
    assert initial_state.status == "not-configured"
    assert initial_state.running is False

    updated = await bot.update_settings(
        BullpenAutoLiveSettingsUpdate(
            bankroll_usd=250,
            auto_live_enabled=True,
            dry_run=True,
        )
    )
    assert updated.bankroll_usd == 250
    assert updated.auto_live_enabled is True

    started = await bot.start()
    assert started.running is True
    assert started.next_run_at is not None

    run = await bot.run_once()
    assert run.status == "completed"
    assert run.decisions_count == 1

    decisions = await bot.list_decisions()
    assert len(decisions) == 1
    assert decisions[0].run_id == run.id

    emergency = await bot.emergency_stop()
    assert emergency.paused is True
    assert emergency.status == "paused"

    await bot.shutdown()

    reloaded_bot = BullpenAutoLiveBot(
        settings_store=settings_store,
        state_store=state_store,
        run_store=run_store,
        decision_store=decision_store,
    )
    await reloaded_bot.init()

    reloaded_settings = await reloaded_bot.get_settings()
    reloaded_state = await reloaded_bot.get_state()
    reloaded_runs = await reloaded_bot.list_runs()

    assert reloaded_settings.bankroll_usd == 250
    assert reloaded_settings.emergency_stop is True
    assert reloaded_state.running is False
    assert reloaded_state.paused is True
    assert reloaded_runs[0].id == run.id

    await reloaded_bot.shutdown()


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
            guardrails_summary="Max single trade: 2.00% • Cash reserve: 40.00%",
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
