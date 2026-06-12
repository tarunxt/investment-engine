import asyncio
import os
import time
from datetime import datetime

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://test:test@localhost:5432/testdb",
)
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

import pytest

from app.domains.polymarket.bot import PolymarketPaperCopyBot
from app.domains.polymarket.bullpen import BullpenBalanceReader, BullpenLiveExecutor
from app.domains.polymarket.config import load_polymarket_config
from app.domains.polymarket.logger import PolymarketFileLogger
from app.domains.polymarket.schemas import (
    PolymarketLiveTradeDecision,
    PolymarketPaperTrade,
)
from app.domains.polymarket.storage import JsonModelStore


class SlowProvider:
    async def get_top_traders(self):
        await asyncio.sleep(30)
        return []

    async def get_recent_trades(self, traders):
        return []


@pytest.mark.anyio
async def test_start_returns_before_initial_poll_finishes(tmp_path):
    config = load_polymarket_config().model_copy(
        update={
            "paper_trading": True,
            "live_trading": False,
            "use_live_reads": False,
            "poll_interval_ms": 1000,
            "data_dir": str(tmp_path),
        }
    )
    provider = SlowProvider()
    logger = PolymarketFileLogger(tmp_path / "bot.log", tmp_path / "errors.log")
    await logger.init()
    bot = PolymarketPaperCopyBot(
        config=config,
        provider=provider,
        fallback_provider=provider,
        store=JsonModelStore(tmp_path / "paper.json", PolymarketPaperTrade),
        live_store=JsonModelStore(tmp_path / "live.json", PolymarketLiveTradeDecision),
        live_executor=BullpenLiveExecutor(),
        balance_reader=BullpenBalanceReader(),
        logger=logger,
    )

    started_at = time.perf_counter()
    await bot.start()
    elapsed = time.perf_counter() - started_at

    assert elapsed < 0.5
    assert bot.running is True
    assert bot._poll_task is not None

    bot._poll_task.cancel()
    await asyncio.gather(bot._poll_task, return_exceptions=True)


class SlowDoctorExecutor:
    async def doctor(self):
        await asyncio.sleep(30)
        raise AssertionError("doctor must run in the background after init returns")


class SlowBalanceReader:
    async def refresh(self):
        await asyncio.sleep(30)
        raise AssertionError("balance must run in the background after init returns")


@pytest.mark.anyio
async def test_init_returns_before_startup_warmup_finishes(tmp_path):
    config = load_polymarket_config().model_copy(
        update={
            "paper_trading": True,
            "live_trading": False,
            "use_live_reads": False,
            "poll_interval_ms": 1000,
            "data_dir": str(tmp_path),
        }
    )
    provider = SlowProvider()
    logger = PolymarketFileLogger(tmp_path / "bot.log", tmp_path / "errors.log")
    await logger.init()
    bot = PolymarketPaperCopyBot(
        config=config,
        provider=provider,
        fallback_provider=provider,
        store=JsonModelStore(tmp_path / "paper.json", PolymarketPaperTrade),
        live_store=JsonModelStore(tmp_path / "live.json", PolymarketLiveTradeDecision),
        live_executor=SlowDoctorExecutor(),
        balance_reader=SlowBalanceReader(),
        logger=logger,
    )

    started_at = time.perf_counter()
    await bot.init()
    elapsed = time.perf_counter() - started_at

    assert elapsed < 0.5
    assert bot._startup_warmup_task is not None
    assert bot._balance_task is not None

    await bot.shutdown()


class EmptyProvider:
    async def get_top_traders(self):
        return []

    async def get_recent_trades(self, traders):
        return []


class StaticDoctorExecutor:
    def __init__(self, statuses):
        self.statuses = list(statuses)
        self.calls = 0

    async def doctor(self):
        self.calls += 1
        return self.statuses.pop(0)


class IdleBalanceReader:
    async def refresh(self):
        raise AssertionError("balance refresh is not part of bot startup")


async def build_live_bot(tmp_path, live_executor):
    config = load_polymarket_config().model_copy(
        update={
            "paper_trading": False,
            "live_trading": True,
            "use_live_reads": True,
            "live_unlock_mode": "automatic",
            "poll_interval_ms": 1000,
            "data_dir": str(tmp_path),
        }
    )
    provider = EmptyProvider()
    logger = PolymarketFileLogger(tmp_path / "bot.log", tmp_path / "errors.log")
    await logger.init()
    return PolymarketPaperCopyBot(
        config=config,
        provider=provider,
        fallback_provider=provider,
        store=JsonModelStore(tmp_path / "paper.json", PolymarketPaperTrade),
        live_store=JsonModelStore(tmp_path / "live.json", PolymarketLiveTradeDecision),
        live_executor=live_executor,
        balance_reader=IdleBalanceReader(),
        logger=logger,
    )


@pytest.mark.anyio
async def test_live_start_refreshes_doctor_even_when_recent_failure_exists(tmp_path):
    from app.domains.polymarket.schemas import PolymarketDoctorStatus

    executor = StaticDoctorExecutor(
        [
            PolymarketDoctorStatus(
                checked_at="2026-06-11T10:00:00+00:00",
                ok=True,
                message="Bullpen status, preflight, and approval checks passed.",
            )
        ]
    )
    bot = await build_live_bot(tmp_path, executor)
    bot.doctor_status = PolymarketDoctorStatus(
        checked_at="2026-06-11T09:59:00+00:00",
        ok=False,
        message="Previous Bullpen doctor failure.",
    )

    await bot.start()

    assert executor.calls == 1
    assert bot.running is True
    assert bot.live_unlocked is True
    assert bot.active_mode == "live-trading"

    bot._poll_task.cancel()
    await asyncio.gather(bot._poll_task, return_exceptions=True)


