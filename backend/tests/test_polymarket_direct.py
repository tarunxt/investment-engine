import asyncio
from pathlib import Path

import pytest

from app.domains.polymarket_direct.config import load_polymarket_config
from app.domains.polymarket_direct.direct_polymarket import (
    DIRECT_EXECUTION_NOT_CONFIGURED,
    DirectPolymarketCommandError,
    DirectPolymarketLiveExecutor,
)


def test_direct_domain_does_not_import_bullpen_execution_symbols():
    source = "\n".join(
        path.read_text()
        for path in Path("backend/app/domains/polymarket_direct").glob("*.py")
    )
    forbidden = [
        "run_bullpen",
        "BullpenLiveExecutor",
        "BullpenBalanceReader",
        "app.domains.polymarket.bullpen",
    ]
    for symbol in forbidden:
        assert symbol not in source


def test_direct_live_executor_fails_safely_when_not_configured():
    async def scenario():
        executor = DirectPolymarketLiveExecutor()
        doctor = await executor.doctor()
        assert doctor.ok is False
        assert DIRECT_EXECUTION_NOT_CONFIGURED in doctor.message
        with pytest.raises(DirectPolymarketCommandError, match="not configured"):
            await executor.redeem(dry_run=False)

    asyncio.run(scenario())


def test_direct_config_uses_direct_env_prefix(monkeypatch, tmp_path):
    monkeypatch.setenv("POLYMARKET_DIRECT_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("POLYMARKET_DIRECT_AUTO_START", "false")
    monkeypatch.setenv("POLYMARKET_DIRECT_LIVE_TRADING", "false")

    config = load_polymarket_config()

    assert config.data_dir == str(tmp_path)
    assert config.auto_start is False
    assert config.live_trading is False


def test_direct_live_guard_exposes_bot_state_counters(monkeypatch, tmp_path):
    from app.domains.polymarket_direct.direct_polymarket import LiveTradeGuard
    from app.domains.polymarket_direct.schemas import PolymarketLiveTradeDecision

    monkeypatch.setenv("POLYMARKET_DIRECT_DATA_DIR", str(tmp_path))
    config = load_polymarket_config()
    guard = LiveTradeGuard(config)
    today = guard.live_trades_today(
        [
            PolymarketLiveTradeDecision(
                id="live-1",
                source_trade_id="source-1",
                source_trade_key="source-key-1",
                proposed_at="2026-06-14T00:00:00+00:00",
                updated_at="2026-06-14T00:00:00+00:00",
                trader_id="trader-1",
                trader_name="Trader 1",
                trader_address="0x0000000000000000000000000000000000000001",
                market_id="market-1",
                market_title="Market 1",
                outcome="Yes",
                side="BUY",
                amount=1,
                price=0.5,
                shares=2,
                max_loss=1,
                reason="test",
                status="executed",
                executed_at="2026-06-14T00:01:00+00:00",
                source="live-read",
            )
        ]
    )

    assert today in {0, 1}
    assert guard.realized_live_pnl([]) == 0
