from __future__ import annotations
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from celery.exceptions import SoftTimeLimitExceeded
from sqlalchemy import and_, select

from app.core.logging import get_logger
from app.domains.bullpen_trade_analysis.service import (
    sync_auto_live_position_snapshots_sync,
)
from app.domains.bullpen_run_audit.provenance import build_native_run_audit_metadata
from app.domains.bullpen_run_audit.service import materialize_run_audit_snapshot_sync
from app.domains.polymarket.logger import redact_secrets
from app.domains.polymarket.runtime_broker import run_with_bullpen_runtime_cleanup
from app.domains.polymarket_auto_live.bot import (
    BullpenAutoLiveBot,
    _stage2_llm_targets_snapshot,
    build_initial_run_summary,
    build_initial_scan_stage_result,
    effective_dry_run,
    live_execution_requested,
)
from app.domains.polymarket_auto_live.config import auto_live_execution_v2_enabled
from app.domains.polymarket_auto_live.advisory_lock import (
    AutoLiveAdvisoryLock,
    AutoLiveAdvisoryLockUnavailable,
    acquire_auto_live_run_execution_advisory_lock_sync,
    acquire_order_intent_operation_advisory_lock_sync,
)
from app.domains.polymarket_auto_live.event_exit import ExitSignal, PositionPriceSnapshot
from app.domains.polymarket_auto_live.engine import BullpenAutoLiveEngine, PositionSnapshot
from app.domains.polymarket_auto_live.models import (
    PolymarketAutoLiveOrderIntentRecord,
    PolymarketAutoLiveRunRecord,
    PolymarketAutoLiveSettingsRecord,
    PolymarketAutoLiveStateRecord,
)
from app.domains.polymarket_auto_live.order_intent_lease import (
    OrderIntentLeaseBackendUnavailable,
    OrderIntentOperation,
    OrderIntentOperationLease,
    OrderIntentOperationLeaseHeartbeat,
    acquire_order_intent_operation_lease_sync,
    release_order_intent_operation_lease_sync,
    start_order_intent_operation_lease_sync,
)
from app.domains.polymarket_auto_live.order_intent_service import (
    create_or_refresh_run_order_intents_sync,
    execute_order_intent_sync,
    annotate_intent_dispatch_sync,
    recover_stale_planned_order_intents_sync,
    reconcile_interrupted_runs_on_startup_sync,
    get_intent_user_id_sync,
    list_due_order_intent_ids_sync,
    persist_stage3_intent_diagnostics_sync,
    reconcile_order_intent_sync,
    sync_run_and_decisions_from_intents_sync,
    watchdog_requeue_stale_order_intents_sync,
)
from app.domains.polymarket_auto_live.run_recovery import (
    finalize_failed_run_progress,
    reconcile_running_auto_live_run,
)
from app.domains.polymarket_auto_live.run_lifecycle import (
    AUTO_LIVE_QUEUE,
    AUTO_LIVE_RUN_REDELIVERY_RETRY_SECONDS,
    AutoLiveRunHeartbeat,
    AutoLiveRunLeaseUnavailable,
    acquire_auto_live_run_execution_lease_sync,
    get_auto_live_run_execution_lease_sync,
    mark_auto_live_run_task_started_sync,
    queued_auto_live_task_lifecycle,
    release_auto_live_run_execution_lease_sync,
    update_auto_live_run_task_lifecycle_sync,
)
from app.domains.polymarket_auto_live.repository import (
    SyncPolymarketAutoLiveRepository,
    record_to_run,
    record_to_settings,
    record_to_state,
)
from app.domains.polymarket_auto_live.schemas import BullpenAutoLiveRun
from app.infrastructure.database.sync_session import SyncSessionLocal
from app.infrastructure.messaging.celery_app import celery
from app.infrastructure.messaging.task_registry import (
    register_auto_live_run_task_sync,
)
import app.infrastructure.database.all_models  # noqa: F401

logger = get_logger("app.domains.polymarket_auto_live.tasks")

AUTO_LIVE_WORKFLOW_MAX_RETRIES = 2


def _utc_now() -> datetime:
    return datetime.now(UTC)


class AutoLiveRunCancelled(RuntimeError):
    """Raised when a user-cancelled run should stop persisting worker progress."""


class AutoLiveRunExecutionLeaseLost(RuntimeError):
    """Raised before an old planner can persist after losing its DB fence."""


def _run_execution_fence_is_owned(advisory_lock: AutoLiveAdvisoryLock) -> bool:
    """Confirm the durable planner fence before each mutation boundary.

    Redis remains the fast queue/delivery lease and lifecycle heartbeat, but a
    Redis eviction must not make an already-running worker abandon safely
    serialized Stage 1/2 or Stage 3 persistence. The session-level PostgreSQL
    advisory lock is the split-brain fence while remote work is in flight.
    A failed main-thread health probe means the lock session is gone, so no
    stale in-memory progress may be written.
    """

    return advisory_lock.is_healthy()


def _refresh_order_intent_audit_sync(intent_id: str) -> None:
    """Persist Stage 3 diagnostics, then request one coalesced audit rebuild.

    Reconciliation must never wait for or depend on a full audit rebuild.  In
    particular, multiple long polling tasks for a run should observe the
    latest committed intent state and produce at most one debounced refresh
    task instead of concurrently clearing and rebuilding the same snapshot.
    """

    try:
        with SyncSessionLocal() as session:
            record = session.get(PolymarketAutoLiveOrderIntentRecord, intent_id)
            if record is None:
                return
            persist_stage3_intent_diagnostics_sync(session, record=record)
            run_record = session.get(PolymarketAutoLiveRunRecord, record.run_id)
            freeze_cancelled_run = bool(
                run_record is not None
                and run_record.status == "failed"
                and run_record.error_message == "Cancelled by user"
            )
            user_id = record.user_id
            run_id = record.run_id
            # Make the state visible before the asynchronous materializer
            # starts.  The audit is observational; a persistence failure must
            # not turn into a reconciliation retry or a remote resubmission.
            session.commit()
    except Exception:
        logger.exception(
            "Could not persist Stage 3 audit diagnostics for intent %s",
            intent_id,
        )
        return

    try:
        from app.domains.bullpen_run_audit.tasks import (
            request_bullpen_run_audit_refresh_sync,
        )

        request_bullpen_run_audit_refresh_sync(
            user_id=user_id,
            run_id=run_id,
            # A queued order-intent task can wake after Kill. Its terminal
            # cancellation update must not reopen a frozen run audit.
            freeze=freeze_cancelled_run,
        )
    except Exception:
        # The request helper itself normally contains Redis failures.  This
        # outer guard also protects reconciliation from an import/config error.
        logger.exception(
            "Could not request coalesced Stage 3 audit refresh for intent %s",
            intent_id,
        )


def _queue_due_order_intents_for_run_sync(run_id: str, *, limit: int = 50) -> int:
    """Immediately enqueue due durable Stage 3 intents for one run.

    The beat dispatcher remains the periodic safety net, but Stage 3 must not
    leave freshly persisted Event Exit plans in READY until the next beat tick.
    Queueing the saved run's due intents here turns the run handoff into:
    plan -> persist durable intent -> submit sell/redeem via Celery worker ->
    reconcile -> release dependent replacement buys.
    """

    with SyncSessionLocal() as session:
        due_ids = list_due_order_intent_ids_sync(
            session,
            limit=limit,
            statuses=("PLANNED", "READY", "RETRY_WAIT", "WAITING_FOR_COLLATERAL", "WAITING_FOR_EXIT"),
            now=_utc_now(),
        )
        if not due_ids:
            return 0
        run_due_ids = list(
            session.execute(
                select(PolymarketAutoLiveOrderIntentRecord.id)
                .where(PolymarketAutoLiveOrderIntentRecord.id.in_(due_ids))
                .where(PolymarketAutoLiveOrderIntentRecord.run_id == run_id)
                .order_by(
                    PolymarketAutoLiveOrderIntentRecord.priority.asc(),
                    PolymarketAutoLiveOrderIntentRecord.created_at.asc(),
                )
            )
            .scalars()
            .all()
        )
    _enqueue_execute_order_intents(run_due_ids)
    return len(run_due_ids)



