"""Overview reads cannot initialize operational managers or legacy summaries."""
from types import SimpleNamespace

import pytest

from app.domains.polymarket.passive_projection import PassiveProjectionUnavailable
from app.domains.polymarket_direct.service import polymarket_direct_bot_manager
from app.domains.polymarket_auto_live.schemas import (
    BullpenAutoLiveBotCardSummary, BullpenAutoLiveSettings,
    BullpenAutoLiveState, BullpenAutoLiveSummary,
)
from app.domains.trading_bots import service


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
@pytest.mark.parametrize("copy_available", [True, False])
async def test_summary_and_overview_read_only_passive_projections(monkeypatch, copy_available):
    calls = []
    forbidden_calls = []

    async def forbidden(*args, **kwargs):
        forbidden_calls.append((args, kwargs))
        raise AssertionError("An overview must not initialize or operate a bot")

    async def read_state(user_id):
        calls.append(("copy-passive", user_id))
        if not copy_available:
            raise PassiveProjectionUnavailable("Saved evidence exceeds the read limit.")
        return SimpleNamespace(read_source="persisted", read_message="Runtime is unknown.")

    expected = BullpenAutoLiveSummary(
        state=BullpenAutoLiveState(last_action="Stored state"),
        settings=BullpenAutoLiveSettings(),
        bot_card=BullpenAutoLiveBotCardSummary(
            status="paused", mode="live-trading", invested_usd=12,
            current_value_usd=13, pnl_usd=1, active_positions=2,
            guardrails_summary="Saved guardrails", strategy_summary="Saved strategy",
            risk_summary="Saved risk", last_run_at="2026-01-01T00:00:00+00:00",
        ),
    )

    async def dashboard():
        calls.append(("auto-passive", 19))
        return expected

    async def auto_bot(user_id):
        assert user_id == 19
        # The real Auto-Live constructor is inert; its legacy summary is not.
        return SimpleNamespace(get_dashboard_summary=dashboard, get_summary=forbidden)

    monkeypatch.setattr(service.polymarket_bot_manager, "get_bot", forbidden)
    monkeypatch.setattr(service.polymarket_bot_manager, "read_state", read_state)
    monkeypatch.setattr(polymarket_direct_bot_manager, "get_bot", forbidden)
    monkeypatch.setattr(service.polymarket_auto_live_bot_manager, "get_bot", auto_bot)
    summary = await service.build_trading_bots_summary(19)
    overview = await service.build_trading_bots_overview(19)
    assert not forbidden_calls
    assert calls == [("copy-passive", 19), ("auto-passive", 19)] * 2
    assert [card.id for card in summary.cards] == [
        "bullpen-x-polymarket", "polymarket-direct", "bullpen-x-ai", "bullpen-ai-auto-live",
    ]
    for card in summary.cards[:2]:
        assert (card.status, card.mode) == ("unavailable", "unknown")
        assert card.note
        for field in ("invested_usd", "current_value_usd", "pnl_usd", "return_pct",
                      "active_positions", "trades_today", "last_run_at", "next_run_at"):
            assert getattr(card, field) is None
        assert card.guardrails == []
    assert summary.cards[2].status == "unavailable"
    assert summary.cards[3].status == "paused"
    assert summary.cards[3].invested_usd == 12
    assert summary.cards[3].current_value_usd == 13
    assert summary.cards[3].last_run_at == "2026-01-01T00:00:00+00:00"
    assert overview.bots[1].status == "unavailable"
    assert overview.bots[1].money_invested is None
    assert overview.bots[3].active_positions_count == 2


@pytest.mark.anyio
async def test_failed_passive_auto_live_projection_cannot_assert_dry_run(monkeypatch):
    async def unavailable(*args, **kwargs):
        raise PassiveProjectionUnavailable("Saved state unavailable")

    async def auto_bot(user_id):
        return SimpleNamespace(get_dashboard_summary=unavailable)

    monkeypatch.setattr(service.polymarket_bot_manager, "read_state", unavailable)
    monkeypatch.setattr(service.polymarket_auto_live_bot_manager, "get_bot", auto_bot)
    result = await service.build_trading_bots_summary(19)
    assert result.cards[3].status == "unavailable"
    assert result.cards[3].mode == "unknown"
    assert result.cards[3].invested_usd is None