@pytest.mark.anyio
async def test_live_start_error_includes_latest_doctor_result(tmp_path):
    from app.domains.polymarket.schemas import PolymarketDoctorStatus

    executor = StaticDoctorExecutor(
        [
            PolymarketDoctorStatus(
                checked_at="2026-06-11T10:00:00+00:00",
                ok=False,
                message="Bullpen doctor failed after status passed: preflight: login required",
            )
        ]
    )
    bot = await build_live_bot(tmp_path, executor)

    with pytest.raises(RuntimeError) as exc_info:
        await bot.start()

    assert executor.calls == 1
    assert bot.running is False
    assert "Live mode locked: Bullpen doctor must pass." in str(exc_info.value)
    assert "Last doctor result: Bullpen doctor failed after status passed" in str(
        exc_info.value
    )


class ActivityProvider:
    async def get_top_traders(self):
        from app.domains.polymarket.schemas import PolymarketTrader

        return [
            PolymarketTrader(
                id="0x204f72f35326db932158CBA6AdF0B9A1DA95e14",
                name="swisstony",
                address="0x204f72f35326db932158CBA6AdF0B9A1DA95e14",
                activity_source="fallback",
                volume_24h=883_184_386.32,
                trades_1h=0,
                trades_6h=0,
                trades_24h=0,
                source_reason="Fallback tracked wallet; no recent trade detected yet",
                source="live-read",
            )
        ]

    async def get_recent_trades(self, traders):
        from app.domains.polymarket.schemas import PolymarketSourceTrade

        return [
            PolymarketSourceTrade(
                id="trade-1",
                source_trade_key="live-read:swisstony:trade-1",
                trader_id=traders[0].id,
                trader_name="swisstony",
                trader_address=traders[0].address,
                clean_trader_identity=traders[0].address,
                market_id="tennis-match",
                market_title="Tennis Match",
                outcome="Player A",
                side="BUY",
                price=0.63,
                size_usd=399.23,
                timestamp="2026-06-12T10:00:00+00:00",
                source="live-read",
            )
        ]


@pytest.mark.anyio
async def test_poll_refreshes_tracked_trader_activity_columns(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "app.domains.polymarket.providers.datetime",
        type(
            "FixedDateTime",
            (datetime,),
            {
                "now": classmethod(
                    lambda cls, tz=None: datetime(2026, 6, 12, 10, 5, tzinfo=tz)
                )
            },
        ),
    )
    config = load_polymarket_config().model_copy(
        update={
            "paper_trading": True,
            "live_trading": False,
            "use_live_reads": True,
            "poll_interval_ms": 1000,
            "data_dir": str(tmp_path),
        }
    )
    provider = ActivityProvider()
    logger = PolymarketFileLogger(tmp_path / "bot.log", tmp_path / "errors.log")
    await logger.init()
    bot = PolymarketPaperCopyBot(
        config=config,
        provider=provider,
        fallback_provider=provider,
        store=JsonModelStore(tmp_path / "paper.json", PolymarketPaperTrade),
        live_store=JsonModelStore(tmp_path / "live.json", PolymarketLiveTradeDecision),
        live_executor=BullpenLiveExecutor(),
        balance_reader=BullpenBalanceReader(),
        logger=logger,
    )
    bot.running = True

    await bot._poll_unlocked()

    trader = bot.tracked_traders[0]
    assert trader.trades_1h == 1
    assert trader.trades_6h == 1
    assert trader.trades_24h == 1
    assert trader.last_trade_at == "2026-06-12T10:00:00+00:00"
    assert trader.last_trade_age == "5m ago"
    assert trader.source_reason == "Recent trade activity detected from tracked wallet"


@pytest.mark.anyio
async def test_live_read_provider_reads_fallback_wallet_activity(monkeypatch):
    from app.domains.polymarket.providers import BullpenReadOnlyProvider
    from app.domains.polymarket.schemas import PolymarketTrader

    config = load_polymarket_config().model_copy(update={"manual_tracked_wallets": ""})
    provider = BullpenReadOnlyProvider(config)
    calls = []

    async def fake_wallet_activity(address):
        calls.append(address)
        return [
            {
                "id": "wallet-trade-1",
                "address": address,
                "market_id": "tennis-match",
                "market_title": "Tennis Match",
                "outcome": "Player A",
                "side": "BUY",
                "price": 0.63,
                "size_usd": 399.23,
                "timestamp": "2026-06-12T10:00:00+00:00",
            }
        ]

    monkeypatch.setattr(provider, "_read_wallet_activity", fake_wallet_activity)
    trades = await provider.get_recent_trades(
        [
            PolymarketTrader(
                id="0x2005D16a84CEEfa912D4e380cD32E7ff827875Ea",
                name="RN1",
                address="0x2005D16a84CEEfa912D4e380cD32E7ff827875Ea",
                activity_source="fallback",
                source_reason="Fallback tracked wallet; no recent trade detected yet",
                source="live-read",
            )
        ]
    )

    assert calls == ["0x2005D16a84CEEfa912D4e380cD32E7ff827875Ea"]
    assert len(trades) == 1
    assert trades[0].trader_name == "RN1"
    assert trades[0].trader_address == "0x2005D16a84CEEfa912D4e380cD32E7ff827875Ea"