_RECONCILABLE_ORDER_INTENT_STATUSES = frozenset(
    {"SUBMITTED", "CONFIRMING", "PARTIALLY_FILLED", "SETTLEMENT_PENDING", "SUBMITTING"}
)


def _enqueue_order_intent_operation(
    intent_id: str,
    *,
    operation: OrderIntentOperation,
    source: str,
) -> bool:
    """Fence a durable intent before publishing one Stage 3 operation task.

    The lease intentionally spans Celery's queued/reserved period as well as
    remote work.  Without that queued state, every beat tick can publish a
    second reconciliation while the first task is waiting for a pool slot.
    """

    normalized_intent_id = str(intent_id)
    task_id = str(uuid4())
    try:
        lease = acquire_order_intent_operation_lease_sync(
            intent_id=normalized_intent_id,
            task_id=task_id,
            operation=operation,
            source=source,
        )
    except OrderIntentLeaseBackendUnavailable:
        # Fail closed.  Publishing an unfenced remote operation is less safe
        # than allowing the periodic scanner or operator to try again.
        logger.exception(
            "Not enqueueing unfenced Stage 3 %s for intent %s because the "
            "Redis operation lease is unavailable.",
            operation,
            normalized_intent_id,
        )
        return False
    if lease is None:
        return False

    try:
        if operation == "reconcile":
            task = reconcile_auto_live_order_intent.apply_async(
                args=(normalized_intent_id, lease.dispatch_token),
                task_id=task_id,
                queue="ai",
            )  # type: ignore[attr-defined]
            task_name = "reconcile_auto_live_order_intent"
        elif operation == "retry":
            task = retry_auto_live_order_intent.apply_async(
                args=(normalized_intent_id, lease.dispatch_token),
                task_id=task_id,
                queue="ai",
            )  # type: ignore[attr-defined]
            task_name = "retry_auto_live_order_intent"
        else:
            task = execute_auto_live_order_intent.apply_async(
                args=(normalized_intent_id, lease.dispatch_token),
                task_id=task_id,
                queue="ai",
            )  # type: ignore[attr-defined]
            task_name = "execute_auto_live_order_intent"
    except Exception:
        try:
            release_order_intent_operation_lease_sync(lease)
        except OrderIntentLeaseBackendUnavailable:
            logger.exception(
                "Could not release unpublished Stage 3 %s lease for intent %s",
                operation,
                normalized_intent_id,
            )
        logger.exception(
            "Failed to enqueue Stage 3 %s for intent %s", operation, normalized_intent_id
        )
        return False

    try:
        with SyncSessionLocal() as session:
            annotate_intent_dispatch_sync(
                session,
                intent_id=normalized_intent_id,
                task_id=getattr(task, "id", task_id),
                queue="ai",
                task_name=task_name,
                operation=operation,
            )
            session.commit()
    except Exception:
        # The task and lease are valid even when this UI-only annotation fails.
        logger.warning(
            "Failed to annotate Stage 3 %s dispatch for %s",
            operation,
            normalized_intent_id,
            exc_info=True,
        )
    return True


def _enqueue_execute_order_intents(intent_ids, *, source: str = "immediate-execution") -> int:
    return sum(
        _enqueue_order_intent_operation(
            str(intent_id),
            operation="execute",
            source=source,
        )
        for intent_id in intent_ids
    )


def _enqueue_reconcile_order_intent(
    intent_id: str,
    *,
    source: str,
) -> bool:
    """The only path that publishes a Stage 3 reconciliation task."""

    return _enqueue_order_intent_operation(
        str(intent_id),
        operation="reconcile",
        source=source,
    )


def enqueue_auto_live_order_intent_execution_sync(
    intent_id: str,
    *,
    source: str = "external-execution-request",
) -> bool:
    """Public, lease-aware publisher for one durable Stage 3 submission."""

    return _enqueue_order_intent_operation(
        str(intent_id),
        operation="execute",
        source=source,
    )


def enqueue_auto_live_order_intent_reconciliation_sync(
    intent_id: str,
    *,
    source: str = "external-reconciliation-request",
) -> bool:
    """Public, lease-aware publisher for one durable Stage 3 reconciliation."""

    return _enqueue_reconcile_order_intent(str(intent_id), source=source)


def enqueue_auto_live_order_intent_retry_sync(
    intent_id: str,
    *,
    source: str = "external-retry-request",
) -> bool:
    """Public, lease-aware publisher for an explicit Stage 3 retry."""

    return _enqueue_order_intent_operation(
        str(intent_id),
        operation="retry",
        source=source,
    )


def enqueue_auto_live_run_order_reconciliations_sync(
    run_id: str,
    *,
    source: str = "external-run-reconciliation-request",
) -> int:
    """Lease-aware run fan-out used by operator and recovery entry points."""

    with SyncSessionLocal() as session:
        intent_ids = (
            session.execute(
                select(PolymarketAutoLiveOrderIntentRecord.id)
                .where(PolymarketAutoLiveOrderIntentRecord.run_id == run_id)
                .where(
                    PolymarketAutoLiveOrderIntentRecord.status.in_(
                        _RECONCILABLE_ORDER_INTENT_STATUSES
                    )
                )
            )
            .scalars()
            .all()
        )
    return sum(
        _enqueue_reconcile_order_intent(str(intent_id), source=source)
        for intent_id in intent_ids
    )


def _task_request_id(task: object) -> str:
    request = getattr(task, "request", None)
    task_id = getattr(request, "id", None)
    return str(task_id) if isinstance(task_id, str) and task_id else str(uuid4())


def _begin_order_intent_operation(
    task: object,
    *,
    intent_id: str,
    operation: OrderIntentOperation,
    lease_token: str | None,
    source: str,
) -> OrderIntentOperationLease | None:
    """Claim the queued lease, or safely fence a legacy/direct task invocation."""

    task_id = _task_request_id(task)
    normalized_intent_id = str(intent_id)
    dispatch_token = lease_token.strip() if isinstance(lease_token, str) else ""

    try:
        if dispatch_token:
            started = start_order_intent_operation_lease_sync(
                intent_id=normalized_intent_id,
                task_id=task_id,
                dispatch_token=dispatch_token,
                operation=operation,
                source=source,
            )
            if started is not None:
                return started

            # The broker message is fenced to this exact queued lease.  Do
            # not let an old redelivery acquire a newly empty lease: a newer
            # task may have already reconciled the durable intent and released
            # it.  The canonical periodic/watchdog scanner will safely issue
            # a fresh fenced delivery when the intent still needs work.
            logger.info(
                "Skipping stale fenced Stage 3 %s delivery for intent %s",
                operation,
                normalized_intent_id,
            )
            return None

        # Compatibility with manually invoked tasks created before the
        # lease-aware publisher was deployed.  They still cannot bypass the
        # mutual-exclusion fence at actual worker execution.
        acquired = acquire_order_intent_operation_lease_sync(
            intent_id=normalized_intent_id,
            task_id=task_id,
            operation=operation,
            source=f"{source}:direct",
        )
        if acquired is None:
            return None
        return start_order_intent_operation_lease_sync(
            intent_id=normalized_intent_id,
            task_id=task_id,
            dispatch_token=acquired.dispatch_token,
            operation=operation,
            source=f"{source}:direct",
        )
    except OrderIntentLeaseBackendUnavailable:
        logger.exception(
            "Skipping unfenced Stage 3 %s for intent %s because the Redis "
            "operation lease is unavailable.",
            operation,
            normalized_intent_id,
        )
        return None


