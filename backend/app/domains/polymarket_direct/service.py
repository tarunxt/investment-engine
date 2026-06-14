from __future__ import annotations

import asyncio
from pathlib import Path

from app.domains.polymarket_direct.bot import PolymarketPaperCopyBot
from app.domains.polymarket_direct.direct_polymarket import (
    DirectPolymarketBalanceReader,
    DirectPolymarketLiveExecutor,
    DirectPolymarketRedeemedTradesReader,
)
from app.domains.polymarket_direct.config import load_polymarket_config
from app.domains.polymarket_direct.logger import PolymarketFileLogger, redact_secrets
from app.domains.polymarket_direct.providers import DirectPolymarketReadOnlyProvider, MockProvider
from app.domains.polymarket_direct.schemas import (
    PolymarketLiveTradeDecision,
    PolymarketPaperTrade,
    PolymarketTrackedAccount,
    PolymarketUserConfigOverride,
)
from app.domains.polymarket_direct.storage import JsonModelStore, JsonObjectStore


class PolymarketDirectBotManager:
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
            config_store = JsonObjectStore(
                user_data_dir / "polymarket-config.json",
                PolymarketUserConfigOverride,
            )
            persisted_config = await config_store.load()
            config_update = {"data_dir": str(user_data_dir)}
            if persisted_config:
                config_update.update(persisted_config.model_dump())
            user_config = base_config.model_copy(update=config_update)
            mock_provider = MockProvider()
            read_provider = (
                DirectPolymarketReadOnlyProvider(user_config)
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
                live_executor=DirectPolymarketLiveExecutor(),
                balance_reader=DirectPolymarketBalanceReader(),
                redeemed_trades_reader=DirectPolymarketRedeemedTradesReader(),
                logger=PolymarketFileLogger(
                    user_data_dir / "polymarket-bot.log",
                    user_data_dir / "polymarket-errors.log",
                ),
            )
            await bot.init()
            self._bots[user_id] = bot
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
        async with self._lock:
            bots = list(self._bots.values())
            self._bots.clear()
        for bot in bots:
            await bot.shutdown()


polymarket_direct_bot_manager = PolymarketDirectBotManager()
