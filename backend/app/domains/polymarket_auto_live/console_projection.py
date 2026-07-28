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
    BullpenAutoLiveVerifiedPortfolioSnapshot,
)

CONSOLE_PROJECTION_VERSION = 2
CONSOLE_HISTORY_DEFAULT_SIZE = 20
CONSOLE_HISTORY_MAX_SIZE = 50

_MAX_STRING_LENGTH = 500
_DEFAULT_LIST_LIMIT = 10
_MAX_DICT_ITEMS = 50
_LIST_LIMITS = {
    # Candidate identity rows are required to repopulate the Auto Scan table.
    # Keep the list bounded, while allowing the normal 30-day/EOM scan universe
    # to survive the lightweight dashboard projection without an extra read.
    "accepted_candidates": 100,
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
    "accepted_candidates",
    "candidate_rows_before_llm",
    "stage1_accepted_candidate_count",
    "active_position_rows",
    "active_position_rows_before_llm",
    "active_positions_found",
    "active_positions_total",
    "active_positions_truncated",
    "available_for_claim",
    "settlement_pending_positions",
    "excluded_position_diagnostics",
    "wallet_snapshot_status",
    "wallet_source",
    "wallet_snapshot_fetched_at",
    "wallet_snapshot_freshness_state",
    "wallet_freshness_state",
    "wallet_account_identity",
    "wallet_position_classifier_version",
    "wallet_credential_artifact_inode",
    "wallet_credential_artifact_mtime_ns",
    "wallet_credential_artifact_size",
    "wallet_credential_artifact",
    "wallet_snapshot_diagnostics",
    "position_classifier_version",
    "wallet_market_enrichment",
    "wallet_market_enrichment_error",
    "wallet_market_enrichment_degraded",
    "stage2_actionables_authoritative",
    "stage3_execution_uses_conservative_occupancy",
    "unresolved_positive_exposure_position_count",
    "conservatively_occupied_market_ids",
    "wallet_refresh_error",
    "wallet_recovery_timeout_seconds",
    "wallet_recovery_max_age_seconds",
    "wallet_recovery_status",
    "wallet_recovery_source",
    "wallet_recovery_error",
    "wallet_recovery_trigger",
    "wallet_lock_wait_ms",
    "wallet_command_duration_ms",
    "stage2_candidate_only",
    "blocked_by_stage1_wallet_refresh",
    "console_trade_amount_usd",
    "console_trade_amount_source",
    "console_trade_last_calculated_usd",
    "console_trade_cash_in_hand_usd",
    "console_trade_occupied_positions",
    "console_trade_active_positions",
    "console_trade_available_slots",
    "console_trade_max_positions",
    "llm_candidate_count",
    "llm_reviewed_candidates",
    "llm_started_provider_target_count",
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
    "stage2_actionable_contract_version",
    "stage2_actionable_contract_authoritative",
    "stage2_actionable_contract_execution_mode",
    "stage2_actionable_wallet_enrichment_degraded",
    "stage2_actionable_handoff_used",
    "stage2_actionable_handoff_source",
    "stage2_actionable_exit_market_ids",
    "stage2_actionable_buy_market_ids",
    "stage2_actionable_exit_count",
    "stage2_actionable_buy_count",
    "missing_stage2_actionable_exit_market_ids",
    "missing_stage2_actionable_buy_market_ids",
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
    "orders_ready",
    "orders_attempted",
    "orders_remotely_accepted",
    "orders_confirmed",
    "orders_filled",
    "orders_retry_wait",
    "orders_waiting_for_collateral",
    "orders_deferred",
    "orders_permanently_failed",
    "persisted_execution_counters",
    "recovery_required",
    "post_exit_snapshot_source",
    "post_exit_snapshot_fetched_at",
    "slot_allocation",
}

_WORKFLOW_STAGE_NUMBERS = {
    "scan": 1,
    "llm": 2,
    "invest": 3,
}

_PORTFOLIO_POSITION_KEYS = (
    "position_key",
    "market_id",
    "market_slug",
    "event_slug",
    "slug",
    "condition_id",
    "market_title",
    "market_url",
    "side",
    "shares",
    "average_price_cents",
    "exposure_usd",
    "current_price_cents",
    "current_value_usd",
    "current_yes_odds",
    "current_no_odds",
    "close_time",
    "theme",
    "is_claimable",
    "classification",
    "classification_reason",
    "claimable_value_usd",
    "expected_payout_usdc",
    "resolution_status",
    "upstream_redeemable",
)


