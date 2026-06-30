from __future__ import annotations

import asyncio
from dataclasses import dataclass
from pathlib import Path

from app.domains.polymarket.bot import PolymarketPaperCopyBot
from app.domains.polymarket.bullpen import (
    BullpenBalanceReader,
    BullpenLiveExecutor,
    BullpenRedeemedTradesReader,
)
from app.domains.polymarket.config import load_polymarket_config
from app.domains.polymarket.logger import PolymarketFileLogger, redact_secrets
from app.domains.polymarket.providers import BullpenReadOnlyProvider, MockProvider
from app.domains.polymarket.schemas import (
    PolymarketLiveTradeDecision,
    PolymarketPaperTrade,
    PolymarketTrackedAccount,
    PolymarketUserConfigOverride,
)
from app.domains.polymarket.storage import JsonModelStore, JsonObjectStore


@dataclass
class _LoopBoundBot:
    bot: PolymarketPaperCopyBot
    loop: asyncio.AbstractEventLoop


class PolymarketBotManager:
    def __init__(self) -> None:
        self._bots: dict[int, _LoopBoundBot] = {}
        self._lock: asyncio.Lock | None = None
        self._lock_loop: asyncio.AbstractEventLoop | None = None

    def _lock_for_current_loop(self) -> asyncio.Lock:
        loop = asyncio.get_running_loop()
        # Celery's asyncio.run creates a fresh event loop per task, so cached
        # bot instances must stay scoped to the loop that created their locks/tasks.
        if self._lock is None or self._lock_loop is not loop:
            self._lock = asyncio.Lock()
            self._lock_loop = loop
        return self._lock

    async def get_bot(self, user_id: int) -> PolymarketPaperCopyBot:
        loop = asyncio.get_running_loop()
        async with self._lock_for_current_loop():
            existing = self._bots.get(user_id)
            if existing and existing.loop is loop:
                return existing.bot
            if existing and existing.loop is not loop:
                self._bots.pop(user_id, None)

            base_config = load_polymarket_config()
            user_data_dir = Path(base_config.data_dir) / f"user-{user_id}"
            config_store = JsonObjectStore(
                user_data_dir / "polymarket-config.json",
                PolymarketUserConfigOverride,
            )
            persisted_config = await config_store.load()
            config_update = {"data_dir": str(user_data_dir)}
            if persisted_config:
                config_update.update(persisted_config.model_dump(exclude_none=True))
            user_config = base_config.model_copy(update=config_update)
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
                config_store=config_store,
                live_executor=BullpenLiveExecutor(),
                balance_reader=BullpenBalanceReader(),
                redeemed_trades_reader=BullpenRedeemedTradesReader(),
                logger=PolymarketFileLogger(
                    user_data_dir / "polymarket-bot.log",
                    user_data_dir / "polymarket-errors.log",
                ),
            )
            await bot.init()
            self._bots[user_id] = _LoopBoundBot(bot=bot, loop=loop)
            if user_config.auto_start:
                asyncio.create_task(self._auto_start_bot(bot))
            return bot

    async def _auto_start_bot(self, bot: PolymarketPaperCopyBot) -> None:
        try:
            await bot.start()
        except Exception as exc:
            sanitized_error = redact_secrets(str(exc))
            bot.last_error = f"Auto-start failed: {sanitized_error}"
            await bot.logger.error("Polymarket bot auto-start failed", exc)
            bot.add_activity(f"Auto-start failed: {sanitized_error}.")

    async def shutdown(self) -> None:
        loop = asyncio.get_running_loop()
        async with self._lock_for_current_loop():
            bots = list(self._bots.values())
            self._bots.clear()
        for entry in bots:
            if entry.loop is not loop:
                continue
            await entry.bot.shutdown()


polymarket_bot_manager = PolymarketBotManager()
