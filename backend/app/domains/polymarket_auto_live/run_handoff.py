from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any, Protocol

from app.domains.bullpen_run_audit.provenance import build_native_run_audit_metadata
from app.domains.polymarket_auto_live.run_lifecycle import (
    AUTO_LIVE_FALLBACK_HANDOFF_TIMEOUT_SECONDS,
    AUTO_LIVE_FALLBACK_QUEUE,
    AUTO_LIVE_PRIMARY_HANDOFF_TIMEOUT_SECONDS,
    AUTO_LIVE_QUEUE,
)
from app.domains.polymarket_auto_live.schemas import (
    BullpenAutoLiveRun,
    BullpenAutoLiveSettings,
)


class _TaskPublisher(Protocol):
    def apply_async(
        self,
        *,
        args: tuple[int, str],
        task_id: str,
        queue: str,
    ) -> Any: ...


class AutoLiveTaskPublishExhausted(RuntimeError):
    """Both bounded broker publish paths rejected one durable run identity."""

    def __init__(
        self,
        *,
        primary_error: Exception,
        fallback_error: Exception,
        failed_at: str,
    ) -> None:
        super().__init__(
            "Primary and fallback Auto-Live worker queues rejected the task."
        )
        self.primary_error = primary_error
        self.fallback_error = fallback_error
        self.failed_at = failed_at


def _utc_now_iso() -> str:
    return datetime.now(UTC).isoformat()


def build_auto_live_run_audit_metadata(
    settings: BullpenAutoLiveSettings,
    *,
    run_id: str | None = None,
    task_id: str | None = None,
    enqueued_at: str | None = None,
    client_supplied_run_id: bool = False,
) -> dict[str, object]:
    metadata = build_native_run_audit_metadata(
        settings_snapshot=settings.model_dump(mode="json"),
        prompt_template=settings.console_llm_prompt_template,
        execution_version=None,
        strategy_version=settings.strategy_profile,
    )
    if run_id and task_id and enqueued_at:
        metadata["execution_handoff"] = {
            "schema_version": 1,
            "run_id": run_id,
            "task_id": task_id,
            "client_supplied_run_id": client_supplied_run_id,
            "max_execution_dispatches": 2,
            "stages": [
                {
                    "stage": "primary",
                    "approach": "dedicated_auto_live_queue",
                    "queue": AUTO_LIVE_QUEUE,
                    "triggered_at": enqueued_at,
                    "reason": "preferred_planning_queue",
                    "validation": "durable_run_and_task_lifecycle_persisted",
                }
            ],
        }
    return metadata


def record_auto_live_execution_handoff(
    run: BullpenAutoLiveRun,
    *,
    stage: str,
    approach: str,
    queue: str | None,
    reason: str,
    validation: str,
    triggered_at: str,
) -> bool:
    """Append one bounded execution-handoff stage to the durable run audit."""

    existing = run.audit_metadata.get("execution_handoff")
    handoff = (
        dict(existing)
        if isinstance(existing, dict)
        else {
            "schema_version": 1,
            "run_id": run.id,
            "task_id": (
                run.task_lifecycle.task_id
                if run.task_lifecycle is not None
                else None
            ),
            "client_supplied_run_id": bool(
                run.request_context and run.request_context.client_run_id
            ),
            "max_execution_dispatches": 2,
            "stages": [],
        }
    )
    stages = [
        dict(item)
        for item in handoff.get("stages", [])
        if isinstance(item, dict)
    ]
    if stage == "secondary" and not stages and run.task_lifecycle is not None:
        # Runs queued before execution_handoff v1 was deployed still need the
        # bounded recovery path. Reconstruct only the primary fact already
        # proven by their durable lifecycle; never invent Stage 1/2 results.
        stages.append(
            {
                "stage": "primary",
                "approach": "dedicated_auto_live_queue",
                "queue": run.task_lifecycle.queue or AUTO_LIVE_QUEUE,
                "triggered_at": run.task_lifecycle.enqueued_at or run.started_at,
                "reason": "legacy_durable_queue_handoff",
                "validation": "persisted_queued_task_lifecycle",
            }
        )
    if any(item.get("stage") == stage for item in stages):
        return False
    stages.append(
        {
            "stage": stage,
            "approach": approach,
            "queue": queue,
            "triggered_at": triggered_at,
            "reason": reason,
            "validation": validation,
        }
    )
    handoff["stages"] = stages
    run.audit_metadata = {
        **run.audit_metadata,
        "execution_handoff": handoff,
    }
    return True


def _log_handoff_transition(
    logger: Any,
    *,
    run_id: str,
    from_stage: str,
    to_stage: str,
    reason: str,
    validation: str,
    queue: str | None = None,
    approach: str | None = None,
    exc_info: bool = False,
) -> None:
    payload = {
        "event": "bullpen_auto_live_handoff_fallback_triggered",
        "run_id": run_id,
        "from_stage": from_stage,
        "to_stage": to_stage,
        "reason": reason,
        "validation": validation,
    }
    if queue is not None:
        payload["queue"] = queue
    if approach is not None:
        payload["approach"] = approach
    log = logger.error if to_stage == "tertiary" else logger.warning
    log(
        "%s",
        json.dumps(payload, sort_keys=True, separators=(",", ":")),
        exc_info=exc_info,
    )