def workflow_stage_key(
    stage: BullpenAutoLiveStageResult,
) -> str | None:
    """Return the canonical three-stage key without reclassifying substages.

    Historical payloads can contain internal stages numbered above three.
    Treating every unknown number as Stage 3 made History render duplicate
    Stage 3 rows and could cause React row-key collisions. Explicit workflow
    metadata wins; only the exact legacy stage numbers 1, 2 and 3 are inferred.
    """

    explicit = stage.outputs.get("workflow_stage_key")
    if explicit in _WORKFLOW_STAGE_NUMBERS:
        return str(explicit)
    for key, stage_number in _WORKFLOW_STAGE_NUMBERS.items():
        if stage.stage_number == stage_number:
            return key
    return None


def canonical_workflow_stage_results(
    stages: Iterable[BullpenAutoLiveStageResult],
) -> list[BullpenAutoLiveStageResult]:
    """Select at most one durable row for each user-facing workflow stage."""

    selected: dict[str, tuple[BullpenAutoLiveStageResult, bool]] = {}
    for stage in stages:
        key = workflow_stage_key(stage)
        if key is None:
            continue
        is_exact_stage = stage.stage_number == _WORKFLOW_STAGE_NUMBERS[key]
        current = selected.get(key)
        if current is None or (is_exact_stage and not current[1]):
            selected[key] = (stage, is_exact_stage)
    return [
        selected[key][0]
        for key in ("scan", "llm", "invest")
        if key in selected
    ]


def has_verified_stage1_portfolio(run: BullpenAutoLiveRun) -> bool:
    """Return whether a run contains a completed, usable wallet snapshot.

    A candidate-only Stage 1 can legitimately persist an empty position list
    when its wallet refresh fails.  That is useful workflow evidence, but it
    must never replace the last verified portfolio in the console.
    """

    for stage in canonical_workflow_stage_results(run.stage_results):
        if workflow_stage_key(stage) != "scan":
            continue
        outputs = stage.outputs
        phase_status = str(outputs.get("phase_status") or "").strip().lower()
        completed = bool(stage.completed_at) or phase_status == "completed"
        if not completed or stage.status not in {"pass", "warning"}:
            return False
        if not isinstance(outputs.get("active_positions_found"), list):
            return False
        if bool(outputs.get("stage2_candidate_only")) or bool(
            outputs.get("blocked_by_stage1_wallet_refresh")
        ):
            return False
        wallet_refresh_error = outputs.get("wallet_refresh_error")
        if (
            isinstance(wallet_refresh_error, str)
            and wallet_refresh_error.strip()
        ) or (
            wallet_refresh_error is not None
            and not isinstance(wallet_refresh_error, str)
            and wallet_refresh_error is not False
        ):
            return False
        wallet_market_enrichment_error = outputs.get(
            "wallet_market_enrichment_error"
        )
        if (
            isinstance(wallet_market_enrichment_error, str)
            and wallet_market_enrichment_error.strip()
        ) or (
            wallet_market_enrichment_error is not None
            and not isinstance(wallet_market_enrichment_error, str)
            and wallet_market_enrichment_error is not False
        ):
            return False
        snapshot_status = str(
            outputs.get("wallet_snapshot_status") or ""
        ).strip().lower()
        # Missing lineage is not proof of a fresh wallet. Older projections
        # without these fields remain readable, but cannot replace the last
        # explicitly verified portfolio with a fabricated empty snapshot.
        if snapshot_status != "fresh":
            return False
        freshness = str(
            outputs.get("wallet_snapshot_freshness_state")
            or outputs.get("wallet_freshness_state")
            or ""
        ).strip().lower()
        if freshness != "fresh":
            return False
        return True
    return False


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


def _optional_number(value: object) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip())
        except ValueError:
            return None
    return None


def _optional_integer(value: object) -> int | None:
    number = _optional_number(value)
    if number is None:
        return None
    return max(0, int(number))


