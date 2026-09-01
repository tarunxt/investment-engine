from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from time import perf_counter
from uuid import uuid4

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import get_logger
from app.domains.polymarket_auto_live.console_profile import (
    CONSOLE_PROFILE_ID,
    next_console_schedule_time,
    next_custom_console_schedule_time,
)
from app.domains.polymarket_auto_live.console_projection import (
    CONSOLE_PROJECTION_VERSION,
    build_verified_stage1_portfolio_snapshot,
)
from app.domains.polymarket_auto_live.config import (
    auto_live_backend_allows_execution,
    auto_live_backend_execution_env_detail,
)
from app.domains.bullpen_run_audit.service import materialize_run_audit_snapshot_sync
from app.domains.polymarket_auto_live.order_intent_service import (
    cancel_unsubmitted_run_order_intents_for_user_sync,
    cancel_order_intent_for_user_sync,
    get_run_orders_for_user_sync,
    refresh_run_order_state_for_user_sync,
    retry_failed_exits_and_continue_buys_for_user_sync,
    retry_order_intent_for_user_sync,
)
from app.domains.polymarket_auto_live.run_recovery import (
    mark_historical_auth_error_recovered,
    reconcile_running_auto_live_run,
    run_contains_historical_auth_error,
)
from app.domains.polymarket_auto_live.run_handoff import (
    AutoLiveTaskPublishExhausted,
    build_auto_live_run_audit_metadata,
    publish_auto_live_task_with_fallback,
)
from app.domains.polymarket_auto_live.run_lifecycle import queued_auto_live_task_lifecycle
from app.domains.polymarket_auto_live.repository import (
    AsyncPolymarketAutoLiveRepository,
    apply_run_to_record,
    extract_stage3_decisions_from_run,
    record_to_run,
    record_to_settings,
    record_to_state,
)
from app.domains.polymarket_auto_live.schemas import (
    BullpenAutoLiveBotCardSummary,
    BullpenAutoLiveConsoleRunDetail,
    BullpenAutoLiveDecision,
    BullpenAutoLiveEventTrendsResponse,
    BullpenAutoLiveGuardrailCheck,
    BullpenAutoLiveHistoryPage,
    BullpenAutoLiveRun,
    BullpenAutoLiveRunDiagnostics,
    BullpenAutoLiveRunOrdersResponse,
    BullpenAutoLiveRunOnceRequest,
    BullpenAutoLiveStageResult,
    BullpenAutoLiveSettings,
    BullpenAutoLiveSettingsUpdate,
    BullpenAutoLivePersistedStatus,
    BullpenAutoLiveSchedulerStatus,
    BullpenAutoLiveStatusConfiguration,
    BullpenAutoLiveState,
    BullpenAutoLiveSummary,
    BullpenAutoLiveSummarySection,
    TradingBotGuardrail,
)
from app.infrastructure.database.session import AsyncSessionLocal
from app.infrastructure.database.sync_session import SyncSessionLocal
from app.infrastructure.messaging.task_registry import (
    register_auto_live_run_task,
    revoke_auto_live_run_task_sync,
    revoke_registered_auto_live_run_task,
)

logger = get_logger(__name__)

CONSOLE_RUN_DETAIL_DECISION_LIMIT = 32
CONSOLE_RUN_DETAIL_VISIBLE_ID_LIMIT = 200
_STAGE3_SUPPORT_PAUSE_MARKERS = (
    "auto runs paused because bullpen requires support verification",
    "auto runs are paused pending bullpen support verification",
)
_STAGE3_SUPPORT_ANALYSIS_RESUMED_ACTION = (
    "Scheduled Stage 1/2 analysis remains active; Stage 3 remote writes remain "
    "blocked pending Bullpen support verification of the Polymarket wallet route."
)


def _is_stage3_support_scheduler_pause(state: BullpenAutoLiveState) -> bool:
    """Recognize only the legacy Stage 3 support gate that paused all analysis."""

    action = str(state.last_action or "").strip().lower()
    return bool(
        state.paused
        and any(marker in action for marker in _STAGE3_SUPPORT_PAUSE_MARKERS)
    )


def _summarize_run_for_list(run: BullpenAutoLiveRun) -> BullpenAutoLiveRun:
    """Preserve the response shape while keeping list rows lightweight."""

    return run.model_copy(
        update={
            "summary": run.summary[:500],
            "error_message": run.error_message[:500] if run.error_message else None,
            "stage_results": [],
            "guardrail_checks": [],
            "decision_ids": [],
            "order_intent_ids": [],
            "diagnostics": BullpenAutoLiveRunDiagnostics(),
            "stage2_llm_targets_snapshot": None,
            "request_context": None,
            "audit_metadata": {},
        }
    )


def _freeze_cancelled_run_audit_sync(*, user_id: int, run_id: str) -> None:
    """Freeze the cancellation snapshot even when Celery is terminated first."""
    with SyncSessionLocal() as session:
        materialize_run_audit_snapshot_sync(
            session,
            user_id=user_id,
            run_id=run_id,
            force=True,
            freeze=True,
        )
        session.commit()

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
    "scans upcoming markets, runs LLM consensus on every Stage 1 event, sizes each "
    "new opportunity as cash in hand divided by remaining open top-10 slots, buys "
    "qualified ranked opportunities on their stronger LLM side, and exits active "
    "positions that fall outside that top 10."
)