def publish_auto_live_task_with_fallback(
    publisher: _TaskPublisher,
    *,
    user_id: int,
    run: BullpenAutoLiveRun,
    task_id: str,
    logger: Any,
) -> tuple[Any, bool]:
    """Publish once to the preferred queue, then once to the fallback queue."""

    try:
        task = publisher.apply_async(
            args=(user_id, run.id),
            task_id=task_id,
            queue=AUTO_LIVE_QUEUE,
        )
        return task, False
    except Exception as primary_error:
        fallback_at = _utc_now_iso()
        primary_validation = (
            f"primary_error_type:{type(primary_error).__name__}"
        )
        _log_handoff_transition(
            logger,
            run_id=run.id,
            from_stage="primary",
            to_stage="secondary",
            queue=AUTO_LIVE_FALLBACK_QUEUE,
            reason="primary_queue_publish_failed",
            validation=primary_validation,
            exc_info=True,
        )

        try:
            task = publisher.apply_async(
                args=(user_id, run.id),
                task_id=task_id,
                queue=AUTO_LIVE_FALLBACK_QUEUE,
            )
        except Exception as fallback_error:
            fallback_validation = (
                f"fallback_publish_failed:{type(fallback_error).__name__}"
            )
            record_auto_live_execution_handoff(
                run,
                stage="secondary",
                approach="general_worker_queue",
                queue=AUTO_LIVE_FALLBACK_QUEUE,
                reason="primary_queue_publish_failed",
                validation=fallback_validation,
                triggered_at=fallback_at,
            )
            failed_at = _utc_now_iso()
            terminal_validation = (
                "no_execution_dispatch_confirmed:"
                f"{type(fallback_error).__name__}"
            )
            record_auto_live_execution_handoff(
                run,
                stage="tertiary",
                approach="bounded_fail_closed",
                queue=None,
                reason="primary_and_secondary_publish_failed",
                validation=terminal_validation,
                triggered_at=failed_at,
            )
            _log_handoff_transition(
                logger,
                run_id=run.id,
                from_stage="secondary",
                to_stage="tertiary",
                approach="bounded_fail_closed",
                reason="primary_and_secondary_publish_failed",
                validation=terminal_validation,
                exc_info=True,
            )
            raise AutoLiveTaskPublishExhausted(
                primary_error=primary_error,
                fallback_error=fallback_error,
                failed_at=failed_at,
            ) from fallback_error

        record_auto_live_execution_handoff(
            run,
            stage="secondary",
            approach="general_worker_queue",
            queue=AUTO_LIVE_FALLBACK_QUEUE,
            reason="primary_queue_publish_failed",
            validation=(
                f"fallback_publish_accepted:{primary_validation}"
            ),
            triggered_at=fallback_at,
        )
        if run.task_lifecycle is not None:
            run.task_lifecycle = run.task_lifecycle.model_copy(
                update={
                    "queue": AUTO_LIVE_FALLBACK_QUEUE,
                    "detail": (
                        "Primary queue publish failed; the fallback queue "
                        "accepted the fenced task."
                    ),
                }
            )
        return task, True


def _parse_handoff_timestamp(value: object) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def auto_live_handoff_fallback_action(
    run: BullpenAutoLiveRun,
    *,
    now: datetime,
) -> str | None:
    """Choose one finite handoff action from durable, validated state."""

    lifecycle = run.task_lifecycle
    if run.status != "running" or lifecycle is None or lifecycle.state != "QUEUED":
        return None
    enqueued_at = _parse_handoff_timestamp(lifecycle.enqueued_at)
    if enqueued_at is None:
        return None

    raw_handoff = run.audit_metadata.get("execution_handoff")
    handoff = raw_handoff if isinstance(raw_handoff, dict) else {}
    stages = [
        item
        for item in handoff.get("stages", [])
        if isinstance(item, dict)
    ]
    stage_names = [
        str(item.get("stage") or "").strip().lower()
        for item in stages
    ]
    if stage_names not in ([], ["primary"], ["primary", "secondary"]):
        return None
    if not stage_names and lifecycle.queue not in {None, AUTO_LIVE_QUEUE}:
        return None
    secondary = next(
        (item for item in stages if item.get("stage") == "secondary"),
        None,
    )
    if secondary is None:
        if (now - enqueued_at).total_seconds() >= (
            AUTO_LIVE_PRIMARY_HANDOFF_TIMEOUT_SECONDS
        ):
            return "secondary"
        return None

    secondary_at = _parse_handoff_timestamp(secondary.get("triggered_at"))
    if secondary_at is None:
        return None
    if (now - secondary_at).total_seconds() >= (
        AUTO_LIVE_FALLBACK_HANDOFF_TIMEOUT_SECONDS
    ):
        return "tertiary"
    return None
