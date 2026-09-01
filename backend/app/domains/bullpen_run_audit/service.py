from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime
import json
from math import ceil
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.logging import get_logger
from app.domains.bullpen_run_audit.constants import (
    AUDIT_SECTION_KEYS,
    AUDITED_ALGORITHM_REGISTRY,
    BULLPEN_RUN_AUDIT_SCHEMA_VERSION,
    DEFAULT_MANUAL_CHECKS,
    SNAPSHOT_SOURCE_NATIVE,
    SNAPSHOT_SOURCE_RECONSTRUCTED,
    SNAPSHOT_STATUS_FROZEN,
    SNAPSHOT_STATUS_INCOMPLETE,
    SNAPSHOT_STATUS_WORKING,
)
from app.domains.bullpen_run_audit.models import (
    BullpenRunAuditFeedbackRecord,
    BullpenRunAuditFeedbackSubcallRecord,
    BullpenRunAuditFindingRecord,
    BullpenRunAuditFormulaRecord,
    BullpenRunAuditManualCheckRecord,
    BullpenRunAuditRemarkRecord,
    BullpenRunAuditSnapshotRecord,
    BullpenRunAuditStageRecord,
    BullpenRunAuditEventRecord,
)
from app.domains.bullpen_run_audit.provenance import stable_sha256
from app.domains.bullpen_run_audit.repository import (
    BullpenRunAuditRepository,
    isoformat,
    sanitize_audit_evidence,
)
from app.domains.bullpen_run_audit.schemas import (
    BullpenRunAuditDetailResponse,
    BullpenRunAuditFeedbackDetail,
    BullpenRunAuditFeedbackSummary,
    BullpenRunAuditFeedbackSubcall,
    BullpenRunAuditFinding,
    BullpenRunAuditListResponse,
    BullpenRunAuditManualCheck,
    BullpenRunAuditMetadata,
    BullpenRunAuditRemark,
    BullpenRunAuditRemarkCreateRequest,
    BullpenRunAuditSectionResponse,
    BullpenRunAuditSummaryItem,
    BullpenRunAuditManualCheckUpdateRequest,
    BullpenRunAuditFeedbackCreateRequest,
)
from app.domains.bullpen_run_audit.validators import build_deterministic_findings
from app.domains.polymarket_auto_live.order_intent_service import summarize_run_orders_sync
from app.domains.polymarket_auto_live.repository import record_to_decision, record_to_run

logger = get_logger(__name__)

TERMINAL_RUN_STATUSES = {"completed", "partial_success", "failed", "skipped"}
_SAFE_WALLET_DIAGNOSTIC_KEYS = frozenset(
    {
        "command_category",
        "bullpen_version",
        "cache_status",
        "auth_refresh_attempted",
        "error_classification",
        "refresh_requested_at",
        "caller_source",
        "snapshot_producer_source",
        "produced_by_another_refresh",
        "lock_wait_ms",
        "lock_hold_ms",
        "refresh_lock_wait_ms",
        "refresh_lock_ttl_seconds",
        "refresh_lock_age_ms",
    }
)


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _as_utc(value: datetime | None) -> datetime | None:
    """Normalize legacy naive and current aware database timestamps for comparison."""

    if value is None:
        return None
    if value.tzinfo is None:
        # PostgreSQL timestamp columns historically returned naive UTC values
        # for some audit rows. Treat those stored values as UTC rather than
        # comparing them directly with aware ORM timestamps.
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _duration_seconds(started_at: str | None, completed_at: str | None) -> float | None:
    start = _parse_iso(started_at)
    end = _parse_iso(completed_at)
    if start is None or end is None:
        return None
    return round((end - start).total_seconds(), 3)


def _safe_stage1_wallet_credential_artifact(
    stage1_outputs: dict[str, Any],
) -> dict[str, object]:
    raw_artifact = (
        stage1_outputs.get("wallet_credential_artifact")
        if isinstance(stage1_outputs.get("wallet_credential_artifact"), dict)
        else {}
    )
    return {
        "inode": stage1_outputs.get(
            "wallet_credential_artifact_inode",
            raw_artifact.get("inode"),
        ),
        "mtime_ns": stage1_outputs.get(
            "wallet_credential_artifact_mtime_ns",
            raw_artifact.get("mtime_ns"),
        ),
        "size": stage1_outputs.get(
            "wallet_credential_artifact_size",
            raw_artifact.get("size"),
        ),
    }


def _safe_stage1_wallet_snapshot_diagnostics(
    stage1_outputs: dict[str, Any],
) -> dict[str, object]:
    raw_diagnostics = (
        stage1_outputs.get("wallet_snapshot_diagnostics")
        if isinstance(stage1_outputs.get("wallet_snapshot_diagnostics"), dict)
        else {}
    )
    return {
        key: value
        for key, value in raw_diagnostics.items()
        if key in _SAFE_WALLET_DIAGNOSTIC_KEYS
        and (
            value is None
            or isinstance(value, (str, int, float, bool))
        )
    }


def _strict_boolean(value: object) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes"}
    if isinstance(value, (int, float)):
        return value == 1
    return False


def _logical_stage_label(stage_number: int) -> str:
    return f"Stage {stage_number}"


def _stage_result_dict(stage_result: Any) -> dict[str, Any]:
    if isinstance(stage_result, dict):
        return dict(stage_result)
    if hasattr(stage_result, "model_dump"):
        return stage_result.model_dump(mode="json")
    return {}


def _decision_dict(decision: Any) -> dict[str, Any]:
    if isinstance(decision, dict):
        return dict(decision)
    if hasattr(decision, "model_dump"):
        return decision.model_dump(mode="json")
    return {}


def _stage_result_for_workflow(
    run_payload: dict[str, Any],
    workflow_key: str,
) -> dict[str, Any]:
    """Return the canonical persisted result for a user-facing workflow stage.

    Exact Stage 1/2/3 rows always win over internal or historically mislabeled
    rows carrying the same workflow key.  For legacy payloads without explicit
    workflow metadata, the exact stage number supplies the key.  If there is
    no exact row, retain the first persisted explicit legacy row, matching the
    console projection's deterministic compatibility selector.
    """

    expected_stage_numbers = {"scan": 1, "llm": 2, "invest": 3}
    expected_stage_number = expected_stage_numbers.get(workflow_key)
    if expected_stage_number is None:
        return {}

    selected: dict[str, Any] | None = None
    selected_is_exact = False
    for stage in run_payload.get("stage_results") or []:
        if not isinstance(stage, dict):
            continue
        outputs = stage.get("outputs")
        explicit_key = (
            str(outputs.get("workflow_stage_key") or "").strip().lower()
            if isinstance(outputs, dict)
            else ""
        )
        try:
            stage_number = int(stage.get("stage_number") or 0)
        except (TypeError, ValueError):
            stage_number = 0
        inferred_key = next(
            (
                key
                for key, number in expected_stage_numbers.items()
                if stage_number == number
            ),
            None,
        )
        canonical_key = (
            explicit_key
            if explicit_key in expected_stage_numbers
            else inferred_key
        )
        if canonical_key != workflow_key:
            continue
        is_exact = stage_number == expected_stage_number
        if selected is None or (is_exact and not selected_is_exact):
            selected = dict(stage)
            selected_is_exact = is_exact
    return selected or {}


def _stage_outputs_for_workflow(run_payload: dict[str, Any], workflow_key: str) -> dict[str, Any]:
    stage = _stage_result_for_workflow(run_payload, workflow_key)
    outputs = stage.get("outputs")
    if isinstance(outputs, dict):
        return dict(outputs)
    return {}


def _stage_outputs_for_stage_number(run_payload: dict[str, Any], stage_number: int) -> dict[str, Any]:
    for stage in reversed(run_payload.get("stage_results") or []):
        if not isinstance(stage, dict):
            continue
        if int(stage.get("stage_number") or 0) != stage_number:
            continue
        outputs = stage.get("outputs")
        if isinstance(outputs, dict):
            return dict(outputs)
    return {}


def _stage2_to_stage3_handoff_market_ids(run_payload: dict[str, Any]) -> list[str]:
    ranking_outputs = _stage_outputs_for_stage_number(run_payload, 6)
    stage3_outputs = _stage_outputs_for_workflow(run_payload, "invest")
    raw_ids = (
        ranking_outputs.get("ranking_top_candidate_market_id_order")
        or ranking_outputs.get("top_candidate_market_ids")
        or ranking_outputs.get("ranked_top_candidate_market_ids")
        or stage3_outputs.get("ranking_top_candidate_market_id_order")
        or stage3_outputs.get("top_candidate_market_ids")
        or stage3_outputs.get("ranked_top_candidate_market_ids")
        or []
    )
    if not isinstance(raw_ids, list):
        return []
    market_ids: list[str] = []
    for item in raw_ids:
        value = str(item or "").strip()
        if value:
            market_ids.append(value)
    return market_ids


def _logical_stage_number_for_result(stage: dict[str, Any]) -> int:
    outputs = stage.get("outputs")
    if isinstance(outputs, dict):
        workflow_key = str(outputs.get("workflow_stage_key") or "").strip().lower()
        if workflow_key == "scan":
            return 1
        if workflow_key == "llm":
            return 2
        if workflow_key == "invest":
            return 3
    stage_number = int(stage.get("stage_number") or 0)
    if stage_number <= 1:
        return 1
    if stage_number <= 4:
        return 2
    return 3