def _auth_recovery_operator_resume_active(run: BullpenAutoLiveRun) -> bool:
    recovery = run.audit_metadata.get("auth_recovery")
    return isinstance(recovery, dict) and bool(recovery.get("operator_resume_at"))


def _stage3_intent_operator_resume_active(run: BullpenAutoLiveRun) -> bool:
    recovery = run.audit_metadata.get("stage3_recovery")
    resume = run.audit_metadata.get("stage3_resume_action")
    return bool(
        run.status == "running"
        and run.order_intent_ids
        and isinstance(recovery, dict)
        and recovery.get("required") is False
        and recovery.get("resolution") == "operator_retry"
        and isinstance(resume, dict)
        and resume.get("same_run") is True
        and resume.get("llm_analysis_rerun") is False
    )


CONSOLE_AUTO_LIVE_RISK_SUMMARY = (
    "The console profile still depends on Bullpen live session health, doctor "
    "checks, balance availability, and limit-order guardrails before any live "
    "orders are submitted."
)


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


def _parse_state_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _state_has_due_scheduled_run(
    settings: BullpenAutoLiveSettings,
    state: BullpenAutoLiveState,
    *,
    reference_time: datetime,
) -> bool:
    if (
        not settings.auto_live_enabled
        or settings.emergency_stop
        or not state.running
        or state.paused
        or not state.next_run_at
    ):
        return False
    next_run_at = _parse_state_datetime(state.next_run_at)
    return bool(next_run_at is not None and next_run_at <= reference_time)


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


def build_initial_run_summary(
    request: BullpenAutoLiveRunOnceRequest | None = None,
) -> str:
    console_profile = request.console_profile if request else None
    if console_profile and console_profile.candidate_rows:
        return "Stage 1 started. Bullpen scan is loading the current questions table."
    return "Stage 1 started. Bullpen scan is preparing the candidate fetch."


def build_initial_scan_stage_result(
    *,
    request: BullpenAutoLiveRunOnceRequest | None = None,
    started_at: str,
) -> BullpenAutoLiveStageResult:
    console_profile = request.console_profile if request else None
    total_items = None
    if console_profile is not None:
        if console_profile.total_candidates > 0:
            total_items = console_profile.total_candidates
        elif console_profile.candidate_rows:
            total_items = len(console_profile.candidate_rows)

    selected_manual_candidate_count = (
        sum(1 for row in console_profile.candidate_rows if row.selected)
        if console_profile is not None
        else 0
    )
    outputs: dict[str, object] = {
        "workflow_stage_key": "scan",
        "phase_status": "running",
        "completed_items": 0,
        "item_label": "events",
    }
    if total_items is not None:
        outputs["total_items"] = total_items
    if console_profile is not None:
        if console_profile.snapshot_id:
            outputs["snapshot_id"] = console_profile.snapshot_id
        if console_profile.mode:
            outputs["mode"] = console_profile.mode
        if console_profile.source_label:
            outputs["scan_source_label"] = console_profile.source_label
        if console_profile.source_url:
            outputs["scan_source_url"] = console_profile.source_url
        if selected_manual_candidate_count > 0:
            outputs["selected_manual_candidate_count"] = selected_manual_candidate_count

    reason = (
        "Bullpen scan started with the current questions table."
        if console_profile and console_profile.candidate_rows
        else "Bullpen scan started and is preparing the candidate fetch."
    )
    return BullpenAutoLiveStageResult(
        stage_number=1,
        stage_name="Candidate Scan",
        status="pass",
        reason=reason,
        outputs=outputs,
        started_at=started_at,
        completed_at=None,
    )


def _stage2_llm_targets_snapshot(
    settings: BullpenAutoLiveSettings,
):
    return [target.model_copy(deep=True) for target in settings.console_llm_targets]


