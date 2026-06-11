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
