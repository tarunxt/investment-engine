from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from app.core.logging import get_logger
from app.domains.polymarket.logger import redact_secrets
from app.domains.polymarket_auto_live.schemas import (
    BullpenAutoLiveRun,
    BullpenAutoLiveStageResult,
)
from app.domains.polymarket_auto_live.run_lifecycle import (
    AUTO_LIVE_RUN_WORKER_LOSS_GRACE_SECONDS,
    auto_live_run_execution_lease_is_live_sync,
    lifecycle_detail_for_state,
    task_lifecycle_has_redelivery_evidence,
    task_lifecycle_heartbeat_at,
    task_lifecycle_is_queue_waiting,
)
from app.domains.polymarket_auto_live.advisory_lock import (
    auto_live_run_execution_advisory_lock_is_live_sync,
)
from app.infrastructure.messaging.celery_app import celery
from app.infrastructure.messaging.task_registry import (
    get_registered_auto_live_run_task_id_sync,
    revoke_auto_live_run_task_sync,
)

logger = get_logger("app.domains.polymarket_auto_live.run_recovery")

AUTO_LIVE_RUN_HEARTBEAT_TIMEOUT = timedelta(minutes=15)
# A run that has not reached a terminal state by this point is unsafe to leave
# executing, even when Celery still reports its process as active.  Individual
# provider calls have much shorter timeouts, so this is a workflow circuit
# breaker rather than the normal execution path.
AUTO_LIVE_RUN_ABSOLUTE_TIMEOUT = timedelta(hours=2)
TASK_INSPECT_TIMEOUT_SECONDS = 1.0
# Dashboard polling must not turn a running workflow into repeated Celery
# broadcast inspections. Cache the result briefly; a fresh inspection still
# occurs quickly enough for recovery while concurrent HTTP requests share it.
TASK_INSPECTION_CACHE_TTL_SECONDS = 10.0

_PENDING_STAGE3_ORDER_DETAIL = "Order planned but not executed yet."
_TERMINAL_CELERY_STATES = frozenset({"SUCCESS", "FAILURE", "REVOKED"})
_LIVE_CELERY_STATES = frozenset({"STARTED"})
_TERMINAL_STAGE_PHASES = frozenset({"completed", "failed", "cancelled"})
_WORKER_LOST_RESULT_MARKERS = (
    "workerlosterror",
    "worker lost",
    "worker exited prematurely",
)
_WORKFLOW_STAGE_LABELS = {
    "scan": "Stage 1 · Bullpen Scan",
    "llm": "Stage 2 · Run LLM",
    "invest": "Stage 3 · Exit and Invest",
}


@dataclass(frozen=True)
class AutoLiveTaskRuntimeSnapshot:
    task_id: str | None
    state: str | None = None
    result_error: str | None = None
    result_traceback: str | None = None
    is_active: bool = False
    is_reserved: bool = False
    is_scheduled: bool = False
    inspect_succeeded: bool = False
    # Celery inspect is broadcast best-effort.  ``False`` means at least one
    # expected worker did not reply, so absence from its response is not proof
    # that a task is absent globally.  ``None`` preserves compatibility with
    # existing focused callers that only supplied ``inspect_succeeded``.
    inspect_complete: bool | None = None

    @property
    def is_live(self) -> bool:
        normalized_state = (self.state or "").strip().upper()
        return (
            normalized_state in _LIVE_CELERY_STATES
            or self.is_active
            or self.is_reserved
            or self.is_scheduled
        )


# A lifecycle task ID can outlive the Redis task-registry entry (for example
# after a Redis restart).  Include the requested fallback in the cache key so
# a dashboard lookup without a task ID can never poison recovery's richer
# inspection of the persisted delivery.
_task_inspection_cache: dict[
    tuple[str, str | None], tuple[float, AutoLiveTaskRuntimeSnapshot]
] = {}
_task_inspection_cache_lock = threading.Lock()


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _utc_now_iso() -> str:
    return _utc_now().isoformat()