def _finish_order_intent_operation(lease: OrderIntentOperationLease) -> None:
    try:
        release_order_intent_operation_lease_sync(lease)
    except OrderIntentLeaseBackendUnavailable:
        # A killed/restarted process will eventually be recovered by the TTL.
        # Never turn a completed safe operation into an unsafe duplicate retry.
        logger.exception(
            "Could not release Stage 3 %s lease for intent %s; it will expire.",
            lease.operation,
            lease.intent_id,
        )


def recover_and_enqueue_stale_order_intents_for_run_sync(run_id: str, *, limit: int = 50) -> int:
    with SyncSessionLocal() as session:
        recovered_ids = recover_stale_planned_order_intents_sync(session, run_id=run_id, limit=limit)
        due_ids = list_due_order_intent_ids_sync(
            session,
            limit=limit,
            statuses=("READY", "RETRY_WAIT", "WAITING_FOR_COLLATERAL", "WAITING_FOR_EXIT"),
            now=_utc_now(),
        )
        due_ids = list(
            session.execute(
                select(PolymarketAutoLiveOrderIntentRecord.id)
                .where(PolymarketAutoLiveOrderIntentRecord.id.in_(set(recovered_ids) | set(due_ids)))
                .where(PolymarketAutoLiveOrderIntentRecord.run_id == run_id)
                .order_by(
                    PolymarketAutoLiveOrderIntentRecord.priority.asc(),
                    PolymarketAutoLiveOrderIntentRecord.created_at.asc(),
                )
            )
            .scalars()
            .all()
        )
        session.commit()
    return _enqueue_execute_order_intents(due_ids)


def recover_and_enqueue_stale_order_intents_on_startup_sync(
    *,
    limit: int = 100,
    stale_after_seconds: int = 0,
) -> int:
    """Backward-compatible wrapper for restart-safe run recovery.

    Startup recovery intentionally does not enqueue or resubmit order intents.
    """
    interrupted_at = _utc_now()
    stale_before = (
        interrupted_at - timedelta(seconds=max(0, stale_after_seconds))
        if stale_after_seconds > 0
        else None
    )
    with SyncSessionLocal() as session:
        recovered_ids = reconcile_interrupted_runs_on_startup_sync(
            session,
            limit=limit,
            interrupted_at=interrupted_at,
            stale_before=stale_before,
        )
        session.commit()
    return len(recovered_ids)


def reconcile_interrupted_auto_live_runs_on_startup_sync(
    *,
    limit: int = 100,
    stale_after_seconds: int = 0,
) -> int:
    return recover_and_enqueue_stale_order_intents_on_startup_sync(
        limit=limit,
        stale_after_seconds=stale_after_seconds,
    )


@celery.task(
    name="app.domains.polymarket_auto_live.tasks.reconcile_interrupted_auto_live_runs_after_startup_grace",
    queue=AUTO_LIVE_QUEUE,
)
def reconcile_interrupted_auto_live_runs_after_startup_grace(limit: int = 100) -> int:
    """Run restart recovery only after late-ack task redelivery can settle."""

    return reconcile_interrupted_auto_live_runs_on_startup_sync(limit=limit)


def _position_snapshot_from_record(record) -> PositionSnapshot:
    payload = record.payload or {}
    return PositionSnapshot(
        market_id=record.market_id,
        slug=record.slug,
        market_title=record.market_title,
        market_url=record.market_url,
        theme=record.theme,
        side=record.side,
        exposure_usd=float(record.exposure_usd),
        shares=float(record.shares),
        average_price_cents=float(record.average_price_cents),
        opened_at=record.opened_at.astimezone(UTC),
        updated_at=record.updated_at.astimezone(UTC),
        close_time=payload.get("close_time") if isinstance(payload.get("close_time"), str) else None,
        current_price_cents=(
            float(payload["current_price_cents"])
            if isinstance(payload.get("current_price_cents"), (int, float))
            else None
        ),
        condition_id=payload.get("condition_id") if isinstance(payload.get("condition_id"), str) else None,
        current_yes_odds=(
            float(payload["current_yes_odds"])
            if isinstance(payload.get("current_yes_odds"), (int, float))
            else None
        ),
        current_no_odds=(
            float(payload["current_no_odds"])
            if isinstance(payload.get("current_no_odds"), (int, float))
            else None
        ),
        best_bid_cents=(
            float(payload["best_bid_cents"])
            if isinstance(payload.get("best_bid_cents"), (int, float))
            else None
        ),
        best_ask_cents=(
            float(payload["best_ask_cents"])
            if isinstance(payload.get("best_ask_cents"), (int, float))
            else None
        ),
        price_history=[
            PositionPriceSnapshot.model_validate(snapshot)
            for snapshot in payload.get("price_history", [])
            if isinstance(snapshot, dict)
        ],
        exit_signals=[
            ExitSignal.model_validate(signal)
            for signal in payload.get("exit_signals", [])
            if isinstance(signal, dict)
        ],
        exit_state=payload.get("exit_state") if isinstance(payload.get("exit_state"), str) else "ACTIVE",
        estimated_freeable_value_usd=(
            float(payload["estimated_freeable_value_usd"])
            if isinstance(payload.get("estimated_freeable_value_usd"), (int, float))
            else None
        ),
    )

_finalize_failed_run_progress = finalize_failed_run_progress


def _run_was_cancelled_by_user(
    repo: SyncPolymarketAutoLiveRepository,
    run_id: str,
    *,
    lock: bool = False,
) -> bool:
    # A worker's session can retain the run object it loaded at task start.
    # Always refresh from the database; when the worker is about to write,
    # retain a row lock through that write so cancellation wins either side of
    # the race.
    get_run = (
        getattr(repo, "get_run_for_update", None)
        if lock
        else getattr(repo, "get_run_fresh", None)
    )
    if get_run is None:
        # Keeps the helper compatible with the small repository doubles used
        # by focused unit tests.
        get_run = getattr(repo, "get_run", None)
    if get_run is None:
        return False
    current_run = get_run(run_id)
    if current_run is None or current_run.status != "failed":
        return False
    if current_run.error_message == "Cancelled by user":
        return True
    auth_recovery = current_run.audit_metadata.get("auth_recovery")
    if isinstance(auth_recovery, dict) and auth_recovery.get(
        "historical_error_stale"
    ):
        return True
    stage3_recovery = current_run.audit_metadata.get("stage3_recovery")
    return bool(
        isinstance(stage3_recovery, dict)
        and stage3_recovery.get("required")
        and not stage3_recovery.get("resolved_at")
    )


def _synchronize_state(
    user_id: int,
    repo: SyncPolymarketAutoLiveRepository,
) -> tuple:
    settings_record = repo.get_settings_record(user_id)
    state_record = repo.get_state_record(user_id)
    settings = record_to_settings(settings_record)
    state = record_to_state(state_record)
    normalized = BullpenAutoLiveBot(user_id=user_id)._synchronize_state(settings, state)
    repo.save_settings(user_id, settings)
    repo.save_state(user_id, normalized)
    return settings, normalized


def persist_auto_live_progress_sync(
    *,
    user_id: int,
    repo: SyncPolymarketAutoLiveRepository,
    session,
    run: BullpenAutoLiveRun,
    state,
) -> None:
    if _run_was_cancelled_by_user(repo, run.id, lock=True):
        raise AutoLiveRunCancelled(f"Auto-Live run {run.id} was cancelled by user.")
    repo.save_run(user_id, run)
    repo.replace_run_decisions_from_stage3_payload(user_id, run)
    repo.save_state(user_id, state)
    session.commit()


def _mark_auto_live_task_lifecycle_best_effort(
    *,
    run_id: str,
    task_id: str,
    state: str,
    detail: str | None = None,
    worker_hostname: str | None = None,
) -> None:
    """Persist task outcome without letting observability mask workflow safety."""

    try:
        with SyncSessionLocal() as lifecycle_session:
            updated = update_auto_live_run_task_lifecycle_sync(
                lifecycle_session,
                run_id=run_id,
                state=state,  # type: ignore[arg-type]
                task_id=task_id,
                queue=AUTO_LIVE_QUEUE,
                worker_hostname=worker_hostname,
                detail=detail,
                expected_task_id=task_id,
            )
            if updated is None:
                lifecycle_session.rollback()
                return
            lifecycle_session.commit()
    except Exception:
        logger.warning(
            "Could not update Auto-Live task lifecycle to %s for run %s.",
            state,
            run_id,
            exc_info=True,
        )