def build_verified_stage1_portfolio_snapshot(
    run: BullpenAutoLiveRun,
) -> BullpenAutoLiveVerifiedPortfolioSnapshot | None:
    """Extract the Stage 1-only portfolio payload needed by the console."""

    if not has_verified_stage1_portfolio(run):
        return None
    stage = next(
        (
            candidate
            for candidate in canonical_workflow_stage_results(run.stage_results)
            if workflow_stage_key(candidate) == "scan"
        ),
        None,
    )
    if stage is None:
        return None
    outputs = stage.outputs
    def compact_position_rows(
        key: str,
        *,
        limit: int,
    ) -> list[dict[str, object]]:
        source_rows = outputs.get(key)
        if not isinstance(source_rows, list):
            return []
        compact_rows: list[dict[str, object]] = []
        for source_row in source_rows[:limit]:
            if not isinstance(source_row, dict):
                continue
            compact_row: dict[str, object] = {}
            for field in _PORTFOLIO_POSITION_KEYS:
                if field not in source_row:
                    continue
                value = _bounded_value(source_row[field], key=field)
                if isinstance(value, str) and len(value) > 200:
                    value = f"{value[:200]}…"
                if value is not None:
                    compact_row[field] = value
            compact_rows.append(compact_row)
        return compact_rows

    source_active_positions = outputs.get("active_positions_found")
    source_active_position_count = (
        sum(1 for row in source_active_positions if isinstance(row, dict))
        if isinstance(source_active_positions, list)
        else 0
    )
    active_positions = compact_position_rows(
        "active_positions_found",
        limit=10,
    )

    max_positions = _optional_integer(
        outputs.get("console_trade_max_positions")
    )
    active_positions_total = max(
        source_active_position_count,
        _optional_integer(outputs.get("active_positions_total")) or 0,
        _optional_integer(outputs.get("console_trade_active_positions"))
        or 0,
    )
    occupied_positions = max(
        active_positions_total,
        _optional_integer(outputs.get("console_trade_occupied_positions"))
        or 0,
    )
    available_slots = (
        max(0, max_positions - occupied_positions)
        if max_positions is not None
        else _optional_integer(outputs.get("console_trade_available_slots"))
    )

    def optional_text(value: object) -> str | None:
        if isinstance(value, str) and value.strip():
            return value.strip()
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return str(value)
        return None

    return BullpenAutoLiveVerifiedPortfolioSnapshot(
        run_id=run.id,
        verified_at=(
            stage.completed_at
            or run.completed_at
            or stage.started_at
            or run.started_at
        ),
        active_positions=active_positions,
        active_positions_total=active_positions_total,
        active_positions_truncated=active_positions_total > len(active_positions),
        claimable_positions=compact_position_rows(
            "available_for_claim",
            limit=10,
        ),
        settlement_pending_positions=compact_position_rows(
            "settlement_pending_positions",
            limit=5,
        ),
        excluded_positions=compact_position_rows(
            "excluded_position_diagnostics",
            limit=5,
        ),
        cash_in_hand_usd=_optional_number(
            outputs.get("console_trade_cash_in_hand_usd")
        ),
        occupied_positions=occupied_positions,
        available_slots=available_slots,
        max_positions=max_positions,
        trade_amount_usd=_optional_number(
            outputs.get("console_trade_amount_usd")
        ),
        wallet_source=optional_text(outputs.get("wallet_source")),
        wallet_snapshot_fetched_at=optional_text(
            outputs.get("wallet_snapshot_fetched_at")
        ),
        wallet_freshness_state=optional_text(
            outputs.get("wallet_snapshot_freshness_state")
            or outputs.get("wallet_freshness_state")
        ),
        wallet_account_identity=optional_text(
            outputs.get("wallet_account_identity")
        ),
        wallet_credential_artifact_inode=_optional_integer(
            outputs.get("wallet_credential_artifact_inode")
        ),
        wallet_credential_artifact_mtime_ns=_optional_integer(
            outputs.get("wallet_credential_artifact_mtime_ns")
        ),
        wallet_credential_artifact_size=_optional_integer(
            outputs.get("wallet_credential_artifact_size")
        ),
        position_classifier_version=optional_text(
            outputs.get("wallet_position_classifier_version")
            or outputs.get("position_classifier_version")
        ),
    )


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
        "stage_results": [
            _compact_stage(stage)
            for stage in canonical_workflow_stage_results(run.stage_results)
        ],
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


def build_minimal_workflow_stage_results(
    stages: Iterable[BullpenAutoLiveStageResult],
) -> list[BullpenAutoLiveStageResult]:
    """Keep exact stage identity/status when optional diagnostics are dropped."""

    compact: list[BullpenAutoLiveStageResult] = []
    for stage in canonical_workflow_stage_results(stages):
        key = workflow_stage_key(stage)
        if key is None:
            continue
        outputs = _select_keys(
            stage.outputs,
            (
                "phase_status",
                "completed_items",
                "total_items",
                "orders_planned",
                "orders_processed",
                "orders_submitted",
                "persisted_execution_counters",
                "current_blockage",
                "next_action",
                "next_retry_at",
                "next_reconciliation_at",
            ),
        )
        outputs["workflow_stage_key"] = key
        compact.append(
            stage.model_copy(
                update={
                    "inputs": {},
                    "outputs": outputs,
                    "guardrails_checked": [],
                }
            )
        )
    return compact


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


def _stage_history(stage: BullpenAutoLiveStageResult) -> BullpenAutoLiveHistoryStage:
    outputs = stage.outputs
    key = workflow_stage_key(stage)
    if key is None:
        raise ValueError("non-workflow stage cannot be projected into console history")
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
    stages = [
        _stage_history(stage)
        for stage in canonical_workflow_stage_results(run.stage_results)
    ]
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