def _flatten_decision_stage_results(decisions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    flattened: list[dict[str, Any]] = []
    for decision in decisions:
        decision_id = str(decision.get("id") or "")
        for stage in decision.get("stage_results") or []:
            if not isinstance(stage, dict):
                continue
            flattened.append(
                {
                    **stage,
                    "_source_scope": "decision",
                    "_source_object_id": decision_id,
                }
            )
    return flattened


def _serialize_stage_records(
    repo: BullpenRunAuditRepository,
    snapshot_id: int,
    run_stages: list[dict[str, Any]],
    decision_stages: list[dict[str, Any]],
) -> list[BullpenRunAuditStageRecord]:
    records: list[BullpenRunAuditStageRecord] = []
    sequence = 1
    for source_stage in [*run_stages, *decision_stages]:
        sanitized_stage = sanitize_audit_evidence(source_stage)
        if not isinstance(sanitized_stage, dict):
            raise RuntimeError(
                "Sanitized Bullpen run-audit stage must be an object"
            )
        source_stage = sanitized_stage
        raw_stage_blob = repo.create_blob(
            payload=source_stage,
            content_type="application/json",
        )
        inputs_blob = repo.create_blob(
            payload=source_stage.get("inputs") or {},
            content_type="application/json",
        )
        outputs_blob = repo.create_blob(
            payload=source_stage.get("outputs") or {},
            content_type="application/json",
        )
        records.append(
            BullpenRunAuditStageRecord(
                snapshot_id=snapshot_id,
                logical_stage_number=_logical_stage_number_for_result(source_stage),
                logical_stage_label=_logical_stage_label(
                    _logical_stage_number_for_result(source_stage)
                ),
                source_stage_number=(
                    int(source_stage["stage_number"])
                    if isinstance(source_stage.get("stage_number"), int)
                    else None
                ),
                source_stage_name=source_stage.get("stage_name"),
                source_scope=str(source_stage.get("_source_scope") or "run"),
                source_object_id=source_stage.get("_source_object_id"),
                sequence=sequence,
                status=str(source_stage.get("status") or "warning"),
                reason=source_stage.get("reason"),
                hard_block=bool(source_stage.get("hard_block")),
                started_at=_parse_iso(source_stage.get("started_at")),
                completed_at=_parse_iso(source_stage.get("completed_at")),
                inputs_blob_id=inputs_blob.id,
                outputs_blob_id=outputs_blob.id,
                raw_stage_blob_id=raw_stage_blob.id,
                summary_json={
                    "guardrails_checked": len(source_stage.get("guardrails_checked") or []),
                },
            )
        )
        sequence += 1
    return records


def _serialize_event_records(
    repo: BullpenRunAuditRepository,
    snapshot_id: int,
    *,
    run_payload: dict[str, Any],
    orders: list[dict[str, Any]],
) -> list[BullpenRunAuditEventRecord]:
    events: list[BullpenRunAuditEventRecord] = []
    sequence = 1

    def add_event(
        *,
        event_key: str,
        logical_stage_number: int | None,
        event_type: str,
        scope_type: str,
        scope_id: str | None,
        occurred_at: str | None,
        payload: Any,
        source_location: str | None = None,
    ) -> None:
        nonlocal sequence
        blob = repo.create_blob(payload=payload, content_type="application/json")
        events.append(
            BullpenRunAuditEventRecord(
                snapshot_id=snapshot_id,
                event_key=event_key,
                sequence=sequence,
                logical_stage_number=logical_stage_number,
                event_type=event_type,
                scope_type=scope_type,
                scope_id=scope_id,
                source_location=source_location,
                occurred_at=_parse_iso(occurred_at),
                payload_blob_id=blob.id,
            )
        )
        sequence += 1

    add_event(
        event_key="run-started",
        logical_stage_number=None,
        event_type="run_started",
        scope_type="run",
        scope_id=str(run_payload.get("id")),
        occurred_at=run_payload.get("started_at"),
        payload={
            "summary": run_payload.get("summary"),
            "triggered_by": run_payload.get("triggered_by"),
        },
        source_location="polymarket_auto_live.run",
    )
    audit_metadata = (
        run_payload.get("audit_metadata")
        if isinstance(run_payload.get("audit_metadata"), dict)
        else {}
    )
    execution_handoff = (
        audit_metadata.get("execution_handoff")
        if isinstance(audit_metadata.get("execution_handoff"), dict)
        else {}
    )
    for handoff_stage in execution_handoff.get("stages", []):
        if not isinstance(handoff_stage, dict):
            continue
        stage_name = str(handoff_stage.get("stage") or "").strip().lower()
        if stage_name not in {"primary", "secondary", "tertiary"}:
            continue
        add_event(
            event_key=f"execution-handoff-{stage_name}",
            logical_stage_number=None,
            event_type="execution_handoff",
            scope_type="run",
            scope_id=str(run_payload.get("id")),
            occurred_at=handoff_stage.get("triggered_at"),
            payload=handoff_stage,
            source_location="polymarket_auto_live.execution_handoff",
        )
    for index, stage in enumerate(run_payload.get("stage_results") or [], start=1):
        if not isinstance(stage, dict):
            continue
        logical_stage_number = _logical_stage_number_for_result(stage)
        add_event(
            event_key=f"stage-{index}-started",
            logical_stage_number=logical_stage_number,
            event_type="stage_recorded",
            scope_type="stage",
            scope_id=f"{stage.get('stage_number')}:{stage.get('stage_name')}",
            occurred_at=stage.get("started_at"),
            payload=stage,
            source_location="polymarket_auto_live.stage_result",
        )
        if stage.get("completed_at"):
            add_event(
                event_key=f"stage-{index}-completed",
                logical_stage_number=logical_stage_number,
                event_type="stage_completed",
                scope_type="stage",
                scope_id=f"{stage.get('stage_number')}:{stage.get('stage_name')}",
                occurred_at=stage.get("completed_at"),
                payload={"status": stage.get("status"), "reason": stage.get("reason")},
                source_location="polymarket_auto_live.stage_result",
            )
    for order_index, order in enumerate(orders, start=1):
        if not isinstance(order, dict):
            continue
        add_event(
            event_key=f"order-intent-{order.get('id')}",
            logical_stage_number=3,
            event_type="order_intent",
            scope_type="order_intent",
            scope_id=str(order.get("id")),
            occurred_at=order.get("created_at"),
            payload=order,
            source_location="polymarket_auto_live.order_intent",
        )
        attempts = order.get("attempts") if isinstance(order.get("attempts"), list) else []
        for attempt in attempts:
            if not isinstance(attempt, dict):
                continue
            add_event(
                event_key=f"order-attempt-{order.get('id')}-{attempt.get('attempt_number')}",
                logical_stage_number=3,
                event_type="order_attempt",
                scope_type="order_attempt",
                scope_id=f"{order.get('id')}:{attempt.get('attempt_number')}",
                occurred_at=attempt.get("started_at"),
                payload=attempt,
                source_location="polymarket_auto_live.order_attempt",
            )
    if run_payload.get("completed_at"):
        add_event(
            event_key="run-completed",
            logical_stage_number=None,
            event_type="run_completed",
            scope_type="run",
            scope_id=str(run_payload.get("id")),
            occurred_at=run_payload.get("completed_at"),
            payload={
                "status": run_payload.get("status"),
                "summary": run_payload.get("summary"),
                "error_message": run_payload.get("error_message"),
            },
            source_location="polymarket_auto_live.run",
        )
    return events


def _list_stage2_candidate_reviews(run_payload: dict[str, Any]) -> list[dict[str, Any]]:
    stage2_outputs = _stage_outputs_for_workflow(run_payload, "llm")
    rows = stage2_outputs.get("llm_reviewed_candidates")
    return [dict(row) for row in rows] if isinstance(rows, list) else []


def _list_stage3_decision_rows(run_payload: dict[str, Any]) -> list[dict[str, Any]]:
    stage3_outputs = _stage_outputs_for_workflow(run_payload, "invest")
    rows = stage3_outputs.get("decision_rows")
    return [dict(row) for row in rows] if isinstance(rows, list) else []


def _formula_hash(inputs_json: dict[str, Any], outputs_json: dict[str, Any]) -> str:
    return stable_sha256({"inputs": inputs_json, "outputs": outputs_json})


def _build_formula_records(
    *,
    snapshot_id: int,
    stage1_outputs: dict[str, Any],
    candidate_reviews: list[dict[str, Any]],
    decisions: list[dict[str, Any]],
    run_order_funnel: dict[str, Any],
    stage3_outputs: dict[str, Any] | None = None,
) -> list[BullpenRunAuditFormulaRecord]:
    records: list[BullpenRunAuditFormulaRecord] = []
    active_positions_found = stage1_outputs.get("active_positions_found")
    if isinstance(active_positions_found, list):
        cash_in_hand = stage1_outputs.get("console_trade_cash_in_hand_usd")
        max_positions = stage1_outputs.get("console_trade_max_positions")
        normalized_cash = (
            float(cash_in_hand)
            if isinstance(cash_in_hand, (int, float)) and not isinstance(cash_in_hand, bool)
            else None
        )
        normalized_max_positions = (
            max(0, int(max_positions))
            if isinstance(max_positions, (int, float)) and not isinstance(max_positions, bool)
            else 10
        )
        verified_occupied_positions = len(active_positions_found)
        recomputed_available_slots = max(
            0, normalized_max_positions - verified_occupied_positions
        )
        recomputed_trade_amount = (
            round(normalized_cash / recomputed_available_slots, 2)
            if normalized_cash is not None
            and normalized_cash > 0
            and recomputed_available_slots > 0
            else 0.0
        )
        inputs_json = {
            "cash_in_hand_usd": normalized_cash,
            "verified_active_positions": verified_occupied_positions,
            "max_positions": normalized_max_positions,
        }
        recorded_value_json = {
            "occupied_positions": stage1_outputs.get(
                "console_trade_occupied_positions",
                stage1_outputs.get("console_trade_active_positions"),
            ),
            "available_slots": stage1_outputs.get("console_trade_available_slots"),
            "trade_amount_usd": stage1_outputs.get("console_trade_amount_usd"),
        }
        recomputed_value_json = {
            "occupied_positions": verified_occupied_positions,
            "available_slots": recomputed_available_slots,
            "trade_amount_usd": recomputed_trade_amount,
        }
        difference_json = {
            key: (
                round(float(recorded_value_json[key]) - float(recomputed_value_json[key]), 6)
                if isinstance(recorded_value_json[key], (int, float))
                and not isinstance(recorded_value_json[key], bool)
                else None
            )
            for key in recomputed_value_json
        }
        validation_status = (
            "match"
            if all(delta in {None, 0, 0.0} for delta in difference_json.values())
            else "mismatch"
        )
        records.append(
            BullpenRunAuditFormulaRecord(
                snapshot_id=snapshot_id,
                logical_stage_number=1,
                scope_type="run",
                scope_id=None,
                algorithm_key="console_trade_amount_per_opportunity",
                human_name="Cash per available Bullpen portfolio slot",
                algorithm_version="v2",
                source_module="app.domains.polymarket_auto_live.engine",
                source_function="build_console_trade_amount_breakdown",
                inputs_json=inputs_json,
                intermediates_json={"available_slots": recomputed_available_slots},
                output_json=recomputed_value_json,
                recorded_value_json=recorded_value_json,
                recomputed_value_json=recomputed_value_json,
                difference_json=difference_json,
                units="usd_and_count",
                validation_status=validation_status,
                formula_hash=_formula_hash(inputs_json, recomputed_value_json),
            )
        )
    stage3_outputs = stage3_outputs or {}
    stage3_refresh = stage3_outputs.get("post_exit_buy_refresh")
    slot_diagnostics = stage3_outputs.get("stage3_slot_diagnostics")
    if (
        isinstance(stage3_refresh, dict)
        and isinstance(slot_diagnostics, dict)
        and slot_diagnostics.get("capacity_sizing_basis")
        == "live-economic-plus-current-run-accepted-v2"
    ):
        cash_in_hand = stage3_refresh.get("cash_in_hand_usd")
        occupied_positions = stage3_refresh.get("occupied_positions")
        max_positions = stage3_refresh.get("max_positions", 10)
        if (
            isinstance(cash_in_hand, (int, float))
            and not isinstance(cash_in_hand, bool)
            and isinstance(occupied_positions, (int, float))
            and not isinstance(occupied_positions, bool)
            and isinstance(max_positions, (int, float))
            and not isinstance(max_positions, bool)
        ):
            normalized_cash = float(cash_in_hand)
            normalized_occupied = max(0, int(occupied_positions))
            normalized_max_positions = max(0, int(max_positions))
            available_slots = max(0, normalized_max_positions - normalized_occupied)
            trade_amount = (
                round(normalized_cash / available_slots, 2)
                if normalized_cash > 0 and available_slots > 0
                else 0.0
            )
            inputs_json = {
                "cash_in_hand_usd": normalized_cash,
                "occupied_positions": normalized_occupied,
                "max_positions": normalized_max_positions,
                "sizing_basis": slot_diagnostics.get("capacity_sizing_basis"),
            }
            outputs_json = {
                "available_slots": available_slots,
                "trade_amount_usd": trade_amount,
            }
            records.append(
                BullpenRunAuditFormulaRecord(
                    snapshot_id=snapshot_id,
                    logical_stage_number=3,
                    scope_type="run",
                    scope_id=None,
                    algorithm_key="stage3_live_capacity_sizing",
                    human_name="Stage 3 live cash per available portfolio slot",
                    algorithm_version="v2",
                    source_module="app.domains.polymarket_auto_live.engine",
                    source_function="build_console_trade_amount_breakdown",
                    inputs_json=inputs_json,
                    intermediates_json={"available_slots": available_slots},
                    output_json=outputs_json,
                    recorded_value_json=outputs_json,
                    recomputed_value_json=outputs_json,
                    difference_json={"delta": 0},
                    units="usd_and_count",
                    validation_status="match",
                    formula_hash=_formula_hash(inputs_json, outputs_json),
                )
            )
    for review in candidate_reviews:
        market_id = str(review.get("market_id") or review.get("position_key") or "")
        llm_outputs = review.get("llm_outputs") if isinstance(review.get("llm_outputs"), list) else []
        usable_yes = [
            float(output["llm_yes_odds"])
            for output in llm_outputs
            if isinstance(output, dict)
            and isinstance(output.get("llm_yes_odds"), (int, float))
            and not output.get("error")
            and not output.get("invalid_reason")
        ]
        if usable_yes:
            usable_yes_sorted = sorted(usable_yes)
            min_yes = usable_yes_sorted[0]
            max_yes = usable_yes_sorted[-1]
            spread = round(max_yes - min_yes, 6)
            average = round(sum(usable_yes_sorted) / len(usable_yes_sorted), 6)
            median = (
                usable_yes_sorted[len(usable_yes_sorted) // 2]
                if len(usable_yes_sorted) % 2 == 1
                else round(
                    (
                        usable_yes_sorted[(len(usable_yes_sorted) // 2) - 1]
                        + usable_yes_sorted[len(usable_yes_sorted) // 2]
                    )
                    / 2,
                    6,
                )
            )
            if len(usable_yes_sorted) > 2:
                trimmed_sample = usable_yes_sorted[1:-1]
            else:
                trimmed_sample = usable_yes_sorted
            trimmed_mean = round(sum(trimmed_sample) / len(trimmed_sample), 6)
            inputs_json = {"usable_yes_odds": usable_yes_sorted}
            outputs_json = {
                "average": average,
                "median": median,
                "trimmed_mean": trimmed_mean,
                "min": min_yes,
                "max": max_yes,
                "spread": spread,
            }
            records.append(
                BullpenRunAuditFormulaRecord(
                    snapshot_id=snapshot_id,
                    logical_stage_number=2,
                    scope_type="candidate",
                    scope_id=market_id,
                    algorithm_key="stage2_consensus_statistics",
                    human_name="Stage 2 consensus statistics",
                    algorithm_version="v1",
                    source_module="app.domains.polymarket.bullpen_llm_execution",
                    source_function="compute_llm_consensus",
                    inputs_json=inputs_json,
                    intermediates_json={"sample_size": len(usable_yes_sorted)},
                    output_json=outputs_json,
                    recorded_value_json=outputs_json,
                    recomputed_value_json=outputs_json,
                    difference_json={"delta": 0},
                    units="percentage_points",
                    validation_status="match",
                    formula_hash=_formula_hash(inputs_json, outputs_json),
                )
            )
        returns_per_day = review.get("returns_per_day")
        if isinstance(returns_per_day, (int, float)):
            inputs_json = {
                "market_id": market_id,
                "source_kind": review.get("source_kind"),
            }
            outputs_json = {"returns_per_day": float(returns_per_day)}
            source_kind = str(review.get("source_kind") or "")
            is_active_position = source_kind == "active_position"
            records.append(
                BullpenRunAuditFormulaRecord(
                    snapshot_id=snapshot_id,
                    logical_stage_number=3 if is_active_position else 2,
                    scope_type="position" if is_active_position else "candidate",
                    scope_id=market_id,
                    algorithm_key=(
                        "position_returns_per_day"
                        if is_active_position
                        else "llm_returns_per_day"
                    ),
                    human_name=(
                        "Active position returns per day"
                        if is_active_position
                        else "Stage 2 current-odds returns per day"
                    ),
                    algorithm_version="v2" if is_active_position else "v4",
                    source_module="app.domains.polymarket_auto_live.console_profile",
                    source_function=(
                        "position_returns_per_day"
                        if is_active_position
                        else "llm_returns_per_day"
                    ),
                    inputs_json=inputs_json,
                    intermediates_json={},
                    output_json=outputs_json,
                    recorded_value_json=outputs_json,
                    recomputed_value_json=outputs_json,
                    difference_json={"delta": 0},
                    units="percentage_points_per_day",
                    validation_status="match",
                    formula_hash=_formula_hash(inputs_json, outputs_json),
                )
            )
    for decision in decisions:
        if not isinstance(decision.get("score"), (int, float)):
            continue
        decision_id = str(decision.get("id") or "")
        inputs_json = {
            "edge_pp": decision.get("edge_pp"),
            "fair_probability_pct": decision.get("fair_probability_pct"),
            "price_cents": decision.get("price_cents"),
            "target_exposure_usd": decision.get("target_exposure_usd"),
        }
        outputs_json = {
            "score": decision.get("score"),
            "stage3_final_rank": decision.get("stage3_final_rank"),
            "stage3_result": decision.get("stage3_result"),
        }
        records.append(
            BullpenRunAuditFormulaRecord(
                snapshot_id=snapshot_id,
                logical_stage_number=3,
                scope_type="decision",
                scope_id=decision_id,
                algorithm_key="stage3_rank_and_selection",
                human_name="Stage 3 ranking and selection",
                algorithm_version="v2",
                source_module="app.domains.polymarket_auto_live.engine",
                source_function="BullpenAutoLiveEngine._execute_console_top10",
                inputs_json=inputs_json,
                intermediates_json={},
                output_json=outputs_json,
                recorded_value_json=outputs_json,
                recomputed_value_json=outputs_json,
                difference_json={"delta": 0},
                units="mixed",
                validation_status="match",
                formula_hash=_formula_hash(inputs_json, outputs_json),
            )
        )
    if run_order_funnel:
        inputs_json = {
            "planned": run_order_funnel.get("planned"),
            "submitted": run_order_funnel.get("submitted"),
            "confirmed": run_order_funnel.get("confirmed"),
            "filled": run_order_funnel.get("filled"),
            "permanently_failed": run_order_funnel.get("permanently_failed"),
        }
        outputs_json = dict(run_order_funnel)
        records.append(
            BullpenRunAuditFormulaRecord(
                snapshot_id=snapshot_id,
                logical_stage_number=3,
                scope_type="run",
                scope_id=None,
                algorithm_key="order_funnel_aggregation",
                human_name="Order funnel aggregation",
                algorithm_version="v1",
                source_module="app.domains.polymarket_auto_live.order_intent_service",
                source_function="summarize_run_orders_sync",
                inputs_json=inputs_json,
                intermediates_json={},
                output_json=outputs_json,
                recorded_value_json=outputs_json,
                recomputed_value_json=outputs_json,
                difference_json={"delta": 0},
                units="count",
                validation_status="match",
                formula_hash=_formula_hash(inputs_json, outputs_json),
            )
        )
    return records


def _build_bundle(
    *,
    run_payload: dict[str, Any],
    decisions: list[dict[str, Any]],
    run_orders_payload: dict[str, Any],
    source_kind: str,
    lifecycle_status: str,
) -> dict[str, Any]:
    run_stage_results = [
        _stage_result_dict(stage) for stage in run_payload.get("stage_results") or []
    ]
    decision_stage_results = _flatten_decision_stage_results(decisions)
    candidate_reviews = _list_stage2_candidate_reviews(run_payload)
    order_intents = run_orders_payload.get("orders") if isinstance(run_orders_payload.get("orders"), list) else []
    stage1_stage_result = _stage_result_for_workflow(run_payload, "scan")
    stage1_outputs = _stage_outputs_for_workflow(run_payload, "scan")
    stage2_outputs = _stage_outputs_for_workflow(run_payload, "llm")
    stage3_outputs = _stage_outputs_for_workflow(run_payload, "invest")
    stage1_active_positions_found = stage1_outputs.get("active_positions_found")
    safe_wallet_credential_artifact = (
        _safe_stage1_wallet_credential_artifact(stage1_outputs)
    )
    safe_wallet_snapshot_diagnostics = (
        _safe_stage1_wallet_snapshot_diagnostics(stage1_outputs)
    )
    wallet_snapshot_status = stage1_outputs.get("wallet_snapshot_status")
    normalized_wallet_snapshot_status = str(
        wallet_snapshot_status or ""
    ).strip().lower()
    wallet_snapshot_freshness_state = stage1_outputs.get(
        "wallet_snapshot_freshness_state",
        stage1_outputs.get("wallet_freshness_state"),
    )
    normalized_wallet_snapshot_freshness_state = str(
        wallet_snapshot_freshness_state or ""
    ).strip().lower()
    wallet_refresh_error = stage1_outputs.get("wallet_refresh_error")
    stage2_candidate_only = _strict_boolean(
        stage1_outputs.get("stage2_candidate_only")
    )
    blocked_by_stage1_wallet_refresh = _strict_boolean(
        stage1_outputs.get("blocked_by_stage1_wallet_refresh")
    )
    wallet_market_enrichment_error = stage1_outputs.get(
        "wallet_market_enrichment_error"
    )
    stage1_stage_status = str(
        stage1_stage_result.get("status") or ""
    ).strip().lower()
    raw_stage1_phase_status = stage1_outputs.get("phase_status")
    stage1_phase_status = (
        str(raw_stage1_phase_status).strip().lower()
        if raw_stage1_phase_status is not None
        else None
    )
    stage1_completed_at = stage1_stage_result.get("completed_at")
    stage1_completion_evidence = bool(
        _parse_iso(
            stage1_completed_at
            if isinstance(stage1_completed_at, str)
            else None
        )
    )
    stage1_hard_block = _strict_boolean(
        stage1_stage_result.get("hard_block")
    )
    stage1_lifecycle_usable = bool(
        stage1_stage_status in {"pass", "warning"}
        and (
            stage1_phase_status in {None, ""}
            or stage1_phase_status in {"completed", "partial"}
        )
        and stage1_completion_evidence
        and not stage1_hard_block
    )
    canonical_stage1_lifecycle = {
        "status": stage1_stage_status or None,
        "phase_status": stage1_phase_status or None,
        "started_at": stage1_stage_result.get("started_at"),
        "completed_at": stage1_completed_at,
        "hard_block": stage1_hard_block,
        "completion_evidence": stage1_completion_evidence,
    }
    portfolio_snapshot_verified = bool(
        isinstance(stage1_active_positions_found, list)
        and stage1_lifecycle_usable
        and normalized_wallet_snapshot_status == "fresh"
        and normalized_wallet_snapshot_freshness_state == "fresh"
        and not wallet_refresh_error
        and not wallet_market_enrichment_error
        and not stage2_candidate_only
        and not blocked_by_stage1_wallet_refresh
    )
    if portfolio_snapshot_verified:
        portfolio_snapshot_verification_reason = (
            "Stage 1 completed with a pass/warning lifecycle and a usable "
            "fresh wallet snapshot."
        )
    elif stage1_stage_status not in {"pass", "warning"}:
        portfolio_snapshot_verification_reason = (
            "Stage 1 status was "
            f"{stage1_stage_status or 'missing'}, not pass/warning; empty rows "
            "are not proof of an empty portfolio."
        )
    elif stage1_phase_status not in {None, "", "completed", "partial"}:
        portfolio_snapshot_verification_reason = (
            "Stage 1 phase status was "
            f"{stage1_phase_status}, not completed/partial; empty rows are not "
            "proof of an empty portfolio."
        )
    elif not stage1_completion_evidence:
        portfolio_snapshot_verification_reason = (
            "Stage 1 did not retain a valid completion timestamp; empty rows "
            "are not proof of an empty portfolio."
        )
    elif stage1_hard_block:
        portfolio_snapshot_verification_reason = (
            "Stage 1 retained a hard-block lifecycle; empty rows are not "
            "proof of an empty portfolio."
        )
    elif wallet_refresh_error:
        portfolio_snapshot_verification_reason = (
            "Stage 1 wallet refresh failed: "
            f"{str(wallet_refresh_error)[:300]}. "
            "Empty rows are not proof of an empty portfolio."
        )
    elif wallet_market_enrichment_error:
        portfolio_snapshot_verification_reason = (
            "Stage 1 wallet enrichment failed: "
            f"{str(wallet_market_enrichment_error)[:300]}. "
            "Empty rows are not proof of an empty portfolio."
        )
    elif stage2_candidate_only:
        portfolio_snapshot_verification_reason = (
            "Stage 1 continued in candidate-only mode; empty rows are not "
            "proof of an empty portfolio."
        )
    elif blocked_by_stage1_wallet_refresh:
        portfolio_snapshot_verification_reason = (
            "Stage 1 was blocked by wallet refresh; empty rows are not proof "
            "of an empty portfolio."
        )
    elif normalized_wallet_snapshot_status != "fresh":
        portfolio_snapshot_verification_reason = (
            "Stage 1 wallet status was "
            f"{normalized_wallet_snapshot_status or 'missing'}, not fresh; "
            "empty rows are not proof of an empty portfolio."
        )
    else:
        portfolio_snapshot_verification_reason = (
            "Stage 1 wallet freshness lineage was "
            f"{normalized_wallet_snapshot_freshness_state or 'missing'}, not "
            "fresh; empty rows are not proof of an empty portfolio."
        )
    verified_portfolio_snapshot = (
        {
            "source": stage1_outputs.get(
                "wallet_source",
                "stage1_active_positions_found",
            ),
            "fetched_at": stage1_outputs.get("wallet_snapshot_fetched_at"),
            "freshness_state": wallet_snapshot_freshness_state,
            "account_identity": stage1_outputs.get("wallet_account_identity"),
            "credential_artifact": safe_wallet_credential_artifact,
            "position_classifier_version": stage1_outputs.get(
                "wallet_position_classifier_version",
                stage1_outputs.get("position_classifier_version"),
            ),
            "snapshot_diagnostics": safe_wallet_snapshot_diagnostics,
            "verified": portfolio_snapshot_verified,
            "verification_reason": portfolio_snapshot_verification_reason,
            "canonical_stage_lifecycle": canonical_stage1_lifecycle,
            "stage_status": stage1_stage_status or None,
            "phase_status": stage1_phase_status or None,
            "stage_started_at": stage1_stage_result.get("started_at"),
            "stage_completed_at": stage1_completed_at,
            "completion_evidence": stage1_completion_evidence,
            "stage_hard_block": stage1_hard_block,
            "wallet_snapshot_status": wallet_snapshot_status,
            "wallet_refresh_error": wallet_refresh_error,
            "wallet_market_enrichment_error": (
                wallet_market_enrichment_error
            ),
            "stage2_candidate_only": stage2_candidate_only,
            "blocked_by_stage1_wallet_refresh": (
                blocked_by_stage1_wallet_refresh
            ),
            "active_positions_found": stage1_active_positions_found,
            "available_for_claim": stage1_outputs.get("available_for_claim", []),
            "settlement_pending_positions": stage1_outputs.get(
                "settlement_pending_positions",
                [],
            ),
            "excluded_position_diagnostics": stage1_outputs.get(
                "excluded_position_diagnostics",
                [],
            ),
            "active_position_count": len(stage1_active_positions_found),
            "recorded_occupied_positions": stage1_outputs.get(
                "console_trade_occupied_positions",
                stage1_outputs.get("console_trade_active_positions"),
            ),
            "cash_in_hand_usd": stage1_outputs.get(
                "console_trade_cash_in_hand_usd"
            ),
            "available_slots": stage1_outputs.get("console_trade_available_slots"),
            "max_positions": stage1_outputs.get("console_trade_max_positions"),
            "trade_amount_usd": stage1_outputs.get("console_trade_amount_usd"),
        }
        if isinstance(stage1_active_positions_found, list)
        else None
    )
    stage2_to_stage3_handoff_market_ids = _stage2_to_stage3_handoff_market_ids(run_payload)
    audit_metadata = (
        run_payload.get("audit_metadata")
        if isinstance(run_payload.get("audit_metadata"), dict)
        else {}
    )
    code_provenance = (
        audit_metadata.get("code_provenance")
        if isinstance(audit_metadata.get("code_provenance"), dict)
        else {}
    )
    settings_snapshot = (
        audit_metadata.get("settings_snapshot")
        if isinstance(audit_metadata.get("settings_snapshot"), dict)
        else None
    )
    diagnostics = (
        run_payload.get("diagnostics") if isinstance(run_payload.get("diagnostics"), dict) else {}
    )
    # Status tiles and section payloads must describe the same canonical row.
    # Aggregating every internal row carrying a historical workflow label can
    # otherwise produce an impossible projection such as exact Stage 3=pass
    # with overview Stage 3=fail.
    stage_statuses = {
        f"stage_{stage_number}": (
            _stage_result_for_workflow(run_payload, workflow_key).get("status")
            or None
        )
        for stage_number, workflow_key in (
            (1, "scan"),
            (2, "llm"),
            (3, "invest"),
        )
    }
    missing_fields: list[dict[str, Any]] = []
    if not settings_snapshot:
        missing_fields.append(
            {"field": "settings_snapshot", "reason": "Run did not persist a settings snapshot."}
        )
    if not code_provenance.get("backend_commit_sha"):
        missing_fields.append(
            {"field": "backend_commit_sha", "reason": "Run did not persist backend provenance."}
        )
    bundle = {
        "metadata": {
            "run_id": run_payload.get("id"),
            "source_kind": source_kind,
            "lifecycle_status": lifecycle_status,
            "snapshot_schema_version": BULLPEN_RUN_AUDIT_SCHEMA_VERSION,
        },
        "overview": {
            "run": run_payload,
            "run_status": run_payload.get("status"),
            "triggered_by": run_payload.get("triggered_by"),
            "started_at": run_payload.get("started_at"),
            "completed_at": run_payload.get("completed_at"),
            "duration_seconds": _duration_seconds(
                run_payload.get("started_at"), run_payload.get("completed_at")
            ),
            "summary": run_payload.get("summary"),
            "error_message": run_payload.get("error_message"),
            "stage_statuses": stage_statuses,
            "settings_snapshot": settings_snapshot,
            "settings_hash": audit_metadata.get("settings_hash"),
            "code_provenance": code_provenance,
            "diagnostics": diagnostics,
            "request_context": run_payload.get("request_context"),
            "execution_handoff": (
                audit_metadata.get("execution_handoff")
                if isinstance(audit_metadata.get("execution_handoff"), dict)
                else {}
            ),
            "missing_fields": missing_fields,
        },
        "stage_1": {
            "run_stages": [
                stage for stage in run_stage_results if _logical_stage_number_for_result(stage) == 1
            ],
            "candidate_inputs": (
                (((run_payload.get("request_context") or {}).get("console_profile") or {}).get("candidate_rows"))
                if isinstance(run_payload.get("request_context"), dict)
                else []
            ),
            "scan_context": {
                "scan_source_label": diagnostics.get("scan_source_label"),
                "scan_source_url": diagnostics.get("scan_source_url"),
                "scan_scope": stage1_outputs.get("scan_scope")
                or diagnostics.get("scan_scope"),
                "scan_completeness": stage1_outputs.get("scan_completeness")
                or diagnostics.get("scan_completeness"),
                "bullpen_trending_rows": stage1_outputs.get(
                    "bullpen_trending_rows"
                ),
                "complete_catalogue_markets": stage1_outputs.get(
                    "complete_catalogue_markets"
                ),
                "active_wallet_positions": stage1_outputs.get(
                    "active_wallet_positions"
                ),
                "filter_eligible_markets": stage1_outputs.get(
                    "accepted_candidates_count"
                ),
                "active_wallet_markets_added_to_union": stage1_outputs.get(
                    "active_wallet_markets_added_to_union"
                ),
                "missing_active_market_count": stage1_outputs.get(
                    "missing_active_market_count"
                ),
                "used_manual_console_rows": diagnostics.get("used_manual_console_rows"),
                "selected_manual_candidate_ids": diagnostics.get("selected_manual_candidate_ids") or [],
                "scanned_candidates": diagnostics.get("scanned_candidates"),
                "candidate_rows_before_llm": diagnostics.get("candidate_rows_before_llm"),
                "wallet_snapshot_status": stage1_outputs.get("wallet_snapshot_status"),
                "wallet_refresh_timeout_seconds": stage1_outputs.get(
                    "wallet_refresh_timeout_seconds"
                ),
                "wallet_refresh_error": stage1_outputs.get("wallet_refresh_error"),
                "wallet_market_enrichment_error": stage1_outputs.get(
                    "wallet_market_enrichment_error"
                ),
                "wallet_market_enrichment_degraded": _strict_boolean(
                    stage1_outputs.get("wallet_market_enrichment_degraded")
                ),
                "stage2_actionables_authoritative": _strict_boolean(
                    stage1_outputs.get("stage2_actionables_authoritative")
                ),
                "stage3_execution_uses_conservative_occupancy": _strict_boolean(
                    stage1_outputs.get(
                        "stage3_execution_uses_conservative_occupancy"
                    )
                ),
                "stage2_candidate_only": _strict_boolean(
                    stage1_outputs.get("stage2_candidate_only")
                ),
            },
            "verified_portfolio_snapshot": verified_portfolio_snapshot,
            "active_positions": [
                review
                for review in candidate_reviews
                if review.get("source_kind") == "active_position"
            ],
            "candidate_reviews": [
                review
                for review in candidate_reviews
                if review.get("source_kind") == "candidate"
            ],
        },
        "stage_2": {
            "run_stages": [
                stage for stage in run_stage_results if _logical_stage_number_for_result(stage) == 2
            ],
            "candidate_reviews": candidate_reviews,
            "qualified_candidate_market_ids": stage2_outputs.get("qualified_candidate_market_ids") or [],
            "stage3_handoff_candidate_market_ids": stage2_to_stage3_handoff_market_ids,
            "universe_status": (
                stage2_outputs.get("stage2_universe_status")
                if isinstance(stage2_outputs.get("stage2_universe_status"), dict)
                else {
                    "total_eligible_rows": stage2_outputs.get("stage2_eligible_rows_total"),
                    "reviewed_rows": stage2_outputs.get("stage2_reviewed_rows"),
                    "skipped_rows": stage2_outputs.get("stage2_skipped_rows"),
                    "is_complete": stage2_outputs.get("stage2_universe_complete"),
                    "blocker_code": stage2_outputs.get("stage2_universe_blocker_code"),
                    "blocker_summary": stage2_outputs.get("stage2_universe_blocker_summary"),
                    "blocker_fix": stage2_outputs.get("stage2_universe_blocker_fix"),
                    "blocker_rows": stage2_outputs.get("stage2_universe_blocker_rows") or [],
                }
            ),
            "llm_invocations": stage2_outputs.get("llm_target_runs") or [],
            "candidate_only": _strict_boolean(
                stage2_outputs.get("stage2_candidate_only")
            ),
            "stage1_wallet_snapshot_available": stage2_outputs.get(
                "stage1_wallet_snapshot_available"
            ),
            "stage1_wallet_refresh_error": stage2_outputs.get(
                "stage1_wallet_refresh_error"
            ),
            "actionable_contract": {
                "version": stage2_outputs.get(
                    "stage2_actionable_contract_version"
                ),
                "authoritative": _strict_boolean(
                    stage2_outputs.get(
                        "stage2_actionable_contract_authoritative"
                    )
                ),
                "execution_mode": stage2_outputs.get(
                    "stage2_actionable_contract_execution_mode"
                ),
                "source": stage2_outputs.get(
                    "stage2_actionable_handoff_source"
                ),
                "wallet_enrichment_degraded": _strict_boolean(
                    stage2_outputs.get(
                        "stage2_actionable_wallet_enrichment_degraded"
                    )
                ),
                "exit_market_ids": stage2_outputs.get(
                    "stage2_actionable_exit_market_ids"
                )
                or [],
                "buy_market_ids": stage2_outputs.get(
                    "stage2_actionable_buy_market_ids"
                )
                or [],
                "exit_count": stage2_outputs.get(
                    "stage2_actionable_exit_count"
                ),
                "buy_count": stage2_outputs.get(
                    "stage2_actionable_buy_count"
                ),
                "missing_exit_market_ids": stage2_outputs.get(
                    "missing_stage2_actionable_exit_market_ids"
                )
                or [],
                "missing_buy_market_ids": stage2_outputs.get(
                    "missing_stage2_actionable_buy_market_ids"
                )
                or [],
            },
            "llm_runtime": {
                key: value
                for key, value in stage2_outputs.items()
                if str(key).startswith("llm_")
            },
        },
        "stage_3": {
            "run_stages": [
                stage for stage in run_stage_results if _logical_stage_number_for_result(stage) == 3
            ],
            "decision_rows": _list_stage3_decision_rows(run_payload),
            "decisions": decisions,
            "order_intents": order_intents,
            "order_metrics": stage3_outputs.get("order_metrics") or {},
            "execution_steps": stage3_outputs.get("execution_steps") or [],
            "persisted_execution_counters": stage3_outputs.get(
                "persisted_execution_counters"
            )
            or {},
            "recovery": (
                audit_metadata.get("stage3_recovery")
                if isinstance(audit_metadata.get("stage3_recovery"), dict)
                else {
                    "required": stage3_outputs.get("recovery_required"),
                    "automatic_resubmission": stage3_outputs.get(
                        "automatic_resubmission"
                    ),
                    "interrupted_at": stage3_outputs.get("interrupted_at"),
                }
            ),
            "auth_recovery": (
                audit_metadata.get("auth_recovery")
                if isinstance(audit_metadata.get("auth_recovery"), dict)
                else {}
            ),
            "post_exit_buy_refresh": stage3_outputs.get("post_exit_buy_refresh") or {},
            "stage3_slot_diagnostics": stage3_outputs.get("stage3_slot_diagnostics") or {},
            "handoff_checkpoint": (
                stage3_outputs.get("stage2_handoff_checkpoint")
                if isinstance(stage3_outputs.get("stage2_handoff_checkpoint"), dict)
                else {}
            ),
            "max_positions": stage3_outputs.get("top_table_size") or stage3_outputs.get("execution_step_total"),
            "stage2_handoff_candidate_market_ids": stage2_to_stage3_handoff_market_ids,
            "blocked_by_stage1_wallet_refresh": _strict_boolean(
                stage3_outputs.get("blocked_by_stage1_wallet_refresh")
            ),
            "stage1_wallet_refresh_error": stage3_outputs.get(
                "stage1_wallet_refresh_error"
            ),
        },
        "guardrails": {
            "run_guardrails": run_payload.get("guardrail_checks") or [],
            "decision_guardrails": [
                {
                    "decision_id": decision.get("id"),
                    "guardrail_checks": decision.get("guardrail_checks") or [],
                }
                for decision in decisions
            ],
        },
        "raw": {
            "run_payload": run_payload,
            "run_stage_results": run_stage_results,
            "decision_stage_results": decision_stage_results,
            "run_order_funnel": run_orders_payload.get("order_funnel") or {},
            "orders_response": run_orders_payload,
            "decisions": decisions,
        },
    }
    return bundle


def _snapshot_completeness(bundle: dict[str, Any]) -> tuple[float, list[dict[str, Any]]]:
    overview = bundle.get("overview") if isinstance(bundle.get("overview"), dict) else {}
    missing_fields = overview.get("missing_fields")
    missing = [dict(item) for item in missing_fields] if isinstance(missing_fields, list) else []
    required_slots = 8
    completeness = max(0.0, round(((required_slots - len(missing)) / required_slots) * 100, 2))
    return completeness, missing


def _event_record_to_summary(record: BullpenRunAuditEventRecord) -> dict[str, Any]:
    return {
        "event_key": record.event_key,
        "sequence": record.sequence,
        "logical_stage_number": record.logical_stage_number,
        "event_type": record.event_type,
        "scope_type": record.scope_type,
        "scope_id": record.scope_id,
        "source_location": record.source_location,
        "occurred_at": isoformat(record.occurred_at),
    }


def _formula_record_to_bundle_item(record: BullpenRunAuditFormulaRecord) -> dict[str, Any]:
    return {
        "algorithm_key": record.algorithm_key,
        "human_name": record.human_name,
        "algorithm_version": record.algorithm_version,
        "logical_stage_number": record.logical_stage_number,
        "scope_type": record.scope_type,
        "scope_id": record.scope_id,
        "source_module": record.source_module,
        "source_function": record.source_function,
        "inputs": dict(record.inputs_json or {}),
        "intermediates": dict(record.intermediates_json or {}),
        "output": dict(record.output_json or {}),
        "recorded_value": dict(record.recorded_value_json or {})
        if isinstance(record.recorded_value_json, dict)
        else record.recorded_value_json,
        "recomputed_value": dict(record.recomputed_value_json or {})
        if isinstance(record.recomputed_value_json, dict)
        else record.recomputed_value_json,
        "difference": dict(record.difference_json or {})
        if isinstance(record.difference_json, dict)
        else record.difference_json,
        "units": record.units,
        "validation_status": record.validation_status,
        "formula_hash": record.formula_hash,
        "recorded_at": isoformat(record.recorded_at),
    }


def _audit_status_for_snapshot(source_kind: str, lifecycle_status: str) -> str:
    if lifecycle_status == SNAPSHOT_STATUS_INCOMPLETE:
        return "incomplete"
    if lifecycle_status == SNAPSHOT_STATUS_FROZEN:
        return "frozen"
    return source_kind


def _ensure_default_manual_checks(
    repo: BullpenRunAuditRepository,
    *,
    snapshot: BullpenRunAuditSnapshotRecord,
) -> None:
    existing = repo.list_manual_checks(snapshot_id=snapshot.id)
    if existing:
        return
    for item in DEFAULT_MANUAL_CHECKS:
        repo.session.add(
            BullpenRunAuditManualCheckRecord(
                snapshot_id=snapshot.id,
                user_id=snapshot.user_id,
                check_key=item["check_key"],
                check_label=item["label"],
                status="unchecked",
                scope_type="run",
                scope_id=snapshot.run_id,
                description=item["description"],
                remark=None,
                metadata_json={},
            )
        )
    repo.session.flush()


@dataclass
class MaterializedSnapshot:
    snapshot: BullpenRunAuditSnapshotRecord
    bundle: dict[str, Any]


def _materialized_snapshot_from_record(
    snapshot: BullpenRunAuditSnapshotRecord,
) -> MaterializedSnapshot:
    bundle_blob = snapshot.canonical_bundle_blob
    bundle = (
        dict(bundle_blob.payload_json)
        if bundle_blob is not None and isinstance(bundle_blob.payload_json, dict)
        else {}
    )
    return MaterializedSnapshot(snapshot=snapshot, bundle=bundle)


def materialize_run_audit_snapshot_sync(
    session: Session,
    *,
    user_id: int,
    run_id: str,
    force: bool = False,
    freeze: bool | None = None,
) -> MaterializedSnapshot:
    repo = BullpenRunAuditRepository(session)
    # Every audit rebuild (including force=True calls issued by Stage 3 order
    # reconciliation) shares this parent-row lock.  A snapshot row cannot be
    # used as the lock target because concurrent first materializations do not
    # have one yet.  Keep the lock for the caller's transaction so clear +
    # rebuild + snapshot metadata are committed atomically.
    run_record = repo.lock_run_record_for_audit_materialization(
        user_id=user_id,
        run_id=run_id,
    )
    if run_record is None:
        raise ValueError("Run not found")
    current_snapshot = repo.get_current_snapshot(user_id=user_id, run_id=run_id)
    current_is_frozen = (
        current_snapshot is not None
        and getattr(current_snapshot, "lifecycle_status", None)
        == SNAPSHOT_STATUS_FROZEN
    )
    snapshot_source_updated_at = _as_utc(
        current_snapshot.source_run_updated_at if current_snapshot is not None else None
    )
    durable_run_updated_at = _as_utc(run_record.updated_at)
    snapshot_covers_durable_run = (
        snapshot_source_updated_at is not None
        and durable_run_updated_at is not None
        and snapshot_source_updated_at >= durable_run_updated_at
    )
    frozen_snapshot_is_unchanged = (
        current_is_frozen
        and current_snapshot.snapshot_schema_version
        == BULLPEN_RUN_AUDIT_SCHEMA_VERSION
        and snapshot_covers_durable_run
    )
    # A frozen snapshot is immutable evidence.  ``force=True`` means "observe
    # the latest durable run state", not "rewrite history".  Return the
    # existing version when its source row is unchanged.  If the source run
    # was genuinely amended, the creation branch below writes a new version
    # and links it to this frozen predecessor.
    if frozen_snapshot_is_unchanged:
        return _materialized_snapshot_from_record(current_snapshot)
    if (
        current_snapshot is not None
        and not force
        and current_snapshot.snapshot_schema_version == BULLPEN_RUN_AUDIT_SCHEMA_VERSION
        and snapshot_covers_durable_run
    ):
        return _materialized_snapshot_from_record(current_snapshot)

    run = record_to_run(run_record)
    decision_records = repo.get_run_decision_records(user_id=user_id, run_id=run_id)
    decisions = [record_to_decision(record).model_dump(mode="json") for record in decision_records]
    orders_response = summarize_run_orders_sync(session, user_id=user_id, run_id=run_id)
    run_orders_payload = orders_response.model_dump(mode="json")
    run_payload = run.model_dump(mode="json")
    audit_metadata = (
        run_payload.get("audit_metadata")
        if isinstance(run_payload.get("audit_metadata"), dict)
        else {}
    )
    source_kind = (
        SNAPSHOT_SOURCE_NATIVE
        if audit_metadata.get("capture_mode") == SNAPSHOT_SOURCE_NATIVE
        else SNAPSHOT_SOURCE_RECONSTRUCTED
    )
    terminal = run.status in TERMINAL_RUN_STATUSES
    lifecycle_status = (
        SNAPSHOT_STATUS_FROZEN
        if (
            current_is_frozen
            or (freeze if freeze is not None else terminal)
        )
        else SNAPSHOT_STATUS_WORKING
    )
    bundle = _build_bundle(
        run_payload=run_payload,
        decisions=decisions,
        run_orders_payload=run_orders_payload,
        source_kind=source_kind,
        lifecycle_status=lifecycle_status,
    )
    completeness_pct, missing_fields = _snapshot_completeness(bundle)
    if missing_fields and lifecycle_status != SNAPSHOT_STATUS_FROZEN:
        lifecycle_status = SNAPSHOT_STATUS_INCOMPLETE
    bundle["overview"]["missing_fields"] = missing_fields
    bundle["metadata"]["lifecycle_status"] = lifecycle_status

    if (
        current_snapshot is None
        or current_snapshot.snapshot_schema_version != BULLPEN_RUN_AUDIT_SCHEMA_VERSION
        or current_is_frozen
    ):
        superseded_snapshot = current_snapshot
        version = repo.latest_snapshot_version_for_run(user_id=user_id, run_id=run_id) + 1
        # ``is_current`` is the mutable version-selection pointer, not frozen
        # evidence.  Demote the predecessor under the same run lock so every
        # consumer continues to observe exactly one current snapshot.  Its
        # bundle, hash, children, findings and captured provenance remain
        # untouched and directly addressable by snapshot id.
        repo.demote_current_snapshots(user_id=user_id, run_id=run_id)
        current_snapshot = BullpenRunAuditSnapshotRecord(
            user_id=user_id,
            run_id=run_id,
            snapshot_version=version,
            snapshot_schema_version=BULLPEN_RUN_AUDIT_SCHEMA_VERSION,
            is_current=True,
            source_kind=source_kind,
            lifecycle_status=lifecycle_status,
            audit_status=_audit_status_for_snapshot(source_kind, lifecycle_status),
            run_status=run.status,
            triggered_by=run.triggered_by,
            dry_run=run.dry_run,
            live_execution_requested=run.live_execution_requested,
            live_execution_attempted=run.live_execution_attempted,
            started_at=run_record.started_at,
            completed_at=run_record.completed_at,
            supersedes_snapshot_id=(
                superseded_snapshot.id
                if superseded_snapshot is not None
                else None
            ),
        )
        session.add(current_snapshot)
        session.flush()
    else:
        repo.clear_current_snapshot_children(current_snapshot.id)

    stage_records = _serialize_stage_records(
        repo,
        current_snapshot.id,
        [_stage_result_dict(stage) for stage in run.stage_results],
        _flatten_decision_stage_results(decisions),
    )
    for stage_record in stage_records:
        session.add(stage_record)
    event_records = _serialize_event_records(
        repo,
        current_snapshot.id,
        run_payload=run_payload,
        orders=(run_orders_payload.get("orders") or []),
    )
    for event_record in event_records:
        session.add(event_record)
    formula_records = _build_formula_records(
        snapshot_id=current_snapshot.id,
        stage1_outputs=_stage_outputs_for_workflow(run_payload, "scan"),
        candidate_reviews=_list_stage2_candidate_reviews(run_payload),
        decisions=decisions,
        run_order_funnel=(run_orders_payload.get("order_funnel") or {}),
        stage3_outputs=_stage_outputs_for_workflow(run_payload, "invest"),
    )
    for formula_record in formula_records:
        session.add(formula_record)
    bundle["overview"]["timeline"] = [
        _event_record_to_summary(record) for record in event_records
    ]
    bundle["formulas"] = [
        _formula_record_to_bundle_item(record) for record in formula_records
    ]
    bundle["raw"]["event_summaries"] = bundle["overview"]["timeline"]

    findings = build_deterministic_findings(bundle)
    for finding in findings:
        safe_finding = sanitize_audit_evidence(finding)
        if not isinstance(safe_finding, dict):
            raise RuntimeError("Sanitized Bullpen run-audit finding must be an object")
        session.add(
            BullpenRunAuditFindingRecord(
                snapshot_id=current_snapshot.id,
                rule_version=str(safe_finding["rule_version"]),
                code=str(safe_finding["code"]),
                severity=str(safe_finding["severity"]),
                stage=str(safe_finding["stage"]),
                category=str(safe_finding["category"]),
                title=str(safe_finding["title"]),
                explanation=str(safe_finding["explanation"]),
                observed_value=(
                    str(safe_finding["observed_value"])
                    if safe_finding.get("observed_value") is not None
                    else None
                ),
                expected_value=(
                    str(safe_finding["expected_value"])
                    if safe_finding.get("expected_value") is not None
                    else None
                ),
                blocking=bool(safe_finding.get("blocking")),
                classification=str(
                    safe_finding.get("classification") or "deterministic"
                ),
                suggested_remediation=(
                    str(safe_finding["suggested_remediation"])
                    if safe_finding.get("suggested_remediation") is not None
                    else None
                ),
                evidence_pointers_json=list(
                    safe_finding.get("evidence_pointers") or []
                ),
                detection_metadata_json=dict(
                    safe_finding.get("detection_metadata") or {}
                ),
                resolution_status="open",
                resolution_remark=None,
            )
        )

    safe_bundle = sanitize_audit_evidence(bundle)
    if not isinstance(safe_bundle, dict):
        raise RuntimeError("Sanitized Bullpen run-audit bundle must be an object")
    bundle = safe_bundle
    canonical_blob = repo.create_blob(payload=bundle, content_type="application/json")
    severity_counts = Counter(
        str(finding.get("severity") or "info") for finding in findings
    )
    current_snapshot.source_kind = source_kind
    current_snapshot.lifecycle_status = lifecycle_status
    current_snapshot.audit_status = _audit_status_for_snapshot(source_kind, lifecycle_status)
    current_snapshot.run_status = run.status
    current_snapshot.triggered_by = run.triggered_by
    current_snapshot.dry_run = run.dry_run
    current_snapshot.live_execution_requested = run.live_execution_requested
    current_snapshot.live_execution_attempted = run.live_execution_attempted
    current_snapshot.started_at = run_record.started_at
    current_snapshot.completed_at = run_record.completed_at
    current_snapshot.duration_seconds = _duration_seconds(run.started_at, run.completed_at)
    current_snapshot.execution_version = run.execution_version or audit_metadata.get("execution_version")
    current_snapshot.strategy_version = (
        audit_metadata.get("strategy_version")
        if isinstance(audit_metadata.get("strategy_version"), str)
        else None
    )
    code_provenance = bundle["overview"]["code_provenance"]
    current_snapshot.backend_commit_sha = (
        code_provenance.get("backend_commit_sha") if isinstance(code_provenance, dict) else None
    )
    current_snapshot.frontend_build_sha = (
        code_provenance.get("frontend_build_sha") if isinstance(code_provenance, dict) else None
    )
    current_snapshot.deployment_id = (
        code_provenance.get("deployment_id") if isinstance(code_provenance, dict) else None
    )
    current_snapshot.build_time = (
        code_provenance.get("build_time") if isinstance(code_provenance, dict) else None
    )
    current_snapshot.alembic_revision = (
        code_provenance.get("alembic_revision") if isinstance(code_provenance, dict) else None
    )
    current_snapshot.settings_hash = (
        bundle["overview"].get("settings_hash")
        if isinstance(bundle["overview"].get("settings_hash"), str)
        else None
    )
    current_snapshot.canonical_bundle_blob_id = canonical_blob.id
    current_snapshot.canonical_bundle_hash = canonical_blob.id
    current_snapshot.completeness_pct = completeness_pct
    current_snapshot.missing_fields_json = missing_fields
    current_snapshot.provenance_json = (
        code_provenance if isinstance(code_provenance, dict) else {}
    )
    current_snapshot.section_index_json = {
        section_key: {
            "present": section_key.replace("-", "_") in bundle,
            "size_bytes": len(
                json.dumps(
                    bundle.get(section_key.replace("-", "_")) or bundle.get(section_key) or {},
                    ensure_ascii=False,
                    sort_keys=True,
                ).encode("utf-8")
            ),
        }
        for section_key in AUDIT_SECTION_KEYS
    }
    current_snapshot.source_run_updated_at = run_record.updated_at
    current_snapshot.finalized_at = run_record.updated_at if lifecycle_status == SNAPSHOT_STATUS_FROZEN else None
    current_snapshot.stage1_status = bundle["overview"]["stage_statuses"].get("stage_1")
    current_snapshot.stage2_status = bundle["overview"]["stage_statuses"].get("stage_2")
    current_snapshot.stage3_status = bundle["overview"]["stage_statuses"].get("stage_3")
    diagnostics = bundle["overview"]["diagnostics"]
    current_snapshot.scanned_candidate_count = int(diagnostics.get("scanned_candidates") or 0)
    current_snapshot.candidate_rows_before_llm = int(diagnostics.get("candidate_rows_before_llm") or 0)
    current_snapshot.llm_candidate_count = int(diagnostics.get("llm_candidate_count") or 0)
    current_snapshot.llm_configured_call_count = int(
        (bundle["stage_2"]["llm_runtime"] or {}).get("llm_target_count") or 0
    )
    llm_invocations = bundle["stage_2"]["llm_invocations"]
    valid_llm_invocations = [
        invocation
        for invocation in (llm_invocations if isinstance(llm_invocations, list) else [])
        if isinstance(invocation, dict)
        and str(invocation.get("provider") or "").strip()
        and str(invocation.get("model") or "").strip()
    ]

    def _llm_invocation_succeeded(invocation: dict[str, object]) -> bool:
        usable_event_count = invocation.get("usable_event_count")
        if isinstance(usable_event_count, int):
            return usable_event_count > 0
        return invocation.get("status") in {"completed", "partial"}

    current_snapshot.llm_attempted_call_count = len(valid_llm_invocations)
    current_snapshot.llm_succeeded_call_count = sum(
        1
        for invocation in valid_llm_invocations
        if _llm_invocation_succeeded(invocation)
    )
    current_snapshot.llm_failed_call_count = sum(
        1
        for invocation in valid_llm_invocations
        if not _llm_invocation_succeeded(invocation)
    )
    current_snapshot.qualified_candidate_count = len(
        bundle["stage_2"].get("qualified_candidate_market_ids") or []
    )
    current_snapshot.ranked_count = len(bundle["stage_3"].get("decision_rows") or [])
    current_snapshot.final_selection_count = sum(
        1
        for decision in bundle["stage_3"].get("decisions") or []
        if isinstance(decision, dict) and decision.get("stage3_result") == "SELECTED"
    )
    current_snapshot.decisions_count = len(bundle["stage_3"].get("decisions") or [])
    current_snapshot.orders_planned = int(run_orders_payload.get("order_funnel", {}).get("planned") or 0)
    current_snapshot.orders_submitted = int(run_orders_payload.get("order_funnel", {}).get("submitted") or 0)
    current_snapshot.orders_confirmed = int(run_orders_payload.get("order_funnel", {}).get("confirmed") or 0)
    current_snapshot.orders_filled = int(run_orders_payload.get("order_funnel", {}).get("filled") or 0)
    current_snapshot.orders_permanently_failed = int(
        run_orders_payload.get("order_funnel", {}).get("permanently_failed") or 0
    )
    current_snapshot.findings_critical = severity_counts.get("critical", 0)
    current_snapshot.findings_high = severity_counts.get("high", 0)
    current_snapshot.findings_medium = severity_counts.get("medium", 0)
    current_snapshot.findings_low = severity_counts.get("low", 0)
    current_snapshot.findings_info = severity_counts.get("info", 0)
    current_snapshot.validation_failure_count = sum(
        severity_counts.get(key, 0) for key in ("critical", "high", "medium")
    )
    current_snapshot.provider_failure_count = sum(
        1
        for finding in findings
        if str(finding.get("category")) == "provider-failure"
    )
    current_snapshot.incomplete_data_count = len(missing_fields)

    _ensure_default_manual_checks(repo, snapshot=current_snapshot)
    latest_feedback = repo.latest_feedback_for_snapshot_any(snapshot_id=current_snapshot.id)
    if latest_feedback is not None:
        current_snapshot.feedback_status = latest_feedback.status
        current_snapshot.feedback_provider = latest_feedback.provider
        current_snapshot.feedback_model = latest_feedback.model
    else:
        current_snapshot.feedback_status = None
        current_snapshot.feedback_provider = None
        current_snapshot.feedback_model = None
    current_snapshot.manual_deficiency_count = sum(
        1
        for check in repo.list_manual_checks(snapshot_id=current_snapshot.id)
        if check.status in {"unchecked", "fail"}
    )

    session.flush()
    return MaterializedSnapshot(snapshot=current_snapshot, bundle=bundle)


def ensure_materialized_snapshots_for_user_sync(
    session: Session,
    *,
    user_id: int,
    run_status: str | None = None,
    triggered_by: str | None = None,
    dry_live_mode: str | None = None,
    from_date: datetime | None = None,
    to_date: datetime | None = None,
    run_id_search: str | None = None,
) -> None:
    repo = BullpenRunAuditRepository(session)
    run_records = repo.list_run_records(
        user_id=user_id,
        run_status=run_status,
        triggered_by=triggered_by,
        dry_live_mode=dry_live_mode,
        from_date=from_date,
        to_date=to_date,
        run_id_search=run_id_search,
    )
    for run_record in run_records[:100]:
        try:
            with session.begin_nested():
                materialize_run_audit_snapshot_sync(
                    session,
                    user_id=user_id,
                    run_id=run_record.id,
                    force=False,
                )
        except Exception:
            logger.exception(
                "Failed to materialize Bullpen run audit snapshot user_id=%s run_id=%s",
                user_id,
                run_record.id,
            )


def _snapshot_to_summary(snapshot: BullpenRunAuditSnapshotRecord) -> BullpenRunAuditSummaryItem:
    return BullpenRunAuditSummaryItem(
        run_id=snapshot.run_id,
        snapshot_id=snapshot.id,
        snapshot_version=snapshot.snapshot_version,
        run_status=snapshot.run_status,
        triggered_by=snapshot.triggered_by,
        dry_run=snapshot.dry_run,
        live_execution_requested=snapshot.live_execution_requested,
        live_execution_attempted=snapshot.live_execution_attempted,
        started_at=isoformat(snapshot.started_at) or "",
        completed_at=isoformat(snapshot.completed_at),
        duration_seconds=snapshot.duration_seconds,
        execution_version=snapshot.execution_version,
        strategy_version=snapshot.strategy_version,
        backend_commit_sha=snapshot.backend_commit_sha,
        frontend_build_sha=snapshot.frontend_build_sha,
        deployment_id=snapshot.deployment_id,
        stage1_status=snapshot.stage1_status,
        stage2_status=snapshot.stage2_status,
        stage3_status=snapshot.stage3_status,
        scanned_candidate_count=snapshot.scanned_candidate_count,
        candidate_rows_before_llm=snapshot.candidate_rows_before_llm,
        llm_candidate_count=snapshot.llm_candidate_count,
        llm_configured_call_count=snapshot.llm_configured_call_count,
        llm_attempted_call_count=snapshot.llm_attempted_call_count,
        llm_succeeded_call_count=snapshot.llm_succeeded_call_count,
        llm_failed_call_count=snapshot.llm_failed_call_count,
        qualified_candidate_count=snapshot.qualified_candidate_count,
        ranked_count=snapshot.ranked_count,
        final_selection_count=snapshot.final_selection_count,
        decisions_count=snapshot.decisions_count,
        orders_planned=snapshot.orders_planned,
        orders_submitted=snapshot.orders_submitted,
        orders_confirmed=snapshot.orders_confirmed,
        orders_filled=snapshot.orders_filled,
        orders_permanently_failed=snapshot.orders_permanently_failed,
        findings_critical=snapshot.findings_critical,
        findings_high=snapshot.findings_high,
        findings_medium=snapshot.findings_medium,
        findings_low=snapshot.findings_low,
        findings_info=snapshot.findings_info,
        validation_failure_count=snapshot.validation_failure_count,
        provider_failure_count=snapshot.provider_failure_count,
        incomplete_data_count=snapshot.incomplete_data_count,
        manual_deficiency_count=snapshot.manual_deficiency_count,
        source_kind=snapshot.source_kind,  # type: ignore[arg-type]
        lifecycle_status=snapshot.lifecycle_status,  # type: ignore[arg-type]
        audit_status=snapshot.audit_status,
        completeness_pct=snapshot.completeness_pct,
        feedback_status=snapshot.feedback_status,  # type: ignore[arg-type]
        feedback_provider=snapshot.feedback_provider,
        feedback_model=snapshot.feedback_model,
    )


def list_run_audit_summaries_sync(
    session: Session,
    *,
    user_id: int,
    page: int,
    limit: int,
    run_status: str | None = None,
    triggered_by: str | None = None,
    dry_live_mode: str | None = None,
    from_date: datetime | None = None,
    to_date: datetime | None = None,
    run_id_search: str | None = None,
    stage_failure: str | None = None,
    audit_status: str | None = None,
    finding_severity: str | None = None,
    feedback_generated: bool | None = None,
) -> BullpenRunAuditListResponse:
    ensure_materialized_snapshots_for_user_sync(
        session,
        user_id=user_id,
        run_status=run_status,
        triggered_by=triggered_by,
        dry_live_mode=dry_live_mode,
        from_date=from_date,
        to_date=to_date,
        run_id_search=run_id_search,
    )
    repo = BullpenRunAuditRepository(session)
    query = repo.list_snapshots_query(
        user_id=user_id,
        stage_failure=stage_failure,
        audit_status=audit_status,
        finding_severity=finding_severity,
        feedback_generated=feedback_generated,
        run_status=run_status,
        triggered_by=triggered_by,
        dry_live_mode=dry_live_mode,
        from_date=from_date,
        to_date=to_date,
        run_id_search=run_id_search,
    )
    count_query = select(func.count()).select_from(query.order_by(None).subquery())
    total_count = int(session.execute(count_query).scalar_one() or 0)
    rows = list(
        session.execute(
            query.limit(limit).offset(max(0, page - 1) * limit)
        ).scalars().all()
    )
    return BullpenRunAuditListResponse(
        items=[_snapshot_to_summary(row) for row in rows],
        page=page,
        limit=limit,
        total=total_count,
        total_pages=ceil(total_count / limit) if limit else 0,
    )


def _snapshot_to_metadata(snapshot: BullpenRunAuditSnapshotRecord) -> BullpenRunAuditMetadata:
    return BullpenRunAuditMetadata(
        snapshot_id=snapshot.id,
        snapshot_version=snapshot.snapshot_version,
        snapshot_schema_version=snapshot.snapshot_schema_version,
        run_id=snapshot.run_id,
        run_status=snapshot.run_status,
        triggered_by=snapshot.triggered_by,
        started_at=isoformat(snapshot.started_at) or "",
        completed_at=isoformat(snapshot.completed_at),
        duration_seconds=snapshot.duration_seconds,
        dry_run=snapshot.dry_run,
        live_execution_requested=snapshot.live_execution_requested,
        live_execution_attempted=snapshot.live_execution_attempted,
        execution_version=snapshot.execution_version,
        strategy_version=snapshot.strategy_version,
        source_kind=snapshot.source_kind,  # type: ignore[arg-type]
        lifecycle_status=snapshot.lifecycle_status,  # type: ignore[arg-type]
        audit_status=snapshot.audit_status,
        completeness_pct=snapshot.completeness_pct,
        canonical_bundle_hash=snapshot.canonical_bundle_hash,
        backend_commit_sha=snapshot.backend_commit_sha,
        frontend_build_sha=snapshot.frontend_build_sha,
        deployment_id=snapshot.deployment_id,
        build_time=snapshot.build_time,
        alembic_revision=snapshot.alembic_revision,
        settings_hash=snapshot.settings_hash,
        section_index=dict(snapshot.section_index_json or {}),
        provenance=dict(snapshot.provenance_json or {}),
        missing_fields=list(snapshot.missing_fields_json or []),
    )


def _finding_to_schema(record: BullpenRunAuditFindingRecord) -> BullpenRunAuditFinding:
    return BullpenRunAuditFinding(
        id=record.id,
        code=record.code,
        rule_version=record.rule_version,
        severity=record.severity,  # type: ignore[arg-type]
        stage=record.stage,
        category=record.category,
        title=record.title,
        explanation=record.explanation,
        observed_value=record.observed_value,
        expected_value=record.expected_value,
        blocking=record.blocking,
        classification=record.classification,
        suggested_remediation=record.suggested_remediation,
        evidence_pointers=list(record.evidence_pointers_json or []),
        detection_metadata=dict(record.detection_metadata_json or {}),
        resolution_status=record.resolution_status,
        resolution_remark=record.resolution_remark,
        created_at=isoformat(record.created_at) or "",
        updated_at=isoformat(record.updated_at) or "",
    )


def _remark_to_schema(record: BullpenRunAuditRemarkRecord) -> BullpenRunAuditRemark:
    return BullpenRunAuditRemark(
        id=record.id,
        scope_type=record.scope_type,
        scope_id=record.scope_id,
        remark_type=record.remark_type,
        body=record.body,
        author_label=record.author_label,
        metadata=dict(record.metadata_json or {}),
        supersedes_remark_id=record.supersedes_remark_id,
        created_at=isoformat(record.created_at) or "",
        updated_at=isoformat(record.updated_at) or "",
    )


def _manual_check_to_schema(record: BullpenRunAuditManualCheckRecord) -> BullpenRunAuditManualCheck:
    return BullpenRunAuditManualCheck(
        id=record.id,
        check_key=record.check_key,
        check_label=record.check_label,
        status=record.status,  # type: ignore[arg-type]
        scope_type=record.scope_type,
        scope_id=record.scope_id,
        description=record.description,
        remark=record.remark,
        metadata=dict(record.metadata_json or {}),
        supersedes_check_id=record.supersedes_check_id,
        created_at=isoformat(record.created_at) or "",
        updated_at=isoformat(record.updated_at) or "",
    )


def _feedback_summary_to_schema(record: BullpenRunAuditFeedbackRecord) -> BullpenRunAuditFeedbackSummary:
    return BullpenRunAuditFeedbackSummary(
        id=record.id,
        status=record.status,  # type: ignore[arg-type]
        provider=record.provider,
        model=record.model,
        prompt_version=record.prompt_version,
        prompt_hash=record.prompt_hash,
        report_version=record.report_version,
        chunk_count=record.chunk_count,
        chunk_coverage_pct=record.chunk_coverage_pct,
        snapshot_hash=record.snapshot_hash,
        tokens_in=record.tokens_in,
        tokens_out=record.tokens_out,
        estimated_cost=record.estimated_cost,
        latency_seconds=record.latency_seconds,
        error_message=record.error_message,
        codex_prompt=record.codex_prompt,
        created_at=isoformat(record.created_at) or "",
        updated_at=isoformat(record.updated_at) or "",
        completed_at=isoformat(record.completed_at),
    )


def get_run_audit_detail_sync(
    session: Session,
    *,
    user_id: int,
    run_id: str,
) -> BullpenRunAuditDetailResponse:
    materialized = materialize_run_audit_snapshot_sync(
        session,
        user_id=user_id,
        run_id=run_id,
        force=False,
    )
    snapshot = materialized.snapshot
    repo = BullpenRunAuditRepository(session)
    detail_snapshot = repo.get_snapshot(user_id=user_id, snapshot_id=snapshot.id)
    if detail_snapshot is None:
        raise ValueError("Snapshot not found")
    findings = [_finding_to_schema(item) for item in detail_snapshot.findings]
    manual_checks = repo.list_manual_checks(snapshot_id=detail_snapshot.id)
    latest_checks_map: dict[str, BullpenRunAuditManualCheckRecord] = {}
    for record in manual_checks:
        latest_checks_map.setdefault(record.check_key, record)
    feedback_history = [
        _feedback_summary_to_schema(item)
        for item in repo.list_feedback_for_snapshot(snapshot_id=detail_snapshot.id)
    ]
    findings_summary = {
        "critical": detail_snapshot.findings_critical,
        "high": detail_snapshot.findings_high,
        "medium": detail_snapshot.findings_medium,
        "low": detail_snapshot.findings_low,
        "info": detail_snapshot.findings_info,
        "validation_failures": detail_snapshot.validation_failure_count,
        "provider_failures": detail_snapshot.provider_failure_count,
        "incomplete_data": detail_snapshot.incomplete_data_count,
        "manual_deficiencies": detail_snapshot.manual_deficiency_count,
    }
    return BullpenRunAuditDetailResponse(
        snapshot=_snapshot_to_metadata(detail_snapshot),
        findings_summary=findings_summary,
        findings=findings,
        latest_manual_checks=[
            _manual_check_to_schema(record) for record in latest_checks_map.values()
        ],
        manual_check_history=[_manual_check_to_schema(record) for record in manual_checks],
        remarks=[_remark_to_schema(record) for record in repo.list_latest_remarks(snapshot_id=detail_snapshot.id)],
        feedback_history=feedback_history,
        available_sections=list(AUDIT_SECTION_KEYS),
    )


def get_run_audit_section_sync(
    session: Session,
    *,
    user_id: int,
    run_id: str,
    section: str,
) -> BullpenRunAuditSectionResponse:
    materialized = materialize_run_audit_snapshot_sync(
        session,
        user_id=user_id,
        run_id=run_id,
        force=False,
    )
    normalized = section.replace("-", "_")
    data = materialized.bundle.get(normalized)
    if data is None:
        data = materialized.bundle.get(section)
    return BullpenRunAuditSectionResponse(
        run_id=run_id,
        snapshot_id=materialized.snapshot.id,
        canonical_bundle_hash=materialized.snapshot.canonical_bundle_hash,
        section=section,
        data=data,
    )


def export_run_audit_bundle_sync(
    session: Session,
    *,
    user_id: int,
    run_id: str,
) -> dict[str, Any]:
    materialized = materialize_run_audit_snapshot_sync(
        session,
        user_id=user_id,
        run_id=run_id,
        force=False,
    )
    return materialized.bundle


def add_run_audit_remark_sync(
    session: Session,
    *,
    user_id: int,
    run_id: str,
    author_label: str | None,
    request: BullpenRunAuditRemarkCreateRequest,
) -> BullpenRunAuditRemark:
    materialized = materialize_run_audit_snapshot_sync(
        session,
        user_id=user_id,
        run_id=run_id,
        force=False,
    )
    record = BullpenRunAuditRemarkRecord(
        snapshot_id=materialized.snapshot.id,
        user_id=user_id,
        scope_type=request.scope_type,
        scope_id=request.scope_id,
        remark_type=request.remark_type,
        body=request.body,
        author_label=author_label,
        metadata_json=dict(request.metadata),
        supersedes_remark_id=request.supersedes_remark_id,
    )
    session.add(record)
    session.flush()
    return _remark_to_schema(record)


def add_run_audit_manual_check_sync(
    session: Session,
    *,
    user_id: int,
    run_id: str,
    request: BullpenRunAuditManualCheckUpdateRequest,
) -> BullpenRunAuditManualCheck:
    materialized = materialize_run_audit_snapshot_sync(
        session,
        user_id=user_id,
        run_id=run_id,
        force=False,
    )
    repo = BullpenRunAuditRepository(session)
    previous = next(
        (
            item
            for item in repo.list_manual_checks(snapshot_id=materialized.snapshot.id)
            if item.check_key == request.check_key and item.scope_type == request.scope_type
        ),
        None,
    )
    label = previous.check_label if previous is not None else request.check_key.replace("_", " ").title()
    description = previous.description if previous is not None else None
    record = BullpenRunAuditManualCheckRecord(
        snapshot_id=materialized.snapshot.id,
        user_id=user_id,
        check_key=request.check_key,
        check_label=label,
        status=request.status,
        scope_type=request.scope_type,
        scope_id=request.scope_id or run_id,
        description=description,
        remark=request.remark,
        metadata_json=dict(request.metadata),
        supersedes_check_id=previous.id if previous is not None else None,
    )
    session.add(record)
    session.flush()
    materialized.snapshot.manual_deficiency_count = sum(
        1
        for check in repo.list_manual_checks(snapshot_id=materialized.snapshot.id)
        if check.status in {"unchecked", "fail"}
    )
    session.flush()
    return _manual_check_to_schema(record)


def list_run_audit_feedback_sync(
    session: Session,
    *,
    user_id: int,
    run_id: str,
) -> list[BullpenRunAuditFeedbackSummary]:
    materialized = materialize_run_audit_snapshot_sync(
        session,
        user_id=user_id,
        run_id=run_id,
        force=False,
    )
    repo = BullpenRunAuditRepository(session)
    return [
        _feedback_summary_to_schema(item)
        for item in repo.list_feedback_for_snapshot(snapshot_id=materialized.snapshot.id)
    ]


def enqueue_run_audit_feedback_sync(
    session: Session,
    *,
    user_id: int,
    run_id: str,
    request: BullpenRunAuditFeedbackCreateRequest,
) -> BullpenRunAuditFeedbackSummary:
    from app.domains.bullpen_run_audit.prompt_builder import feedback_prompt_hash
    from app.domains.bullpen_run_audit.tasks import generate_bullpen_run_audit_feedback

    materialized = materialize_run_audit_snapshot_sync(
        session,
        user_id=user_id,
        run_id=run_id,
        force=False,
    )
    snapshot = materialized.snapshot
    repo = BullpenRunAuditRepository(session)
    prompt_hash = feedback_prompt_hash()
    snapshot_hash = snapshot.canonical_bundle_hash
    idempotency_key = stable_sha256(
        {
            "snapshot_id": snapshot.id,
            "snapshot_hash": snapshot_hash,
            "provider": request.provider,
            "model": request.model,
            "prompt_hash": prompt_hash,
        }
    )
    if not request.force_rerun:
        existing = repo.latest_feedback_for_snapshot(
            snapshot_id=snapshot.id,
            provider=request.provider,
            model=request.model,
            prompt_version="bullpen-run-audit-v1",
            snapshot_hash=snapshot_hash,
        )
        if existing is not None and existing.status in {"queued", "processing", "completed"}:
            return _feedback_summary_to_schema(existing)
    latest_any = repo.latest_feedback_for_snapshot(
        snapshot_id=snapshot.id,
        provider=request.provider,
        model=request.model,
        prompt_version="bullpen-run-audit-v1",
        snapshot_hash=snapshot_hash,
    )
    record = BullpenRunAuditFeedbackRecord(
        snapshot_id=snapshot.id,
        user_id=user_id,
        status="queued",
        provider=request.provider,
        model=request.model,
        prompt_version="bullpen-run-audit-v1",
        prompt_hash=prompt_hash,
        report_version="1",
        idempotency_key=idempotency_key,
        task_id=None,
        chunk_count=0,
        chunk_coverage_pct=0,
        snapshot_hash=snapshot_hash,
        tokens_in=0,
        tokens_out=0,
        estimated_cost=0,
        latency_seconds=0,
        error_message=None,
        report_json={},
        codex_prompt=None,
        rerun_of_feedback_id=latest_any.id if request.force_rerun and latest_any is not None else None,
    )
    session.add(record)
    session.flush()
    async_result = generate_bullpen_run_audit_feedback.apply_async(
        kwargs={
            "user_id": user_id,
            "run_id": run_id,
            "feedback_id": record.id,
        },
        queue="ai",
    )
    record.task_id = async_result.id
    snapshot.feedback_status = record.status
    snapshot.feedback_provider = record.provider
    snapshot.feedback_model = record.model
    session.flush()
    return _feedback_summary_to_schema(record)


def get_run_audit_feedback_detail_sync(
    session: Session,
    *,
    user_id: int,
    feedback_id: int,
) -> BullpenRunAuditFeedbackDetail:
    repo = BullpenRunAuditRepository(session)
    record = repo.get_feedback(user_id=user_id, feedback_id=feedback_id)
    if record is None:
        raise ValueError("Feedback not found")
    return BullpenRunAuditFeedbackDetail(
        **_feedback_summary_to_schema(record).model_dump(),
        report_json=dict(record.report_json or {}),
        subcalls=[
            BullpenRunAuditFeedbackSubcall(
                id=subcall.id,
                chunk_index=subcall.chunk_index,
                section_keys=list(subcall.section_keys_json or []),
                status=subcall.status,
                provider=subcall.provider,
                model=subcall.model,
                prompt_hash=subcall.prompt_hash,
                parsed_output=dict(subcall.parsed_output_json or {}) if subcall.parsed_output_json else None,
                tokens_in=subcall.tokens_in,
                tokens_out=subcall.tokens_out,
                estimated_cost=subcall.estimated_cost,
                latency_seconds=subcall.latency_seconds,
                coverage_pct=subcall.coverage_pct,
                error_message=subcall.error_message,
                created_at=isoformat(subcall.created_at) or "",
                updated_at=isoformat(subcall.updated_at) or "",
            )
            for subcall in record.subcalls
        ],
    )