@celery.task(
    bind=True,
    # Lease-wait retries can span a short redelivery overlap after a worker
    # loss.  Workflow failures below still explicitly cap themselves at two
    # attempts, preserving the prior provider retry policy.
    max_retries=480,
    default_retry_delay=30,
    # Keep this aligned with AUTO_LIVE_RUN_ABSOLUTE_TIMEOUT.  The soft limit
    # lets the task persist a failed run; the hard limit is the final guard
    # against a worker process stuck in an uninterruptible call.
    soft_time_limit=60 * 60 * 2,
    time_limit=(60 * 60 * 2) + 60,
    name="app.domains.polymarket_auto_live.tasks.execute_polymarket_auto_live_run",
    queue=AUTO_LIVE_QUEUE,
)
def execute_polymarket_auto_live_run(
    self,
    user_id: int,
    run_id: str,
    lease_observed_at: str | None = None,
) -> None:
    """Run one planner task only while its renewable run lease is owned."""

    task_id = str(self.request.id or uuid4())
    delivery_info = getattr(self.request, "delivery_info", None)
    broker_redelivered = bool(
        isinstance(delivery_info, dict) and delivery_info.get("redelivered")
    )
    try:
        lease = acquire_auto_live_run_execution_lease_sync(run_id, task_id=task_id)
    except AutoLiveRunLeaseUnavailable as exc:
        logger.warning(
            "Auto-Live run %s could not establish its execution lease; retrying.",
            run_id,
        )
        _mark_auto_live_task_lifecycle_best_effort(
            run_id=run_id,
            task_id=task_id,
            state="RETRYING",
            detail="Execution lease backend unavailable; retry is queued.",
            worker_hostname=getattr(self.request, "hostname", None),
        )
        raise self.retry(exc=exc, countdown=AUTO_LIVE_RUN_REDELIVERY_RETRY_SECONDS)

    if lease is None:
        owner = get_auto_live_run_execution_lease_sync(run_id)
        # A late-ack task can be broker-redelivered immediately after the old
        # child dies, before its Redis lease reaches TTL.  Probe that one
        # delivery once across a heartbeat interval: if the current owner
        # renews, it is healthy and this task exits; if it stops renewing, the
        # retry waits safely for expiry and then continues the legitimate
        # redelivery.  Ordinary duplicate deliveries never enter this retry
        # path and therefore cannot replay a healthy completed run.
        if (
            owner is not None
            and owner.task_id == task_id
            and (broker_redelivered or lease_observed_at is not None)
        ):
            if lease_observed_at and owner.last_renewed_at != lease_observed_at:
                logger.info(
                    "Skipping redelivered Auto-Live task %s for run %s; its prior "
                    "owner renewed the execution lease.",
                    task_id,
                    run_id,
                )
                return
            logger.info(
                "Auto-Live redelivery %s for run %s is waiting for stale lease "
                "owner expiry.",
                task_id,
                run_id,
            )
            _mark_auto_live_task_lifecycle_best_effort(
                run_id=run_id,
                task_id=task_id,
                state="RETRYING",
                detail="Redelivered task is waiting for prior execution lease expiry.",
                worker_hostname=getattr(self.request, "hostname", None),
            )
            raise self.retry(
                args=(user_id, run_id),
                countdown=AUTO_LIVE_RUN_REDELIVERY_RETRY_SECONDS,
                kwargs={"lease_observed_at": owner.last_renewed_at},
            )

        if broker_redelivered and owner is None:
            # ``SET NX`` reported an owner but the diagnostic read became
            # unavailable or raced with expiry.  Preserve the late-ack
            # delivery rather than acknowledging it as a duplicate; the next
            # retry either acquires the expired lease or observes the current
            # owner and applies the fenced logic above.
            _mark_auto_live_task_lifecycle_best_effort(
                run_id=run_id,
                task_id=task_id,
                state="RETRYING",
                detail="Redelivered task is rechecking execution lease ownership.",
                worker_hostname=getattr(self.request, "hostname", None),
            )
            raise self.retry(
                args=(user_id, run_id),
                countdown=AUTO_LIVE_RUN_REDELIVERY_RETRY_SECONDS,
                kwargs={"lease_observed_at": lease_observed_at},
            )

        # A plain duplicate, a differently-owned lease, or a known healthy
        # same-ID owner exits cheaply without touching Stage 1/2/3.
        logger.info(
            "Skipping duplicate Auto-Live run task %s for run %s; lease owner is %s.",
            task_id,
            run_id,
            owner.task_id if owner is not None else "unknown",
        )
        return

    worker_hostname = getattr(self.request, "hostname", None)
    heartbeat: AutoLiveRunHeartbeat | None = None
    advisory_lock: AutoLiveAdvisoryLock | None = None
    try:
        try:
            advisory_lock = acquire_auto_live_run_execution_advisory_lock_sync(run_id)
        except AutoLiveAdvisoryLockUnavailable as exc:
            # Do not execute Stage 1/2 after Redis eviction without the
            # PostgreSQL fencing lock.  Retrying is safe because the Redis
            # lease is released in the finally block below.
            logger.warning(
                "Auto-Live run %s could not establish its PostgreSQL execution "
                "fence; retrying.",
                run_id,
                exc_info=True,
            )
            _mark_auto_live_task_lifecycle_best_effort(
                run_id=run_id,
                task_id=task_id,
                state="RETRYING",
                detail="PostgreSQL execution fence unavailable; retry is queued.",
                worker_hostname=worker_hostname,
            )
            raise self.retry(
                exc=exc,
                countdown=AUTO_LIVE_RUN_REDELIVERY_RETRY_SECONDS,
            )
        if advisory_lock is None:
            # Redis can be evicted while a healthy planner is inside a remote
            # Stage 1/2 provider call.  The durable PostgreSQL lock remains
            # owned by that worker, so this redelivery/duplicate must leave
            # without touching lifecycle or workflow state.
            logger.info(
                "Skipping duplicate Auto-Live run task %s for run %s; PostgreSQL "
                "execution fence is held by another worker.",
                task_id,
                run_id,
            )
            return
        with SyncSessionLocal() as lifecycle_session:
            started_run = mark_auto_live_run_task_started_sync(
                lifecycle_session,
                run_id=run_id,
                task_id=task_id,
                worker_hostname=worker_hostname,
                increment_redelivery=(
                    broker_redelivered or lease_observed_at is not None
                ),
            )
            lifecycle_session.commit()
        if started_run is None:
            logger.warning("Auto-Live run %s disappeared before its worker started", run_id)
            return
        if started_run.status != "running":
            logger.info(
                "Skipping inactive Auto-Live run %s with status %s",
                run_id,
                started_run.status,
            )
            _mark_auto_live_task_lifecycle_best_effort(
                run_id=run_id,
                task_id=task_id,
                state="REVOKED" if started_run.status in {"failed", "skipped"} else "SUCCESS",
                worker_hostname=worker_hostname,
            )
            return
        heartbeat = AutoLiveRunHeartbeat(lease=lease, worker_hostname=worker_hostname)
        heartbeat.start()
        if not _run_execution_fence_is_owned(advisory_lock):
            raise self.retry(
                exc=AutoLiveRunExecutionLeaseLost(
                    "Auto-Live PostgreSQL execution fence was lost before planner start."
                ),
                countdown=AUTO_LIVE_RUN_REDELIVERY_RETRY_SECONDS,
            )
        _execute_polymarket_auto_live_run_with_lease(
            self,
            user_id,
            run_id,
            task_id=task_id,
            heartbeat=heartbeat,
            advisory_lock=advisory_lock,
        )
    finally:
        if heartbeat is not None:
            heartbeat.stop()
        if advisory_lock is not None:
            advisory_lock.release()
        release_auto_live_run_execution_lease_sync(lease)


