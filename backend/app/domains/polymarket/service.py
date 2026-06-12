from __future__ import annotations

import asyncio
from pathlib import Path

from app.domains.polymarket.bot import PolymarketPaperCopyBot
from app.domains.polymarket.bullpen import BullpenBalanceReader, BullpenLiveExecutor
from app.domains.polymarket.config import load_polymarket_config
from app.domains.polymarket.logger import PolymarketFileLogger
from app.domains.polymarket.providers import BullpenReadOnlyProvider, MockProvider
from app.domains.polymarket.schemas import (
    PolymarketLiveTradeDecision,
    PolymarketPaperTrade,
    PolymarketTrackedAccount,
)
from app.domains.polymarket.storage import JsonModelStore


class PolymarketBotManager:
    def __init__(self) -> None:
        self._bots: dict[int, PolymarketPaperCopyBot] = {}
        self._lock = asyncio.Lock()

    async def get_bot(self, user_id: int) -> PolymarketPaperCopyBot:
        async with self._lock:
            existing = self._bots.get(user_id)
            if existing:
                return existing

            base_config = load_polymarket_config()
            user_data_dir = Path(base_config.data_dir) / f"user-{user_id}"
            user_config = base_config.model_copy(
                update={"data_dir": str(user_data_dir)}
            )
            mock_provider = MockProvider()
            read_provider = (
                BullpenReadOnlyProvider(user_config)
                if user_config.use_live_reads
                else mock_provider
            )
            bot = PolymarketPaperCopyBot(
                config=user_config,
                provider=read_provider,
                fallback_provider=mock_provider,
                store=JsonModelStore(
                    user_data_dir / "polymarket-trades.json", PolymarketPaperTrade
                ),
                live_store=JsonModelStore(
                    user_data_dir / "polymarket-live-trades.json",
                    PolymarketLiveTradeDecision,
                ),
                tracked_account_store=JsonModelStore(
                    user_data_dir / "polymarket-tracked-accounts.json",
                    PolymarketTrackedAccount,
                ),
                live_executor=BullpenLiveExecutor(),
                balance_reader=BullpenBalanceReader(),
                logger=PolymarketFileLogger(
                    user_data_dir / "polymarket-bot.log",
                    user_data_dir / "polymarket-errors.log",
                ),
            )
            await bot.init()
            self._bots[user_id] = bot
            return bot

    async def shutdown(self) -> None:
        async with self._lock:
            bots = list(self._bots.values())
            self._bots.clear()
        for bot in bots:
            await bot.shutdown()


polymarket_bot_manager = PolymarketBotManager()