def _normalize_datetime(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _parse_iso_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return _normalize_datetime(parsed)


def _inspect_has_complete_negative_evidence(
    snapshot: AutoLiveTaskRuntimeSnapshot,
) -> bool:
    """Whether a missing task was observed by a complete inspect response.

    A historic test double only has ``inspect_succeeded``; preserve that
    behavior for callers which did not yet provide the richer field.  Actual
    broker inspection always sets ``inspect_complete`` explicitly.
    """

    if snapshot.inspect_complete is not None:
        return snapshot.inspect_complete
    return snapshot.inspect_succeeded


def _read_output_int(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str) and value.strip():
        try:
            return int(value)
        except ValueError:
            return None
    return None


def _read_output_string(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    return trimmed or None


def _stage_workflow_key(stage: BullpenAutoLiveStageResult) -> str | None:
    workflow_stage_key = stage.outputs.get("workflow_stage_key")
    if not isinstance(workflow_stage_key, str):
        return None
    normalized_key = workflow_stage_key.strip().lower()
    return normalized_key if normalized_key in _WORKFLOW_STAGE_LABELS else None


def _stage_phase_status(stage: BullpenAutoLiveStageResult) -> str | None:
    phase_status = stage.outputs.get("phase_status")
    if not isinstance(phase_status, str):
        return None
    trimmed = phase_status.strip().lower()
    return trimmed or None


def _stage_terminal(stage: BullpenAutoLiveStageResult) -> bool:
    phase_status = _stage_phase_status(stage)
    return bool(stage.completed_at) and phase_status in _TERMINAL_STAGE_PHASES


def _workflow_stage_label(stage: BullpenAutoLiveStageResult) -> str:
    workflow_stage_key = _stage_workflow_key(stage)
    if workflow_stage_key is not None:
        return _WORKFLOW_STAGE_LABELS[workflow_stage_key]
    return f"Stage {stage.stage_number}"


def _latest_stage_completed_at(run: BullpenAutoLiveRun) -> str | None:
    completed_at_values = [
        stage.completed_at
        for stage in run.stage_results
        if isinstance(stage.completed_at, str) and stage.completed_at.strip()
    ]
    if not completed_at_values:
        return run.completed_at
    return max(completed_at_values)


def _find_terminal_invest_stage(
    run: BullpenAutoLiveRun,
) -> BullpenAutoLiveStageResult | None:
    invest_stages = [
        stage
        for stage in run.stage_results
        if _stage_workflow_key(stage) == "invest" and _stage_terminal(stage)
    ]
    if not invest_stages:
        return None
    return max(invest_stages, key=lambda stage: stage.stage_number)


def _find_failure_stage(
    run: BullpenAutoLiveRun,
) -> BullpenAutoLiveStageResult | None:
    failure_stages = [
        stage
        for stage in run.stage_results
        if (
            _stage_phase_status(stage) in {"failed", "cancelled"}
            or stage.status == "fail"
        )
    ]
    if not failure_stages:
        return None
    return max(failure_stages, key=lambda stage: stage.stage_number)


def _summary_looks_inflight(summary: str) -> bool:
    normalized = summary.strip().lower()
    if not normalized:
        return True
    return (
        normalized.startswith("stage ")
        or normalized.startswith("bullpen scan started")
        or normalized.startswith("auto-live run failed during stage")
        or "reviewed row" in normalized
        or "loading the current questions table" in normalized
        or "preparing the candidate fetch" in normalized
        or normalized.endswith("is still running.")
    )


def _build_completed_summary(
    run: BullpenAutoLiveRun,
    stage: BullpenAutoLiveStageResult | None,
) -> str:
    if stage is not None:
        decisions_count = _read_output_int(stage.outputs.get("decisions_count"))
        orders_planned = _read_output_int(stage.outputs.get("orders_planned"))
        orders_submitted = _read_output_int(stage.outputs.get("orders_submitted"))
        if (
            decisions_count is not None
            and orders_planned is not None
            and orders_submitted is not None
        ):
            return (
                f"Auto-Live completed with {decisions_count} decisions, "
                f"{orders_planned} planned orders, and {orders_submitted} submitted orders."
            )
        reason = _read_output_string(stage.reason)
        if reason is not None:
            return reason

    return (
        run.summary
        if run.summary.strip() and not _summary_looks_inflight(run.summary)
        else "Auto-Live completed after the stored workflow stages finished."
    )


def _build_failure_message(stage: BullpenAutoLiveStageResult | None) -> str | None:
    if stage is None:
        return None

    for key in (
        "error_message",
        "failure_message",
        "execution_failure_message",
        "execution_gate_reason",
    ):
        value = _read_output_string(stage.outputs.get(key))
        if value is not None:
            return value

    reason = _read_output_string(stage.reason)
    if reason is not None:
        return reason
    return None


def _append_failure_reason(reason: str, failure_message: str) -> str:
    normalized_reason = reason.strip()
    failure_suffix = f"Worker error: {failure_message}"
    if not normalized_reason:
        return failure_suffix
    if failure_message in normalized_reason or failure_suffix in normalized_reason:
        return normalized_reason
    separator = " " if normalized_reason.endswith((".", "!", "?")) else ". "
    return f"{normalized_reason}{separator}{failure_suffix}"


def _mark_stage3_decision_rows_failed(
    outputs: dict[str, object],
    *,
    failure_message: str,
) -> dict[str, object]:
    raw_decision_rows = outputs.get("decision_rows")
    if not isinstance(raw_decision_rows, list):
        return outputs

    updated_rows: list[object] = []
    failed_orders = 0
    processed_orders = 0

    for row in raw_decision_rows:
        if not isinstance(row, dict):
            updated_rows.append(row)
            continue

        next_row = dict(row)
        raw_order_plan = next_row.get("order_plan")
        if isinstance(raw_order_plan, dict):
            next_order_plan = dict(raw_order_plan)
            order_status = str(next_order_plan.get("status") or "").strip().lower()
            if order_status == "planned":
                next_order_plan["status"] = "failed"
                detail = str(next_order_plan.get("detail") or "").strip()
                if not detail or detail == _PENDING_STAGE3_ORDER_DETAIL:
                    next_order_plan["detail"] = failure_message
                next_row["order_plan"] = next_order_plan
                failed_orders += 1

            final_status = str(next_order_plan.get("status") or "").strip().lower()
            if final_status and final_status != "planned":
                processed_orders += 1

        updated_rows.append(next_row)

    outputs["decision_rows"] = updated_rows
    if failed_orders > 0:
        outputs["orders_failed"] = max(
            failed_orders,
            _read_output_int(outputs.get("orders_failed")) or 0,
        )
        outputs["orders_processed"] = max(
            processed_orders,
            _read_output_int(outputs.get("orders_processed")) or 0,
        )
    return outputs


def finalize_failed_run_progress(
    run: BullpenAutoLiveRun,
    *,
    failure_message: str,
    completed_at: str,
) -> str:
    active_stage = next(
        (
            stage
            for stage in sorted(run.stage_results, key=lambda item: item.stage_number, reverse=True)
            if stage.completed_at is None
            or _stage_phase_status(stage) == "running"
        ),
        None,
    )
    if active_stage is None:
        return f"Auto-Live run failed: {failure_message}"

    stage_outputs = dict(active_stage.outputs)
    stage_outputs["phase_status"] = "failed"
    stage_outputs["error_message"] = failure_message
    stage_outputs["failure_message"] = failure_message
    if _stage_workflow_key(active_stage) == "invest":
        stage_outputs = _mark_stage3_decision_rows_failed(
            stage_outputs,
            failure_message=failure_message,
        )

    active_stage.outputs = stage_outputs
    active_stage.status = "fail"
    active_stage.reason = _append_failure_reason(active_stage.reason, failure_message)
    active_stage.completed_at = completed_at

    return f"Auto-Live run failed during {_workflow_stage_label(active_stage)}: {failure_message}"


def run_contains_historical_auth_error(run: BullpenAutoLiveRun | None) -> bool:
    if run is None:
        return False
    searchable = "\n".join(
        [
            run.summary,
            run.error_message or "",
            *[
                f"{stage.reason}\n{stage.outputs}"
                for stage in run.stage_results
            ],
        ]
    ).lower()
    return any(
        marker in searchable
        for marker in (
            "auth_refresh_rejected_login_required",
            "bullpen login",
            "login required",
            "requires_login",
            "auth_required",
            "session expired",
            "invalid refresh token",
            "could not resolve your polymarket address",
        )
    )


def mark_historical_auth_error_recovered(
    run: BullpenAutoLiveRun,
    *,
    recovered_at: str,
) -> BullpenAutoLiveRun:
    """Close an inconsistent run after active doctor auth proves recovery."""

    summary = (
        "Earlier Bullpen authentication error recovered; the latest active "
        "doctor auth refresh is healthy. The interrupted run was closed and "
        "does not block a new run."
    )
    run.audit_metadata = {
        **run.audit_metadata,
        "auth_recovery": {
            "historical_error_stale": True,
            "active_auth_healthy": True,
            "recovered_at": recovered_at,
        },
    }
    for stage in reversed(run.stage_results):
        if _stage_terminal(stage):
            continue
        stage.status = "fail"
        stage.completed_at = recovered_at
        stage.reason = summary
        stage.outputs = {
            **stage.outputs,
            "phase_status": "aborted",
            "historical_auth_error_stale": True,
            "auth_recovered_at": recovered_at,
        }
        break
    run.status = "failed"
    run.completed_at = recovered_at
    run.error_message = None
    run.summary = summary
    return run


def mark_interrupted_run_for_restart(
    run: BullpenAutoLiveRun,
    *,
    interrupted_at: str | None = None,
) -> BullpenAutoLiveRun:
    """Abort persisted in-progress work without inferring or resubmitting orders."""

    if run.status not in {"running", "confirming"}:
        return run
    completed_at = interrupted_at or _utc_now_iso()
    invest_stage = next(
        (
            stage
            for stage in reversed(run.stage_results)
            if _stage_workflow_key(stage) == "invest" or stage.stage_number == 3
        ),
        None,
    )
    if invest_stage is not None:
        summary = (
            "Stage 3 was interrupted by a worker/service restart. Recovery is "
            "required; persisted submissions will be reconciled and no order was "
            "automatically resubmitted."
        )
        recovery = run.audit_metadata.get("stage3_recovery")
        recovery = dict(recovery) if isinstance(recovery, dict) else {}
        run.audit_metadata = {
            **run.audit_metadata,
            "stage3_recovery": {
                **recovery,
                "required": True,
                "status": "aborted_recovery_required",
                "interrupted_at": completed_at,
                "automatic_resubmission": False,
            },
        }
        invest_stage.status = "fail"
        invest_stage.completed_at = completed_at
        invest_stage.reason = summary
        invest_stage.outputs = {
            **invest_stage.outputs,
            "phase_status": "aborted",
            "recovery_required": True,
            "automatic_resubmission": False,
            "interrupted_at": completed_at,
        }
    else:
        summary = (
            "Auto-Live run was interrupted by a worker/service restart before "
            "Stage 3. Start a new run to continue."
        )
        active_stage = next(
            (
                stage
                for stage in reversed(run.stage_results)
                if not _stage_terminal(stage)
            ),
            None,
        )
        if active_stage is not None:
            active_stage.status = "fail"
            active_stage.completed_at = completed_at
            active_stage.reason = summary
            active_stage.outputs = {
                **active_stage.outputs,
                "phase_status": "aborted",
                "interrupted_at": completed_at,
            }
    run.status = "failed"
    run.completed_at = completed_at
    run.error_message = summary
    run.summary = summary
    return run


def inspect_auto_live_run_task_sync(
    run_id: str,
    *,
    lifecycle_task_id: str | None = None,
) -> AutoLiveTaskRuntimeSnapshot:
    """Read one run's Celery state without multiplying broker inspections.

    The Auto-Live console polls while a run is executing. Celery inspect uses
    broadcast RPCs, so duplicate polling requests can otherwise accumulate
    faster than workers reply and make the API unavailable behind nginx.
    """
    normalized_lifecycle_task_id = (
        lifecycle_task_id.strip() if isinstance(lifecycle_task_id, str) else None
    ) or None
    cache_key = (run_id, normalized_lifecycle_task_id)
    now = time.monotonic()
    with _task_inspection_cache_lock:
        cached = _task_inspection_cache.get(cache_key)
        if cached is not None and now - cached[0] < TASK_INSPECTION_CACHE_TTL_SECONDS:
            return cached[1]

        snapshot = _inspect_auto_live_run_task_uncached(
            run_id,
            lifecycle_task_id=normalized_lifecycle_task_id,
        )
        _task_inspection_cache[cache_key] = (now, snapshot)
        # Keep the process-local cache bounded when many historical runs have
        # been inspected. Expired entries are never needed for recovery.
        expired_before = now - TASK_INSPECTION_CACHE_TTL_SECONDS
        for cached_run_id, (cached_at, _) in tuple(_task_inspection_cache.items()):
            if cached_at < expired_before:
                _task_inspection_cache.pop(cached_run_id, None)
        return snapshot


def _inspect_auto_live_run_task_uncached(
    run_id: str,
    *,
    lifecycle_task_id: str | None = None,
) -> AutoLiveTaskRuntimeSnapshot:
    task_id = get_registered_auto_live_run_task_id_sync(run_id) or lifecycle_task_id
    if not task_id:
        # An evicted/unavailable registry key is not evidence that the task is
        # absent globally.  In particular, a STARTED lifecycle must never be
        # terminalized merely because the convenience registry no longer has
        # its task ID.  Recovery can still apply the absolute circuit breaker.
        return AutoLiveTaskRuntimeSnapshot(
            task_id=None,
            inspect_succeeded=False,
            inspect_complete=False,
        )

    state: str | None = None
    result_error: str | None = None
    result_traceback: str | None = None
    try:
        async_result = celery.AsyncResult(task_id)
        state_value = async_result.state
        state = str(state_value).strip().upper() or None
        if state in _TERMINAL_CELERY_STATES:
            raw_result = getattr(async_result, "result", None)
            if raw_result is not None:
                result_error = redact_secrets(str(raw_result))[:1000]
            raw_traceback = getattr(async_result, "traceback", None)
            if raw_traceback:
                result_traceback = redact_secrets(str(raw_traceback))[-2000:]
    except Exception:
        logger.exception("Failed to read Celery result state for Auto-Live task %s", task_id)

    inspect_succeeded = False
    inspect_complete: bool | None = None
    is_active = False
    is_reserved = False
    is_scheduled = False

    try:
        inspector = celery.control.inspect(timeout=TASK_INSPECT_TIMEOUT_SECONDS)
        active = getattr(inspector, "active", None)
        active_reply = active() if callable(active) else None
        query_task = getattr(inspector, "query_task", None)
        query_task_reply = query_task(task_id) if callable(query_task) else None
        reserved_reply = inspector.reserved()
        scheduled_reply = inspector.scheduled()
        ping = getattr(inspector, "ping", None)
        ping_reply = ping() if callable(ping) else None
        inspect_succeeded = any(
            reply is not None
            for reply in (
                active_reply,
                query_task_reply,
                reserved_reply,
                scheduled_reply,
                ping_reply,
            )
        )
        is_active = _payload_contains_task_id(active_reply, task_id) or _payload_contains_task_id(
            query_task_reply,
            task_id,
        )
        is_reserved = _payload_contains_task_id(reserved_reply, task_id)
        is_scheduled = _payload_contains_task_id(scheduled_reply, task_id)
        # ``active``/``reserved``/``scheduled`` list tasks per worker.  When
        # ping gives the expected worker set, absence is only meaningful if
        # all three replies cover every responder. Do not infer global absence
        # from a partial broadcast response.
        if isinstance(ping_reply, dict):
            workers = {str(worker) for worker in ping_reply}
            active_workers = (
                {str(worker) for worker in active_reply}
                if isinstance(active_reply, dict)
                else set()
            )
            reserved_workers = (
                {str(worker) for worker in reserved_reply}
                if isinstance(reserved_reply, dict)
                else set()
            )
            scheduled_workers = (
                {str(worker) for worker in scheduled_reply}
                if isinstance(scheduled_reply, dict)
                else set()
            )
            inspect_complete = (
                bool(workers)
                and workers.issubset(active_workers)
                and workers.issubset(reserved_workers)
                and workers.issubset(scheduled_workers)
            )
    except Exception:
        logger.warning(
            "Failed to inspect live Celery worker state for Auto-Live task %s.",
            task_id,
            exc_info=True,
        )

    return AutoLiveTaskRuntimeSnapshot(
        task_id=task_id,
        state=state,
        result_error=result_error,
        result_traceback=result_traceback,
        is_active=is_active,
        is_reserved=is_reserved,
        is_scheduled=is_scheduled,
        inspect_succeeded=inspect_succeeded,
        inspect_complete=inspect_complete,
    )


def _payload_contains_task_id(payload: object, task_id: str) -> bool:
    if isinstance(payload, dict):
        if payload.get("id") == task_id:
            return True
        if task_id in payload:
            return True
        return any(_payload_contains_task_id(value, task_id) for value in payload.values())
    if isinstance(payload, list):
        return any(_payload_contains_task_id(value, task_id) for value in payload)
    return False


def _format_terminal_task_result_detail(task_snapshot: AutoLiveTaskRuntimeSnapshot) -> str:
    """Return the best persisted Celery failure detail for a dead run task."""
    details: list[str] = []
    if task_snapshot.result_error:
        details.append(f"Failure detail: {task_snapshot.result_error}")
    if task_snapshot.result_traceback:
        traceback_head = task_snapshot.result_traceback.strip().splitlines()[-1]
        if traceback_head and traceback_head not in (task_snapshot.result_error or ""):
            details.append(f"Traceback tail: {traceback_head}")
    return " ".join(details) if details else "No persisted Celery exception detail was available."


def _is_worker_lost_terminal_result(task_snapshot: AutoLiveTaskRuntimeSnapshot) -> bool:
    """Whether Celery's FAILURE represents a potentially redeliverable loss.

    With late acknowledgement, Celery can write ``WorkerLostError`` before a
    replacement receives the same task ID. That is not a definitive workflow
    failure; it must travel through the heartbeat/lease/redelivery grace path.
    """

    if (task_snapshot.state or "").strip().upper() != "FAILURE":
        return False
    details = " ".join(
        value
        for value in (task_snapshot.result_error, task_snapshot.result_traceback)
        if isinstance(value, str)
    ).lower()
    return any(marker in details for marker in _WORKER_LOST_RESULT_MARKERS)


def _should_finalize_settled_running_run(run: BullpenAutoLiveRun) -> bool:
    if _find_failure_stage(run) is not None:
        unfinished_workflow_stage = next(
            (
                stage
                for stage in run.stage_results
                if _stage_workflow_key(stage) is not None and not _stage_terminal(stage)
            ),
            None,
        )
        return unfinished_workflow_stage is None

    # A stale `running` record is only safe to mark completed once the Invest
    # workflow stage itself reached a terminal state. A stray completed_at
    # timestamp alone can be persisted before Stage 3 decisions are finalized.
    return _find_terminal_invest_stage(run) is not None


def _finalize_settled_running_run(run: BullpenAutoLiveRun) -> None:
    failure_stage = _find_failure_stage(run)
    completed_at = _latest_stage_completed_at(run) or _utc_now_iso()
    run.completed_at = completed_at

    if failure_stage is not None:
        failure_message = (
            _build_failure_message(failure_stage)
            or _read_output_string(run.error_message)
            or "The worker stopped before the run status was finalized."
        )
        run.status = "failed"
        run.error_message = failure_message
        run.summary = (
            run.summary
            if run.summary.strip() and not _summary_looks_inflight(run.summary)
            else f"Auto-Live run failed during {_workflow_stage_label(failure_stage)}: {failure_message}"
        )
        return

    invest_stage = _find_terminal_invest_stage(run)
    run.status = "completed"
    run.error_message = None
    run.summary = _build_completed_summary(run, invest_stage)


def _set_task_lifecycle_terminal(
    run: BullpenAutoLiveRun,
    *,
    state: str,
    detail: str | None = None,
) -> None:
    if run.task_lifecycle is None:
        return
    run.task_lifecycle = run.task_lifecycle.model_copy(
        update={
            "state": state,
            "detail": detail or lifecycle_detail_for_state(state),
        }
    )


def _finalize_successful_worker_after_stage3_handoff(
    run: BullpenAutoLiveRun,
    *,
    completed_at: str,
) -> bool:
    """Mark a successful task handoff as confirming instead of a false failure.

    Durable Stage 3 can legitimately finish the Celery planning task after it
    has persisted/queued order intents, while the run remains non-terminal so
    follow-up dispatch/reconciliation can complete asynchronously.
    """

    invest_stage = next(
        (
            stage
            for stage in reversed(run.stage_results)
            if _stage_workflow_key(stage) == "invest" or stage.stage_number == 3
        ),
        None,
    )
    if invest_stage is None or _stage_terminal(invest_stage):
        return False

    phase_status = _stage_phase_status(invest_stage)
    if phase_status not in {"queued", "running", "confirming"}:
        return False

    queued_orders = _read_output_int(invest_stage.outputs.get("orders_queued")) or 0
    planned_orders = _read_output_int(invest_stage.outputs.get("orders_planned")) or 0
    decision_rows = invest_stage.outputs.get("decision_rows")
    decision_row_count = len(decision_rows) if isinstance(decision_rows, list) else 0
    if max(queued_orders, planned_orders, decision_row_count) <= 0:
        return False

    run.status = "confirming"
    run.completed_at = None
    run.error_message = None
    run.summary = (
        "Stage 3 queued durable order intents and is awaiting asynchronous "
        "execution reconciliation."
    )
    invest_stage.outputs = {
        **invest_stage.outputs,
        "phase_status": "confirming",
        "worker_handoff_completed_at": completed_at,
    }
    invest_stage.reason = (
        "Stage 3 queued durable order intents; asynchronous execution "
        "reconciliation is in progress."
    )
    invest_stage.completed_at = None
    return True


def _build_stalled_run_failure_message(
    *,
    heartbeat_age: timedelta,
    absolute_age: timedelta,
    task_snapshot: AutoLiveTaskRuntimeSnapshot,
    run: BullpenAutoLiveRun,
) -> str | None:
    normalized_state = (task_snapshot.state or "").strip().upper()
    if absolute_age >= AUTO_LIVE_RUN_ABSOLUTE_TIMEOUT:
        elapsed_minutes = max(1, int(absolute_age.total_seconds() // 60))
        task_detail = (
            f" Worker task {task_snapshot.task_id} termination was requested."
            if task_snapshot.task_id
            else ""
        )
        return (
            f"Auto-Live exceeded its {int(AUTO_LIVE_RUN_ABSOLUTE_TIMEOUT.total_seconds() // 60)}-minute "
            f"maximum runtime ({elapsed_minutes} minutes)."
            f"{task_detail} Please rerun."
        )

    lifecycle = run.task_lifecycle
    lifecycle_task_id = lifecycle.task_id if lifecycle is not None else None
    # The task registry/result backend can briefly retain a completed old
    # delivery after a late-ack redelivery has already been persisted.  Never
    # let that old result terminalize the newer lifecycle delivery.
    if (
        lifecycle_task_id
        and task_snapshot.task_id
        and lifecycle_task_id != task_snapshot.task_id
    ):
        return None

    worker_lost_result = _is_worker_lost_terminal_result(task_snapshot)
    if (
        normalized_state in _TERMINAL_CELERY_STATES
        and task_snapshot.task_id
        and not worker_lost_result
    ):
        result_detail = _format_terminal_task_result_detail(task_snapshot)
        return (
            f"Worker task {task_snapshot.task_id} ended with {normalized_state.lower()} "
            "before the run status was finalized."
            f" {result_detail}"
            " Please rerun."
        )

    # A broker-received task can sit in a Celery prefork reserved list for a
    # long time.  Its lack of workflow-stage progress is expected; neither a
    # PENDING result nor a partial inspect reply proves it has died. A
    # matching terminal Celery result above remains authoritative.
    if task_lifecycle_is_queue_waiting(run):
        return None

    if task_snapshot.is_live:
        return None

    explicit_heartbeat_at = _parse_iso_datetime(task_lifecycle_heartbeat_at(run))
    if explicit_heartbeat_at is not None:
        # ``heartbeat_age`` is calculated with the caller's test/reference
        # clock below, so retain that clock when it is supplied.
        if heartbeat_age < AUTO_LIVE_RUN_HEARTBEAT_TIMEOUT:
            return None
        if heartbeat_age < (
            AUTO_LIVE_RUN_HEARTBEAT_TIMEOUT
            + timedelta(seconds=AUTO_LIVE_RUN_WORKER_LOSS_GRACE_SECONDS)
        ):
            return None
        # A newer registered delivery is concrete redelivery evidence even if
        # inspect has not yet observed it.  Never terminalize the old delivery.
        if task_lifecycle_has_redelivery_evidence(run, task_snapshot.task_id):
            return None

        # A PENDING result is intentionally ambiguous.  It can accompany a
        # redelivery, result-backend loss, or an unobserved queue wait.  Only a
        # stale explicit STARTED heartbeat *plus* complete negative inspect
        # evidence can declare this worker lost.
        if not _inspect_has_complete_negative_evidence(task_snapshot):
            return None
        if lifecycle is not None and lifecycle.state == "STARTED":
            # The execution lease is renewed independently of the database
            # heartbeat.  In particular, an audit snapshot may momentarily
            # lock the run row and defer a heartbeat write.  A live (or
            # unreadable) Redis lease is liveness/unknown evidence, never
            # proof that this worker was lost.
            execution_lease_is_live = auto_live_run_execution_lease_is_live_sync(
                run.id
            )
            if execution_lease_is_live is not False:
                return None
            # Redis can evict a lease key while a healthy planner is inside a
            # remote Bullpen call. The PostgreSQL session-level advisory lock
            # remains the split-brain fence in that interval; its presence (or
            # an unreadable database probe) is liveness/unknown evidence, not
            # proof that the worker died.
            advisory_lock_is_live = auto_live_run_execution_advisory_lock_is_live_sync(
                run.id
            )
            if advisory_lock_is_live is not False:
                return None
            stalled_minutes = max(1, int(heartbeat_age.total_seconds() // 60))
            return (
                f"Worker heartbeat lost for task {task_snapshot.task_id or lifecycle.task_id or 'unknown'} "
                f"after {stalled_minutes} minutes without progress. Please rerun."
            )

    # A WorkerLostError on an old late-acked delivery may be followed by a
    # broker redelivery carrying that same task ID. Historical runs without
    # lifecycle evidence remain recoverable until the absolute breaker; new
    # lifecycle-bearing runs only reach WorkerLost above after heartbeat
    # expiry, grace, complete negative inspect, and an absent execution lease.
    if worker_lost_result:
        return None

    if not task_snapshot.inspect_succeeded:
        return None

    # A result-backend PENDING state is not evidence that a legacy task is
    # absent.  Legacy runs without an explicit STARTED heartbeat stay
    # recoverable until a terminal Celery result or the absolute circuit
    # breaker; they must not be failed from ``updated_at`` alone.
    if normalized_state == "PENDING":
        return None

    if heartbeat_age < AUTO_LIVE_RUN_HEARTBEAT_TIMEOUT:
        return None

    # Legacy runs created before the lifecycle field existed retain the prior
    # stale-progress fallback, but only with a complete negative inspection.
    # This avoids turning a partial inspect response into an irreversible run
    # failure during a deployment or broker partition.
    if not _inspect_has_complete_negative_evidence(task_snapshot):
        return None

    stalled_minutes = max(1, int(heartbeat_age.total_seconds() // 60))
    if task_snapshot.task_id:
        return (
            f"Worker task {task_snapshot.task_id} is no longer active and the run has not "
            f"reported progress for {stalled_minutes} minutes. Please rerun."
        )
    return (
        f"The run has not reported progress for {stalled_minutes} minutes and no worker "
        "task id is registered. Please rerun."
    )


def _task_snapshot_matches_current_lifecycle(
    run: BullpenAutoLiveRun,
    task_snapshot: AutoLiveTaskRuntimeSnapshot,
) -> bool:
    """Fence a retained result from an older Celery delivery.

    Celery result rows are keyed by task ID and may outlive a redelivery.  A
    terminal result can only finalize this persisted run when it belongs to
    the lifecycle's current delivery (or when this is a legacy run with no
    lifecycle task ID).
    """

    lifecycle = run.task_lifecycle
    return not bool(
        lifecycle
        and lifecycle.task_id
        and task_snapshot.task_id
        and lifecycle.task_id != task_snapshot.task_id
    )


def reconcile_running_auto_live_run(
    run: BullpenAutoLiveRun,
    *,
    started_at: datetime | None,
    updated_at: datetime | None,
    now: datetime | None = None,
    task_snapshot: AutoLiveTaskRuntimeSnapshot | None = None,
) -> BullpenAutoLiveRun | None:
    if run.status != "running":
        return None

    if _should_finalize_settled_running_run(run):
        _finalize_settled_running_run(run)
        _set_task_lifecycle_terminal(
            run,
            state="SUCCESS" if run.status == "completed" else "FAILURE",
        )
        return run

    reference_now = _normalize_datetime(now) or _utc_now()
    normalized_started_at = _normalize_datetime(started_at) or reference_now
    normalized_updated_at = _normalize_datetime(updated_at) or normalized_started_at
    runtime_snapshot = task_snapshot or inspect_auto_live_run_task_sync(
        run.id,
        lifecycle_task_id=(
            run.task_lifecycle.task_id if run.task_lifecycle is not None else None
        ),
    )
    if (
        (runtime_snapshot.state or "").strip().upper() == "SUCCESS"
        and _task_snapshot_matches_current_lifecycle(run, runtime_snapshot)
        and _finalize_successful_worker_after_stage3_handoff(
            run,
            completed_at=reference_now.isoformat(),
        )
    ):
        _set_task_lifecycle_terminal(run, state="SUCCESS")
        return run
    lifecycle_heartbeat_at = _parse_iso_datetime(task_lifecycle_heartbeat_at(run))
    heartbeat_reference = lifecycle_heartbeat_at or normalized_updated_at
    failure_message = _build_stalled_run_failure_message(
        heartbeat_age=max(reference_now - heartbeat_reference, timedelta()),
        absolute_age=max(reference_now - normalized_started_at, timedelta()),
        task_snapshot=runtime_snapshot,
        run=run,
    )
    if failure_message is None:
        return None

    # Do not leave an over-limit task executing after the persisted run has
    # been marked failed; it could otherwise continue into later workflow
    # stages or submit orders after the dashboard reports failure.
    absolute_age = max(reference_now - normalized_started_at, timedelta())
    if (
        absolute_age >= AUTO_LIVE_RUN_ABSOLUTE_TIMEOUT
        and runtime_snapshot.task_id
        and runtime_snapshot.is_live
    ):
        revoke_auto_live_run_task_sync(runtime_snapshot.task_id)

    completed_at = reference_now.isoformat()
    active_invest_stage = next(
        (
            stage
            for stage in reversed(run.stage_results)
            if (_stage_workflow_key(stage) == "invest" or stage.stage_number == 3)
            and not _stage_terminal(stage)
        ),
        None,
    )
    if active_invest_stage is not None:
        mark_interrupted_run_for_restart(run, interrupted_at=completed_at)
        active_invest_stage.outputs = {
            **active_invest_stage.outputs,
            "failure_message": failure_message,
            "error_message": failure_message,
        }
        active_invest_stage.reason = _append_failure_reason(
            active_invest_stage.reason,
            failure_message,
        )
        run.error_message = failure_message
        run.summary = (
            f"Auto-Live run failed during {_workflow_stage_label(active_invest_stage)}: "
            f"{failure_message} Recovery is required; no order was automatically "
            "resubmitted."
        )
        lifecycle_state = (
            "WORKER_LOST"
            if failure_message.startswith("Worker heartbeat lost")
            else "REVOKED"
            if (runtime_snapshot.state or "").strip().upper() == "REVOKED"
            else "FAILURE"
        )
        _set_task_lifecycle_terminal(
            run,
            state=lifecycle_state,
            detail=(
                "Absolute timeout"
                if absolute_age >= AUTO_LIVE_RUN_ABSOLUTE_TIMEOUT
                else failure_message
            ),
        )
        return run

    run.status = "failed"
    run.completed_at = completed_at
    run.error_message = failure_message
    run.summary = finalize_failed_run_progress(
        run,
        failure_message=failure_message,
        completed_at=completed_at,
    )
    lifecycle_state = (
        "WORKER_LOST"
        if failure_message.startswith("Worker heartbeat lost")
        else "REVOKED"
        if (runtime_snapshot.state or "").strip().upper() == "REVOKED"
        else "FAILURE"
    )
    _set_task_lifecycle_terminal(
        run,
        state=lifecycle_state,
        detail=(
            "Absolute timeout"
            if absolute_age >= AUTO_LIVE_RUN_ABSOLUTE_TIMEOUT
            else failure_message
        ),
    )
    return run