def _execute_polymarket_auto_live_run_with_lease(
    self,
    user_id: int,
    run_id: str,
    *,
    task_id: str,
    heartbeat: AutoLiveRunHeartbeat,
    advisory_lock: AutoLiveAdvisoryLock,
) -> None:
    with SyncSessionLocal() as session:
        repo = SyncPolymarketAutoLiveRepository(session)
        register_auto_live_run_task_sync(run_id, task_id)
        run = repo.get_run(run_id)
        if run is None:
            logger.warning("Auto-Live run %s for user %s was not found", run_id, user_id)
            return
        if run.status != "running":
            logger.info("Skipping inactive Auto-Live run %s with status %s", run_id, run.status)
            _mark_auto_live_task_lifecycle_best_effort(
                run_id=run_id,
                task_id=task_id,
                state="REVOKED" if run.status in {"failed", "skipped"} else "SUCCESS",
                worker_hostname=getattr(self.request, "hostname", None),
            )
            return
        if not _run_execution_fence_is_owned(advisory_lock):
            session.rollback()
            raise self.retry(
                exc=AutoLiveRunExecutionLeaseLost(
                    "Auto-Live PostgreSQL execution fence was lost before workflow start."
                ),
                countdown=AUTO_LIVE_RUN_REDELIVERY_RETRY_SECONDS,
            )
        try:
            materialize_run_audit_snapshot_sync(
                session,
                user_id=user_id,
                run_id=run_id,
                force=True,
                freeze=False,
            )
            session.commit()
        except Exception:
            logger.exception("Initial Bullpen run audit materialization failed for run %s", run_id)
            session.rollback()

        settings, state = _synchronize_state(user_id, repo)
        position_records = repo.list_open_position_records(user_id)
        positions = [_position_snapshot_from_record(record) for record in position_records]
        historical_decisions = repo.list_decisions(user_id)

        try:
            if not _run_execution_fence_is_owned(advisory_lock):
                raise AutoLiveRunExecutionLeaseLost(
                    "Auto-Live PostgreSQL execution fence was lost before Stage 1/2 work."
                )

            def persist_progress(current_run: BullpenAutoLiveRun, current_state) -> None:
                if not _run_execution_fence_is_owned(advisory_lock):
                    raise AutoLiveRunExecutionLeaseLost(
                        "Auto-Live PostgreSQL execution fence was lost before progress persistence."
                    )
                persist_auto_live_progress_sync(
                    user_id=user_id,
                    repo=repo,
                    session=session,
                    run=current_run,
                    state=current_state,
                )

            engine_result = run_with_bullpen_runtime_cleanup(
                BullpenAutoLiveEngine().execute(
                    user_id=user_id,
                    settings=settings,
                    state=state,
                    run=run,
                    positions=positions,
                    historical_decisions=historical_decisions,
                    progress_callback=persist_progress,
                    durable_execution=auto_live_execution_v2_enabled(),
                )
            )
            if engine_result.run.status not in {
                "completed",
                "partial_success",
                "failed",
                "skipped",
                "confirming",
            }:
                raise RuntimeError(
                    "Bullpen Auto-Live engine returned without finalizing the run "
                    f"status (received {engine_result.run.status!r})."
                )
            if not _run_execution_fence_is_owned(advisory_lock):
                raise AutoLiveRunExecutionLeaseLost(
                    "Auto-Live PostgreSQL execution fence was lost before final persistence."
                )
        except AutoLiveRunExecutionLeaseLost as exc:
            # Never let an old task save its stale in-memory run as a generic
            # retry/failure after its ownership is gone. The advisory lock
            # serializes any in-flight remote call; retry only after the task
            # has unwound and released that fence.
            logger.warning(
                "Auto-Live run %s lost execution ownership; rolling back stale "
                "planner state before a fenced retry.",
                run_id,
            )
            session.rollback()
            raise self.retry(
                exc=exc,
                countdown=AUTO_LIVE_RUN_REDELIVERY_RETRY_SECONDS,
            )
        except AutoLiveRunCancelled:
            logger.info("Stopping Auto-Live worker for user-cancelled run %s", run_id)
            try:
                materialize_run_audit_snapshot_sync(
                    session,
                    user_id=user_id,
                    run_id=run_id,
                    force=True,
                    freeze=True,
                )
                session.commit()
            except Exception:
                logger.exception(
                    "Bullpen run audit freeze after cancellation failed for run %s",
                    run_id,
                )
                session.rollback()
            _mark_auto_live_task_lifecycle_best_effort(
                run_id=run_id,
                task_id=task_id,
                state="REVOKED",
                worker_hostname=getattr(self.request, "hostname", None),
            )
            return
        except Exception as exc:
            if not _run_execution_fence_is_owned(advisory_lock):
                session.rollback()
                raise self.retry(
                    exc=AutoLiveRunExecutionLeaseLost(
                        "Auto-Live PostgreSQL execution fence was lost before retry persistence."
                    ),
                    countdown=AUTO_LIVE_RUN_REDELIVERY_RETRY_SECONDS,
                )
            logger.exception("Auto-Live run %s failed before completion", run_id)
            sanitized_error = redact_secrets(str(exc))
            current_retries = int(getattr(self.request, "retries", 0) or 0)
            max_retries = AUTO_LIVE_WORKFLOW_MAX_RETRIES
            if current_retries < max_retries and not isinstance(exc, SoftTimeLimitExceeded):
                if _run_was_cancelled_by_user(repo, run_id, lock=True):
                    logger.info("Skipping retry for cancelled Auto-Live run %s", run_id)
                    return
                retry_number = current_retries + 1
                run.status = "running"
                run.completed_at = None
                run.error_message = None
                run.summary = (
                    f"Auto-Live worker hit a retryable error and is automatically "
                    f"retrying attempt {retry_number} of {max_retries}: {sanitized_error}"
                )
                state.last_error = None
                state.last_action = run.summary
                state.last_run_id = run.id
                state.last_run_at = datetime.now(UTC).isoformat()
                repo.save_run(user_id, run)
                repo.save_state(user_id, state)
                session.commit()
                _mark_auto_live_task_lifecycle_best_effort(
                    run_id=run_id,
                    task_id=task_id,
                    state="RETRYING",
                    detail=(
                        f"Worker retry {retry_number} of {max_retries} is queued."
                    ),
                    worker_hostname=getattr(self.request, "hostname", None),
                )
                raise self.retry(exc=exc, max_retries=max_retries)

            completed_at = datetime.now(UTC).isoformat()
            run.status = "failed"
            run.completed_at = completed_at
            run.error_message = sanitized_error
            run.summary = finalize_failed_run_progress(
                run,
                failure_message=sanitized_error,
                completed_at=completed_at,
            )
            state.last_error = run.summary
            state.last_action = run.summary
            state.last_run_id = run.id
            state.last_run_at = completed_at
            persist_auto_live_progress_sync(
                user_id=user_id,
                repo=repo,
                session=session,
                run=run,
                state=state,
            )
            try:
                materialize_run_audit_snapshot_sync(
                    session,
                    user_id=user_id,
                    run_id=run_id,
                    force=True,
                    freeze=True,
                )
                session.commit()
            except Exception:
                logger.exception("Final Bullpen run audit freeze failed for run %s", run_id)
                session.rollback()
            logger.exception("Auto-Live run %s exhausted retries", run_id)
            _mark_auto_live_task_lifecycle_best_effort(
                run_id=run_id,
                task_id=task_id,
                state="FAILURE",
                worker_hostname=getattr(self.request, "hostname", None),
            )
            return

        if _run_was_cancelled_by_user(repo, run_id, lock=True):
            logger.info("Skipping final Auto-Live persistence for cancelled run %s", run_id)
            try:
                materialize_run_audit_snapshot_sync(
                    session,
                    user_id=user_id,
                    run_id=run_id,
                    force=True,
                    freeze=True,
                )
                session.commit()
            except Exception:
                logger.exception(
                    "Bullpen run audit freeze after final cancellation check failed for run %s",
                    run_id,
                )
                session.rollback()
            _mark_auto_live_task_lifecycle_best_effort(
                run_id=run_id,
                task_id=task_id,
                state="REVOKED",
                worker_hostname=getattr(self.request, "hostname", None),
            )
            return

        if not _run_execution_fence_is_owned(advisory_lock):
            session.rollback()
            raise self.retry(
                exc=AutoLiveRunExecutionLeaseLost(
                    "Auto-Live PostgreSQL execution fence was lost before final run persistence."
                ),
                countdown=AUTO_LIVE_RUN_REDELIVERY_RETRY_SECONDS,
            )
        repo.save_run(user_id, engine_result.run)
        repo.replace_run_decisions(user_id, run_id, engine_result.decisions)
        repo.replace_positions(user_id, engine_result.positions)
        repo.save_state(user_id, engine_result.state)

        # Keep the final Stage 1/2 result and Stage 3's durable intent handoff
        # in one database transaction.  A planning task may safely retry after
        # losing its advisory fence, but it must never leave a persisted
        # ``confirming`` run without the order intents that own the remainder
        # of its work.  In particular, do not commit the run before creating
        # and synchronizing its intents below.
        if (
            auto_live_execution_v2_enabled()
            and engine_result.run.live_execution_requested
            and not engine_result.run.dry_run
        ):
            if not _run_execution_fence_is_owned(advisory_lock):
                session.rollback()
                raise self.retry(
                    exc=AutoLiveRunExecutionLeaseLost(
                        "Auto-Live PostgreSQL execution fence was lost before Stage 3 intent persistence."
                    ),
                    countdown=AUTO_LIVE_RUN_REDELIVERY_RETRY_SECONDS,
                )
            persisted_intents = create_or_refresh_run_order_intents_sync(
                session,
                user_id=user_id,
                run=engine_result.run,
                decisions=engine_result.decisions,
            )
            for stage in engine_result.run.stage_results:
                if stage.stage_number != 3 and stage.outputs.get("workflow_stage_key") != "invest":
                    continue
                diagnostics = stage.outputs.get("stage3_slot_diagnostics")
                if isinstance(diagnostics, dict):
                    diagnostics.update(
                        {
                            "exit_intent_ids": [
                                intent.id
                                for intent in persisted_intents
                                if intent.action in {"sell", "redeem"}
                            ],
                            "planned_buy_ids": [
                                intent.id for intent in persisted_intents if intent.action == "buy"
                            ],
                            "exit_retry_history": [
                                {
                                    "intent_id": intent.id,
                                    "history": intent.execution_metadata_json.get(
                                        "stage3_rpc_retry_history", []
                                    ),
                                }
                                for intent in persisted_intents
                                if intent.action in {"sell", "redeem"}
                            ],
                        }
                    )
                break
            # Persist the additive Stage 3 audit fields before the intent
            # synchronizer reads the saved run back from the database.
            repo.save_run(user_id, engine_result.run)
            session.flush()
            synced_run = sync_run_and_decisions_from_intents_sync(
                session,
                user_id=user_id,
                run_id=run_id,
            )
            if synced_run is not None:
                engine_result.state.last_action = synced_run.summary
                engine_result.state.last_error = (
                    None if synced_run.status in {"completed", "confirming"} else synced_run.summary
                )
                engine_result.state.last_run_id = synced_run.id
                engine_result.state.last_run_at = synced_run.completed_at or _utc_now().isoformat()
                repo.save_state(user_id, engine_result.state)

        if not _run_execution_fence_is_owned(advisory_lock):
            session.rollback()
            raise self.retry(
                exc=AutoLiveRunExecutionLeaseLost(
                    "Auto-Live PostgreSQL execution fence was lost before committing "
                    "the final planner result and Stage 3 intent handoff."
                ),
                countdown=AUTO_LIVE_RUN_REDELIVERY_RETRY_SECONDS,
            )
        session.commit()

        if (
            auto_live_execution_v2_enabled()
            and engine_result.run.live_execution_requested
            and not engine_result.run.dry_run
        ):
            if not _run_execution_fence_is_owned(advisory_lock):
                session.rollback()
                raise self.retry(
                    exc=AutoLiveRunExecutionLeaseLost(
                        "Auto-Live PostgreSQL execution fence was lost before Stage 3 dispatch."
                    ),
                    countdown=AUTO_LIVE_RUN_REDELIVERY_RETRY_SECONDS,
                )
            queued_count = _queue_due_order_intents_for_run_sync(run_id)
            if queued_count:
                logger.info(
                    "Queued %s due durable Stage 3 order intents for run %s immediately after planning.",
                    queued_count,
                    run_id,
                )
        try:
            materialize_run_audit_snapshot_sync(
                session,
                user_id=user_id,
                run_id=run_id,
                force=True,
                freeze=engine_result.run.status in {"completed", "partial_success", "failed", "skipped"},
            )
            session.commit()
        except Exception:
            logger.exception("Bullpen run audit post-run materialization failed for run %s", run_id)
            session.rollback()
            dispatch_due_auto_live_order_intents.delay()  # type: ignore[attr-defined]
        try:
            sync_auto_live_position_snapshots_sync(
                user_id=user_id,
                positions=engine_result.positions,
            )
        except Exception:
            logger.warning(
                "Auto-Live trade-analysis periodic snapshot sync failed for run %s.",
                run_id,
                exc_info=True,
            )
        if not _run_execution_fence_is_owned(advisory_lock):
            session.rollback()
            raise self.retry(
                exc=AutoLiveRunExecutionLeaseLost(
                    "Auto-Live PostgreSQL execution fence was lost before task completion."
                ),
                countdown=AUTO_LIVE_RUN_REDELIVERY_RETRY_SECONDS,
            )
        _mark_auto_live_task_lifecycle_best_effort(
            run_id=run_id,
            task_id=task_id,
            state="SUCCESS",
            worker_hostname=getattr(self.request, "hostname", None),
        )


