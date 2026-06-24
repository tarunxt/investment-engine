from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import uuid4

from app.domains.polymarket_auto_live.console_profile import (
    CONSOLE_PROFILE_ID,
    next_console_schedule_time,
)
from app.domains.polymarket_auto_live.config import auto_live_backend_allows_execution
from app.domains.polymarket_auto_live.repository import (
    AsyncPolymarketAutoLiveRepository,
    apply_run_to_record,
    record_to_run,
    record_to_settings,
    record_to_state,
)
from app.domains.polymarket_auto_live.schemas import (
    BullpenAutoLiveBotCardSummary,
    BullpenAutoLiveDecision,
    BullpenAutoLiveGuardrailCheck,
    BullpenAutoLiveRun,
    BullpenAutoLiveSettings,
    BullpenAutoLiveSettingsUpdate,
    BullpenAutoLiveState,
    BullpenAutoLiveSummary,
    TradingBotGuardrail,
)
from app.infrastructure.database.session import AsyncSessionLocal

AUTO_LIVE_STRATEGY_SUMMARY = (
    "Fully automated AI + evidence + market-rules based Bullpen trading engine. "
    "Scans markets, parses rules, builds shared evidence, runs LLM consensus, "
    "scores edges, sizes positions, rebalances active positions, and executes "
    "live limit orders only when all guardrails pass."
)
AUTO_LIVE_RISK_SUMMARY = (
    "Full automation can compound model, evidence, and execution errors quickly "
    "once live trading is enabled."
)
CONSOLE_AUTO_LIVE_STRATEGY_SUMMARY = (
    "Runs the Bullpen console top-10 profile on a fixed IST schedule. Each cycle "
    "scans upcoming markets, runs LLM consensus, buys $5 of each new No-side "
    "opportunity in the top-10 returns/day table, and exits active positions that "
    "fall outside that top 10."
)
CONSOLE_AUTO_LIVE_RISK_SUMMARY = (
    "The console profile still depends on Bullpen live session health, doctor "
    "checks, balance availability, and limit-order guardrails before any live "
    "orders are submitted."
)


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


def round_money(value: float | None) -> float | None:
    if value is None:
        return None
    return round(value, 2)


def live_execution_requested(settings: BullpenAutoLiveSettings) -> bool:
    return (
        settings.auto_live_enabled
        and not settings.dry_run
        and settings.allow_live_execution
    )


def live_execution_armed(settings: BullpenAutoLiveSettings) -> bool:
    return live_execution_requested(settings) and auto_live_backend_allows_execution()


def effective_dry_run(settings: BullpenAutoLiveSettings) -> bool:
    return not live_execution_armed(settings)


def strategy_summary_for(settings: BullpenAutoLiveSettings) -> str:
    if settings.strategy_profile == CONSOLE_PROFILE_ID:
        return CONSOLE_AUTO_LIVE_STRATEGY_SUMMARY
    return AUTO_LIVE_STRATEGY_SUMMARY


def risk_summary_for(settings: BullpenAutoLiveSettings) -> str:
    if settings.strategy_profile == CONSOLE_PROFILE_ID:
        return CONSOLE_AUTO_LIVE_RISK_SUMMARY
    return AUTO_LIVE_RISK_SUMMARY


