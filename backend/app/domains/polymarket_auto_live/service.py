from __future__ import annotations

import asyncio
from pathlib import Path

from app.domains.polymarket_auto_live.bot import BullpenAutoLiveBot
from app.domains.polymarket_auto_live.config import get_polymarket_auto_live_data_dir
from app.domains.polymarket_auto_live.schemas import (
    BullpenAutoLiveDecision,
    BullpenAutoLiveRun,
    BullpenAutoLiveSettings,
    BullpenAutoLiveState,
)
from app.domains.polymarket_auto_live.storage import JsonModelStore, JsonObjectStore


class BullpenAutoLiveBotManager:
    def __init__(self) -> None:
        self._bots: dict[int, BullpenAutoLiveBot] = {}
        self._lock = asyncio.Lock()

    async def get_bot(self, user_id: int) -> BullpenAutoLiveBot:
        async with self._lock:
            existing = self._bots.get(user_id)
            if existing:
                return existing

            user_data_dir = Path(get_polymarket_auto_live_data_dir()) / f"user-{user_id}"
            bot = BullpenAutoLiveBot(
                settings_store=JsonObjectStore(
                    user_data_dir / "polymarket-auto-live-settings.json",
                    BullpenAutoLiveSettings,
                ),
                state_store=JsonObjectStore(
                    user_data_dir / "polymarket-auto-live-state.json",
                    BullpenAutoLiveState,
                ),
                run_store=JsonModelStore(
                    user_data_dir / "polymarket-auto-live-runs.json",
                    BullpenAutoLiveRun,
                ),
                decision_store=JsonModelStore(
                    user_data_dir / "polymarket-auto-live-decisions.json",
                    BullpenAutoLiveDecision,
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


polymarket_auto_live_bot_manager = BullpenAutoLiveBotManager()