@celery.task(
    name="app.domains.polymarket_auto_live.tasks.enqueue_due_polymarket_auto_live_runs",
    queue="beat",
)
def enqueue_due_polymarket_auto_live_runs() -> None:
    now = _utc_now()
    with SyncSessionLocal() as session:
        repo = SyncPolymarketAutoLiveRepository(session)
        due_states = session.execute(
            select(PolymarketAutoLiveStateRecord).where(
                and_(
                    PolymarketAutoLiveStateRecord.running.is_(True),
                    PolymarketAutoLiveStateRecord.paused.is_(False),
                    PolymarketAutoLiveStateRecord.next_run_at.is_not(None),
                    PolymarketAutoLiveStateRecord.next_run_at <= now,
                )
            )
        ).scalars().all()

        for state_record in due_states:
            user_id = state_record.user_id
            settings_record = repo.get_settings_record(user_id)
            settings = record_to_settings(settings_record)
            if settings.emergency_stop or not settings.auto_live_enabled:
                continue
            state = record_to_state(state_record)
            active_run = session.execute(
                select(PolymarketAutoLiveRunRecord).where(
                    and_(
                        PolymarketAutoLiveRunRecord.user_id == user_id,
                        PolymarketAutoLiveRunRecord.status == "running",
                    )
                )
            ).scalar_one_or_none()
            if active_run is not None:
                recovered_run = reconcile_running_auto_live_run(
                    record_to_run(active_run),
                    started_at=active_run.started_at,
                    updated_at=active_run.updated_at,
                )
                if recovered_run is None:
                    continue

                state.last_run_id = recovered_run.id
                state.last_run_at = recovered_run.completed_at
                state.last_action = recovered_run.summary
                state.last_error = (
                    None if recovered_run.status == "completed" else recovered_run.summary
                )
                state = BullpenAutoLiveBot(user_id=user_id)._synchronize_state(
                    settings,
                    state,
                )
                repo.save_run(user_id, recovered_run)
                repo.replace_run_decisions_from_stage3_payload(user_id, recovered_run)
                repo.save_state(user_id, state)
                session.commit()

            state.last_action = "Queued scheduled Auto-Live run."
            BullpenAutoLiveBot(user_id=user_id)._schedule_next_cycles(
                settings,
                state,
                reference_time=now,
            )
            task_id = str(uuid4())
            run = BullpenAutoLiveRun(
                id=str(uuid4()),
                triggered_by="scheduler",
                status="running",
                dry_run=effective_dry_run(settings),
                started_at=now.isoformat(),
                summary=build_initial_run_summary(),
                live_execution_requested=live_execution_requested(settings),
                guardrail_checks=state.latest_guardrail_checks,
                stage_results=[
                    build_initial_scan_stage_result(
                        started_at=now.isoformat(),
                    )
                ],
                stage2_llm_targets_snapshot=_stage2_llm_targets_snapshot(settings),
                audit_metadata=build_native_run_audit_metadata(
                    settings_snapshot=settings.model_dump(mode="json"),
                    prompt_template=settings.console_llm_prompt_template,
                    execution_version=None,
                    strategy_version=settings.strategy_profile,
                ),
                task_lifecycle=queued_auto_live_task_lifecycle(
                    task_id=task_id,
                    enqueued_at=now.isoformat(),
                ),
            )
            repo.save_run(user_id, run)
            repo.save_state(user_id, state)
            session.commit()
            try:
                task = execute_polymarket_auto_live_run.apply_async(  # type: ignore[attr-defined]
                    args=(user_id, run.id),
                    task_id=task_id,
                    queue=AUTO_LIVE_QUEUE,
                )
            except Exception:
                logger.exception(
                    "Could not enqueue scheduled Auto-Live run %s; marking it failed.",
                    run.id,
                )
                run.status = "failed"
                run.completed_at = _utc_now().isoformat()
                run.error_message = "Could not enqueue Auto-Live worker task"
                run.summary = run.error_message
                if run.task_lifecycle is not None:
                    run.task_lifecycle = run.task_lifecycle.model_copy(
                        update={
                            "state": "FAILURE",
                            "detail": run.error_message,
                        }
                    )
                repo.save_run(user_id, run)
                repo.save_state(user_id, state)
                session.commit()
                continue
            register_auto_live_run_task_sync(run.id, str(task.id))


