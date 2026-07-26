from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Iterable

from app.domains.polymarket_auto_live.schemas import (
    BullpenAutoLiveDecision,
    BullpenAutoLiveHistoryItem,
    BullpenAutoLiveHistoryStage,
    BullpenAutoLiveOrderFunnel,
    BullpenAutoLiveRun,
    BullpenAutoLiveStageResult,
)

CONSOLE_PROJECTION_VERSION = 1
CONSOLE_HISTORY_DEFAULT_SIZE = 20
CONSOLE_HISTORY_MAX_SIZE = 50

_MAX_STRING_LENGTH = 500
_DEFAULT_LIST_LIMIT = 10
_MAX_DICT_ITEMS = 50
_LIST_LIMITS = {
    "active_positions_found": 10,
    "available_for_claim": 10,
    "settlement_pending_positions": 10,
    "excluded_position_diagnostics": 10,
    "decision_rows": 10,
    "event_exit_rows": 10,
    "execution_steps": 10,
    "guardrails_checked": 10,
    "llm_outputs": 0,
    "llm_reviewed_candidates": 10,
    "llm_target_runs": 0,
}
_DROPPED_KEYS = {
    "raw",
    "raw_output",
    "raw_response",
    "raw_provider_response",
    "provider_response",
    "prompt",
    "prompt_text",
    "console_llm_prompt_template",
    "prepared_question_payload",
    "market_context",
    "resolution_rules",
    "rules",
    "audit_metadata",
    "request_context",
}
_STAGE_INPUT_KEYS = {
    "workflow_stage_key",
    "phase_status",
    "candidate_count",
    "candidate_rows_count",
    "active_position_count",
    "stage2_handoff_checkpoint",
    "reuse_saved_llm_outputs",
    "source_snapshot_id",
    "source_run_id",
}
_STAGE_OUTPUT_KEYS = {
    "workflow_stage_key",
    "phase_status",
    "progress_commentary",
    "error_message",
    "failure_category",
    "cancellation_state",
    "next_action",
    "next_retry_at",
    "next_reconciliation_at",
    "execution_gate_reason",
    "execution_mode_reason",
    "execution_step_label",
    "execution_step_detail",
    "execution_steps",
    "current_blockage",
    "how_to_resolve",
    "scanned_candidates",
    "total_items",
    "completed_items",
    "failed_items",
    "accepted_candidates_count",
    "candidate_rows_before_llm",
    "stage1_accepted_candidate_count",
    "active_position_rows",
    "active_positions_found",
    "available_for_claim",
    "settlement_pending_positions",
    "excluded_position_diagnostics",
    "wallet_snapshot_status",
    "wallet_source",
    "wallet_snapshot_fetched_at",
    "wallet_refresh_error",
    "wallet_lock_wait_ms",
    "wallet_command_duration_ms",
    "stage2_candidate_only",
    "blocked_by_stage1_wallet_refresh",
    "llm_candidate_count",
    "llm_reviewed_candidates",
    "llm_provider_target_count",
    "llm_selected_target_count",
    "llm_target_count",
    "llm_completed_provider_target_count",
    "llm_completed_model_count",
    "llm_successful_provider_target_count",
    "llm_passed_provider_target_count",
    "llm_usable_provider_target_count",
    "llm_failed_provider_target_count",
    "llm_failed_model_count",
    "llms_completed",
    "llm_targets",
    "llm_execution_mode",
    "llm_events_per_prompt",
    "reused_existing_llm_outputs",
    "stage2_eligible_rows_total",
    "stage2_reviewed_rows",
    "stage2_skipped_rows",
    "stage2_universe_complete",
    "stage2_universe_status",
    "stage2_universe_blocker_code",
    "stage2_universe_blocker_summary",
    "stage2_universe_blocker_fix",
    "stage2_strategy_metadata",
    "qualified_candidate_market_ids",
    "stage2_handoff_checkpoint",
    "candidate_decision_rows",
    "decision_rows",
    "event_exit_rows",
    "event_exit_planned",
    "event_exit_processed",
    "event_exit_submitted",
    "event_exit_forced_planned",
    "event_exit_forced_submitted",
    "event_exit_ranking_llm_planned",
    "event_exit_ranking_llm_submitted",
    "redeem_planned",
    "redeem_processed",
    "redeem_submitted",
    "orders_planned",
    "orders_processed",
    "orders_submitted",
    "persisted_execution_counters",
    "recovery_required",
    "post_exit_snapshot_source",
    "post_exit_snapshot_fetched_at",
    "slot_allocation",
}