class BullpenAutoLiveBot:
    def __init__(self, user_id: int) -> None:
        self.user_id = user_id

    async def get_settings(self) -> BullpenAutoLiveSettings:
        async with AsyncSessionLocal() as session:
            repo = AsyncPolymarketAutoLiveRepository(session)
            settings = await repo.ensure_settings(self.user_id)
            state = await repo.ensure_state(self.user_id)
            normalized_state = self._synchronize_state(settings, state)
            await repo.save_state(self.user_id, normalized_state)
            await session.commit()
            return settings

    async def update_settings(
        self, update: BullpenAutoLiveSettingsUpdate
    ) -> BullpenAutoLiveSettings:
        async with AsyncSessionLocal() as session:
            repo = AsyncPolymarketAutoLiveRepository(session)
            settings = await repo.ensure_settings(self.user_id)
            merged = settings.model_dump()
            merged.update(update.model_dump(exclude_unset=True))
            validated = BullpenAutoLiveSettings.model_validate(merged)
            state = self._synchronize_state(
                validated,
                await repo.ensure_state(self.user_id),
            )
            await repo.save_settings(self.user_id, validated)
            await repo.save_state(self.user_id, state)
            await session.commit()
            return validated

    async def reset_settings(self) -> BullpenAutoLiveSettings:
        async with AsyncSessionLocal() as session:
            repo = AsyncPolymarketAutoLiveRepository(session)
            settings = BullpenAutoLiveSettings()
            state = self._synchronize_state(settings, await repo.ensure_state(self.user_id))
            await repo.save_settings(self.user_id, settings)
            await repo.save_state(self.user_id, state)
            await session.commit()
            return settings

    async def get_state(self) -> BullpenAutoLiveState:
        async with AsyncSessionLocal() as session:
            repo = AsyncPolymarketAutoLiveRepository(session)
            settings = await repo.ensure_settings(self.user_id)
            state = self._synchronize_state(settings, await repo.ensure_state(self.user_id))
            await repo.save_state(self.user_id, state)
            await session.commit()
            return state

    async def get_summary(self) -> BullpenAutoLiveSummary:
        async with AsyncSessionLocal() as session:
            repo = AsyncPolymarketAutoLiveRepository(session)
            settings = await repo.ensure_settings(self.user_id)
            state = self._synchronize_state(settings, await repo.ensure_state(self.user_id))
            runs = await repo.list_runs(self.user_id, limit=10)
            decisions = await repo.list_decisions(self.user_id, limit=25)
            await repo.save_state(self.user_id, state)
            await session.commit()
            latest_guardrails = self._build_guardrail_checks(settings, state)
            return BullpenAutoLiveSummary(
                state=state,
                settings=settings,
                bot_card=self._build_bot_card_summary(settings, state, latest_guardrails),
                latest_run=runs[0] if runs else None,
                recent_runs=runs,
                recent_decisions=decisions[:10],
                latest_guardrail_checks=latest_guardrails,
            )

    async def list_runs(self) -> list[BullpenAutoLiveRun]:
        async with AsyncSessionLocal() as session:
            repo = AsyncPolymarketAutoLiveRepository(session)
            return await repo.list_runs(self.user_id)

    async def list_decisions(self) -> list[BullpenAutoLiveDecision]:
        async with AsyncSessionLocal() as session:
            repo = AsyncPolymarketAutoLiveRepository(session)
            return await repo.list_decisions(self.user_id)

    async def run_once(self, *, triggered_by: str = "manual") -> BullpenAutoLiveRun:
        from app.domains.polymarket_auto_live.tasks import execute_polymarket_auto_live_run

        async with AsyncSessionLocal() as session:
            repo = AsyncPolymarketAutoLiveRepository(session)
            settings = await repo.ensure_settings(self.user_id)
            state = self._synchronize_state(settings, await repo.ensure_state(self.user_id))
            if settings.emergency_stop:
                run = BullpenAutoLiveRun(
                    id=str(uuid4()),
                    triggered_by=triggered_by,  # type: ignore[arg-type]
                    status="skipped",
                    dry_run=effective_dry_run(settings),
                    started_at=utc_now(),
                    completed_at=utc_now(),
                    summary="Emergency stop is active.",
                    guardrail_checks=self._build_guardrail_checks(settings, state),
                )
                run_record = self._new_run_record(run)
                session.add(run_record)
                state.last_action = run.summary
                state.last_run_id = run.id
                await repo.save_state(self.user_id, state)
                await session.commit()
                return run

            running_record = await repo.get_running_run_record(self.user_id)
            if running_record is not None:
                running_run = record_to_run(running_record)
                run = BullpenAutoLiveRun(
                    id=str(uuid4()),
                    triggered_by=triggered_by,  # type: ignore[arg-type]
                    status="skipped",
                    dry_run=effective_dry_run(settings),
                    started_at=utc_now(),
                    completed_at=utc_now(),
                    summary=f"Run {running_run.id} is already in progress.",
                    guardrail_checks=self._build_guardrail_checks(settings, state),
                )
                session.add(self._new_run_record(run))
                state.last_action = run.summary
                state.last_run_id = run.id
                await repo.save_state(self.user_id, state)
                await session.commit()
                return run

            run = BullpenAutoLiveRun(
                id=str(uuid4()),
                triggered_by=triggered_by,  # type: ignore[arg-type]
                status="running",
                dry_run=effective_dry_run(settings),
                started_at=utc_now(),
                summary="Auto-Live run queued.",
                live_execution_requested=live_execution_requested(settings),
                guardrail_checks=self._build_guardrail_checks(settings, state),
            )
            session.add(self._new_run_record(run))
            state.last_action = run.summary
            state.last_run_id = run.id
            if not state.running:
                state.running = triggered_by in {"start", "resume"}
            if state.running:
                self._schedule_next_cycles(settings, state, reference_time=datetime.now(UTC))
            await repo.save_state(self.user_id, state)
            await session.commit()
            execute_polymarket_auto_live_run.delay(self.user_id, run.id)  # type: ignore[attr-defined]
            return run

    async def start(self) -> BullpenAutoLiveState:
        async with AsyncSessionLocal() as session:
            repo = AsyncPolymarketAutoLiveRepository(session)
            settings = await repo.ensure_settings(self.user_id)
            state = self._synchronize_state(settings, await repo.ensure_state(self.user_id))
            state.running = True
            state.paused = False
            state.started_at = utc_now()
            state.stopped_at = None
            state.last_action = "Auto-Live scheduler started."
            self._schedule_next_cycles(settings, state, reference_time=datetime.now(UTC))
            await repo.save_state(self.user_id, state)
            await session.commit()
            return state

    async def stop(self) -> BullpenAutoLiveState:
        async with AsyncSessionLocal() as session:
            repo = AsyncPolymarketAutoLiveRepository(session)
            settings = await repo.ensure_settings(self.user_id)
            state = self._synchronize_state(settings, await repo.ensure_state(self.user_id))
            state.running = False
            state.stopped_at = utc_now()
            state.next_run_at = None
            state.next_scan_at = None
            state.next_llm_run_at = None
            state.next_rebalance_at = None
            state.last_action = "Auto-Live scheduler stopped."
            await repo.save_state(self.user_id, state)
            await session.commit()
            return state

    async def pause(self) -> BullpenAutoLiveState:
        async with AsyncSessionLocal() as session:
            repo = AsyncPolymarketAutoLiveRepository(session)
            settings = await repo.ensure_settings(self.user_id)
            state = self._synchronize_state(settings, await repo.ensure_state(self.user_id))
            state.paused = True
            state.last_action = "Auto-Live scheduler paused."
            await repo.save_state(self.user_id, state)
            await session.commit()
            return state

    async def resume(self) -> BullpenAutoLiveState:
        async with AsyncSessionLocal() as session:
            repo = AsyncPolymarketAutoLiveRepository(session)
            settings = await repo.ensure_settings(self.user_id)
            state = self._synchronize_state(settings, await repo.ensure_state(self.user_id))
            state.running = True
            state.paused = False
            state.last_action = "Auto-Live scheduler resumed."
            self._schedule_next_cycles(settings, state, reference_time=datetime.now(UTC))
            await repo.save_state(self.user_id, state)
            await session.commit()
            return state

    async def emergency_stop(self) -> BullpenAutoLiveState:
        async with AsyncSessionLocal() as session:
            repo = AsyncPolymarketAutoLiveRepository(session)
            settings = await repo.ensure_settings(self.user_id)
            settings = settings.model_copy(update={"emergency_stop": True})
            state = self._synchronize_state(settings, await repo.ensure_state(self.user_id))
            state.paused = True
            state.last_action = "Emergency stop activated."
            await repo.save_settings(self.user_id, settings)
            await repo.save_state(self.user_id, state)
            await session.commit()
            return state

    async def clear_emergency_stop(self) -> BullpenAutoLiveState:
        async with AsyncSessionLocal() as session:
            repo = AsyncPolymarketAutoLiveRepository(session)
            settings = await repo.ensure_settings(self.user_id)
            settings = settings.model_copy(update={"emergency_stop": False})
            state = self._synchronize_state(settings, await repo.ensure_state(self.user_id))
            state.last_action = "Emergency stop cleared."
            await repo.save_settings(self.user_id, settings)
            await repo.save_state(self.user_id, state)
            await session.commit()
            return state

    def _new_run_record(self, run: BullpenAutoLiveRun):
        from app.domains.polymarket_auto_live.models import PolymarketAutoLiveRunRecord

        record = PolymarketAutoLiveRunRecord(
            id=run.id,
            user_id=self.user_id,
            status=run.status,
            triggered_by=run.triggered_by,
            dry_run=run.dry_run,
            started_at=datetime.fromisoformat(run.started_at),
            summary=run.summary,
            payload={},
        )
        apply_run_to_record(record, run, user_id=self.user_id)
        return record

    def _build_guardrail_checks(
        self,
        settings: BullpenAutoLiveSettings,
        state: BullpenAutoLiveState,
    ) -> list[BullpenAutoLiveGuardrailCheck]:
        if state.latest_guardrail_checks:
            return state.latest_guardrail_checks

        checked_at = utc_now()
        return [
            BullpenAutoLiveGuardrailCheck(
                id="auto-live-enabled",
                label="Auto-live enabled",
                status="pass" if settings.auto_live_enabled else "watch",
                detail="Automation can schedule live evaluation cycles."
                if settings.auto_live_enabled
                else "Automation is disabled; use manual runs only.",
                value="On" if settings.auto_live_enabled else "Off",
                checked_at=checked_at,
            ),
            BullpenAutoLiveGuardrailCheck(
                id="live-execution-env",
                label="Backend live execution",
                status="pass" if auto_live_backend_allows_execution() else "watch",
                detail="Backend environment allows live execution."
                if auto_live_backend_allows_execution()
                else "Backend environment still blocks live execution.",
                value="Allowed" if auto_live_backend_allows_execution() else "Blocked",
                checked_at=checked_at,
            ),
            BullpenAutoLiveGuardrailCheck(
                id="limit-orders-only",
                label="Limit orders only",
                status="pass" if settings.limit_orders_only else "fail",
                detail="Live trading is restricted to limit orders."
                if settings.limit_orders_only
                else "Live trading is blocked because limit orders only is disabled.",
                value="Required" if settings.limit_orders_only else "Blocked",
                blocking=not settings.limit_orders_only,
                checked_at=checked_at,
            ),
            BullpenAutoLiveGuardrailCheck(
                id="manual-confirmation",
                label="Manual confirmation",
                status="watch" if settings.require_manual_confirmation else "pass",
                detail="Manual confirmation is still configured, but Auto-Live now relies on explicit live arming, dashboard unlock, and backend runtime guards instead."
                if settings.require_manual_confirmation
                else "Manual confirmation is not configured for Auto-Live.",
                value="Required" if settings.require_manual_confirmation else "Cleared",
                checked_at=checked_at,
            ),
            BullpenAutoLiveGuardrailCheck(
                id="emergency-stop",
                label="Emergency stop",
                status="fail" if settings.emergency_stop else "pass",
                detail="Emergency stop is active."
                if settings.emergency_stop
                else "Emergency stop is clear.",
                value="Active" if settings.emergency_stop else "Clear",
                blocking=settings.emergency_stop,
                checked_at=checked_at,
            ),
        ]

    def _synchronize_state(
        self,
        settings: BullpenAutoLiveSettings,
        state: BullpenAutoLiveState,
    ) -> BullpenAutoLiveState:
        synchronized = state.model_copy()
        synchronized.dry_run = effective_dry_run(settings)
        synchronized.live_armed = live_execution_armed(settings)
        synchronized.live_execution_allowed = (
            synchronized.live_execution_allowed
            if synchronized.live_armed and not synchronized.paused and not settings.emergency_stop
            else False
        )
        synchronized.emergency_stopped = settings.emergency_stop
        synchronized.mode = self._derive_mode(settings)
        synchronized.status = self._derive_status(settings, synchronized)
        synchronized.server_now = utc_now()
        synchronized.latest_guardrail_checks = self._build_guardrail_checks(settings, synchronized)
        return synchronized

    def _derive_mode(self, settings: BullpenAutoLiveSettings) -> str:
        if effective_dry_run(settings):
            return "dry-run"
        if live_execution_armed(settings):
            return "live-trading"
        return "analysis-only"

    def _derive_status(
        self,
        settings: BullpenAutoLiveSettings,
        state: BullpenAutoLiveState,
    ) -> str:
        if state.last_error:
            return "error"
        if state.paused or settings.emergency_stop:
            return "paused"
        if state.running:
            return "running"
        if not settings.auto_live_enabled and not state.last_run_id:
            return "not-configured"
        return "stopped"

    def _schedule_next_cycles(
        self,
        settings: BullpenAutoLiveSettings,
        state: BullpenAutoLiveState,
        *,
        reference_time: datetime,
    ) -> None:
        if settings.strategy_profile == CONSOLE_PROFILE_ID:
            next_run_at = next_console_schedule_time(reference_time).isoformat()
            state.next_run_at = next_run_at
            state.next_scan_at = next_run_at
            state.next_llm_run_at = next_run_at
            state.next_rebalance_at = next_run_at
            return

        state.next_run_at = (
            reference_time + timedelta(seconds=settings.active_price_refresh_seconds)
        ).isoformat()
        state.next_scan_at = (
            reference_time + timedelta(minutes=settings.new_scan_interval_minutes)
        ).isoformat()
        state.next_llm_run_at = (
            reference_time + timedelta(minutes=settings.llm_rerun_interval_minutes)
        ).isoformat()
        state.next_rebalance_at = (
            reference_time + timedelta(minutes=settings.rebalance_interval_minutes)
        ).isoformat()

    def _build_bot_card_summary(
        self,
        settings: BullpenAutoLiveSettings,
        state: BullpenAutoLiveState,
        latest_guardrails: list[BullpenAutoLiveGuardrailCheck],
    ) -> BullpenAutoLiveBotCardSummary:
        invested = round_money(state.invested_usd) or 0
        current_value = round_money(state.current_value_usd)
        pnl = round_money(state.pnl_usd)
        return_pct = None
        if invested > 0 and pnl is not None:
            return_pct = round((pnl / invested) * 100, 2)

        guardrails = [
            TradingBotGuardrail(
                label=check.label,
                value=check.value or check.detail,
                tone=(
                    "critical"
                    if check.status == "fail"
                    else "warning"
                    if check.status == "watch"
                    else "positive"
                ),
            )
            for check in latest_guardrails
        ]

        return BullpenAutoLiveBotCardSummary(
            status=state.status,
            mode=state.mode,
            invested_usd=invested,
            current_value_usd=current_value,
            pnl_usd=pnl,
            return_pct=return_pct,
            active_positions=state.active_positions,
            trades_today=state.trades_today,
            last_run_at=state.last_run_at,
            next_run_at=state.next_run_at if state.running else None,
            guardrails_summary=" • ".join(
                f"{check.label}: {check.value or check.detail}" for check in latest_guardrails[:4]
            ),
            strategy_summary=strategy_summary_for(settings),
            risk_summary=risk_summary_for(settings),
            guardrails=guardrails,
        )