@celery.task(
    name="app.domains.polymarket_auto_live.tasks.dispatch_due_auto_live_order_intents",
    queue="beat",
)
def dispatch_due_auto_live_order_intents(limit: int = 50) -> None:
    """Canonical periodic dispatcher for *executable* durable intents only.

    Reconciliation is intentionally not scanned here.  Keeping submitted and
    confirming states in ``reconcile_all_pending_auto_live_orders`` prevents
    two every-minute beat tasks from scheduling the same expensive remote poll.
    """

    with SyncSessionLocal() as session:
        watchdog_requeue_stale_order_intents_sync(session, limit=limit)
        session.commit()
        executable_ids = list_due_order_intent_ids_sync(
            session,
            limit=limit,
            statuses=("PLANNED", "READY", "RETRY_WAIT", "WAITING_FOR_COLLATERAL", "WAITING_FOR_EXIT"),
        )

    _enqueue_execute_order_intents(executable_ids, source="periodic-execution-dispatch")


@celery.task(
    name="app.domains.polymarket_auto_live.tasks.watchdog_requeue_stale_auto_live_order_intents",
    queue="beat",
)
def watchdog_requeue_stale_auto_live_order_intents(limit: int = 100) -> None:
    with SyncSessionLocal() as session:
        touched_ids = watchdog_requeue_stale_order_intents_sync(session, limit=limit)
        reconcile_ids = set(
            session.execute(
                select(PolymarketAutoLiveOrderIntentRecord.id)
                .where(PolymarketAutoLiveOrderIntentRecord.id.in_(touched_ids))
                .where(PolymarketAutoLiveOrderIntentRecord.status.in_(("CONFIRMING", "SUBMITTING")))
            )
            .scalars()
            .all()
        )
        session.commit()
    for intent_id in touched_ids:
        if intent_id in reconcile_ids:
            _enqueue_reconcile_order_intent(
                str(intent_id),
                source="watchdog-stale-submission",
            )
        else:
            _enqueue_execute_order_intents(
                [intent_id],
                source="watchdog-execution-recovery",
            )


@celery.task(
    bind=True,
    max_retries=0,
    # Bullpen RPC/runtime locking can take many minutes.  Bound the worker
    # slot without treating an interrupted submission as permission to
    # resubmit: durable intent state and remote reconciliation remain the
    # recovery authority.
    soft_time_limit=60 * 30,
    time_limit=(60 * 30) + 60,
    name="app.domains.polymarket_auto_live.tasks.execute_auto_live_order_intent",
    queue="ai",
)
def execute_auto_live_order_intent(
    self,
    intent_id: str,
    lease_token: str | None = None,
) -> None:
    lease = _begin_order_intent_operation(
        self,
        intent_id=intent_id,
        operation="execute",
        lease_token=lease_token,
        source="execute-auto-live-order-intent",
    )
    if lease is None:
        logger.info(
            "Skipping duplicate or fenced Stage 3 execution for intent %s", intent_id
        )
        return
    heartbeat = OrderIntentOperationLeaseHeartbeat(lease)
    advisory_lock: AutoLiveAdvisoryLock | None = None
    status: str | None = None
    ownership_healthy = False
    try:
        heartbeat.start()
        if not heartbeat.ensure_ownership():
            return
        try:
            advisory_lock = acquire_order_intent_operation_advisory_lock_sync(
                intent_id
            )
        except AutoLiveAdvisoryLockUnavailable:
            # The Redis lease is not enough to permit a remote submission if
            # its key was evicted.  Leave the durable intent unchanged for a
            # later fenced scheduler/recovery attempt.
            logger.exception(
                "Skipping unfenced Stage 3 execution for intent %s because its "
                "PostgreSQL advisory lock is unavailable.",
                intent_id,
            )
            return
        if advisory_lock is None:
            logger.info(
                "Skipping duplicate Stage 3 execution for intent %s; PostgreSQL "
                "advisory lock is held by another worker.",
                intent_id,
            )
            return
        if not advisory_lock.is_healthy():
            logger.error(
                "Skipping Stage 3 execution for intent %s because its PostgreSQL "
                "advisory lock session was lost before remote work.",
                intent_id,
            )
            return
        if not heartbeat.ensure_ownership():
            return
        try:
            with SyncSessionLocal() as session:
                annotate_intent_dispatch_sync(
                    session,
                    intent_id=intent_id,
                    task_id=_task_request_id(self),
                    queue="ai",
                    worker=getattr(getattr(self, "request", None), "hostname", None),
                    task_name="execute_auto_live_order_intent",
                    operation="execute",
                )
                session.commit()
        except Exception:
            logger.warning(
                "Failed to annotate Stage 3 worker receipt for %s",
                intent_id,
                exc_info=True,
            )
        if not advisory_lock.is_healthy():
            logger.error(
                "Skipping Stage 3 execution for intent %s because its PostgreSQL "
                "advisory lock session was lost before the remote call.",
                intent_id,
            )
            return
        status = execute_order_intent_sync(
            intent_id,
            worker_task_id=_task_request_id(self),
        )
        _refresh_order_intent_audit_sync(intent_id)
        ownership_healthy = not heartbeat.ownership_lost
    finally:
        if advisory_lock is not None:
            advisory_lock.release()
        heartbeat.stop()
        _finish_order_intent_operation(lease)

    # Submit/ambiguous outcomes must be reconciled promptly, but only after
    # releasing the same per-intent operation lease.  The one canonical helper
    # makes this race-safe with beat, watchdog, recovery, and operator paths.
    if ownership_healthy and status in _RECONCILABLE_ORDER_INTENT_STATUSES:
        _enqueue_reconcile_order_intent(
            intent_id,
            source="post-execution-reconciliation",
        )