def _bounded_value(
    value: Any,
    *,
    key: str | None = None,
    depth: int = 0,
) -> Any:
    if depth > 6:
        return None
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        if len(value) <= _MAX_STRING_LENGTH:
            return value
        return f"{value[:_MAX_STRING_LENGTH]}…"
    if isinstance(value, dict):
        compact: dict[str, Any] = {}
        for raw_key, raw_value in list(value.items())[:_MAX_DICT_ITEMS]:
            normalized_key = str(raw_key)
            if normalized_key in _DROPPED_KEYS:
                continue
            compact_value = _bounded_value(
                raw_value,
                key=normalized_key,
                depth=depth + 1,
            )
            if compact_value is not None:
                compact[normalized_key] = compact_value
        return compact
    if isinstance(value, (list, tuple)):
        limit = _LIST_LIMITS.get(key or "", _DEFAULT_LIST_LIMIT)
        if limit <= 0:
            return []
        return [
            compact
            for item in value[:limit]
            if (compact := _bounded_value(item, key=key, depth=depth + 1))
            is not None
        ]
    return _bounded_value(str(value), key=key, depth=depth + 1)


def _select_keys(
    value: dict[str, Any],
    keys: Iterable[str],
) -> dict[str, Any]:
    selected: dict[str, Any] = {}
    for key in keys:
        if key not in value:
            continue
        compact = _bounded_value(value[key], key=key)
        if compact is not None:
            selected[key] = compact
    return selected


def _compact_stage(stage: BullpenAutoLiveStageResult) -> dict[str, Any]:
    payload = stage.model_dump(mode="json")
    payload["inputs"] = _select_keys(stage.inputs, _STAGE_INPUT_KEYS)
    payload["outputs"] = _select_keys(stage.outputs, _STAGE_OUTPUT_KEYS)
    payload["guardrails_checked"] = _bounded_value(
        payload.get("guardrails_checked", []),
        key="guardrails_checked",
    )
    return payload


def build_run_console_projection(run: BullpenAutoLiveRun) -> dict[str, Any]:
    """Build the bounded console-only copy persisted beside the frozen run."""

    return {
        "version": CONSOLE_PROJECTION_VERSION,
        "order_funnel": _bounded_value(run.order_funnel.model_dump(mode="json")),
        "action_funnels": _bounded_value(
            {
                key: funnel.model_dump(mode="json")
                for key, funnel in run.action_funnels.items()
            }
        ),
        "retry_counts": _bounded_value(run.retry_counts),
        "provider_error_counts": _bounded_value(run.provider_error_counts),
        "average_confirmation_seconds": run.average_confirmation_seconds,
        "oldest_pending_order_age_seconds": run.oldest_pending_order_age_seconds,
        "pending_confirmation_count": run.pending_confirmation_count,
        "partial_fill_count": run.partial_fill_count,
        "permanent_failure_count": run.permanent_failure_count,
        "transient_failure_count": run.transient_failure_count,
        "stage_results": [_compact_stage(stage) for stage in run.stage_results],
        "guardrail_checks": _bounded_value(
            [
                guardrail.model_dump(mode="json")
                for guardrail in run.guardrail_checks
            ],
            key="guardrails_checked",
        ),
        "decision_ids": list(run.decision_ids[:25]),
        "order_intent_ids": list(run.order_intent_ids[:50]),
        "diagnostics": _bounded_value(run.diagnostics.model_dump(mode="json")),
        "stage2_llm_targets_snapshot": _bounded_value(
            [
                target.model_dump(mode="json")
                for target in (run.stage2_llm_targets_snapshot or [])
            ]
        ),
        "task_lifecycle": (
            _bounded_value(run.task_lifecycle.model_dump(mode="json"))
            if run.task_lifecycle is not None
            else None
        ),
    }


def build_decision_console_projection(
    decision: BullpenAutoLiveDecision,
) -> dict[str, Any]:
    payload = decision.model_dump(mode="json")
    payload["llm_outputs"] = []
    payload["stage_results"] = []
    payload["guardrail_checks"] = []
    return _bounded_value(payload)


def projected_run_payload(
    *,
    projection: dict[str, Any] | None,
    id: str,
    triggered_by: str,
    status: str,
    dry_run: bool,
    started_at: str,
    completed_at: str | None,
    summary: str,
    live_execution_requested: bool,
    live_execution_attempted: bool,
    decisions_count: int,
    orders_planned: int,
    orders_submitted: int,
    error_message: str | None,
) -> tuple[dict[str, Any], bool]:
    valid_projection = (
        isinstance(projection, dict)
        and projection.get("version") == CONSOLE_PROJECTION_VERSION
    )
    payload = dict(projection or {}) if valid_projection else {}
    payload.pop("version", None)
    payload.update(
        {
            "id": id,
            "triggered_by": triggered_by,
            "status": status,
            "dry_run": dry_run,
            "started_at": started_at,
            "completed_at": completed_at,
            "summary": str(_bounded_value(summary) or ""),
            "live_execution_requested": live_execution_requested,
            "live_execution_attempted": live_execution_attempted,
            "decisions_count": decisions_count,
            "orders_planned": orders_planned,
            "orders_submitted": orders_submitted,
            "error_message": (
                str(_bounded_value(error_message))
                if error_message is not None
                else None
            ),
        }
    )
    return payload, valid_projection


