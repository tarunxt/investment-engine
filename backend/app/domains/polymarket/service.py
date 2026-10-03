from __future__ import annotations

import asyncio
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, TypeVar

from app.domains.polymarket.bot import PolymarketPaperCopyBot
from app.domains.polymarket.bullpen import (
    BullpenBalanceReader,
    BullpenLiveExecutor,
    BullpenRedeemedTradesReader,
)
from app.domains.polymarket.config import load_polymarket_config
from app.domains.polymarket.logger import PolymarketFileLogger, redact_secrets
from app.domains.polymarket.passive_projection import (
    PassiveProjectionUnavailable,
    read_persisted_history,
    read_persisted_state,
)
from app.domains.polymarket.providers import BullpenReadOnlyProvider, MockProvider
from app.domains.polymarket.schemas import (
    PolymarketBotState,
    PolymarketHistoryResponse,
    PolymarketLiveTradeDecision,
    PolymarketPaperTrade,
    PolymarketTrackedAccount,
    PolymarketUserConfigOverride,
)
from app.domains.polymarket.storage import JsonModelStore, JsonObjectStore

PASSIVE_LOCK_TIMEOUT_SECONDS = 0.25
MAX_CONCURRENT_COLD_READS = 1
ReadT = TypeVar("ReadT")


@dataclass
class _LoopBoundBot:
    bot: PolymarketPaperCopyBot
    loop: asyncio.AbstractEventLoop
    display_snapshot: PolymarketBotState | None = None
    display_in_progress: bool = False
    display_future: asyncio.Future[PolymarketBotState] | None = None


class PolymarketBotManager:
    def __init__(self) -> None:
        self._bots: dict[int, _LoopBoundBot] = {}
        self._lock: asyncio.Lock | None = None
        self._lock_loop: asyncio.AbstractEventLoop | None = None
        self._passive_jobs: dict[tuple, asyncio.Future] = {}

    def _lock_for_current_loop(self) -> asyncio.Lock:
        loop = asyncio.get_running_loop()
        # Celery's asyncio.run creates a fresh event loop per task, so cached
        # bot instances must stay scoped to the loop that created their locks/tasks.
        if self._lock is None or self._lock_loop is not loop:
            self._lock = asyncio.Lock()
            self._lock_loop = loop
        return self._lock

    async def read_state(self, user_id: int) -> PolymarketBotState:
        """Project existing evidence, without initializing or repairing a runtime."""
        existing = self._bots.get(user_id)
        if existing and existing.loop is asyncio.get_running_loop():
            if existing.display_future is not None:
                snapshot = await asyncio.shield(existing.display_future)
                return await asyncio.to_thread(deepcopy, snapshot)
            if existing.display_in_progress:
                return await self._last_display_snapshot(existing)
            existing.display_in_progress = True
            try:
                async with asyncio.timeout(PASSIVE_LOCK_TIMEOUT_SECONDS):
                    await existing.bot._lock.acquire()
            except TimeoutError:
                existing.display_in_progress = False
                return await self._last_display_snapshot(existing)
            except BaseException:
                existing.display_in_progress = False
                raise

            def project() -> PolymarketBotState:
                # Detach every nested model before releasing the operational
                # lock; background changes cannot rewrite the cached evidence.
                return existing.bot.get_state_snapshot(
                    restore_poller=False,
                ).model_copy(deep=True)

            try:
                future = existing.loop.run_in_executor(None, project)
            except BaseException:
                existing.bot._lock.release()
                existing.display_in_progress = False
                raise
            existing.display_future = future

            def finished(result: asyncio.Future[PolymarketBotState]) -> None:
                try:
                    existing.display_snapshot = result.result()
                except Exception:
                    # The waiting reader receives the original error. Do not
                    # write bot log files from a read, including on disconnect.
                    pass
                finally:
                    existing.display_future = None
                    existing.display_in_progress = False
                    existing.bot._lock.release()

            future.add_done_callback(finished)
            # Cancellation must not release the bot lock while the thread is
            # still reading it. The completion callback owns that release.
            snapshot = await asyncio.shield(future)
            return await asyncio.to_thread(deepcopy, snapshot)
        return await self._read_cold(
            (user_id, "state"), lambda: read_persisted_state(user_id)
        )

    @staticmethod
    async def _last_display_snapshot(existing: _LoopBoundBot) -> PolymarketBotState:
        if existing.display_snapshot is None:
            raise PassiveProjectionUnavailable(
                "Current CopyTrader runtime is busy; no coherent cached snapshot is available. Try again."
            )
        snapshot = await asyncio.to_thread(deepcopy, existing.display_snapshot)
        return snapshot.model_copy(update={
            "read_message": "The runtime is busy. Showing the last captured snapshot; no refresh was started.",
        })

    async def _read_cold(self, key: tuple, project: Callable[[], ReadT]) -> ReadT:
        loop = asyncio.get_running_loop()
        loop_key = (loop, *key)
        future = self._passive_jobs.get(loop_key)
        if future is None:
            if len(self._passive_jobs) >= MAX_CONCURRENT_COLD_READS:
                raise PassiveProjectionUnavailable("Saved CopyTrader snapshots are busy. Try again.")
            future = loop.run_in_executor(None, project)
            self._passive_jobs[loop_key] = future
            def finished(result: asyncio.Future) -> None:
                self._passive_jobs.pop(loop_key, None)
                # Retrieve failures even if every waiting HTTP reader cancelled.
                if not result.cancelled():
                    result.exception()

            future.add_done_callback(finished)
        snapshot = await asyncio.shield(future)
        return await asyncio.to_thread(deepcopy, snapshot)

    async def read_history(self, user_id: int, limit: int) -> PolymarketHistoryResponse:
        existing = self._bots.get(user_id)
        if existing and existing.loop is asyncio.get_running_loop():
            bot = existing.bot
            try:
                async with asyncio.timeout(PASSIVE_LOCK_TIMEOUT_SECONDS):
                    await bot._lock.acquire()
            except TimeoutError as exc:
                raise PassiveProjectionUnavailable("Current CopyTrader history is busy. Try again.") from exc
            try:
                return PolymarketHistoryResponse(
                    paper_trades=list(reversed(bot.trade_history[-limit:])),
                    live_decisions=list(reversed(bot.live_trade_history[-limit:])),
                    redeemed_trades=bot.bullpen_redeemed_trades[:limit],
                ).model_copy(deep=True)
            finally:
                bot._lock.release()
        return await self._read_cold(
            (user_id, "history", limit),
            lambda: read_persisted_history(user_id, limit),
        )

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
                user_id=user_id,
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
