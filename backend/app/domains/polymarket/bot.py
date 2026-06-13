from __future__ import annotations

import asyncio
import os
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse
from uuid import uuid4


from app.domains.polymarket.bullpen import (
    BullpenBalanceReader,
    BullpenCommandError,
    BullpenLiveExecutor,
    LiveTradeGuard,
    is_redeem_metadata_lookup_warning,
    live_position_key,
    utc_now,
)
from app.domains.polymarket.logger import PolymarketFileLogger, redact_secrets
from app.domains.polymarket.providers import (
    BullpenReadOnlyProvider,
    MarketDataProvider,
    MockProvider,
    aggregate_traders,
    estimate_polymarket_net_worth,
    identity_key,
    newest_iso,
    trader_identity_candidates,
)
from app.domains.polymarket.schemas import (
    BotMode,
    PolymarketActivity,
    PolymarketBalanceState,
    PolymarketBotConfig,
    PolymarketBotState,
    PolymarketDoctorStatus,
    PolymarketLiveControlState,
    PolymarketLiveSourceStatus,
    PolymarketLiveTradeDecision,
    PolymarketMetrics,
    PolymarketPaperTrade,
    PolymarketPosition,
    PolymarketSourceTrade,
    PolymarketTrackedAccount,
    PolymarketLiveLimitUpdate,
    PolymarketUserConfigOverride,
    PolymarketTrackedAccountCreate,
    PolymarketTrackedAccountUpdate,
    PolymarketTrader,
)
from app.domains.polymarket.storage import JsonModelStore, JsonObjectStore


BALANCE_REFRESH_INTERVAL_SECONDS = max(
    5, int(float(os.getenv("POLYMARKET_BALANCE_REFRESH_INTERVAL_SECONDS", "5")))
)