def _parse_timestamp(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _read_count(outputs: dict[str, Any], *keys: str) -> int | None:
    for key in keys:
        value = outputs.get(key)
        if isinstance(value, bool):
            continue
        if isinstance(value, (int, float)) and value >= 0:
            return int(value)
    return None


def _stage_key(stage: BullpenAutoLiveStageResult) -> str:
    explicit = stage.outputs.get("workflow_stage_key")
    if explicit in {"scan", "llm", "invest"}:
        return str(explicit)
    if stage.stage_number == 1:
        return "scan"
    if stage.stage_number == 2:
        return "llm"
    return "invest"


def _stage_history(stage: BullpenAutoLiveStageResult) -> BullpenAutoLiveHistoryStage:
    outputs = stage.outputs
    key = _stage_key(stage)
    input_count: int | None
    processed_count: int | None
    succeeded_count: int | None
    failed_count: int | None
    if key == "scan":
        input_count = _read_count(outputs, "total_items", "scanned_candidates")
        processed_count = _read_count(outputs, "scanned_candidates", "completed_items")
        succeeded_count = _read_count(
            outputs,
            "accepted_candidates_count",
            "stage1_accepted_candidate_count",
        )
        failed_count = _read_count(outputs, "failed_items")
    elif key == "llm":
        input_count = _read_count(
            outputs,
            "llm_candidate_count",
            "stage2_eligible_rows_total",
            "total_items",
        )
        processed_count = _read_count(
            outputs,
            "stage2_reviewed_rows",
            "completed_items",
        )
        succeeded_count = _read_count(
            outputs,
            "llm_usable_provider_target_count",
            "llm_successful_provider_target_count",
        )
        failed_count = _read_count(
            outputs,
            "llm_failed_provider_target_count",
            "llm_failed_model_count",
        )
    else:
        input_count = _read_count(outputs, "orders_planned")
        processed_count = _read_count(outputs, "orders_processed")
        succeeded_count = _read_count(outputs, "orders_submitted")
        failed_count = _read_count(outputs, "permanent_failure_count")

    blocker = next(
        (
            str(outputs[name]).strip()
            for name in (
                "current_blockage",
                "execution_gate_reason",
                "error_message",
                "stage2_universe_blocker_summary",
            )
            if isinstance(outputs.get(name), str) and str(outputs[name]).strip()
        ),
        None,
    )
    if blocker is None and stage.status == "fail":
        blocker = stage.reason

    return BullpenAutoLiveHistoryStage(
        key=key,  # type: ignore[arg-type]
        stage_number=stage.stage_number,
        label=stage.stage_name,
        status=stage.status,
        phase_status=(
            str(outputs["phase_status"])
            if isinstance(outputs.get("phase_status"), str)
            else None
        ),
        started_at=stage.started_at,
        completed_at=stage.completed_at,
        input_count=input_count,
        processed_count=processed_count,
        succeeded_count=succeeded_count,
        failed_count=failed_count,
        blocker_preview=blocker,
    )


def build_history_item(
    run: BullpenAutoLiveRun,
    *,
    latest_update_at: str,
    projection_available: bool,
) -> BullpenAutoLiveHistoryItem:
    started_at = _parse_timestamp(run.started_at)
    completed_at = _parse_timestamp(run.completed_at)
    duration_seconds = (
        max(0.0, (completed_at - started_at).total_seconds())
        if started_at is not None and completed_at is not None
        else None
    )
    stages = [_stage_history(stage) for stage in run.stage_results]
    blocker = run.error_message or next(
        (stage.blocker_preview for stage in reversed(stages) if stage.blocker_preview),
        None,
    )
    return BullpenAutoLiveHistoryItem(
        id=run.id,
        triggered_by=run.triggered_by,
        status=run.status,
        dry_run=run.dry_run,
        started_at=run.started_at,
        completed_at=run.completed_at,
        duration_seconds=duration_seconds,
        summary=run.summary,
        error_message=run.error_message,
        decisions_count=run.decisions_count,
        orders_planned=run.orders_planned,
        orders_submitted=run.orders_submitted,
        order_funnel=run.order_funnel,
        stages=stages,
        blocker_preview=blocker,
        latest_update_at=latest_update_at,
        projection_available=projection_available,
    )


def empty_order_funnel() -> dict[str, Any]:
    return BullpenAutoLiveOrderFunnel().model_dump(mode="json")