class BullpenAutoLiveBot:
    def __init__(self, user_id: int) -> None:
        self.user_id = user_id

    async def _reconcile_terminal_stage3_decisions(
        self,
        repo: AsyncPolymarketAutoLiveRepository,
        runs: list[BullpenAutoLiveRun],
    ) -> bool:
        terminal_runs = [
            run for run in runs if run.status not in {"running", "confirming"}
        ]
        if not terminal_runs:
            return False

        payload_decisions_by_run: dict[
            str,
            list[BullpenAutoLiveDecision],
        ] = {}
        for run in terminal_runs:
            decisions = extract_stage3_decisions_from_run(run)
            if decisions is not None:
                payload_decisions_by_run[run.id] = decisions
        decision_id_sets = await repo.list_visible_decision_id_sets_by_run(
            self.user_id,
            {
                run_id: len({decision.id for decision in decisions})
                for run_id, decisions in payload_decisions_by_run.items()
            },
        )
        reconciled = False
        for run in terminal_runs:
            payload_decisions = payload_decisions_by_run.get(run.id)
            if payload_decisions is None:
                continue
            payload_ids = {decision.id for decision in payload_decisions}
            if decision_id_sets.get(run.id, set()) == payload_ids:
                continue

            await repo.replace_run_decisions_from_stage3_payload(self.user_id, run)
            decision_id_sets[run.id] = payload_ids
            reconciled = True

        return reconciled

    async def _get_active_run_or_recover(
        self,
        repo: AsyncPolymarketAutoLiveRepository,
        settings: BullpenAutoLiveSettings,
        state: BullpenAutoLiveState,
    ) -> tuple[BullpenAutoLiveRun | None, BullpenAutoLiveState]:
        running_record = await repo.get_running_run_record(self.user_id)
        if running_record is None:
            return None, state

        running_run = record_to_run(running_record)
        if running_run.status == "confirming":
            confirming_state = self._synchronize_state(
                settings,
                state.model_copy(
                    update={
                        "last_run_id": running_run.id,
                        "last_action": running_run.summary,
                        "last_error": None,
                    }
                ),
            )
            return running_run, confirming_state

        recovered_run: BullpenAutoLiveRun | None = None
        recovered_auth_error = False
        if run_contains_historical_auth_error(
            running_run
        ) and not _auth_recovery_operator_resume_active(running_run):
            from app.domains.polymarket.runtime_broker import get_bullpen_runtime_broker

            try:
                active_auth = await get_bullpen_runtime_broker().resolve_latest_active_auth_result(
                    refresh_if_stale=True,
                )
            except Exception:
                logger.exception(
                    "Could not resolve active Bullpen auth while recovering run %s.",
                    running_run.id,
                )
                active_auth = None
            if active_auth is not None and active_auth.healthy:
                recovered_run = mark_historical_auth_error_recovered(
                    running_run,
                    recovered_at=active_auth.checked_at,
                )
                recovered_auth_error = True
                await revoke_registered_auto_live_run_task(recovered_run.id)
        if recovered_run is None:
            if _stage3_intent_operator_resume_active(running_run):
                resumed_state = self._synchronize_state(
                    settings,
                    state.model_copy(
                        update={
                            "last_run_id": running_run.id,
                            "last_action": running_run.summary,
                            "last_error": None,
                        }
                    ),
                )
                return running_run, resumed_state
            recovered_run = await asyncio.to_thread(
                reconcile_running_auto_live_run,
                running_run,
                started_at=running_record.started_at,
                updated_at=running_record.updated_at,
            )
        if recovered_run is None:
            return running_run, state

        recovered_state = state.model_copy(
            update={
                "last_run_id": recovered_run.id,
                "last_run_at": recovered_run.completed_at,
                "last_action": recovered_run.summary,
                "last_error": (
                    None
                    if recovered_run.status == "completed" or recovered_auth_error
                    else recovered_run.summary
                ),
            }
        )
        recovered_state = self._synchronize_state(settings, recovered_state)
        await repo.save_run(self.user_id, recovered_run)
        if not recovered_auth_error:
            await repo.replace_run_decisions_from_stage3_payload(self.user_id, recovered_run)
        await repo.save_state(self.user_id, recovered_state)
        return None, recovered_state

    async def _cancel_active_run_if_needed(
        self,
        repo: AsyncPolymarketAutoLiveRepository,
    ) -> BullpenAutoLiveRun | None:
        active_run_record = await repo.get_running_run_record(
            self.user_id,
            for_update=True,
        )
        if active_run_record is None:
            return None

        active_run = record_to_run(active_run_record)
        cancelled_at = utc_now()
        active_run.status = "failed"
        active_run.completed_at = cancelled_at
        active_run.error_message = "Cancelled by user"
        active_run.summary = "Auto-Live run cancelled by user."
        active_run.audit_metadata = {
            **active_run.audit_metadata,
            "cancellation": {
                "requested_by": "user",
                "cancelled_at": cancelled_at,
                "terminalized_stages": True,
            },
        }
        for stage_result in active_run.stage_results:
            if stage_result.completed_at is None:
                stage_result.status = "fail"
                stage_result.completed_at = cancelled_at
                stage_result.reason = "Cancelled by user."
                stage_result.outputs = {
                    **stage_result.outputs,
                    "phase_status": "cancelled",
                }
        await repo.save_run(self.user_id, active_run)
        return active_run

    async def get_settings(self) -> BullpenAutoLiveSettings:
        async with AsyncSessionLocal() as session:
            repo = AsyncPolymarketAutoLiveRepository(session)
            settings = await repo.ensure_settings(self.user_id)
            state = await repo.ensure_state(self.user_id)
            normalized_state = self._synchronize_state(settings, state)
            await repo.save_state(self.user_id, normalized_state)
            await session.commit()
            return settings

    async def get_persisted_status(
        self,
        session: AsyncSession | None = None,
    ) -> BullpenAutoLivePersistedStatus:
        if session is None:
            async with AsyncSessionLocal() as owned_session:
                return await self.get_persisted_status(owned_session)

        repo = AsyncPolymarketAutoLiveRepository(session)
        settings_record = await repo.get_settings_record(self.user_id)
        state_record = await repo.get_state_record(self.user_id)
        active_run = await repo.get_active_run_identity(self.user_id)

        settings = record_to_settings(settings_record)
        persisted_state = record_to_state(state_record)
        state = self._synchronize_persisted_scheduler_state(settings, persisted_state)

        def timestamp(value: datetime | None) -> str | None:
            if value is None:
                return None
            if value.tzinfo is None:
                return value.replace(tzinfo=UTC).isoformat()
            return value.astimezone(UTC).isoformat()

        return BullpenAutoLivePersistedStatus(
            refreshed_at=utc_now(),
            configuration=BullpenAutoLiveStatusConfiguration(
                strategy_profile=settings.strategy_profile,
                auto_live_enabled=settings.auto_live_enabled,
                dry_run=settings.dry_run,
                allow_live_execution=settings.allow_live_execution,
                require_manual_confirmation=settings.require_manual_confirmation,
                emergency_stop=settings.emergency_stop,
                limit_orders_only=settings.limit_orders_only,
                console_order_usd=settings.console_order_usd,
                console_scan_scope=settings.console_scan_scope,
                console_auto_start_at=settings.console_auto_start_at,
                console_auto_refresh_minutes=settings.console_auto_refresh_minutes,
                console_llm_target_count=len(settings.console_llm_targets),
                updated_at=timestamp(
                    getattr(settings_record, "updated_at", None)
                    if settings_record is not None
                    else None
                ),
            ),
            scheduler=BullpenAutoLiveSchedulerStatus(
                running=state.running,
                paused=state.paused,
                dry_run=state.dry_run,
                live_armed=state.live_armed,
                live_execution_allowed=state.live_execution_allowed,
                emergency_stopped=state.emergency_stopped,
                status=state.status,
                mode=state.mode,
                started_at=state.started_at,
                stopped_at=state.stopped_at,
                last_run_at=state.last_run_at,
                last_execution_at=state.last_execution_at,
                next_run_at=state.next_run_at,
                last_run_id=state.last_run_id,
                active_run_id=active_run[0] if active_run else None,
                active_run_status=active_run[1] if active_run else None,
                updated_at=timestamp(
                    getattr(state_record, "updated_at", None)
                    if state_record is not None
                    else None
                ),
            ),
        )

    async def update_settings(
        self, update: BullpenAutoLiveSettingsUpdate
    ) -> BullpenAutoLiveSettings:
        async with AsyncSessionLocal() as session:
            repo = AsyncPolymarketAutoLiveRepository(session)
            settings = await repo.ensure_settings(self.user_id)
            merged = settings.model_dump()
            merged.update(update.model_dump(exclude_unset=True))
            validated = BullpenAutoLiveSettings.model_validate(merged)
            state = self._synchronize_state(validated, await repo.ensure_state(self.user_id))
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
        should_enqueue_due_run = False
        async with AsyncSessionLocal() as session:
            repo = AsyncPolymarketAutoLiveRepository(session)
            settings = await repo.ensure_settings(self.user_id)
            state = self._synchronize_state(settings, await repo.ensure_state(self.user_id))
            active_run, state = await self._get_active_run_or_recover(repo, settings, state)
            should_enqueue_due_run = active_run is None and _state_has_due_scheduled_run(
                settings,
                state,
                reference_time=datetime.now(UTC),
            )
            if should_enqueue_due_run:
                state.last_action = "Queued scheduled Auto-Live run from state poll."
            await repo.save_state(self.user_id, state)
            await session.commit()

        if should_enqueue_due_run:
            await self.run_once(triggered_by="scheduler")
            async with AsyncSessionLocal() as session:
                repo = AsyncPolymarketAutoLiveRepository(session)
                settings = await repo.ensure_settings(self.user_id)
                state = self._synchronize_state(settings, await repo.ensure_state(self.user_id))
                await repo.save_state(self.user_id, state)
                await session.commit()
                return state

        return state

    async def _get_summary_with_run_limit(
        self,
        *,
        run_limit: int,
    ) -> BullpenAutoLiveSummary:
        should_enqueue_due_run = False
        async with AsyncSessionLocal() as session:
            repo = AsyncPolymarketAutoLiveRepository(session)
            settings = await repo.ensure_settings(self.user_id)
            state = self._synchronize_state(settings, await repo.ensure_state(self.user_id))
            active_run, state = await self._get_active_run_or_recover(repo, settings, state)
            should_enqueue_due_run = active_run is None and _state_has_due_scheduled_run(
                settings,
                state,
                reference_time=datetime.now(UTC),
            )
            if should_enqueue_due_run:
                state.last_action = "Queued scheduled Auto-Live run from summary poll."
            await repo.save_state(self.user_id, state)
            await session.commit()

        if should_enqueue_due_run:
            await self.run_once(triggered_by="scheduler")

        async with AsyncSessionLocal() as session:
            repo = AsyncPolymarketAutoLiveRepository(session)
            settings = await repo.ensure_settings(self.user_id)
            state = self._synchronize_state(settings, await repo.ensure_state(self.user_id))
            _, state = await self._get_active_run_or_recover(repo, settings, state)
            runs = await repo.list_runs(self.user_id, limit=run_limit)
            if await self._reconcile_terminal_stage3_decisions(repo, runs):
                await session.commit()
                runs = await repo.list_runs(self.user_id, limit=run_limit)
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

    async def get_summary(self) -> BullpenAutoLiveSummary:
        return await self._get_summary_with_run_limit(run_limit=10)

    async def get_dashboard_summary(
        self,
        session: AsyncSession | None = None,
    ) -> BullpenAutoLiveSummary:
        if session is None:
            async with AsyncSessionLocal() as owned_session:
                return await self.get_dashboard_summary(session=owned_session)

        query_started_at = perf_counter()
        repo = AsyncPolymarketAutoLiveRepository(session)
        settings_record = await repo.get_settings_record(self.user_id)
        state_record = await repo.get_state_record(self.user_id)
        settings = record_to_settings(settings_record)
        state = self._synchronize_persisted_scheduler_state(
            settings,
            record_to_state(state_record),
        )
        active_identity = await repo.get_active_run_identity(self.user_id)
        latest_projection = (
            await repo.get_projected_run_for_user(
                self.user_id,
                active_identity[0],
            )
            if active_identity is not None
            else None
        )
        if latest_projection is None:
            latest_projection = await repo.get_latest_projected_run(self.user_id)
        latest_run = latest_projection[0] if latest_projection else None
        verified_portfolio_snapshot = state.verified_portfolio_snapshot
        if verified_portfolio_snapshot is None and latest_run is not None:
            verified_portfolio_snapshot = build_verified_stage1_portfolio_snapshot(latest_run)
        if verified_portfolio_snapshot is None:
            verified_portfolio_snapshot = await repo.get_latest_verified_portfolio_snapshot(self.user_id)
        if verified_portfolio_snapshot is not None:
            state = state.model_copy(
                update={"verified_portfolio_snapshot": verified_portfolio_snapshot}
            )
        projection_available = latest_projection[1] if latest_projection else True
        workflow_as_of = (
            latest_projection[2]
            if latest_projection
            else (
                state_record.updated_at.isoformat()
                if state_record is not None and state_record.updated_at is not None
                else utc_now()
            )
        )
        decisions = (
            await repo.list_projected_decisions_for_run(
                self.user_id,
                latest_run.id,
                limit=25,
            )
            if latest_run is not None
            else []
        )

        database_duration_ms = (perf_counter() - query_started_at) * 1000
        dashboard_settings = settings.model_copy(update={"console_llm_prompt_template": None})
        latest_guardrails = self._build_guardrail_checks(settings, state)
        degraded_sections = []
        workflow_status = "persisted"
        workflow_detail = None
        if latest_run is not None and not projection_available:
            degraded_sections.append("workflow")
            workflow_status = "unavailable"
            workflow_detail = (
                "This legacy run predates the bounded console projection. "
                "Open run detail for its complete frozen evidence."
            )
        generated_at = utc_now()
        return BullpenAutoLiveSummary(
            state=state,
            settings=dashboard_settings,
            bot_card=self._build_bot_card_summary(settings, state, latest_guardrails),
            latest_run=latest_run,
            recent_runs=[latest_run] if latest_run is not None else [],
            recent_decisions=decisions,
            latest_guardrail_checks=latest_guardrails,
            generated_at=generated_at,
            projection_version=CONSOLE_PROJECTION_VERSION,
            degraded_sections=degraded_sections,
            sections={
                "scheduler": BullpenAutoLiveSummarySection(
                    source="postgresql_scheduler_rows",
                    status="persisted",
                    as_of=(
                        state_record.updated_at.isoformat()
                        if state_record is not None and state_record.updated_at is not None
                        else generated_at
                    ),
                    duration_ms=database_duration_ms,
                ),
                "settings": BullpenAutoLiveSummarySection(
                    source="postgresql_settings_projection",
                    status="persisted",
                    as_of=(
                        settings_record.updated_at.isoformat()
                        if settings_record is not None and settings_record.updated_at is not None
                        else generated_at
                    ),
                    duration_ms=database_duration_ms,
                    detail="The saved LLM prompt is loaded only when its editor opens.",
                ),
                "workflow": BullpenAutoLiveSummarySection(
                    source="postgresql_console_projection",
                    status=workflow_status,  # type: ignore[arg-type]
                    as_of=workflow_as_of,
                    duration_ms=database_duration_ms,
                    detail=workflow_detail,
                ),
                "decisions": BullpenAutoLiveSummarySection(
                    source="postgresql_decision_projections",
                    status="persisted" if latest_run is not None else "unavailable",
                    as_of=workflow_as_of if latest_run is not None else None,
                    duration_ms=database_duration_ms,
                    detail=None if latest_run is not None else "No durable Auto-Live run exists yet.",
                ),
            },
        )

    async def list_runs(
        self,
        *,
        limit: int = 25,
        include_detail: bool = False,
    ) -> list[BullpenAutoLiveRun]:
        async with AsyncSessionLocal() as session:
            repo = AsyncPolymarketAutoLiveRepository(session)
            runs = await repo.list_runs(self.user_id, limit=limit)
            if await self._reconcile_terminal_stage3_decisions(repo, runs):
                await session.commit()
                runs = await repo.list_runs(self.user_id, limit=limit)
            if include_detail:
                return runs
            return [_summarize_run_for_list(run) for run in runs]

    async def list_run_history(
        self,
        *,
        page: int,
        size: int,
    ) -> BullpenAutoLiveHistoryPage:
        async with AsyncSessionLocal() as session:
            repo = AsyncPolymarketAutoLiveRepository(session)
            return await repo.list_run_history_page(self.user_id, page=page, size=size)

    async def list_recent_event_trends(self) -> BullpenAutoLiveEventTrendsResponse:
        async with AsyncSessionLocal() as session:
            return await AsyncPolymarketAutoLiveRepository(session).list_recent_event_trends(self.user_id)

    async def get_run(self, run_id: str) -> BullpenAutoLiveRun:
        async with AsyncSessionLocal() as session:
            repo = AsyncPolymarketAutoLiveRepository(session)
            run = await repo.get_run_for_user(self.user_id, run_id)
            if run is None:
                raise ValueError("Auto-Live run not found.")
            return run

    async def get_console_run_detail(
        self,
        run_id: str,
    ) -> BullpenAutoLiveConsoleRunDetail:
        async with AsyncSessionLocal() as session:
            repo = AsyncPolymarketAutoLiveRepository(session)
            snapshot = await repo.get_console_run_snapshot_for_user(
                self.user_id,
                run_id,
                decision_limit=CONSOLE_RUN_DETAIL_DECISION_LIMIT,
                visible_id_limit=CONSOLE_RUN_DETAIL_VISIBLE_ID_LIMIT + 1,
            )
            if snapshot is None:
                raise ValueError("Auto-Live run not found.")
            (
                run,
                projection_available,
                as_of,
                decisions,
                visible_decision_ids,
            ) = snapshot
        visible_decision_ids_truncated = len(visible_decision_ids) > CONSOLE_RUN_DETAIL_VISIBLE_ID_LIMIT
        visible_decision_ids = visible_decision_ids[:CONSOLE_RUN_DETAIL_VISIBLE_ID_LIMIT]
        if not visible_decision_ids_truncated:
            run = run.model_copy(update={"decisions_count": len(visible_decision_ids)})
        return BullpenAutoLiveConsoleRunDetail(
            run=run,
            decisions=decisions,
            visible_decision_ids=visible_decision_ids,
            visible_decision_ids_truncated=visible_decision_ids_truncated,
            generated_at=utc_now(),
            as_of=as_of,
            projection_version=CONSOLE_PROJECTION_VERSION,
            projection_available=projection_available,
            decisions_limit=CONSOLE_RUN_DETAIL_DECISION_LIMIT,
            decisions_truncated=(visible_decision_ids_truncated or len(visible_decision_ids) > len(decisions)),
        )

    async def list_run_decisions(self, run_id: str) -> list[BullpenAutoLiveDecision]:
        async with AsyncSessionLocal() as session:
            repo = AsyncPolymarketAutoLiveRepository(session)
            if not await repo.run_exists_for_user(self.user_id, run_id):
                raise ValueError("Auto-Live run not found.")
            return await repo.list_decisions_for_run(self.user_id, run_id, limit=200)

    async def list_decisions(self) -> list[BullpenAutoLiveDecision]:
        async with AsyncSessionLocal() as session:
            repo = AsyncPolymarketAutoLiveRepository(session)
            runs = await repo.list_runs(self.user_id, limit=25)
            if await self._reconcile_terminal_stage3_decisions(repo, runs):
                await session.commit()
            return await repo.list_decisions(self.user_id)

    async def get_run_orders(self, run_id: str) -> BullpenAutoLiveRunOrdersResponse:
        return await asyncio.to_thread(
            get_run_orders_for_user_sync,
            user_id=self.user_id,
            run_id=run_id,
        )

    async def reconcile_run_orders(self, run_id: str) -> BullpenAutoLiveRunOrdersResponse:
        from app.domains.polymarket_auto_live.tasks import enqueue_auto_live_run_order_reconciliations_sync

        summary = await asyncio.to_thread(
            refresh_run_order_state_for_user_sync,
            user_id=self.user_id,
            run_id=run_id,
        )
        await asyncio.to_thread(
            enqueue_auto_live_run_order_reconciliations_sync,
            run_id,
            source="operator-run-reconciliation",
        )
        return summary

    async def retry_order_intent(
        self,
        intent_id: str,
        *,
        remote_absence_verified: bool = False,
    ) -> BullpenAutoLiveRunOrdersResponse:
        from app.domains.polymarket_auto_live.tasks import enqueue_auto_live_order_intent_retry_sync

        summary = await asyncio.to_thread(
            retry_order_intent_for_user_sync,
            user_id=self.user_id,
            intent_id=intent_id,
            remote_absence_verified=remote_absence_verified,
        )
        await asyncio.to_thread(
            enqueue_auto_live_order_intent_retry_sync,
            intent_id,
            source="operator-intent-retry",
        )
        return summary

    async def retry_failed_exits_and_continue_buys(
        self, run_id: str
    ) -> BullpenAutoLiveRunOrdersResponse:
        from app.domains.polymarket_auto_live.tasks import (
            enqueue_auto_live_order_intent_execution_sync,
            enqueue_auto_live_run_order_reconciliations_sync,
        )

        summary = await asyncio.to_thread(
            retry_failed_exits_and_continue_buys_for_user_sync,
            user_id=self.user_id,
            run_id=run_id,
        )
        await asyncio.to_thread(
            enqueue_auto_live_run_order_reconciliations_sync,
            run_id,
            source="operator-resume-reconciliation",
        )
        for order in summary.orders:
            if order.status == "READY" and order.action in {"sell", "redeem", "buy"}:
                await asyncio.to_thread(
                    enqueue_auto_live_order_intent_execution_sync,
                    order.id,
                    source="operator-resume-execution",
                )
        return summary

    async def cancel_order_intent(self, intent_id: str) -> BullpenAutoLiveRunOrdersResponse:
        return await asyncio.to_thread(
            cancel_order_intent_for_user_sync,
            user_id=self.user_id,
            intent_id=intent_id,
        )

    async def run_once(
        self,
        *,
        triggered_by: str = "manual",
        request: BullpenAutoLiveRunOnceRequest | None = None,
    ) -> BullpenAutoLiveRun:
        from app.domains.polymarket_auto_live.tasks import execute_polymarket_auto_live_run

        async with AsyncSessionLocal() as session:
            repo = AsyncPolymarketAutoLiveRepository(session)
            settings = await repo.ensure_settings(self.user_id)
            state = await repo.ensure_state(self.user_id)
            lock_state_record = getattr(repo, "lock_state_record", None)
            if callable(lock_state_record):
                state = await lock_state_record(self.user_id)
            state = self._synchronize_state(settings, state)
            requested_run_id = request.client_run_id if request else None
            if requested_run_id:
                get_run_for_user = getattr(repo, "get_run_for_user", None)
                existing_run = (
                    await get_run_for_user(self.user_id, requested_run_id)
                    if callable(get_run_for_user)
                    else None
                )
                if existing_run is not None:
                    logger.info(
                        "Returning idempotent Auto-Live run %s for user %s; the client start identity was already persisted.",
                        requested_run_id,
                        self.user_id,
                    )
                    return existing_run
            running_run, state = await self._get_active_run_or_recover(repo, settings, state)
            if settings.emergency_stop:
                run = BullpenAutoLiveRun(
                    id=requested_run_id or str(uuid4()),
                    triggered_by=triggered_by,  # type: ignore[arg-type]
                    status="skipped",
                    dry_run=effective_dry_run(settings),
                    started_at=utc_now(),
                    completed_at=utc_now(),
                    summary="Emergency stop is active.",
                    guardrail_checks=self._build_guardrail_checks(settings, state),
                    stage2_llm_targets_snapshot=_stage2_llm_targets_snapshot(settings),
                    request_context=request,
                    audit_metadata=build_auto_live_run_audit_metadata(settings),
                )
                run_record = self._new_run_record(run)
                session.add(run_record)
                state.last_action = run.summary
                state.last_run_id = run.id
                await repo.save_state(self.user_id, state)
                await session.commit()
                return run

            if running_run is not None:
                if triggered_by == "scheduler":
                    logger.info(
                        "Scheduled Auto-Live trigger for user %s reused active run %s.",
                        self.user_id,
                        running_run.id,
                    )
                    return running_run
                run = BullpenAutoLiveRun(
                    id=requested_run_id or str(uuid4()),
                    triggered_by=triggered_by,  # type: ignore[arg-type]
                    status="skipped",
                    dry_run=effective_dry_run(settings),
                    started_at=utc_now(),
                    completed_at=utc_now(),
                    summary=f"Run {running_run.id} is already in progress.",
                    guardrail_checks=self._build_guardrail_checks(settings, state),
                    stage2_llm_targets_snapshot=_stage2_llm_targets_snapshot(settings),
                    request_context=request,
                    audit_metadata=build_auto_live_run_audit_metadata(settings),
                )
                session.add(self._new_run_record(run))
                state.last_action = run.summary
                state.last_run_id = run.id
                await repo.save_state(self.user_id, state)
                await session.commit()
                return run

            started_at = utc_now()
            task_id = str(uuid4())
            run_id = requested_run_id or str(uuid4())
            run = BullpenAutoLiveRun(
                id=run_id,
                triggered_by=triggered_by,  # type: ignore[arg-type]
                status="running",
                dry_run=effective_dry_run(settings),
                started_at=started_at,
                summary=build_initial_run_summary(request),
                live_execution_requested=live_execution_requested(settings),
                guardrail_checks=self._build_guardrail_checks(settings, state),
                stage_results=[build_initial_scan_stage_result(request=request, started_at=started_at)],
                stage2_llm_targets_snapshot=_stage2_llm_targets_snapshot(settings),
                request_context=request,
                audit_metadata=build_auto_live_run_audit_metadata(
                    settings,
                    run_id=run_id,
                    task_id=task_id,
                    enqueued_at=started_at,
                    client_supplied_run_id=bool(requested_run_id),
                ),
                task_lifecycle=queued_auto_live_task_lifecycle(
                    task_id=task_id,
                    enqueued_at=started_at,
                ),
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
            try:
                task, fallback_used = publish_auto_live_task_with_fallback(
                    execute_polymarket_auto_live_run,
                    user_id=self.user_id,
                    run=run,
                    task_id=task_id,
                    logger=logger,
                )
            except AutoLiveTaskPublishExhausted as publish_error:
                if run.task_lifecycle is not None:
                    run.task_lifecycle = run.task_lifecycle.model_copy(
                        update={
                            "state": "FAILURE",
                            "detail": "Primary and fallback worker queues could not accept the task.",
                        }
                    )
                run.status = "failed"
                run.completed_at = publish_error.failed_at
                run.error_message = "Could not enqueue Auto-Live worker task through the primary or fallback queue."
                run.summary = run.error_message
                await repo.save_run(self.user_id, run)
                await session.commit()
                raise publish_error.fallback_error from publish_error.primary_error
            if fallback_used:
                await repo.save_run(self.user_id, run)
                await session.commit()
            await register_auto_live_run_task(run.id, str(task.id))
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
            state = self._synchronize_state(settings, state)
            await repo.save_state(self.user_id, state)
            await session.commit()
            return state

    async def stop(self) -> BullpenAutoLiveState:
        async with AsyncSessionLocal() as session:
            repo = AsyncPolymarketAutoLiveRepository(session)
            # The planner can hold the run row lock while Stage 3 is executing.
            # Revoke its worker before requesting that same lock; otherwise the
            # stop request waits behind the worker it is supposed to terminate
            # and the HTTP request eventually returns 504.
            preempted_run_id: str | None = None
            active_run_record = await repo.get_running_run_record(self.user_id)
            if active_run_record is not None:
                active_run = record_to_run(active_run_record)
                revoked_task_id = await revoke_registered_auto_live_run_task(
                    active_run.id
                )
                if (
                    revoked_task_id is None
                    and active_run.task_lifecycle is not None
                ):
                    revoked_task_id = active_run.task_lifecycle.task_id
                    if revoked_task_id:
                        await asyncio.to_thread(
                            revoke_auto_live_run_task_sync,
                            revoked_task_id,
                        )
                if revoked_task_id:
                    preempted_run_id = active_run.id

            settings = await repo.ensure_settings(self.user_id)
            state = self._synchronize_state(settings, await repo.ensure_state(self.user_id))
            cancelled_run = await self._cancel_active_run_if_needed(repo)
            state.running = False
            state.paused = False
            state.stopped_at = utc_now()
            state.next_run_at = None
            state.next_scan_at = None
            state.next_llm_run_at = None
            state.next_rebalance_at = None
            state.last_action = (
                "Auto-Live scheduler stopped and the active run was cancelled."
                if cancelled_run is not None
                else "Auto-Live scheduler stopped."
            )
            state = self._synchronize_state(settings, state)
            await repo.save_state(self.user_id, state)
            await session.commit()
            if cancelled_run is not None:
                try:
                    await asyncio.to_thread(
                        cancel_unsubmitted_run_order_intents_for_user_sync,
                        user_id=self.user_id,
                        run_id=cancelled_run.id,
                    )
                except Exception:
                    logger.exception("Failed to cancel unsubmitted Stage 3 intents for run %s", cancelled_run.id)
                if cancelled_run.id != preempted_run_id:
                    await revoke_registered_auto_live_run_task(cancelled_run.id)
                try:
                    await asyncio.to_thread(
                        _freeze_cancelled_run_audit_sync,
                        user_id=self.user_id,
                        run_id=cancelled_run.id,
                    )
                except Exception:
                    logger.exception("Failed to freeze Bullpen audit after cancelling run %s", cancelled_run.id)
            return state

    async def pause(self) -> BullpenAutoLiveState:
        async with AsyncSessionLocal() as session:
            repo = AsyncPolymarketAutoLiveRepository(session)
            settings = await repo.ensure_settings(self.user_id)
            state = self._synchronize_state(settings, await repo.ensure_state(self.user_id))
            state.paused = True
            state.last_action = "Auto-Live scheduler paused."
            state = self._synchronize_state(settings, state)
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
            state = self._synchronize_state(settings, state)
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
            state = self._synchronize_state(settings, state)
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
            state = self._synchronize_state(settings, state)
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
                detail="Backend environment allows Auto-Live execution."
                if auto_live_backend_allows_execution()
                else auto_live_backend_execution_env_detail(),
                value="Allowed" if auto_live_backend_allows_execution() else "Blocked",
                checked_at=checked_at,
            ),
            BullpenAutoLiveGuardrailCheck(
                id="live-armed",
                label="Live armed",
                status="pass" if state.live_armed else "watch",
                detail="Env plus Auto-Live settings are armed for live execution."
                if state.live_armed
                else "Live execution is not armed, so the engine will simulate decisions only.",
                value="Armed" if state.live_armed else "Simulation",
                checked_at=checked_at,
            ),
            BullpenAutoLiveGuardrailCheck(
                id="limit-orders-only",
                label="Limit orders only",
                status="pass" if settings.limit_orders_only else "fail",
                detail="Live execution is limited to explicit limit orders."
                if settings.limit_orders_only
                else "Live execution is blocked because limit orders only is disabled.",
                value="Required" if settings.limit_orders_only else "Blocked",
                blocking=not settings.limit_orders_only,
                checked_at=checked_at,
            ),
            BullpenAutoLiveGuardrailCheck(
                id="manual-confirmation",
                label="Manual confirmation",
                status="watch" if settings.require_manual_confirmation else "pass",
                detail="Manual confirmation is still configured, but Auto-Live now relies on explicit live arming, runtime health checks, and any manual lock or emergency stop that is still active."
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
            BullpenAutoLiveGuardrailCheck(
                id="runtime-status",
                label="Runtime status",
                status="watch" if state.paused else "pass",
                detail="Auto-Live is paused."
                if state.paused
                else "Auto-Live can evaluate markets.",
                value="Paused" if state.paused else "Ready",
                blocking=state.paused,
                checked_at=checked_at,
            ),
        ]

    def _synchronize_state(
        self,
        settings: BullpenAutoLiveSettings,
        state: BullpenAutoLiveState,
    ) -> BullpenAutoLiveState:
        support_pause = _is_stage3_support_scheduler_pause(state)
        synchronized = self._synchronize_persisted_scheduler_state(settings, state)
        if support_pause and settings.auto_live_enabled and not settings.emergency_stop:
            synchronized.running = True
            synchronized.paused = False
            synchronized.stopped_at = None
            self._schedule_next_cycles(
                settings,
                synchronized,
                reference_time=datetime.now(UTC),
            )
            synchronized.last_action = _STAGE3_SUPPORT_ANALYSIS_RESUMED_ACTION
            synchronized = self._synchronize_persisted_scheduler_state(
                settings,
                synchronized,
            )
        synchronized.server_now = utc_now()
        synchronized.latest_guardrail_checks = self._build_guardrail_checks(settings, synchronized)
        return synchronized

    def _synchronize_persisted_scheduler_state(
        self,
        settings: BullpenAutoLiveSettings,
        state: BullpenAutoLiveState,
    ) -> BullpenAutoLiveState:
        synchronized = state.model_copy()
        if (
            _is_stage3_support_scheduler_pause(synchronized)
            and settings.auto_live_enabled
            and not settings.emergency_stop
        ):
            # Read-only projections should no longer advertise a global pause.
            # The mutating synchronization path above restores the next cadence.
            synchronized.running = True
            synchronized.paused = False
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
            next_run_at = next_custom_console_schedule_time(
                reference_time,
                start_at=settings.console_auto_start_at,
                refresh_minutes=settings.console_auto_refresh_minutes,
            ).isoformat()
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