class PolymarketPaperCopyBot:
    def __init__(
        self,
        config: PolymarketBotConfig,
        provider: MarketDataProvider,
        fallback_provider: MockProvider,
        store: JsonModelStore[PolymarketPaperTrade],
        live_store: JsonModelStore[PolymarketLiveTradeDecision],
        live_executor: BullpenLiveExecutor,
        balance_reader: BullpenBalanceReader,
        logger: PolymarketFileLogger,
        tracked_account_store: JsonModelStore[PolymarketTrackedAccount] | None = None,
        config_store: JsonObjectStore[PolymarketUserConfigOverride] | None = None,
    ) -> None:
        self.config = config
        self.provider = provider
        self.fallback_provider = fallback_provider
        self.store = store
        self.live_store = live_store
        self.tracked_account_store = tracked_account_store or JsonModelStore(
            Path(config.data_dir) / "polymarket-tracked-accounts.json",
            PolymarketTrackedAccount,
        )
        self.config_store = config_store or JsonObjectStore(
            Path(config.data_dir) / "polymarket-config.json",
            PolymarketUserConfigOverride,
        )
        self.live_executor = live_executor
        self.balance_reader = balance_reader
        self.logger = logger

        self.running = False
        self.session_started_at = utc_now()
        self.started_at: str | None = None
        self.stopped_at: str | None = None
        self.last_poll_at: str | None = None
        self.next_poll_at: str | None = None
        self.last_error: str | None = None
        self.tracked_accounts: list[PolymarketTrackedAccount] = []
        self.tracked_traders: list[PolymarketTrader] = []
        self.seen_source_trades: set[str] = set()
        self.trade_history: list[PolymarketPaperTrade] = []
        self.live_trade_history: list[PolymarketLiveTradeDecision] = []
        self.recent_activity: list[PolymarketActivity] = []
        self.active_provider: MarketDataProvider = (
            provider if config.use_live_reads else fallback_provider
        )
        self.active_mode: BotMode = "live-read" if config.use_live_reads else "mock"
        self.live_unlocked = False
        self.live_unlock_mode: str = "locked"
        self.live_manually_locked = False
        self.emergency_stopped = False
        self.doctor_status = PolymarketDoctorStatus(
            ok=False, message="Bullpen doctor has not run."
        )
        self.balance_state = PolymarketBalanceState(
            status="idle", message="Balance has not been refreshed."
        )
        self.live_source_status = PolymarketLiveSourceStatus(
            source_mode=self.active_mode,
            discovery_mode=(
                "active feed + manual wallets" if config.use_live_reads else "mock"
            ),
            trending_market_activity_enabled=config.use_trending_market_activity,
        )
        self.live_guard = LiveTradeGuard(config)
        self.proposal_cooldown_by_trader: dict[str, float] = {}

        self._poll_task: asyncio.Task[None] | None = None
        self._balance_task: asyncio.Task[None] | None = None
        self._startup_warmup_task: asyncio.Task[None] | None = None
        self._net_worth_refresh_task: asyncio.Task[None] | None = None
        self._lock = asyncio.Lock()

    async def init(self) -> None:
        async with self._lock:
            await self.logger.init()
            self.trade_history = await self.store.load()
            self.live_trade_history = await self.live_store.load()
            self.tracked_accounts = await self._load_or_seed_tracked_accounts_unlocked()
            self._apply_tracked_accounts_to_provider_unlocked()
            for trade in self.live_trade_history:
                self.seen_source_trades.add(trade.source_trade_id)
                self.seen_source_trades.add(trade.source_trade_key)
            self._ensure_balance_task()
            self._ensure_startup_warmup_task()
            self._ensure_net_worth_refresh_task()
            await self.logger.info(
                f"Bot initialized. paperTrading={self.config.paper_trading} liveTrading={self.config.live_trading}"
            )
            self._add_activity(
                "Bot initialized. Startup checks are refreshing in the background."
            )

    def add_activity(self, message: str) -> None:
        self._add_activity(message)

    async def shutdown(self) -> None:
        async with self._lock:
            if self.running and not self.stopped_at:
                self.stopped_at = utc_now()
            self.running = False
            await self._cancel_task(self._poll_task)
            self._poll_task = None
            await self._cancel_task(self._balance_task)
            self._balance_task = None
            await self._cancel_task(self._startup_warmup_task)
            self._startup_warmup_task = None
            await self._cancel_task(self._net_worth_refresh_task)
            self._net_worth_refresh_task = None

    async def start(self) -> None:
        async with self._lock:
            if self.running:
                return
            if self._wants_live_execution():
                await self._refresh_doctor_for_start_unlocked()
                await self._try_auto_unlock_live_unlocked("Start Bot")
                block_reason = self.live_guard.startup_block_reason(
                    self.doctor_status,
                    self.live_unlocked,
                    self.emergency_stopped,
                    self.live_manually_locked,
                )
                if block_reason:
                    message = self._startup_block_message(block_reason)
                    self.active_provider = (
                        self.provider
                        if self.config.use_live_reads
                        else self.fallback_provider
                    )
                    self.active_mode = (
                        "live-read" if self.config.use_live_reads else "mock"
                    )
                    self.live_source_status.source_mode = self.active_mode
                    self._add_activity(
                        "Live trading remains locked; starting read-only poller instead: "
                        f"{message}"
                    )
                    await self.logger.warn(
                        "Live trading remains locked; starting read-only poller instead: "
                        f"{message}"
                    )
                else:
                    self.active_mode = "live-trading"
                    self.live_source_status.source_mode = self.active_mode
            self.running = True
            started_at = utc_now()
            self.session_started_at = started_at
            self.started_at = started_at
            self.stopped_at = None
            self.next_poll_at = started_at
            await self.logger.info(f"Bot started. mode={self.active_mode}")
            self._add_activity(f"Bot started in {self.active_mode} mode.")
            self._ensure_poll_task(initial_delay=0)

    async def stop(self) -> None:
        async with self._lock:
            if self.running or not self.stopped_at:
                self.stopped_at = utc_now()
            self.running = False
            self.next_poll_at = None
            await self._cancel_task(self._poll_task)
            self._poll_task = None
            await self.logger.info("Bot stopped.")
            self._add_activity("Bot stopped.")

    async def pause(self) -> None:
        async with self._lock:
            self.config.paused = True
            await self.logger.info("Bot paused.")
            self._add_activity("Bot paused.")

    async def resume(self) -> None:
        async with self._lock:
            self.config.paused = False
            await self.logger.info("Bot resumed.")
            self._add_activity("Bot resumed.")

    async def unlock_live(self) -> None:
        async with self._lock:
            self.live_manually_locked = False
            self.live_unlocked = True
            self.live_unlock_mode = "manual"
            await self._refresh_doctor_unlocked()
            block_reason = self.live_guard.startup_block_reason(
                self.doctor_status,
                self.live_unlocked,
                self.emergency_stopped,
                self.live_manually_locked,
            )
            if block_reason:
                self.live_unlocked = False
                self.live_unlock_mode = "locked"
                raise RuntimeError(f"Live mode remains locked: {block_reason}")
            self._add_activity("Live trading unlocked by dashboard confirmation.")
            await self.logger.warn("Live trading unlocked by dashboard confirmation.")
            if self._wants_live_execution() and self.config.use_live_reads:
                self.active_provider = self.provider
                self.active_mode = "live-trading"
                self.live_source_status.source_mode = self.active_mode

    async def lock_live(self) -> None:
        async with self._lock:
            self.live_unlocked = False
            self.live_unlock_mode = "locked"
            self.live_manually_locked = True
            await self.logger.warn("Live trading locked by dashboard.")
            self._add_activity(
                "Live trading locked by dashboard. Future live proposals disabled."
            )

    async def refresh_doctor(self) -> None:
        async with self._lock:
            await self._refresh_doctor_unlocked()

    async def refresh_balance(self) -> None:
        async with self._lock:
            await self._refresh_balance_unlocked()

    async def redeem_live_positions(self) -> None:
        async with self._lock:
            await self._redeem_live_positions_unlocked()

    async def emergency_stop(self) -> None:
        async with self._lock:
            self.emergency_stopped = True
            self.live_unlocked = False
            await self.logger.warn("Emergency stop activated. Live execution disabled.")
            self._add_activity("Emergency stop activated. Live execution disabled.")

    async def reset_emergency_stop(self) -> None:
        async with self._lock:
            self.emergency_stopped = False
            await self._refresh_doctor_unlocked()
            await self._try_auto_unlock_live_unlocked("emergency reset")
            await self.logger.warn("Emergency stop cleared.")
            self._add_activity("Emergency stop cleared.")

    async def reject_live_trade(self, trade_id: str) -> None:
        async with self._lock:
            trade = self._find_pending_live_trade(trade_id)
            trade.status = "rejected"
            trade.updated_at = utc_now()
            trade.reason = f"{trade.reason} Rejected in dashboard."
            await self._save_live_trades_unlocked()
            self._add_activity(
                f"Rejected live {trade.side}: {trade.market_id} {trade.outcome}."
            )

    async def reject_all_pending_live_trades(self) -> int:
        async with self._lock:
            pending = self._pending_live_trades()
            now = utc_now()
            for trade in pending:
                trade.status = "rejected"
                trade.updated_at = now
                trade.reason = f"{trade.reason} Rejected in dashboard bulk action."
            await self._save_live_trades_unlocked()
            self._add_activity(
                f"Rejected all pending live confirmations: {len(pending)}."
            )
            return len(pending)

    async def confirm_live_trade(self, trade_id: str) -> None:
        async with self._lock:
            trade = self._find_pending_live_trade(trade_id)
            await self._execute_live_trade_unlocked(
                trade, "manual dashboard confirmation"
            )

    async def update_live_limits(self, request: PolymarketLiveLimitUpdate) -> None:
        async with self._lock:
            self.config.max_live_trades_per_day = request.max_live_trades_per_day
            await self.config_store.save(
                PolymarketUserConfigOverride(
                    max_live_trades_per_day=request.max_live_trades_per_day
                )
            )
            await self.logger.info(
                f"Updated max live trades per day to {request.max_live_trades_per_day}."
            )
            self._add_activity(
                f"Updated max live trades per day to {request.max_live_trades_per_day}."
            )

    async def add_tracked_account(
        self, request: PolymarketTrackedAccountCreate
    ) -> PolymarketTrackedAccount:
        async with self._lock:
            account = self._tracked_account_from_request(request)
            if any(existing.id == account.id for existing in self.tracked_accounts):
                raise RuntimeError("Tracked account already exists.")
            self.tracked_accounts.append(account)
            await self._save_tracked_accounts_unlocked()
            self._apply_tracked_accounts_to_provider_unlocked()
            self.live_source_status.live_baseline_completed_at = None
            self._add_activity(f"Tracked account added: {account.target}.")
        return await self.refresh_tracked_account_net_worth(account.id)

    async def update_tracked_account(
        self, account_id: str, request: PolymarketTrackedAccountUpdate
    ) -> PolymarketTrackedAccount:
        async with self._lock:
            account = self._find_tracked_account(account_id)
            update = request.model_dump(exclude_unset=True)
            target_changed = False
            if "target" in update and update["target"]:
                normalized = normalize_tracked_account_target(str(update["target"]))
                new_id = tracked_account_id(normalized)
                if new_id != account.id and any(
                    item.id == new_id for item in self.tracked_accounts
                ):
                    raise RuntimeError("Tracked account already exists.")
                account.id = new_id
                account.target = normalized
                target_changed = True
                account.handle = tracked_account_handle(normalized)
                account.address = normalized if normalized.startswith("0x") else ""
                account.proxy_wallet = account.address or None
                account.profile_url = tracked_account_profile_url(normalized)
                account.net_worth_error = None
            for field in (
                "threshold_percent",
                "net_worth_usd",
                "copy_trade_usd",
                "enabled",
            ):
                if field in update:
                    setattr(account, field, update[field])
            account.updated_at = utc_now()
            await self._save_tracked_accounts_unlocked()
            self._apply_tracked_accounts_to_provider_unlocked()
            self.live_source_status.live_baseline_completed_at = None
            self._add_activity(f"Tracked account updated: {account.target}.")
            refresh_account_id = account.id if target_changed else None
        if refresh_account_id:
            return await self.refresh_tracked_account_net_worth(refresh_account_id)
        async with self._lock:
            return self._find_tracked_account(account_id)

    async def delete_tracked_account(self, account_id: str) -> None:
        async with self._lock:
            before = len(self.tracked_accounts)
            self.tracked_accounts = [
                item for item in self.tracked_accounts if item.id != account_id
            ]
            if len(self.tracked_accounts) == before:
                raise RuntimeError("Tracked account not found.")
            await self._save_tracked_accounts_unlocked()
            self._apply_tracked_accounts_to_provider_unlocked()
            self.live_source_status.live_baseline_completed_at = None
            self._add_activity("Tracked account deleted.")

    async def debug_discovery(self, target: str) -> object:
        provider = (
            self.provider
            if isinstance(self.provider, BullpenReadOnlyProvider)
            else None
        )
        if not provider:
            raise RuntimeError(
                "Live-read discovery debug is unavailable while USE_LIVE_READS=false."
            )
        return await provider.debug_discovery(target)

    async def get_state(self) -> PolymarketBotState:
        async with self._lock:
            return self._build_state_unlocked()

    def _build_state_unlocked(self) -> PolymarketBotState:
        if self.running and (self._poll_task is None or self._poll_task.done()):
            self._add_activity(
                "Warning: Bot poller stopped automatically; restarting it now."
            )
            self._ensure_poll_task(initial_delay=0)
        now = utc_now()
        open_positions = (
            self._live_positions()
            if self.active_mode == "live-trading"
            else self._positions()
        )
        return PolymarketBotState(
            running=self.running,
            paused=self.config.paused,
            mode=self.active_mode,
            server_now=now,
            session_started_at=self.session_started_at,
            started_at=self.started_at,
            stopped_at=self.stopped_at,
            last_poll_at=self.last_poll_at,
            next_poll_at=self.next_poll_at,
            seconds_until_next_poll=self._seconds_until_next_poll(now),
            last_error=self.last_error,
            tracked_accounts=self.tracked_accounts,
            tracked_traders=self.tracked_traders,
            open_positions=open_positions,
            trade_history=list(reversed(self.trade_history)),
            recent_activity=self.recent_activity[:20],
            metrics=self._metrics(),
            config=self.config,
            live=self._live_state(),
        )

    def _ensure_poll_task(self, *, initial_delay: float | None = None) -> None:
        if self._poll_task and not self._poll_task.done():
            return
        self._poll_task = asyncio.create_task(
            self._poll_loop(initial_delay=initial_delay)
        )

    def _ensure_balance_task(self) -> None:
        if self._balance_task and not self._balance_task.done():
            return
        self._balance_task = asyncio.create_task(self._balance_loop())

    def _ensure_startup_warmup_task(self) -> None:
        if self._startup_warmup_task and not self._startup_warmup_task.done():
            return
        self._startup_warmup_task = asyncio.create_task(self._startup_warmup_loop())

    async def _startup_warmup_loop(self) -> None:
        try:
            results = await asyncio.gather(
                self._refresh_startup_doctor_background(),
                self._refresh_startup_balance_background(),
                self._perform_startup_live_baseline_background(),
                return_exceptions=True,
            )
        except asyncio.CancelledError:
            return

        for result in results:
            if not isinstance(result, Exception):
                continue
            message = redact_secrets(str(result))
            async with self._lock:
                self.last_error = message
                if self.active_mode in ("live-read", "live-trading"):
                    self.live_source_status.last_live_read_error = message
                self._add_activity(f"Startup background refresh failed: {message}.")
            await self.logger.error("Startup background refresh failed", result)

    async def _refresh_startup_doctor_background(self) -> None:
        doctor_status = await self.live_executor.doctor()
        async with self._lock:
            self.doctor_status = doctor_status
            await self._try_auto_unlock_live_unlocked("server initialization")

    async def _refresh_startup_balance_background(self) -> None:
        await self._refresh_balance_background()

    async def _perform_startup_live_baseline_background(self) -> None:
        if not self.config.use_live_reads or self.active_mode == "mock":
            return
        try:
            traders = await self.active_provider.get_top_traders()
            selected_traders = traders[: max(1, self.config.max_tracked_traders)]
            source_trades = await self.active_provider.get_recent_trades(
                selected_traders
            )
            selected_traders = self._traders_with_recent_activity(
                selected_traders, source_trades
            )
        except Exception as exc:
            message = redact_secrets(str(exc))
            async with self._lock:
                self.last_error = str(exc)
                self.live_source_status.last_live_read_error = message
                self._add_activity(f"Startup live baseline failed: {message}.")
            await self.logger.warn(f"Startup live baseline failed: {message}")
            return

        async with self._lock:
            if self.running or self.live_source_status.live_baseline_completed_at:
                return
            self.tracked_traders = selected_traders
            self.live_source_status.live_read_traders_count = len(
                [trader for trader in selected_traders if trader.source == "live-read"]
            )
            self._apply_provider_discovery_status_unlocked()
            for trade in source_trades:
                self._mark_source_trade_seen(trade)
            self.live_source_status.live_baseline_completed_at = utc_now()
            self.live_source_status.seen_live_trades_baseline_count = len(source_trades)
            self._finish_poll_unlocked(
                len(source_trades),
                0,
                0,
                {
                    "after_filters": 0,
                    "skipped_by_filters": 0,
                    "skipped_by_limits": 0,
                    "skipped_duplicates": 0,
                },
            )
            self._add_activity(
                f"Startup live baseline completed. Existing {len(source_trades)} source trades marked seen; no proposals created."
            )
        await self.logger.info(
            f"Startup live baseline completed. Existing {len(source_trades)} source trades marked seen; no proposals created."
        )

    async def _poll_loop(self, *, initial_delay: float | None = None) -> None:
        try:
            delay = max(self.config.poll_interval_ms / 1000, 1)
            if initial_delay is not None:
                delay = max(initial_delay, 0)
            while True:
                await asyncio.sleep(delay)
                async with self._lock:
                    if not self.running:
                        self.next_poll_at = None
                        break
                    try:
                        if (
                            self.active_mode in ("live-trading", "live-read")
                            and not self.live_source_status.live_baseline_completed_at
                        ):
                            await self._perform_live_baseline_unlocked("Start Bot")
                        await self._poll_unlocked()
                    except Exception as exc:
                        self.last_error = str(exc)
                        if self.active_mode in ("live-read", "live-trading"):
                            self.live_source_status.last_live_read_error = (
                                redact_secrets(self.last_error)
                            )
                        await self.logger.error("Polling failed", exc)
                        self._add_activity(f"Poll failed: {self.last_error}.")
                        self._schedule_next_poll_unlocked()
                delay = max(self.config.poll_interval_ms / 1000, 1)
        except asyncio.CancelledError:
            return

    async def _balance_loop(self) -> None:
        try:
            while True:
                await asyncio.sleep(BALANCE_REFRESH_INTERVAL_SECONDS)
                await self._refresh_balance_background()
        except asyncio.CancelledError:
            return

    async def _poll_unlocked(self) -> None:
        if not self.running:
            return
        self.last_poll_at = utc_now()
        try:
            self.tracked_traders = await self._read_top_traders_unlocked()
            source_trades = await self._read_recent_trades_unlocked(
                self.tracked_traders
            )
            self._refresh_tracked_trader_activity_unlocked(source_trades)
            if self.active_mode == "live-trading":
                await self._auto_exit_favorable_live_positions_unlocked(source_trades)
            live_proposals_before = len(self._pending_live_trades())

            if self.config.paused:
                for trade in source_trades:
                    self._mark_source_trade_seen(trade)
                await self.logger.info(
                    f"Paused. Marked {len(source_trades)} source trades as seen without copying."
                )
                self._add_activity(
                    f"Poll completed while paused. Marked {len(source_trades)} trades as seen."
                )
                self._finish_poll_unlocked(
                    len(source_trades),
                    0,
                    0,
                    {
                        "after_filters": 0,
                        "skipped_by_filters": 0,
                        "skipped_by_limits": 0,
                        "skipped_duplicates": 0,
                    },
                )
                return

            new_trade_count = 0
            proposal_stats = {
                "created": 0,
                "after_filters": 0,
                "skipped_by_filters": 0,
                "skipped_by_limits": 0,
                "skipped_duplicates": 0,
                "per_trader_created": defaultdict(int),
            }
            for source_trade in source_trades:
                if self._is_source_trade_seen(source_trade):
                    if self.active_mode == "live-trading":
                        proposal_stats["skipped_duplicates"] += 1
                    continue
                self._mark_source_trade_seen(source_trade)
                new_trade_count += 1
                await self._handle_source_trade_unlocked(source_trade, proposal_stats)

            live_proposals_after = len(self._pending_live_trades())
            self._finish_poll_unlocked(
                len(source_trades),
                new_trade_count,
                live_proposals_after - live_proposals_before,
                proposal_stats,
            )
            if self.active_mode == "live-trading" and not source_trades:
                self._add_activity(
                    "Live mode is active. No live source trades detected yet."
                )
            elif self.active_mode == "live-trading" and new_trade_count == 0:
                self._add_activity(
                    "Live mode is active. No new live source trades detected yet."
                )
        except Exception as exc:
            self.last_error = str(exc)
            if self.active_mode in ("live-read", "live-trading"):
                self.live_source_status.last_live_read_error = redact_secrets(
                    self.last_error
                )
            await self.logger.error("Polling failed", exc)
            self._add_activity(f"Poll failed: {self.last_error}.")
            self._schedule_next_poll_unlocked()

    async def _read_top_traders_unlocked(self) -> list[PolymarketTrader]:
        try:
            traders = await self.active_provider.get_top_traders()
            selected = traders[: max(1, self.config.max_tracked_traders)]
            await self._sync_leaderboard_tracked_accounts_unlocked(selected)
            self.live_source_status.live_read_traders_count = len(
                [trader for trader in selected if trader.source == "live-read"]
            )
            self._apply_provider_discovery_status_unlocked()
            return selected
        except Exception as exc:
            message = redact_secrets(str(exc))
            self.live_source_status.last_live_read_error = message
            if self.active_mode == "live-trading" or self._wants_live_execution():
                self._add_activity(f"Bullpen live-read traders failed: {message}")
                await self.logger.warn(f"Bullpen live-read traders failed: {message}")
                raise
            await self.logger.warn(
                "Read provider unavailable. Falling back to mock traders."
            )
            self._add_activity("Live read unavailable. Switched to mock traders.")
            self.active_provider = self.fallback_provider
            self.active_mode = "mock"
            return await self.fallback_provider.get_top_traders()

    async def _read_recent_trades_unlocked(
        self, traders: list[PolymarketTrader]
    ) -> list[PolymarketSourceTrade]:
        try:
            trades = await self.active_provider.get_recent_trades(traders)
            if self.active_mode in ("live-read", "live-trading"):
                self.live_source_status.last_live_read_error = None
            return trades
        except Exception as exc:
            message = redact_secrets(str(exc))
            self.live_source_status.last_live_read_error = message
            if self.active_mode == "live-trading" or self._wants_live_execution():
                self._add_activity(f"Bullpen live-read trades failed: {message}")
                await self.logger.warn(f"Bullpen live-read trades failed: {message}")
                raise
            await self.logger.warn(
                "Read provider trades unavailable. Falling back to mock trades."
            )
            self._add_activity("Live trade feed unavailable. Switched to mock trades.")
            self.active_provider = self.fallback_provider
            self.active_mode = "mock"
            return await self.fallback_provider.get_recent_trades(traders)

    def _refresh_tracked_trader_activity_unlocked(
        self, source_trades: list[PolymarketSourceTrade]
    ) -> None:
        self.tracked_traders = self._traders_with_recent_activity(
            self.tracked_traders, source_trades
        )

    def _traders_with_recent_activity(
        self,
        traders: list[PolymarketTrader],
        source_trades: list[PolymarketSourceTrade],
    ) -> list[PolymarketTrader]:
        if not traders or not source_trades:
            return traders

        trade_rows = [
            {
                "address": trade.trader_address,
                "handle": trade.trader_handle,
                "trader_name": trade.trader_name,
                "market_id": trade.market_id,
                "market_title": trade.market_title,
                "outcome": trade.outcome,
                "side": trade.side,
                "price": trade.price,
                "size_usd": trade.size_usd,
                "timestamp": trade.timestamp,
            }
            for trade in source_trades
            if trade.source in ("live-read", "live-market-read", "mock")
        ]
        recent_activity = aggregate_traders(
            trade_rows,
            "live-read" if self.active_mode != "mock" else "mock",
            "Recent source trade activity",
        )
        activity_by_identity = {
            candidate: activity
            for activity in recent_activity
            for candidate in trader_identity_candidates(activity)
        }

        updated: list[PolymarketTrader] = []
        for trader in traders:
            activity = next(
                (
                    activity_by_identity[candidate]
                    for candidate in trader_identity_candidates(trader)
                    if candidate in activity_by_identity
                ),
                None,
            )
            if not activity:
                updated.append(trader)
                continue

            latest_trade_at = newest_iso(trader.last_trade_at, activity.last_trade_at)
            latest_trade_age = (
                activity.last_trade_age
                if latest_trade_at == activity.last_trade_at
                else trader.last_trade_age
            )
            detected_activity_source = (
                "wallet"
                if activity.address
                else activity.activity_source or trader.activity_source
            )
            updated.append(
                PolymarketTrader(
                    **{
                        **trader.model_dump(),
                        "activity_source": detected_activity_source,
                        "volume_24h": max(trader.volume_24h, activity.volume_24h),
                        "trades_1h": max(trader.trades_1h, activity.trades_1h),
                        "trades_6h": max(trader.trades_6h, activity.trades_6h),
                        "trades_24h": max(trader.trades_24h, activity.trades_24h),
                        "last_trade_at": latest_trade_at,
                        "last_trade_age": latest_trade_age,
                        "source_reason": (
                            "Recent trade activity detected from tracked wallet"
                            if trader.source_reason.startswith("Fallback")
                            and activity.trades_24h > 0
                            else trader.source_reason
                        ),
                    }
                )
            )
        return updated

    async def _auto_exit_favorable_live_positions_unlocked(
        self, source_trades: list[PolymarketSourceTrade]
    ) -> None:
        """Sell live positions when observed prices imply a near-certain win."""
        if not self.config.auto_redeem_live or not self._wants_live_execution():
            return

        block_reason = self.live_guard.startup_block_reason(
            self.doctor_status,
            self.live_unlocked,
            self.emergency_stopped,
            self.live_manually_locked,
        )
        if block_reason:
            return

        latest_prices = self._latest_live_prices_by_market_outcome(source_trades)
        if not latest_prices:
            return

        for position in list(self._live_positions()):
            trigger_price = self._favorable_exit_price(position, latest_prices)
            if trigger_price is None:
                continue
            decision = self._auto_exit_decision(position, trigger_price)
            await self._record_live_trade_unlocked(decision)
            try:
                await self._execute_live_trade_unlocked(
                    decision,
                    "automatic favorable-price exit threshold reached",
                    bypass_trade_risk=True,
                )
                await self.live_executor.redeem(dry_run=False)
                self._add_activity(
                    f"Auto-exited and redeemed favorable live position: {position.market_title} "
                    f"{position.outcome} at {trigger_price * 100:.1f}¢."
                )
            except Exception as exc:
                self._add_activity(
                    f"Auto-exit failed and bot kept looping: {redact_secrets(str(exc))}"
                )

    def _latest_live_prices_by_market_outcome(
        self, source_trades: list[PolymarketSourceTrade]
    ) -> dict[tuple[str, str], float]:
        prices: dict[tuple[str, str], float] = {}
        for trade in sorted(source_trades, key=lambda item: item.timestamp):
            if trade.source not in ("live-read", "live-market-read"):
                continue
            prices[(trade.market_id, trade.outcome)] = trade.price
        return prices

    def _favorable_exit_price(
        self,
        position: PolymarketPosition,
        latest_prices: dict[tuple[str, str], float],
    ) -> float | None:
        held_price = latest_prices.get((position.market_id, position.outcome))
        if held_price is not None and held_price >= 0.999:
            return held_price

        opposite_prices = [
            price
            for (market_id, outcome), price in latest_prices.items()
            if market_id == position.market_id and outcome != position.outcome
        ]
        if any(price <= 0.001 for price in opposite_prices):
            return 0.999
        return None

    def _auto_exit_decision(
        self, position: PolymarketPosition, price: float
    ) -> PolymarketLiveTradeDecision:
        now = utc_now()
        source_id = f"auto-exit:{position.key}:{now}"
        return PolymarketLiveTradeDecision(
            id=str(uuid4()),
            source_trade_id=source_id,
            source_trade_key=source_id,
            proposed_at=now,
            updated_at=now,
            trader_id="auto-exit",
            trader_name="Favorable price auto-exit",
            trader_address="",
            market_id=position.market_id,
            market_title=position.market_title,
            outcome=position.outcome,
            side="SELL",
            amount=position.shares * price,
            price=price,
            shares=position.shares,
            max_loss=0,
            reason=(
                "Current live price reached a favorable auto-exit threshold "
                "(99.9¢ on the held outcome or 0.1¢ on the opposite outcome)."
            ),
            status="proposed",
            command="sell",
            source="live-read",
        )

    async def _handle_source_trade_unlocked(
        self,
        source_trade: PolymarketSourceTrade,
        proposal_stats: dict[str, object],
    ) -> None:
        self._add_activity(
            f"{'Mock' if source_trade.source == 'mock' else 'Live-read'} trade detected: {source_trade.side} {source_trade.market_id} {source_trade.outcome}."
        )
        if self.active_mode == "live-trading":
            await self._handle_live_source_trade_unlocked(source_trade, proposal_stats)
            return

        if not self.config.paper_trading:
            self._add_activity(
                "Sandbox trading is disabled; source trade was observed but no simulated trade was recorded."
            )
            await self.logger.warn(
                f"Skipped non-live source trade while PAPER_TRADING=false: source={source_trade.source}"
            )
            return

        risk_reason = self._risk_block_reason(source_trade)
        if risk_reason:
            self._add_activity(
                f"Risk skipped {source_trade.side} {source_trade.market_id}: {risk_reason}"
            )
            await self._record_trade_unlocked(
                self._paper_trade(source_trade, "skipped", 0, 0, 0, risk_reason)
            )
            return

        if source_trade.side == "BUY":
            copied_usd = min(
                self.config.fixed_copy_trade_size, self.config.max_trade_size
            )
            shares = copied_usd / source_trade.price
            await self._record_trade_unlocked(
                self._paper_trade(source_trade, "executed", copied_usd, shares, 0)
            )
            self._add_activity(
                f"Simulated BUY copied: {source_trade.market_id} {source_trade.outcome} for ${copied_usd:.2f}."
            )
            return

        position = next(
            (
                item
                for item in self._positions()
                if item.key == f"{source_trade.market_id}::{source_trade.outcome}"
            ),
            None,
        )
        if not position or position.shares <= 0:
            reason = "No matching paper position to exit."
            await self._record_trade_unlocked(
                self._paper_trade(source_trade, "skipped", 0, 0, 0, reason)
            )
            self._add_activity(
                f"Simulated SELL skipped: {source_trade.market_id} {source_trade.outcome}. {reason}"
            )
            return

        implied_source_shares = source_trade.size_usd / source_trade.price
        sell_shares = min(position.shares, max(0.0001, implied_source_shares * 0.05))
        copied_usd = sell_shares * source_trade.price
        realized_pnl = sell_shares * (source_trade.price - position.average_price)
        await self._record_trade_unlocked(
            self._paper_trade(
                source_trade, "executed", copied_usd, -sell_shares, realized_pnl
            )
        )
        self._add_activity(
            f"Simulated SELL copied: {source_trade.market_id} {source_trade.outcome} for ${copied_usd:.2f}."
        )

    async def _handle_live_source_trade_unlocked(
        self,
        source_trade: PolymarketSourceTrade,
        proposal_stats: dict[str, object],
    ) -> None:
        if source_trade.source not in ("live-read", "live-market-read"):
            await self.logger.warn(
                f"Ignored non-live source in live-trading mode: source={source_trade.source}"
            )
            self._add_activity("Ignored non-live source trade in live-trading mode.")
            return

        duplicate_reason = self._duplicate_live_source_reason(source_trade)
        if duplicate_reason:
            proposal_stats["skipped_duplicates"] = (
                int(proposal_stats["skipped_duplicates"]) + 1
            )
            self._add_activity(f"{duplicate_reason}: {source_trade.id}.")
            return

        proposal_block = self._proposal_block_reason(source_trade, proposal_stats)
        if proposal_block:
            key = (
                "skipped_by_filters"
                if proposal_block["kind"] == "filter"
                else "skipped_by_limits"
            )
            proposal_stats[key] = int(proposal_stats[key]) + 1
            self._add_activity(
                f"Live proposal skipped {source_trade.side} {source_trade.market_id}: {proposal_block['reason']}"
            )
            return
        proposal_stats["after_filters"] = int(proposal_stats["after_filters"]) + 1

        risk_reason = self.live_guard.trade_block_reason(
            source_trade, self.live_trade_history, self._live_positions()
        )
        if risk_reason:
            await self._record_live_trade_unlocked(
                self._live_decision(source_trade, "skipped", 0, 0, risk_reason)
            )
            self._add_activity(
                f"Live skipped {source_trade.side} {source_trade.market_id}: {risk_reason}"
            )
            return

        decision = self._live_decision_from_source(source_trade)
        block_reason = self.live_guard.startup_block_reason(
            self.doctor_status,
            self.live_unlocked,
            self.emergency_stopped,
            self.live_manually_locked,
        )
        if (
            not self.running
            or self.active_mode != "live-trading"
            or self.config.paused
            or block_reason
        ):
            proposal_stats["skipped_by_limits"] = (
                int(proposal_stats["skipped_by_limits"]) + 1
            )
            self._add_activity(
                f"Live proposal skipped: {block_reason or 'proposals paused or stopped.'}"
            )
            return

        await self._record_live_trade_unlocked(decision)
        proposal_stats["created"] = int(proposal_stats["created"]) + 1
        trader_key = identity_key(
            source_trade.clean_trader_identity
            or source_trade.trader_address
            or source_trade.trader_handle
            or source_trade.trader_id
        )
        proposal_stats["per_trader_created"][trader_key] += 1
        self.proposal_cooldown_by_trader[trader_key] = datetime.now(
            timezone.utc
        ).timestamp()
        self._add_activity(
            f"Live trade proposed from {source_trade.source}: {decision.side} {decision.market_id} {decision.outcome} for ${decision.amount:.2f}."
        )
        if (
            self.config.auto_execute_live
            and not self.config.require_manual_confirmation
        ):
            try:
                await self._execute_live_trade_unlocked(
                    decision, "automatic copy trading enabled"
                )
            except Exception as exc:
                proposal_stats["skipped_by_limits"] = (
                    int(proposal_stats["skipped_by_limits"]) + 1
                )
                self._add_activity(
                    f"Automatic live execution failed and bot kept looping: {redact_secrets(str(exc))}"
                )

    async def _execute_live_trade_unlocked(
        self,
        trade: PolymarketLiveTradeDecision,
        confirmation_reason: str,
        *,
        bypass_trade_risk: bool = False,
    ) -> None:
        await self._refresh_doctor_unlocked()
        block_reason = self.live_guard.startup_block_reason(
            self.doctor_status,
            self.live_unlocked,
            self.emergency_stopped,
            self.live_manually_locked,
        )
        if block_reason:
            trade.status = "failed"
            trade.failure_reason = f"Live execution blocked: {block_reason}"
            trade.updated_at = utc_now()
            await self._save_live_trades_unlocked()
            raise RuntimeError(trade.failure_reason)

        risk_reason = self.live_guard.trade_block_reason(
            PolymarketSourceTrade(
                id=trade.source_trade_id,
                source_trade_key=trade.source_trade_key,
                trader_id=trade.trader_id,
                trader_name=trade.trader_name,
                trader_address=trade.trader_address,
                trader_handle=trade.trader_handle,
                clean_trader_identity=trade.trader_address
                or trade.trader_handle
                or trade.trader_id,
                market_id=trade.market_id,
                market_title=trade.market_title,
                outcome=trade.outcome,
                side=trade.side,
                price=trade.price,
                size_usd=trade.amount,
                timestamp=trade.proposed_at,
                source=trade.source,
            ),
            self.live_trade_history,
            self._live_positions(),
        )
        if bypass_trade_risk:
            risk_reason = None

        if risk_reason:
            trade.status = "skipped"
            trade.reason = f"{trade.reason} {risk_reason}"
            trade.updated_at = utc_now()
            await self._save_live_trades_unlocked()
            self._add_activity(f"Live execution skipped: {risk_reason}")
            return

        trade.status = "confirmed"
        trade.reason = f"{trade.reason} Confirmed: {confirmation_reason}."
        trade.updated_at = utc_now()
        await self._save_live_trades_unlocked()

        try:
            await self.live_executor.execute(trade)
            trade.status = "executed"
            trade.executed_at = utc_now()
            trade.updated_at = trade.executed_at
            await self._save_live_trades_unlocked()
            self._add_activity(
                f"Executed live {trade.side}: {trade.market_id} {trade.outcome} for ${trade.amount:.2f}."
            )
            await self.logger.warn(
                f"Executed live {trade.side} {trade.market_id} {trade.outcome} amount={trade.amount:.2f}"
            )
        except Exception as exc:
            trade.status = "failed"
            trade.failure_reason = str(exc)
            trade.updated_at = utc_now()
            await self._save_live_trades_unlocked()
            await self.logger.error("Live execution failed", exc)
            raise

    async def _perform_live_baseline_unlocked(self, label: str) -> None:
        if not self.config.use_live_reads or self.active_mode == "mock":
            return
        try:
            traders = await self._read_top_traders_unlocked()
            self.tracked_traders = traders
            source_trades = await self._read_recent_trades_unlocked(traders)
            self._refresh_tracked_trader_activity_unlocked(source_trades)
            for trade in source_trades:
                self._mark_source_trade_seen(trade)
            self.live_source_status.live_baseline_completed_at = utc_now()
            self.live_source_status.seen_live_trades_baseline_count = len(source_trades)
            self._finish_poll_unlocked(
                len(source_trades),
                0,
                0,
                {
                    "after_filters": 0,
                    "skipped_by_filters": 0,
                    "skipped_by_limits": 0,
                    "skipped_duplicates": 0,
                },
            )
            await self.logger.info(
                f"{label} live baseline completed. Existing {len(source_trades)} source trades marked seen; no proposals created."
            )
            self._add_activity(
                f"Live baseline completed. Existing {len(source_trades)} source trades marked seen; no proposals created."
            )
        except Exception as exc:
            message = redact_secrets(str(exc))
            self.live_source_status.last_live_read_error = message
            await self.logger.warn(f"{label} live baseline failed: {message}")
            self._add_activity(f"Live baseline failed: {message}")
            if self.active_mode == "live-trading":
                raise

    async def _refresh_doctor_unlocked(self) -> None:
        self.doctor_status = await self.live_executor.doctor()
        await self._try_auto_unlock_live_unlocked("doctor refresh")

    async def _refresh_doctor_for_start_unlocked(self) -> None:
        await self._refresh_doctor_unlocked()

    def _startup_block_message(self, block_reason: str) -> str:
        if block_reason != "Bullpen doctor must pass.":
            return block_reason
        doctor_message = redact_secrets(self.doctor_status.message).strip()
        if not doctor_message:
            return block_reason
        return f"{block_reason} Last doctor result: {doctor_message}"

    async def _auto_redeem_unlocked(self) -> None:
        if not self.config.auto_redeem_live or not self._wants_live_execution():
            return
        try:
            await self._redeem_live_positions_unlocked(automatic=True)
        except Exception as exc:
            await self.logger.error("Auto-redeem failed", exc)
            self._add_activity(
                f"Auto-redeem failed and bot kept looping: {redact_secrets(str(exc))}"
            )

    async def _redeem_live_positions_unlocked(self, *, automatic: bool = False) -> None:
        if not self._wants_live_execution():
            raise RuntimeError(
                "Live execution is disabled; Bullpen redeem is unavailable."
            )
        try:
            await self.live_executor.redeem(dry_run=False)
        except BullpenCommandError as exc:
            message = redact_secrets(str(exc))
            if not is_redeem_metadata_lookup_warning(message):
                raise
            await self.logger.warn(
                "Bullpen redeem skipped a resolved market missing Gamma metadata: "
                f"{message}"
            )
            self._add_activity(
                "Bullpen redeem checked resolved positions but skipped a market missing Gamma metadata."
            )
        else:
            self._add_activity(
                "Auto-redeem checked and submitted any Bullpen redeemable positions."
                if automatic
                else "Manual Bullpen redeem submitted for all resolved positions."
            )
        self.balance_state = self._with_next_balance_refresh(
            await self.balance_reader.refresh()
        )

    async def _auto_redeem_background(self) -> None:
        async with self._lock:
            should_redeem = (
                self.config.auto_redeem_live and self._wants_live_execution()
            )
        if not should_redeem:
            return
        try:
            await self.live_executor.redeem(dry_run=False)
        except BullpenCommandError as exc:
            message = redact_secrets(str(exc))
            if not is_redeem_metadata_lookup_warning(message):
                raise
            await self.logger.warn(
                "Bullpen redeem skipped a resolved market missing Gamma metadata: "
                f"{message}"
            )
            async with self._lock:
                self._add_activity(
                    "Bullpen redeem checked resolved positions but skipped a market missing Gamma metadata."
                )
        else:
            async with self._lock:
                self._add_activity(
                    "Auto-redeem checked and submitted any Bullpen redeemable positions."
                )

    def _loading_balance_state(self) -> PolymarketBalanceState:
        return self.balance_state.model_copy(
            update={
                "status": "loading",
                "message": "Refreshing Bullpen balance...",
            }
        )

    async def _refresh_balance_background(self) -> None:
        await self._auto_redeem_background()
        async with self._lock:
            self.balance_state = self._loading_balance_state()
        balance_state = self._with_next_balance_refresh(
            await self.balance_reader.refresh()
        )
        async with self._lock:
            self.balance_state = balance_state

    async def _refresh_balance_unlocked(self) -> None:
        await self._auto_redeem_unlocked()
        self.balance_state = self._loading_balance_state()
        self.balance_state = self._with_next_balance_refresh(
            await self.balance_reader.refresh()
        )

    async def _try_auto_unlock_live_unlocked(self, reason: str) -> None:
        if (
            self.config.live_unlock_mode != "automatic"
            or self.live_unlocked
            or self.live_manually_locked
            or self.emergency_stopped
            or not self._wants_live_execution()
        ):
            return
        block_reason = self.live_guard.hard_block_reason(self.doctor_status)
        if block_reason:
            return
        self.live_unlocked = True
        self.live_unlock_mode = "automatic"
        if self.config.use_live_reads:
            self.active_provider = self.provider
            self.active_mode = "live-trading"
            self.live_source_status.source_mode = self.active_mode
        await self.logger.warn(
            f"Live trading auto-unlocked after hard guards passed: {reason}."
        )
        self._add_activity(
            f"Live trading auto-unlocked after hard guards passed: {reason}."
        )

    def _live_decision_from_source(
        self, source_trade: PolymarketSourceTrade
    ) -> PolymarketLiveTradeDecision:
        reason = (
            "Detected live-market-read trade from trending market activity; requires manual confirmation."
            if source_trade.source == "live-market-read"
            else "Detected live-read trade from active trader; requires manual confirmation."
        )
        account = self._matched_tracked_account(source_trade)
        copy_trade_usd = (
            account.copy_trade_usd if account else self.config.fixed_copy_trade_size
        )
        if source_trade.side == "BUY":
            amount = min(
                copy_trade_usd,
                self.config.max_live_trade_size,
                source_trade.size_usd,
            )
            return self._live_decision(
                source_trade, "proposed", amount, amount / source_trade.price, reason
            )

        position = next(
            (
                item
                for item in self._live_positions()
                if item.key
                == live_position_key(source_trade.market_id, source_trade.outcome)
            ),
            None,
        )
        implied_source_shares = source_trade.size_usd / source_trade.price
        shares = min(
            position.shares if position else 0,
            max(0.0001, implied_source_shares * 0.05),
        )
        amount = min(
            copy_trade_usd,
            self.config.max_live_trade_size,
            shares * source_trade.price,
        )
        return self._live_decision(
            source_trade, "proposed", amount, amount / source_trade.price, reason
        )

    def _live_decision(
        self,
        source_trade: PolymarketSourceTrade,
        status: str,
        amount: float,
        shares: float,
        reason: str,
    ) -> PolymarketLiveTradeDecision:
        now = utc_now()
        account = self._matched_tracked_account(source_trade)
        trader_net_worth_usd = account.net_worth_usd if account else 0
        return PolymarketLiveTradeDecision(
            id=str(uuid4()),
            source_trade_id=source_trade.id,
            source_trade_key=source_trade.source_trade_key,
            proposed_at=now,
            updated_at=now,
            trader_id=source_trade.trader_id,
            trader_name=source_trade.trader_name,
            trader_address=source_trade.trader_address,
            trader_handle=source_trade.trader_handle,
            market_id=source_trade.market_id,
            market_title=source_trade.market_title,
            event_end_at=source_trade.event_end_at,
            outcome=source_trade.outcome,
            side=source_trade.side,
            amount=amount,
            price=source_trade.price,
            shares=shares,
            max_loss=amount if source_trade.side == "BUY" else 0,
            trader_invested_usd=source_trade.size_usd,
            trader_net_worth_usd=trader_net_worth_usd,
            reason=reason,
            status=status,
            command="buy" if source_trade.side == "BUY" else "sell",
            source=source_trade.source,
        )

    def _live_state(self) -> PolymarketLiveControlState:
        block_reason = self.live_guard.startup_block_reason(
            self.doctor_status,
            self.live_unlocked,
            self.emergency_stopped,
            self.live_manually_locked,
        )
        return PolymarketLiveControlState(
            enabled_by_env=self._wants_live_execution(),
            unlocked=not block_reason,
            unlock_mode=self.live_unlock_mode if not block_reason else "locked",
            manually_locked=self.live_manually_locked,
            locked_reason=block_reason,
            emergency_stopped=self.emergency_stopped,
            doctor=self.doctor_status,
            balance=self.balance_state,
            source_status=self.live_source_status,
            max_live_trade_size=self.config.max_live_trade_size,
            live_trades_today=self.live_guard.live_trades_today(
                self.live_trade_history
            ),
            pending_confirmations=self._pending_live_trades(),
            recent_decisions=list(reversed(self.live_trade_history)),
        )

    def _finish_poll_unlocked(
        self,
        source_trade_count: int,
        new_trade_count: int,
        new_live_proposal_count: int,
        stats: dict[str, object],
    ) -> None:
        self.live_source_status.source_mode = self.active_mode
        self.live_source_status.last_poll_time = self.last_poll_at
        self.live_source_status.source_trades_found_last_poll = source_trade_count
        self.live_source_status.new_live_proposals_created_last_poll = max(
            0, new_live_proposal_count
        )
        self.live_source_status.source_trades_after_filters_last_poll = int(
            stats.get("after_filters", 0)
        )
        self.live_source_status.skipped_by_filters_last_poll = int(
            stats.get("skipped_by_filters", 0)
        )
        self.live_source_status.skipped_by_limits_last_poll = int(
            stats.get("skipped_by_limits", 0)
        )
        self.live_source_status.skipped_duplicates_last_poll = int(
            stats.get("skipped_duplicates", 0)
        )
        new_trade_label = (
            "new live proposals" if self.active_mode == "live-trading" else "new trades"
        )
        activity_count = (
            max(0, new_live_proposal_count)
            if self.active_mode == "live-trading"
            else new_trade_count
        )
        self._add_activity(
            f"Poll completed. Source trades={source_trade_count}, {new_trade_label}={activity_count}."
        )
        self._schedule_next_poll_unlocked()

    def _pending_live_trades(self) -> list[PolymarketLiveTradeDecision]:
        return [
            trade
            for trade in self.live_trade_history
            if trade.status == "proposed"
            and trade.source in ("live-read", "live-market-read")
        ]

    def _is_source_trade_seen(self, source_trade: PolymarketSourceTrade) -> bool:
        return (
            source_trade.id in self.seen_source_trades
            or source_trade.source_trade_key in self.seen_source_trades
        )

    def _mark_source_trade_seen(self, source_trade: PolymarketSourceTrade) -> None:
        self.seen_source_trades.add(source_trade.id)
        self.seen_source_trades.add(source_trade.source_trade_key)

    def _duplicate_live_source_reason(
        self, source_trade: PolymarketSourceTrade
    ) -> str | None:
        if any(
            trade.source_trade_id == source_trade.id
            or trade.source_trade_key == source_trade.source_trade_key
            for trade in self.live_trade_history
        ):
            return "Duplicate live source trade ignored"
        if any(
            trade.source_trade_key == source_trade.source_trade_key
            for trade in self._pending_live_trades()
        ):
            return "Duplicate pending confirmation ignored"
        return None

    def _proposal_block_reason(
        self,
        source_trade: PolymarketSourceTrade,
        proposal_stats: dict[str, object],
    ) -> dict[str, str] | None:
        import re

        trader_key = identity_key(
            source_trade.clean_trader_identity
            or source_trade.trader_address
            or source_trade.trader_handle
            or source_trade.trader_id
        )
        title = source_trade.market_title or source_trade.market_id
        handle = source_trade.trader_handle or source_trade.trader_name or ""

        def regex_matches(pattern: str, value: str) -> bool:
            if not pattern:
                return False
            try:
                return bool(re.search(pattern, value, re.IGNORECASE))
            except re.error:
                return False

        if self.config.require_manual_tracked_wallets_for_live and not any(
            "Manual" in trader.source_reason for trader in self.tracked_traders
        ):
            return {"kind": "filter", "reason": "Manual tracked wallet required"}
        if regex_matches(self.config.exclude_market_title_regex, title):
            return {"kind": "filter", "reason": "Market excluded by title filter."}
        if self.config.allow_market_title_regex and not regex_matches(
            self.config.allow_market_title_regex, title
        ):
            return {"kind": "filter", "reason": "Market excluded by title filter."}
        if regex_matches(self.config.exclude_trader_handle_regex, handle):
            return {"kind": "filter", "reason": "Trader handle excluded by filter."}
        if self.config.allow_trader_handle_regex and not regex_matches(
            self.config.allow_trader_handle_regex, handle
        ):
            return {"kind": "filter", "reason": "Trader handle excluded by filter."}
        account = self._matched_tracked_account(source_trade)
        if account:
            if account.net_worth_usd <= 0 or (
                account.tracking_source == "leaderboard"
                and not account.net_worth_checked_at
            ):
                return {
                    "kind": "filter",
                    "reason": "Tracked account net worth refresh pending.",
                }
            threshold_usd = account.net_worth_usd * (account.threshold_percent / 100)
            if source_trade.size_usd < threshold_usd:
                return {
                    "kind": "filter",
                    "reason": (
                        f"Source trade ${source_trade.size_usd:.2f} below "
                        f"{account.threshold_percent:.2f}% net-worth threshold (${threshold_usd:.2f})."
                    ),
                }
        elif source_trade.size_usd < self.config.min_source_trade_size_usd:
            return {"kind": "filter", "reason": "Source trade size below minimum"}
        if (
            source_trade.price < self.config.min_copy_price
            or source_trade.price > self.config.max_copy_price
        ):
            return {"kind": "filter", "reason": "Price outside allowed range"}
        if len(self._pending_live_trades()) >= self.config.max_pending_confirmations:
            return {"kind": "limit", "reason": "Max pending confirmations reached"}
        if (
            int(proposal_stats["created"])
            >= self.config.max_new_live_proposals_per_poll
        ):
            return {"kind": "limit", "reason": "Max proposals per poll reached"}
        if (
            proposal_stats["per_trader_created"][trader_key]
            >= self.config.max_new_live_proposals_per_trader_per_poll
        ):
            return {"kind": "limit", "reason": "Max proposals per trader reached"}
        if (
            len(
                [
                    trade
                    for trade in self._pending_live_trades()
                    if identity_key(
                        trade.trader_address or trade.trader_handle or trade.trader_id
                    )
                    == trader_key
                ]
            )
            >= self.config.max_pending_per_trader
        ):
            return {"kind": "limit", "reason": "Max pending confirmations reached"}
        last_proposal_at = self.proposal_cooldown_by_trader.get(trader_key, 0)
        if (
            datetime.now(timezone.utc).timestamp() - last_proposal_at
            < self.config.proposal_cooldown_seconds_per_trader
        ):
            return {"kind": "limit", "reason": "Trader cooldown active"}
        return None

    def _apply_provider_discovery_status_unlocked(self) -> None:
        provider = self.active_provider
        status = (
            provider.get_discovery_status()
            if hasattr(provider, "get_discovery_status")
            else None
        )
        if not status:
            return
        self.live_source_status.discovery_mode = status.discovery_mode
        self.live_source_status.active_traders_found = status.active_traders_found
        self.live_source_status.candidate_rows_considered = (
            status.candidate_rows_considered
        )
        self.live_source_status.candidate_wallets_extracted = (
            status.candidate_wallets_extracted
        )
        self.live_source_status.fallback_traders_selected = (
            status.fallback_traders_selected
        )
        self.live_source_status.activity_source_used = status.activity_source_used
        self.live_source_status.rows_rejected_last_discovery = (
            status.rows_rejected_last_discovery
        )
        self.live_source_status.accepted_activity_trades_last_discovery = (
            status.accepted_activity_trades_last_discovery
        )
        self.live_source_status.manual_wallets_configured = (
            status.manual_wallets_configured
        )
        self.live_source_status.manual_wallets_valid = status.manual_wallets_valid
        self.live_source_status.manual_wallets_invalid = status.manual_wallets_invalid
        self.live_source_status.manual_tracked_wallets = status.manual_tracked_wallets
        self.live_source_status.last_active_trader_discovery_time = (
            status.last_active_trader_discovery_time
        )
        self.live_source_status.last_discovery_error = status.last_discovery_error
        self.live_source_status.trending_market_activity_enabled = (
            status.trending_market_activity_enabled
        )
        self.live_source_status.trending_market_activity_unavailable = (
            status.trending_market_activity_unavailable
        )

    def _ensure_net_worth_refresh_task(self) -> None:
        if self._net_worth_refresh_task and not self._net_worth_refresh_task.done():
            return
        self._net_worth_refresh_task = asyncio.create_task(
            self._refresh_all_tracked_account_net_worths()
        )

    async def _refresh_all_tracked_account_net_worths(self) -> None:
        async with self._lock:
            account_ids = [account.id for account in self.tracked_accounts]
        for account_id in account_ids:
            try:
                await self.refresh_tracked_account_net_worth(account_id)
            except Exception as exc:
                await self.logger.error(
                    f"Tracked account net worth refresh failed account={account_id}: {redact_secrets(str(exc))}"
                )

    async def refresh_tracked_account_net_worth(
        self, account_id: str
    ) -> PolymarketTrackedAccount:
        async with self._lock:
            account = self._find_tracked_account(account_id)
            target = account.target

        try:
            estimate = await estimate_polymarket_net_worth(target)
        except Exception as exc:
            message = redact_secrets(str(exc))
            async with self._lock:
                account = self._find_tracked_account(account_id)
                account.net_worth_error = message
                account.net_worth_checked_at = utc_now()
                account.updated_at = utc_now()
                await self._save_tracked_accounts_unlocked()
                self._add_activity(
                    f"Net worth refresh failed for {account.target}: {message}"
                )
                return account

        async with self._lock:
            account = self._find_tracked_account(account_id)
            if account.target != target:
                return account
            account.proxy_wallet = estimate.wallet
            account.address = estimate.wallet
            account.net_worth_usd = estimate.net_worth_usd
            account.positions_value_usd = estimate.positions_value_usd
            account.cash_balance_usd = estimate.cash_balance_usd
            account.redeemable_value_usd = estimate.redeemable_value_usd
            account.net_worth_source = "polymarket_public_api_plus_polygon_pusd"
            account.net_worth_checked_at = utc_now()
            account.net_worth_error = None
            account.updated_at = utc_now()
            await self._save_tracked_accounts_unlocked()
            self._apply_tracked_accounts_to_provider_unlocked()
            self._add_activity(
                f"Net worth refreshed for {account.target}: ${account.net_worth_usd:.2f}."
            )
            return account

    async def _load_or_seed_tracked_accounts_unlocked(
        self,
    ) -> list[PolymarketTrackedAccount]:
        accounts = await self.tracked_account_store.load()
        if accounts:
            return accounts
        defaults = [
            "https://polymarket.com/@weatherstappen",
            "https://polymarket.com/@weatherhk",
            "https://polymarket.com/@opopv2",
            "https://polymarket.com/@empusa",
        ]
        now = utc_now()
        accounts = [
            PolymarketTrackedAccount(
                id=tracked_account_id(normalize_tracked_account_target(target)),
                target=normalize_tracked_account_target(target),
                handle=tracked_account_handle(normalize_tracked_account_target(target)),
                address=(
                    normalize_tracked_account_target(target)
                    if normalize_tracked_account_target(target).startswith("0x")
                    else ""
                ),
                proxy_wallet=(
                    normalize_tracked_account_target(target)
                    if normalize_tracked_account_target(target).startswith("0x")
                    else None
                ),
                profile_url=tracked_account_profile_url(
                    normalize_tracked_account_target(target)
                ),
                threshold_percent=5,
                net_worth_usd=100,
                copy_trade_usd=1,
                enabled=True,
                tracking_source="manual",
                created_at=now,
                updated_at=now,
            )
            for target in defaults
        ]
        await self.tracked_account_store.save(accounts)
        return accounts

    async def _sync_leaderboard_tracked_accounts_unlocked(
        self, traders: list[PolymarketTrader]
    ) -> None:
        leaderboard_traders = [
            trader
            for trader in traders
            if "leaderboard" in trader.source_reason.lower()
        ]
        if not leaderboard_traders:
            return

        now = utc_now()
        leaderboard_ids = {
            tracked_account_id(
                normalize_tracked_account_target(
                    trader.address or trader.handle or trader.name or trader.id
                )
            )
            for trader in leaderboard_traders
            if trader.address or trader.handle or trader.name or trader.id
        }
        existing_by_id = {account.id: account for account in self.tracked_accounts}
        changed = False

        for trader in leaderboard_traders:
            target = normalize_tracked_account_target(
                trader.address or trader.handle or trader.name or trader.id
            )
            if not target:
                continue
            account_id = tracked_account_id(target)
            existing = existing_by_id.get(account_id)
            if existing:
                existing.target = target
                existing.handle = tracked_account_handle(target) or trader.handle
                existing.address = trader.address or existing.address
                existing.proxy_wallet = trader.address or existing.proxy_wallet
                existing.profile_url = (
                    trader.polymarket_profile_url
                    or trader.profile_url
                    or tracked_account_profile_url(target)
                )
                if existing.tracking_source != "manual":
                    existing.tracking_source = "leaderboard"
                    existing.threshold_percent = 5
                    existing.copy_trade_usd = 1
                    existing.enabled = True
                existing.updated_at = now
                changed = True
                continue

            self.tracked_accounts.append(
                PolymarketTrackedAccount(
                    id=account_id,
                    target=target,
                    handle=tracked_account_handle(target) or trader.handle,
                    address=trader.address
                    or (target if target.startswith("0x") else ""),
                    proxy_wallet=(
                        trader.address or (target if target.startswith("0x") else None)
                    ),
                    profile_url=(
                        trader.polymarket_profile_url
                        or trader.profile_url
                        or tracked_account_profile_url(target)
                    ),
                    threshold_percent=5,
                    net_worth_usd=100,
                    copy_trade_usd=1,
                    enabled=True,
                    tracking_source="leaderboard",
                    net_worth_source="pending_refresh",
                    net_worth_error="Net worth refresh pending for leaderboard account.",
                    created_at=now,
                    updated_at=now,
                )
            )
            changed = True

        kept_accounts = [
            account
            for account in self.tracked_accounts
            if account.tracking_source == "manual" or account.id in leaderboard_ids
        ]
        if len(kept_accounts) != len(self.tracked_accounts):
            self.tracked_accounts = kept_accounts
            changed = True

        if changed:
            await self._save_tracked_accounts_unlocked()
            self._apply_tracked_accounts_to_provider_unlocked()
            self._ensure_net_worth_refresh_task()
            self._add_activity(
                f"Synced {len(leaderboard_ids)} leaderboard tracked accounts from weekly/today profit leaderboards."
            )

    def _tracked_account_from_request(
        self, request: PolymarketTrackedAccountCreate
    ) -> PolymarketTrackedAccount:
        normalized = normalize_tracked_account_target(request.target)
        now = utc_now()
        return PolymarketTrackedAccount(
            id=tracked_account_id(normalized),
            target=normalized,
            handle=tracked_account_handle(normalized),
            address=normalized if normalized.startswith("0x") else "",
            proxy_wallet=normalized if normalized.startswith("0x") else None,
            profile_url=tracked_account_profile_url(normalized),
            threshold_percent=request.threshold_percent,
            net_worth_usd=request.net_worth_usd,
            copy_trade_usd=request.copy_trade_usd,
            enabled=request.enabled,
            tracking_source="manual",
            created_at=now,
            updated_at=now,
        )

    def _find_tracked_account(self, account_id: str) -> PolymarketTrackedAccount:
        account = next(
            (item for item in self.tracked_accounts if item.id == account_id), None
        )
        if not account:
            raise RuntimeError("Tracked account not found.")
        return account

    async def _save_tracked_accounts_unlocked(self) -> None:
        await self.tracked_account_store.save(self.tracked_accounts)

    def _apply_tracked_accounts_to_provider_unlocked(self) -> None:
        targets = ",".join(
            account.target for account in self.tracked_accounts if account.enabled
        )
        self.config.manual_tracked_wallets = targets
        if hasattr(self.provider, "update_manual_targets"):
            self.provider.update_manual_targets(targets)
        if hasattr(self.active_provider, "update_manual_targets"):
            self.active_provider.update_manual_targets(targets)

    def _matched_tracked_account(
        self, source_trade: PolymarketSourceTrade
    ) -> PolymarketTrackedAccount | None:
        identities = {
            identity_key(value)
            for value in (
                source_trade.clean_trader_identity,
                source_trade.trader_address,
                source_trade.trader_handle,
                source_trade.trader_name,
                source_trade.trader_id,
            )
            if value
        }
        for account in self.tracked_accounts:
            if not account.enabled:
                continue
            account_ids = {
                identity_key(value)
                for value in (account.target, account.handle, account.address)
                if value
            }
            if identities & account_ids:
                return account
        return None

    def _paper_trade(
        self,
        source_trade: PolymarketSourceTrade,
        status: str,
        copied_usd: float,
        shares: float,
        realized_pnl: float,
        reason: str | None = None,
    ) -> PolymarketPaperTrade:
        return PolymarketPaperTrade(
            id=str(uuid4()),
            source_trade_id=source_trade.id,
            timestamp=utc_now(),
            trader_id=source_trade.trader_id,
            trader_name=source_trade.trader_name,
            market_id=source_trade.market_id,
            market_title=source_trade.market_title,
            event_end_at=source_trade.event_end_at,
            outcome=source_trade.outcome,
            side=source_trade.side,
            price=source_trade.price,
            copied_usd=copied_usd,
            shares=shares,
            realized_pnl=realized_pnl,
            status=status,
            reason=reason,
        )

    async def _record_trade_unlocked(self, trade: PolymarketPaperTrade) -> None:
        self.trade_history.append(trade)
        await self.store.save(self.trade_history)
        await self.logger.info(
            f"{trade.status.upper()} {trade.side} {trade.market_id} {trade.outcome} copiedUsd={trade.copied_usd:.2f} reason={trade.reason or 'ok'}"
        )

    async def _record_live_trade_unlocked(
        self, trade: PolymarketLiveTradeDecision
    ) -> None:
        self.live_trade_history.append(trade)
        await self._save_live_trades_unlocked()
        await self.logger.info(
            f"{trade.status.upper()} LIVE {trade.side} {trade.market_id} {trade.outcome} amount={trade.amount:.2f} reason={trade.reason}"
        )

    async def _save_live_trades_unlocked(self) -> None:
        await self.live_store.save(self.live_trade_history)

    def _find_pending_live_trade(self, trade_id: str) -> PolymarketLiveTradeDecision:
        trade = next(
            (item for item in self.live_trade_history if item.id == trade_id), None
        )
        if not trade:
            raise RuntimeError("Live trade not found.")
        if trade.status != "proposed":
            raise RuntimeError(
                f"Live trade is not pending confirmation: {trade.status}."
            )
        if trade.source not in ("live-read", "live-market-read"):
            raise RuntimeError(
                "Live trade confirmation is allowed only for live-read or live-market-read source trades."
            )
        return trade

    def _risk_block_reason(self, source_trade: PolymarketSourceTrade) -> str | None:
        if self._trades_today_count() >= self.config.max_trades_per_day:
            return "Max trades per day reached."
        if self._metrics().total_pnl <= -self.config.max_daily_loss:
            return "Max daily loss reached."
        if source_trade.side == "BUY":
            position = next(
                (
                    item
                    for item in self._positions()
                    if item.key == f"{source_trade.market_id}::{source_trade.outcome}"
                ),
                None,
            )
            current_exposure = position.cost_basis if position else 0
            next_exposure = current_exposure + min(
                self.config.fixed_copy_trade_size, self.config.max_trade_size
            )
            if next_exposure > self.config.max_exposure_per_market:
                return "Max exposure per market reached."
        return None

    def _trades_today_count(self) -> int:
        today = utc_now()[:10]
        return len(
            [
                trade
                for trade in self.trade_history
                if trade.timestamp.startswith(today) and trade.status == "executed"
            ]
        )

    def _positions(self) -> list[PolymarketPosition]:
        positions: dict[str, PolymarketPosition] = {}
        for trade in self.trade_history:
            if trade.status != "executed":
                continue
            key = f"{trade.market_id}::{trade.outcome}"
            existing = positions.get(
                key,
                PolymarketPosition(
                    key=key,
                    market_id=trade.market_id,
                    market_title=trade.market_title,
                    outcome=trade.outcome,
                    shares=0,
                    average_price=0,
                    cost_basis=0,
                ),
            )
            if trade.side == "BUY":
                existing.cost_basis += trade.copied_usd
                existing.shares += trade.shares
                existing.average_price = (
                    existing.cost_basis / existing.shares if existing.shares > 0 else 0
                )
            else:
                sold_shares = abs(trade.shares)
                existing.shares -= sold_shares
                existing.cost_basis = max(
                    0.0, existing.cost_basis - sold_shares * existing.average_price
                )
            if existing.shares > 0.000001:
                positions[key] = existing
            elif key in positions:
                del positions[key]
        return list(positions.values())

    def _live_positions(self) -> list[PolymarketPosition]:
        positions: dict[str, PolymarketPosition] = {}
        for trade in self.live_trade_history:
            if trade.status != "executed":
                continue
            key = live_position_key(trade.market_id, trade.outcome)
            existing = positions.get(
                key,
                PolymarketPosition(
                    key=key,
                    market_id=trade.market_id,
                    market_title=trade.market_title,
                    outcome=trade.outcome,
                    shares=0,
                    average_price=0,
                    cost_basis=0,
                ),
            )
            if trade.side == "BUY":
                existing.cost_basis += trade.amount
                existing.shares += trade.shares
                existing.average_price = (
                    existing.cost_basis / existing.shares if existing.shares > 0 else 0
                )
            else:
                existing.shares -= trade.shares
                existing.cost_basis = max(
                    0.0, existing.cost_basis - trade.shares * existing.average_price
                )
            if existing.shares > 0.000001:
                positions[key] = existing
            elif key in positions:
                del positions[key]
        return list(positions.values())

    def _metrics(self) -> PolymarketMetrics:
        executed = [trade for trade in self.trade_history if trade.status == "executed"]
        sell_trades = [trade for trade in executed if trade.side == "SELL"]
        winners = len([trade for trade in sell_trades if trade.realized_pnl > 0])
        losers = len([trade for trade in sell_trades if trade.realized_pnl < 0])
        return PolymarketMetrics(
            total_pnl=sum(trade.realized_pnl for trade in sell_trades),
            win_rate=(winners / len(sell_trades)) if sell_trades else 0,
            total_trades=len(executed),
            winners=winners,
            losers=losers,
            skipped=len(
                [trade for trade in self.trade_history if trade.status == "skipped"]
            ),
            failed=len(
                [trade for trade in self.trade_history if trade.status == "failed"]
            ),
        )

    def _with_next_balance_refresh(
        self, state: PolymarketBalanceState
    ) -> PolymarketBalanceState:
        next_refresh = (
            datetime.now(timezone.utc).timestamp()
            + BALANCE_REFRESH_INTERVAL_SECONDS
        )
        state.next_refresh_at = datetime.fromtimestamp(
            next_refresh, tz=timezone.utc
        ).isoformat()
        return state

    def _schedule_next_poll_unlocked(self) -> None:
        if not self.running:
            self.next_poll_at = None
            return
        next_poll = datetime.now(timezone.utc).timestamp() + max(
            self.config.poll_interval_ms / 1000, 1
        )
        self.next_poll_at = datetime.fromtimestamp(
            next_poll, tz=timezone.utc
        ).isoformat()

    def _seconds_until_next_poll(self, now_iso: str) -> int:
        if not self.running or not self.next_poll_at:
            return 0
        now_dt = datetime.fromisoformat(now_iso)
        next_dt = datetime.fromisoformat(self.next_poll_at)
        return max(0, int((next_dt - now_dt).total_seconds() + 0.999))

    def _add_activity(self, message: str) -> None:
        self.recent_activity.insert(
            0, PolymarketActivity(timestamp=utc_now(), message=message)
        )
        self.recent_activity = self.recent_activity[:20]

    def _wants_live_execution(self) -> bool:
        return (not self.config.paper_trading) or self.config.live_trading

    @staticmethod
    async def _cancel_task(task: asyncio.Task[None] | None) -> None:
        if not task or task.done():
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            return


def normalize_tracked_account_target(value: str) -> str:
    raw = value.strip().rstrip("?")
    parsed = urlparse(raw)
    if parsed.netloc:
        segment = parsed.path.rstrip("/").rsplit("/", 1)[-1]
        raw = segment or raw
    raw = raw.lstrip("@").strip().strip("/").split("?", 1)[0]
    return raw


def tracked_account_id(target: str) -> str:
    return identity_key(target)


def tracked_account_handle(target: str) -> str | None:
    return None if target.startswith("0x") else target.lstrip("@")


def tracked_account_profile_url(target: str) -> str | None:
    if target.startswith("0x"):
        return f"https://polymarket.com/profile/{target}"
    handle = tracked_account_handle(target)
    return f"https://polymarket.com/@{handle}" if handle else None
