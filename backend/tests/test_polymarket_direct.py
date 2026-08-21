import asyncio
from pathlib import Path

import pytest

from app.domains.polymarket_direct.bot import PolymarketPaperCopyBot
from app.domains.polymarket_direct.config import load_polymarket_config
from app.domains.polymarket_direct.direct_polymarket import (
    DIRECT_EXECUTION_NOT_CONFIGURED,
    DirectPolymarketCommandError,
    DirectPolymarketBalanceReader,
    DirectPolymarketLiveExecutor,
    DirectPolymarketRedeemedTradesReader,
)
from app.domains.polymarket_direct.logger import PolymarketFileLogger
from app.domains.polymarket_direct.schemas import (
    PolymarketLiveTradeDecision,
    PolymarketPaperTrade,
)
from app.domains.polymarket_direct.service import PolymarketDirectBotManager
from app.domains.polymarket_direct.storage import JsonModelStore


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


def test_direct_config_defaults_require_explicit_live_opt_in(monkeypatch, tmp_path):
    monkeypatch.setenv("POLYMARKET_DIRECT_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("POLYMARKET_DIRECT_LIVE_TRADING", raising=False)
    monkeypatch.delenv("POLYMARKET_DIRECT_AUTO_START", raising=False)

    config = load_polymarket_config()

    assert config.live_trading is False
    assert config.auto_start is False


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


def _set_direct_env(monkeypatch):
    monkeypatch.setenv("POLYMARKET_DIRECT_CLOB_HOST", "https://clob.polymarket.com")
    monkeypatch.setenv("POLYMARKET_DIRECT_CLOB_API_KEY", "api-key")
    monkeypatch.setenv("POLYMARKET_DIRECT_CLOB_SECRET", "api-secret")
    monkeypatch.setenv("POLYMARKET_DIRECT_CLOB_PASSPHRASE", "passphrase")
    monkeypatch.setenv("POLYMARKET_DIRECT_PRIVATE_KEY", "0x" + "1" * 64)
    monkeypatch.setenv("POLYMARKET_DIRECT_SIGNATURE_TYPE", "1")
    monkeypatch.setenv("POLYMARKET_DIRECT_FUNDER_ADDRESS", "0x" + "2" * 40)
    monkeypatch.setenv("POLYMARKET_DIRECT_POLYGON_RPC_URL", "https://polygon.example")
    monkeypatch.setenv("POLYMARKET_DIRECT_LIVE_TRADING", "true")
    monkeypatch.setenv("POLYMARKET_DIRECT_FIXED_COPY_TRADE_SIZE", "1")
    monkeypatch.setenv("POLYMARKET_DIRECT_MAX_LIVE_TRADE_SIZE", "1")
    monkeypatch.setenv("POLYMARKET_DIRECT_MAX_LIVE_TRADES_PER_DAY", "5")
    monkeypatch.setenv("POLYMARKET_DIRECT_MAX_LIVE_DAILY_LOSS", "10")
    monkeypatch.setenv("POLYMARKET_DIRECT_MAX_LIVE_EXPOSURE_PER_MARKET", "5")


class DirectSlowProvider:
    async def get_top_traders(self):
        await asyncio.sleep(30)
        return []

    async def get_recent_trades(self, traders):
        return []


class DirectNeverCallDoctorExecutor:
    async def doctor(self):
        raise AssertionError(
            "doctor should not run when POLYMARKET_DIRECT_LIVE_TRADING=false"
        )


@pytest.mark.anyio
async def test_direct_start_skips_live_doctor_when_live_trading_is_disabled(tmp_path):
    config = load_polymarket_config().model_copy(
        update={
            "paper_trading": False,
            "live_trading": False,
            "use_live_reads": True,
            "poll_interval_ms": 1000,
            "data_dir": str(tmp_path),
        }
    )
    provider = DirectSlowProvider()
    logger = PolymarketFileLogger(tmp_path / "bot.log", tmp_path / "errors.log")
    await logger.init()
    bot = PolymarketPaperCopyBot(
        config=config,
        provider=provider,
        fallback_provider=provider,
        store=JsonModelStore(tmp_path / "paper.json", PolymarketPaperTrade),
        live_store=JsonModelStore(tmp_path / "live.json", PolymarketLiveTradeDecision),
        live_executor=DirectNeverCallDoctorExecutor(),
        balance_reader=DirectPolymarketBalanceReader(),
        redeemed_trades_reader=DirectPolymarketRedeemedTradesReader(),
        logger=logger,
    )

    await bot.start()
    state = await bot.get_state()

    assert bot.active_mode == "live-read"
    assert state.live.enabled_by_env is False

    await bot.shutdown()


@pytest.mark.anyio
async def test_direct_pause_and_stop_persist_for_recreated_user_bot(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("POLYMARKET_DIRECT_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("POLYMARKET_DIRECT_AUTO_START", "false")
    monkeypatch.setenv("POLYMARKET_DIRECT_LIVE_TRADING", "false")
    monkeypatch.setenv("POLYMARKET_DIRECT_USE_LIVE_READS", "false")
    monkeypatch.setenv("POLYMARKET_DIRECT_PAPER_TRADING", "true")

    manager = PolymarketDirectBotManager()
    bot = await manager.get_bot(42)
    await bot.start()
    await bot.pause()
    await bot.stop()
    await manager.shutdown()

    recreated_manager = PolymarketDirectBotManager()
    recreated_bot = await recreated_manager.get_bot(42)

    assert recreated_bot.config.auto_start is False
    assert recreated_bot.config.paused is True

    await recreated_manager.shutdown()


@pytest.mark.parametrize(
    "name",
    [
        "POLYMARKET_DIRECT_CLOB_HOST",
        "POLYMARKET_DIRECT_CLOB_API_KEY",
        "POLYMARKET_DIRECT_CLOB_SECRET",
        "POLYMARKET_DIRECT_CLOB_PASSPHRASE",
        "POLYMARKET_DIRECT_PRIVATE_KEY",
        "POLYMARKET_DIRECT_SIGNATURE_TYPE",
        "POLYMARKET_DIRECT_FUNDER_ADDRESS",
        "POLYMARKET_DIRECT_POLYGON_RPC_URL",
    ],
)
def test_direct_doctor_reports_each_missing_env(monkeypatch, name):
    from app.domains.polymarket_direct import direct_polymarket as module

    _set_direct_env(monkeypatch)
    monkeypatch.delenv(name, raising=False)
    if name == "POLYMARKET_DIRECT_POLYGON_RPC_URL":
        monkeypatch.delenv("POLYMARKET_POLYGON_RPC_URLS", raising=False)

    async def scenario():
        doctor = await module.DirectPolymarketLiveExecutor().doctor()
        assert doctor.ok is False
        assert "Missing:" in doctor.message
        assert name in doctor.message or "POLYMARKET_POLYGON_RPC_URLS" in doctor.message

    asyncio.run(scenario())


def test_direct_doctor_passes_with_mocked_clob_and_rpc(monkeypatch):
    from app.domains.polymarket_direct import direct_polymarket as module

    class FakeClient:
        def get_ok(self):
            return {"ok": True}

    _set_direct_env(monkeypatch)
    monkeypatch.setattr(module, "_build_clob_client", lambda settings: FakeClient())
    monkeypatch.setattr(module, "_rpc_call", lambda settings, method, params: "0x1")

    async def scenario():
        doctor = await module.DirectPolymarketLiveExecutor().doctor()
        assert doctor.ok is True
        assert "0x" + "2" * 40 in doctor.message

    asyncio.run(scenario())


def test_direct_balance_reader_returns_mocked_usdc_balance(monkeypatch):
    from app.domains.polymarket_direct import direct_polymarket as module

    _set_direct_env(monkeypatch)
    monkeypatch.setattr(module, "_read_usdc_balance", lambda settings: 12.34)

    async def scenario():
        balance = await module.DirectPolymarketBalanceReader().refresh()
        assert balance.status == "ready"
        assert balance.available_balance_usd == 12.34
        assert balance.account_value_usd == 12.34

    asyncio.run(scenario())


def test_direct_execute_places_mocked_order_after_guard_and_doctor(monkeypatch):
    from app.domains.polymarket_direct import direct_polymarket as module
    from app.domains.polymarket_direct.schemas import (
        PolymarketDoctorStatus,
        PolymarketLiveTradeDecision,
    )

    _set_direct_env(monkeypatch)
    placed = {}

    async def fake_doctor(self):
        return PolymarketDoctorStatus(
            checked_at=module.utc_now(), ok=True, message="ok"
        )

    def fake_place(settings, decision):
        placed["side"] = decision.side
        return "Polymarket CLOB order placed order_id=abc."

    monkeypatch.setattr(module.DirectPolymarketLiveExecutor, "doctor", fake_doctor)
    monkeypatch.setattr(module, "_place_order", fake_place)

    decision = PolymarketLiveTradeDecision(
        id="live-1",
        source_trade_id="source-1",
        source_trade_key="source-key-1",
        proposed_at="2026-06-14T00:00:00+00:00",
        updated_at="2026-06-14T00:00:00+00:00",
        trader_id="trader-1",
        trader_name="Trader 1",
        trader_address="0x" + "3" * 40,
        market_id="123456789012345678901",
        market_title="Market 1",
        outcome="Yes",
        side="BUY",
        amount=1,
        price=0.5,
        shares=2,
        max_loss=1,
        reason="test",
        status="confirmed",
        source="live-read",
    )

    async def scenario():
        result = await module.DirectPolymarketLiveExecutor().execute(decision)
        assert result == "Polymarket CLOB order placed order_id=abc."
        assert placed == {"side": "BUY"}

    asyncio.run(scenario())