@celery.task(
    bind=True,
    max_retries=0,
    soft_time_limit=60 * 30,
    time_limit=(60 * 30) + 60,
    name="app.domains.polymarket_auto_live.tasks.reconcile_auto_live_order_intent",
    queue="ai",
)
def reconcile_auto_live_order_intent(
    self,
    intent_id: str,
    lease_token: str | None = None,
) -> None:
    lease = _begin_order_intent_operation(
        self,
        intent_id=intent_id,
        operation="reconcile",
        lease_token=lease_token,
        source="reconcile-auto-live-order-intent",
    )
    if lease is None:
        logger.info(
            "Skipping duplicate or fenced Stage 3 reconciliation for intent %s",
            intent_id,
        )
        return
    heartbeat = OrderIntentOperationLeaseHeartbeat(lease)
    advisory_lock: AutoLiveAdvisoryLock | None = None
    status: str | None = None
    due_ids: list[str] = []
    ownership_healthy = False
    try:
        heartbeat.start()
        if not heartbeat.ensure_ownership():
            return
        try:
            advisory_lock = acquire_order_intent_operation_advisory_lock_sync(
                intent_id
            )
        except AutoLiveAdvisoryLockUnavailable:
            logger.exception(
                "Skipping unfenced Stage 3 reconciliation for intent %s because "
                "its PostgreSQL advisory lock is unavailable.",
                intent_id,
            )
            return
        if advisory_lock is None:
            logger.info(
                "Skipping duplicate Stage 3 reconciliation for intent %s; "
                "PostgreSQL advisory lock is held by another worker.",
                intent_id,
            )
            return
        if not advisory_lock.is_healthy():
            logger.error(
                "Skipping Stage 3 reconciliation for intent %s because its PostgreSQL "
                "advisory lock session was lost before remote work.",
                intent_id,
            )
            return
        if not heartbeat.ensure_ownership():
            return
        if not advisory_lock.is_healthy():
            logger.error(
                "Skipping Stage 3 reconciliation for intent %s because its PostgreSQL "
                "advisory lock session was lost before the remote call.",
                intent_id,
            )
            return
        status = reconcile_order_intent_sync(intent_id)
        _refresh_order_intent_audit_sync(intent_id)
        if status not in {"CONFIRMED", "FILLED"}:
            return
        # A confirmed exit may have just released a reserved replacement slot.
        # Queue only the same run's due intents; no Stage 1/2 task is created.
        with SyncSessionLocal() as session:
            record = session.get(PolymarketAutoLiveOrderIntentRecord, intent_id)
            if record is None:
                return
            due_ids = list_due_order_intent_ids_sync(
                session,
                limit=50,
                statuses=("READY", "WAITING_FOR_COLLATERAL", "WAITING_FOR_EXIT"),
                now=_utc_now(),
            )
            if due_ids:
                due_ids = list(
                    session.execute(
                        select(PolymarketAutoLiveOrderIntentRecord.id)
                        .where(PolymarketAutoLiveOrderIntentRecord.id.in_(due_ids))
                        .where(PolymarketAutoLiveOrderIntentRecord.run_id == record.run_id)
                )
                    .scalars()
                    .all()
                )
        ownership_healthy = not heartbeat.ownership_lost
    finally:
        if advisory_lock is not None:
            advisory_lock.release()
        heartbeat.stop()
        _finish_order_intent_operation(lease)

    if ownership_healthy:
        for due_id in due_ids:
            _enqueue_execute_order_intents(
                [due_id],
                source="confirmed-reconciliation-dependent-execution",
            )


@celery.task(
    name="app.domains.polymarket_auto_live.tasks.reconcile_auto_live_run_orders",
    queue="beat",
)
def reconcile_auto_live_run_orders(run_id: str) -> None:
    enqueue_auto_live_run_order_reconciliations_sync(
        run_id,
        source="operator-run-reconciliation-task",
    )


@celery.task(
    bind=True,
    max_retries=0,
    soft_time_limit=60 * 30,
    time_limit=(60 * 30) + 60,
    name="app.domains.polymarket_auto_live.tasks.retry_auto_live_order_intent",
    queue="ai",
)
def retry_auto_live_order_intent(
    self,
    intent_id: str,
    lease_token: str | None = None,
) -> None:
    lease = _begin_order_intent_operation(
        self,
        intent_id=intent_id,
        operation="retry",
        lease_token=lease_token,
        source="retry-auto-live-order-intent",
    )
    if lease is None:
        logger.info("Skipping duplicate or fenced Stage 3 retry for intent %s", intent_id)
        return
    heartbeat = OrderIntentOperationLeaseHeartbeat(lease)
    advisory_lock: AutoLiveAdvisoryLock | None = None
    status: str | None = None
    ownership_healthy = False
    try:
        heartbeat.start()
        if not heartbeat.ensure_ownership():
            return
        try:
            advisory_lock = acquire_order_intent_operation_advisory_lock_sync(
                intent_id
            )
        except AutoLiveAdvisoryLockUnavailable:
            logger.exception(
                "Skipping unfenced Stage 3 retry for intent %s because its "
                "PostgreSQL advisory lock is unavailable.",
                intent_id,
            )
            return
        if advisory_lock is None:
            logger.info(
                "Skipping duplicate Stage 3 retry for intent %s; PostgreSQL "
                "advisory lock is held by another worker.",
                intent_id,
            )
            return
        if not advisory_lock.is_healthy():
            logger.error(
                "Skipping Stage 3 retry for intent %s because its PostgreSQL advisory "
                "lock session was lost before remote work.",
                intent_id,
            )
            return
        if not heartbeat.ensure_ownership():
            return
        try:
            with SyncSessionLocal() as session:
                annotate_intent_dispatch_sync(
                    session,
                    intent_id=intent_id,
                    task_id=_task_request_id(self),
                    queue="ai",
                    worker=getattr(getattr(self, "request", None), "hostname", None),
                    task_name="retry_auto_live_order_intent",
                    operation="retry",
                )
                session.commit()
        except Exception:
            logger.warning(
                "Failed to annotate Stage 3 retry worker receipt for %s",
                intent_id,
                exc_info=True,
            )
        if not advisory_lock.is_healthy():
            logger.error(
                "Skipping Stage 3 retry for intent %s because its PostgreSQL advisory "
                "lock session was lost before the remote call.",
                intent_id,
            )
            return
        status = execute_order_intent_sync(
            intent_id,
            worker_task_id=_task_request_id(self),
        )
        _refresh_order_intent_audit_sync(intent_id)
        ownership_healthy = not heartbeat.ownership_lost
    finally:
        if advisory_lock is not None:
            advisory_lock.release()
        heartbeat.stop()
        _finish_order_intent_operation(lease)

    if ownership_healthy and status in _RECONCILABLE_ORDER_INTENT_STATUSES:
        _enqueue_reconcile_order_intent(
            intent_id,
            source="post-retry-reconciliation",
        )


@celery.task(
    name="app.domains.polymarket_auto_live.tasks.reconcile_all_pending_auto_live_orders",
    queue="beat",
)
def reconcile_all_pending_auto_live_orders(limit: int = 100) -> None:
    """The sole periodic scanner for submitted/confirming intent states."""

    with SyncSessionLocal() as session:
        intent_ids = list_due_order_intent_ids_sync(
            session,
            limit=limit,
            statuses=("SUBMITTED", "CONFIRMING", "PARTIALLY_FILLED", "SETTLEMENT_PENDING", "SUBMITTING"),
        )
    for intent_id in intent_ids:
        _enqueue_reconcile_order_intent(
            str(intent_id),
            source="periodic-pending-reconciliation",
        )
