import asyncio
import os
import time

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
