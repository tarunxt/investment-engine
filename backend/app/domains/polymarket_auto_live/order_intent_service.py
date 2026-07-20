from __future__ import annotations

import hashlib
import json
import os
import traceback
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Iterable, Sequence

from sqlalchemy import and_, func, or_, select
from celery import current_app
from sqlalchemy.orm import Session, selectinload

from app.core.logging import get_logger
from app.domains.polymarket import bullpen as bullpen_module
from app.domains.polymarket.bullpen import (
    BullpenBalanceReader,
    BullpenLiveExecutor,
    BullpenRedeemedTradesReader,
    BullpenTradeHistoryReader,
)
from app.domains.polymarket.runtime_broker import run_with_bullpen_runtime_cleanup
from app.domains.polymarket.redeem_coordinator import (
    REDEEM_ATTEMPT_ALREADY_REDEEMED,
    REDEEM_ATTEMPT_CONFIRMED,
    REDEEM_ATTEMPT_PENDING,
    REDEEM_ATTEMPT_RESOLVED_ZERO_PAYOUT,
    normalize_redeem_condition_ids,
    submit_scoped_redeem,
)
from app.domains.polymarket_auto_live.config import (
    auto_live_execution_v2_shadow_only,
)
from app.domains.polymarket_auto_live.console_profile import (
    read_console_wallet_positions,
    read_console_wallet_positions_snapshot,
)
from app.domains.polymarket_auto_live.execution import (
    refresh_balance,
    refresh_execution_quote,
    refresh_live_controls,
)
from app.domains.polymarket_auto_live.models import (
    PolymarketAutoLiveCapitalReservationRecord,
    PolymarketAutoLiveDecisionRecord,
    PolymarketAutoLiveOrderAttemptRecord,
    PolymarketAutoLiveOrderIntentRecord,
    PolymarketAutoLiveRunRecord,
    PolymarketAutoLiveStateRecord,
)
from app.domains.polymarket_auto_live.order_intents import (
    AutoLiveExecutorError,
    INTENT_PENDING_CONFIRMATION_STATUSES,
    INTENT_READY_STATUSES,
    INTENT_RETRYABLE_STATUSES,
    INTENT_TERMINAL_FAILURE_STATUSES,
    INTENT_TERMINAL_SUCCESS_STATUSES,
    TRANSIENT_ERROR_CODES,
    average_confirmation_seconds,
    build_order_funnel,
    build_order_plan_from_intent,
    classify_executor_error,
    compute_next_retry_at,
    derive_run_status_from_intents,
    intent_status_to_order_plan_status,
    oldest_pending_age_seconds,
    parse_datetime,
    sanitize_json_payload,
    sanitize_message,
    utc_now,
    utc_now_iso,
)
from app.domains.polymarket_auto_live.rpc_retry import (
    compute_rpc_retry_delay_seconds,
    extract_retry_after_seconds,
    retry_budget_allows,
)
from app.domains.polymarket_auto_live.stage3_slots import classify_economic_slots
from app.domains.polymarket_auto_live.repository import (
    apply_decision_to_record,
    apply_run_to_record,
    apply_state_to_record,
    record_to_decision,
    record_to_run,
    record_to_state,
)
from app.domains.polymarket_auto_live.run_recovery import (
    mark_interrupted_run_for_restart,
)
from app.domains.polymarket_auto_live.schemas import (
    BullpenAutoLiveDecision,
    BullpenAutoLiveCapitalReservation,
    BullpenAutoLiveOrderAttempt,
    BullpenAutoLiveOrderFunnel,
    BullpenAutoLiveOrderIntent,
    BullpenAutoLiveOrderPlan,
    BullpenAutoLiveRun,
    BullpenAutoLiveRunOrdersResponse,
)
from app.infrastructure.database.sync_session import SyncSessionLocal
from app.infrastructure.messaging.task_registry import (
    get_registered_auto_live_run_task_id_sync,
)


STAGE3_ORDER_INTENT_IDEMPOTENCY_KEY_FORMAT = "auto-live:v2"
STAGE3_ORDER_INTENT_IDEMPOTENCY_KEY_MAX_LENGTH = 128

logger = get_logger("app.domains.polymarket_auto_live.order_intent_service")

_EXECUTABLE_STATUSES = frozenset(
    {"PLANNED", "READY", "RETRY_WAIT", "WAITING_FOR_COLLATERAL", "WAITING_FOR_EXIT"}
)
_RECONCILABLE_STATUSES = frozenset(
    {"SUBMITTED", "CONFIRMING", "PARTIALLY_FILLED", "SETTLEMENT_PENDING", "SUBMITTING"}
)


@dataclass(frozen=True)
class PreparedIntentSubmission:
    intent_id: str
    user_id: int
    action: str
    side: str | None
    market_id: str
    slug: str | None
    condition_ids: list[str]
    order_usd: float | None
    shares: float | None
    limit_price_cents: float | None
    available_balance_usd: float | None
    provider_attempts: list[tuple[str, dict[str, str]]]
    detail: str


@dataclass(frozen=True)
class IntentSubmissionResult:
    status: str
    detail: str
    retryable: bool
    current_order_usd: float | None = None
    current_shares: float | None = None
    current_limit_price_cents: float | None = None
    remote_order_id: str | None = None
    remote_transaction_hash: str | None = None
    provider_alias: str | None = None
    raw_response: dict[str, object] | None = None
    last_error_code: str | None = None
    next_attempt_at: datetime | None = None
    retry_after_seconds: int | None = None
    filled_shares: float | None = None
    remaining_shares: float | None = None
    average_fill_price_cents: float | None = None


def _isoformat(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC).isoformat()
    return value.astimezone(UTC).isoformat()


def _safe_float(value: object) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str) and value.strip():
        try:
            return float(value)
        except ValueError:
            return None
    return None


def _extract_remote_refs(payload: dict[str, object]) -> tuple[str | None, str | None]:
    remote_order_id = None
    remote_transaction_hash = None
    for key in ("orderId", "order_id", "id", "remote_order_id"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            remote_order_id = value.strip()
            break
    for key in ("transactionHash", "txHash", "hash", "remote_transaction_hash"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            remote_transaction_hash = value.strip()
            break
    return remote_order_id, remote_transaction_hash


def _parse_response_payload(raw_response: str | None) -> dict[str, object]:
    if not raw_response:
        return {}
    try:
        parsed = json.loads(raw_response)
    except json.JSONDecodeError:
        return {"message": sanitize_message(raw_response) or ""}
    if isinstance(parsed, dict):
        return sanitize_json_payload(parsed)
    return {"data": parsed}


def _intent_attempt_to_schema(record: PolymarketAutoLiveOrderAttemptRecord) -> BullpenAutoLiveOrderAttempt:
    return BullpenAutoLiveOrderAttempt(
        id=record.id,
        intent_id=record.intent_id,
        attempt_number=record.attempt_number,
        worker_task_id=record.worker_task_id,
        rpc_provider=record.rpc_provider,
        executor_path=record.executor_path,
        started_at=_isoformat(record.started_at) or utc_now_iso(),
        completed_at=_isoformat(record.completed_at),
        result_status=record.result_status,
        error_code=record.error_code,
        error_message=record.error_message,
        retry_after_seconds=record.retry_after_seconds,
        remote_order_id=record.remote_order_id,
        remote_transaction_hash=record.remote_transaction_hash,
        sanitized_request_json=dict(record.sanitized_request_json or {}),
        sanitized_response_json=dict(record.sanitized_response_json or {}),
        reconciliation_json=dict(record.reconciliation_json or {}),
    )


def _reservation_to_schema(
    record: PolymarketAutoLiveCapitalReservationRecord,
) -> BullpenAutoLiveCapitalReservation:
    return BullpenAutoLiveCapitalReservation(
        id=record.id,
        user_id=record.user_id,
        order_intent_id=record.order_intent_id,
        amount_usd=record.amount_usd,
        status=record.status,  # type: ignore[arg-type]
        created_at=_isoformat(record.created_at) or utc_now_iso(),
        updated_at=_isoformat(record.updated_at) or utc_now_iso(),
        released_at=_isoformat(record.released_at),
    )


def _intent_to_schema(record: PolymarketAutoLiveOrderIntentRecord) -> BullpenAutoLiveOrderIntent:
    return BullpenAutoLiveOrderIntent(
        id=record.id,
        user_id=record.user_id,
        run_id=record.run_id,
        decision_id=record.decision_id,
        dependency_group=record.dependency_group,
        action=record.action,  # type: ignore[arg-type]
        market_id=record.market_id,
        slug=record.slug,
        condition_id=record.condition_id,
        side=record.side,  # type: ignore[arg-type]
        requested_order_usd=record.requested_order_usd,
        requested_shares=record.requested_shares,
        requested_limit_price_cents=record.requested_limit_price_cents,
        current_order_usd=record.current_order_usd,
        current_shares=record.current_shares,
        current_limit_price_cents=record.current_limit_price_cents,
        max_slippage_cents=record.max_slippage_cents,
        status=record.status,  # type: ignore[arg-type]
        error_class=record.error_class,
        last_error_code=record.last_error_code,
        last_error_message=record.last_error_message,
        retryable=record.retryable,
        task_id=record.execution_metadata_json.get("last_dispatch_task_id"),
        queue=record.execution_metadata_json.get("last_dispatch_queue") or record.execution_metadata_json.get("required_queue"),
        worker=record.execution_metadata_json.get("last_dispatch_worker"),
        last_dispatch_at=record.execution_metadata_json.get("last_dispatch_at"),
        current_blockage=record.execution_metadata_json.get("current_blockage") or record.last_error_message,
        actionable_resolution=record.execution_metadata_json.get("how_to_resolve"),
        deployed_commit_sha=os.getenv("GIT_SHA") or os.getenv("COMMIT_SHA") or os.getenv("RENDER_GIT_COMMIT"),
        attempt_count=record.attempt_count,
        max_attempts=record.max_attempts,
        next_attempt_at=_isoformat(record.next_attempt_at),
        priority=record.priority,
        remote_order_id=record.remote_order_id,
        remote_transaction_hash=record.remote_transaction_hash,
        idempotency_key=record.idempotency_key,
        reserved_cash_usd=record.reserved_cash_usd,
        expected_release_usd=record.expected_release_usd,
        confirmed_release_usd=record.confirmed_release_usd,
        filled_shares=record.filled_shares,
        remaining_shares=record.remaining_shares,
        average_fill_price_cents=record.average_fill_price_cents,
        dependency_metadata_json=dict(record.dependency_metadata_json or {}),
        execution_metadata_json=dict(record.execution_metadata_json or {}),
        version=record.version,
        created_at=_isoformat(record.created_at) or utc_now_iso(),
        updated_at=_isoformat(record.updated_at) or utc_now_iso(),
        first_submitted_at=_isoformat(record.first_submitted_at),
        last_submitted_at=_isoformat(record.last_submitted_at),
        confirmed_at=_isoformat(record.confirmed_at),
        terminal_at=_isoformat(record.terminal_at),
        attempts=[_intent_attempt_to_schema(item) for item in record.attempts],
        reservations=[_reservation_to_schema(item) for item in record.reservations],
    )


def _provider_candidates() -> list[tuple[str, str]]:
    raw_value = (
        os.getenv("POLYGON_RPC_URLS")
        or os.getenv("POLYMARKET_POLYGON_RPC_URLS")
        or ""
    )
    endpoints = [item.strip() for item in raw_value.split(",") if item.strip()]
    if not endpoints:
        return [("default", "")]
    return [(f"rpc-{index + 1}", endpoint) for index, endpoint in enumerate(endpoints)]


def _provider_env(endpoint: str) -> dict[str, str]:
    if not endpoint:
        return {}
    return {"POLYMARKET_POLYGON_RPC_URLS": endpoint}


def _intent_priority(action: str) -> int:
    if action == "redeem":
        return 5
    if action == "sell":
        return 10
    return 100


def _expected_release_usd(order_plan: BullpenAutoLiveOrderPlan) -> float:
    if order_plan.action == "buy":
        return 0.0
    if order_plan.action == "redeem":
        return round(order_plan.order_size_usd, 2)
    if order_plan.shares > 0:
        return round((order_plan.shares * order_plan.limit_price_cents) / 100, 2)
    return round(order_plan.order_size_usd, 2)


def _next_confirmation_attempt_at(intent: BullpenAutoLiveOrderIntent) -> datetime:
    submitted_at = parse_datetime(intent.first_submitted_at or intent.last_submitted_at)
    now = utc_now()
    if submitted_at is None:
        return now + timedelta(seconds=3)
    age_seconds = max(0.0, (now - submitted_at).total_seconds())
    if age_seconds <= 30:
        return now + timedelta(seconds=3)
    if age_seconds <= 5 * 60:
        return now + timedelta(seconds=15)
    return now + timedelta(minutes=1)


def _summary_text(run_status: str, funnel: BullpenAutoLiveOrderFunnel) -> str:
    if run_status == "confirming":
        return (
            f"Stage 3 queued {funnel.planned} durable order intent"
            f"{'s' if funnel.planned != 1 else ''}; "
            f"{funnel.confirming} still need confirmation."
        )
    if run_status == "partial_success":
        return (
            f"Stage 3 confirmed {funnel.confirmed + funnel.filled} of {funnel.planned} "
            "durable order intents, but some finished deferred or failed."
        )
    if run_status == "failed":
        return (
            f"Stage 3 did not confirm any durable order intents and recorded "
            f"{funnel.permanently_failed + funnel.deferred + funnel.cancelled} failures."
        )
    return (
        f"Stage 3 completed with {funnel.confirmed + funnel.filled} confirmed or filled "
        f"orders out of {funnel.planned} planned intents."
    )


def _provider_error_counts(intents: Sequence[BullpenAutoLiveOrderIntent]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for intent in intents:
        alias = intent.execution_metadata_json.get("provider_alias")
        code = intent.last_error_code
        if not alias or not code:
            continue
        key = f"{alias}:{code}"
        counts[key] = counts.get(key, 0) + 1
    return counts


def _action_funnels(intents: Sequence[BullpenAutoLiveOrderIntent]) -> dict[str, BullpenAutoLiveOrderFunnel]:
    return {
        action: build_order_funnel([intent for intent in intents if intent.action == action])
        for action in ("buy", "sell", "redeem")
    }


def _retry_counts(intents: Sequence[BullpenAutoLiveOrderIntent]) -> dict[str, int]:
    return {
        intent.id: intent.attempt_count
        for intent in intents
        if intent.attempt_count > 0
    }


def _base_order_plan_for(decision: BullpenAutoLiveDecision) -> BullpenAutoLiveOrderPlan | None:
    return decision.order_plan


def build_stage3_order_intent_idempotency_key(
    *,
    run_id: str,
    decision_id: str,
    order_plan_id: str,
) -> str:
    """Build a stable Stage 3 identity that fits the persisted 128-char column."""

    identity = json.dumps(
        [str(run_id), str(decision_id), str(order_plan_id)],
        ensure_ascii=True,
        separators=(",", ":"),
    ).encode("utf-8")
    digest = hashlib.sha256(identity).hexdigest()
    key = f"{STAGE3_ORDER_INTENT_IDEMPOTENCY_KEY_FORMAT}:{digest}"
    if len(key) > STAGE3_ORDER_INTENT_IDEMPOTENCY_KEY_MAX_LENGTH:
        raise ValueError("Stage 3 order-intent idempotency key exceeds storage limit")
    return key


def stage3_execution_market_reference(*, slug: str | None, market_id: str) -> str:
    """Prefer the Bullpen CLI slug while retaining legacy market references."""

    normalized_slug = (slug or "").strip()
    return normalized_slug or market_id


def _stage3_rpc_policy(run: BullpenAutoLiveRun) -> dict[str, float | int]:
    snapshot = run.audit_metadata.get("settings_snapshot")
    snapshot = snapshot if isinstance(snapshot, dict) else {}

    def number(name: str, default: float) -> float:
        value = snapshot.get(name, default)
        try:
            return max(0.0, float(value))
        except (TypeError, ValueError):
            return default

    return {
        "attempts": int(number("stage3_rpc_retry_attempts", 3)),
        "initial_delay_seconds": number("stage3_rpc_retry_initial_delay_seconds", 1),
        "max_delay_seconds": number("stage3_rpc_retry_max_delay_seconds", 30),
        "max_total_wait_seconds": number("stage3_rpc_retry_max_total_wait_seconds", 120),
    }


def _condition_id_for_decision(decision: BullpenAutoLiveDecision) -> str | None:
    for stage in reversed(decision.stage_results):
        value = stage.outputs.get("condition_id")
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _intent_has_persisted_submission_reference(intent: object) -> bool:
    """Return true when a retry could duplicate an already accepted write."""

    return any(
        bool(getattr(intent, field_name, None))
        for field_name in (
            "remote_order_id",
            "remote_transaction_hash",
            "first_submitted_at",
            "last_submitted_at",
        )
    )


def _assert_intent_has_no_persisted_submission_reference(intent: object) -> None:
    if not _intent_has_persisted_submission_reference(intent):
        return
    raise ValueError(
        "This order has a persisted order/submission reference and must be "
        "reconciled instead of retried; retrying could create a duplicate order."
    )


def _auth_recovery_allows_operator_resume(auth_recovery: object) -> bool:
    return isinstance(auth_recovery, dict) and bool(
        auth_recovery.get("operator_resume_at")
    )


def _run_recovery_block_reason(
    session: Session,
    *,
    run_id: str,
) -> str | None:
    run_record = session.get(PolymarketAutoLiveRunRecord, run_id)
    if run_record is None:
        return "The saved Auto-Live run no longer exists."
    run = record_to_run(run_record)
    stage3_recovery = run.audit_metadata.get("stage3_recovery")
    if (
        isinstance(stage3_recovery, dict)
        and stage3_recovery.get("required")
        and not stage3_recovery.get("resolved_at")
    ):
        return (
            "Stage 3 restart recovery requires an explicit operator retry; "
            "automatic submission is disabled."
        )
    auth_recovery = run.audit_metadata.get("auth_recovery")
    if (
        run.status == "failed"
        and isinstance(auth_recovery, dict)
        and auth_recovery.get("historical_error_stale")
        and not _auth_recovery_allows_operator_resume(auth_recovery)
    ):
        return (
            "The historical authentication failure was recovered and this old "
            "run was closed; start a new run instead of submitting its orders."
        )
    return None


def _persisted_stage3_counts(
    intents: Sequence[BullpenAutoLiveOrderIntent],
) -> dict[str, object]:
    def counts_for(actions: set[str]) -> dict[str, int]:
        selected = [intent for intent in intents if intent.action in actions]
        planned = len(selected)
        submitted = sum(
            1 for intent in selected if _intent_has_persisted_submission_reference(intent)
        )
        processed = sum(
            1
            for intent in selected
            if (
                intent.attempt_count > 0
                or (
                    intent.status
                    not in {"PLANNED", "READY", "RETRY_WAIT", "WAITING_FOR_EXIT"}
                    and not (
                        intent.status == "DEFERRED"
                        and intent.execution_metadata_json.get("recovery_required")
                    )
                )
                or _intent_has_persisted_submission_reference(intent)
            )
        )
        processed = min(planned, max(processed, submitted))
        submitted = min(processed, submitted)
        return {
            "planned": planned,
            "processed": processed,
            "submitted": submitted,
        }

    sell = counts_for({"sell", "redeem"})
    redeem = counts_for({"redeem"})
    buy = counts_for({"buy"})
    total = {
        key: int(sell[key]) + int(buy[key])
        for key in ("planned", "processed", "submitted")
    }
    return {
        "source": "persisted_order_intents",
        "total": total,
        "sell": sell,
        "redeem": redeem,
        "buy": buy,
    }


def _persisted_execution_step(
    *,
    key: str,
    label: str,
    step_number: int,
    counts: dict[str, int],
    recovery_required: bool,
) -> dict[str, object]:
    planned = counts["planned"]
    processed = counts["processed"]
    if recovery_required:
        status = "blocked"
        detail = (
            "Worker/service restart interrupted Stage 3. Operator recovery is "
            "required; no order was automatically resubmitted."
        )
    elif planned == 0 or processed >= planned:
        status = "completed"
        detail = (
            "No persisted orders were planned for this step."
            if planned == 0
            else "Persisted execution records confirm this step finished processing."
        )
    else:
        status = "running"
        detail = "Persisted execution records show this step is still processing."
    return {
        "key": key,
        "step_number": step_number,
        "step_total": 2,
        "label": label,
        "status": status,
        "detail": detail,
        "planned_orders": planned,
        "processed_orders": processed,
        "submitted_orders": counts["submitted"],
    }


def _dependency_exit_market_id(dependency_group: str | None) -> str | None:
    if not dependency_group or ":" not in dependency_group:
        return None
    candidate = dependency_group.rsplit(":", 1)[-1].strip()
    return candidate or None


def _update_invest_stage_outputs(run: BullpenAutoLiveRun, response: BullpenAutoLiveRunOrdersResponse) -> None:
    persisted_counts = _persisted_stage3_counts(response.orders)
    total_counts = persisted_counts["total"]
    sell_counts = persisted_counts["sell"]
    redeem_counts = persisted_counts["redeem"]
    buy_counts = persisted_counts["buy"]
    assert isinstance(total_counts, dict)
    assert isinstance(sell_counts, dict)
    assert isinstance(redeem_counts, dict)
    assert isinstance(buy_counts, dict)
    recovery = run.audit_metadata.get("stage3_recovery")
    recovery_required = bool(
        isinstance(recovery, dict)
        and recovery.get("required")
        and not recovery.get("resolved_at")
    )
    for stage in run.stage_results:
        if (
            stage.stage_number == 3
            or stage.outputs.get("workflow_stage_key") == "invest"
        ):
            stage.outputs = {
                **stage.outputs,
                "phase_status": "confirming"
                if run.status == "confirming"
                else "completed"
                if run.status in {"completed", "partial_success", "failed"}
                else stage.outputs.get("phase_status"),
                "orders_planned": response.order_funnel.planned,
                "orders_submitted": response.order_funnel.remotely_accepted,
                "orders_processed": total_counts["processed"],
                "sell_orders_planned": sell_counts["planned"],
                "sell_orders_processed": sell_counts["processed"],
                "sell_orders_submitted": sell_counts["submitted"],
                "redeem_planned": redeem_counts["planned"],
                "redeem_processed": redeem_counts["processed"],
                "redeem_submitted": redeem_counts["submitted"],
                "buy_orders_planned": buy_counts["planned"],
                "buy_orders_processed": buy_counts["processed"],
                "buy_orders_submitted": buy_counts["submitted"],
                "buy_queue_planned": buy_counts["planned"],
                "buy_queue_processed": buy_counts["processed"],
                "buy_queue_submitted": buy_counts["submitted"],
                "persisted_execution_counters": persisted_counts,
                "execution_steps": [
                    {
                        **_persisted_execution_step(
                            key="sell",
                            label="Event Exits",
                            step_number=1,
                            counts=sell_counts,
                            recovery_required=recovery_required,
                        ),
                        "redeem_planned_orders": redeem_counts["planned"],
                        "redeem_processed_orders": redeem_counts["processed"],
                        "redeem_submitted_orders": redeem_counts["submitted"],
                    },
                    _persisted_execution_step(
                        key="buy",
                        label="Invest planned orders",
                        step_number=2,
                        counts=buy_counts,
                        recovery_required=recovery_required,
                    ),
                ],
                "order_funnel": response.order_funnel.model_dump(mode="json"),
                "action_funnels": {
                    key: value.model_dump(mode="json")
                    for key, value in response.action_funnels.items()
                },
                "retry_counts": dict(response.retry_counts),
                "provider_error_counts": dict(response.provider_error_counts),
                "average_confirmation_seconds": response.average_confirmation_seconds,
                "oldest_pending_order_age_seconds": response.oldest_pending_order_age_seconds,
                "pending_confirmation_count": response.pending_confirmation_count,
                "partial_fill_count": response.partial_fill_count,
                "permanent_failure_count": response.permanent_failure_count,
                "transient_failure_count": response.transient_failure_count,
            }
            stage.reason = run.summary
            stage.completed_at = run.completed_at
            stage.status = (
                "fail"
                if run.status == "failed"
                else "warning"
                if run.status in {"confirming", "partial_success"}
                else "pass"
            )
            break


def _preserve_unresolved_stage3_recovery(run: BullpenAutoLiveRun) -> None:
    recovery = run.audit_metadata.get("stage3_recovery")
    if not isinstance(recovery, dict):
        return
    if not recovery.get("required") or recovery.get("resolved_at"):
        return
    interrupted_at = str(recovery.get("interrupted_at") or utc_now_iso())
    summary = (
        "Stage 3 was interrupted by a worker/service restart. Recovery is "
        "required; persisted submissions will be reconciled and no order was "
        "automatically resubmitted."
    )
    run.status = "failed"
    run.completed_at = interrupted_at
    run.error_message = summary
    run.summary = summary
    for stage in run.stage_results:
        if stage.stage_number != 3 and stage.outputs.get("workflow_stage_key") != "invest":
            continue
        stage.status = "fail"
        stage.completed_at = interrupted_at
        stage.reason = summary
        stage.outputs = {
            **stage.outputs,
            "phase_status": "aborted",
            "recovery_required": True,
            "automatic_resubmission": False,
            "interrupted_at": interrupted_at,
        }
        break


def _preserve_recovered_auth_error(run: BullpenAutoLiveRun) -> None:
    recovery = run.audit_metadata.get("auth_recovery")
    if (
        not isinstance(recovery, dict)
        or not recovery.get("historical_error_stale")
        or _auth_recovery_allows_operator_resume(recovery)
    ):
        return
    recovered_at = str(recovery.get("recovered_at") or utc_now_iso())
    summary = (
        "Earlier Bullpen authentication error recovered; the latest active "
        "doctor auth refresh is healthy. The interrupted run was closed and "
        "does not block a new run."
    )
    run.status = "failed"
    run.completed_at = recovered_at
    run.error_message = None
    run.summary = summary
    for stage in run.stage_results:
        if stage.stage_number != 3 and stage.outputs.get("workflow_stage_key") != "invest":
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


def _persist_stage3_reconciliation_diagnostics(
    session: Session,
    *,
    record: PolymarketAutoLiveOrderIntentRecord,
    result: IntentSubmissionResult,
) -> None:
    run_record = session.get(PolymarketAutoLiveRunRecord, record.run_id)
    if run_record is None:
        return
    run = record_to_run(run_record)
    snapshot = (
        result.raw_response.get("post_exit_snapshot")
        if isinstance(result.raw_response, dict)
        else None
    )
    terminal_entry = {
        "market_id": record.market_id,
        "order_id": record.remote_order_id,
        "status": result.status,
        "stage3_status": record.execution_metadata_json.get("stage3_status"),
    }
    for stage in run.stage_results:
        if stage.stage_number != 3 and stage.outputs.get("workflow_stage_key") != "invest":
            continue
        diagnostics = stage.outputs.get("stage3_slot_diagnostics")
        if not isinstance(diagnostics, dict):
            break
        if isinstance(snapshot, dict):
            diagnostics.update(
                {
                    "post_exit_snapshot_source": snapshot.get("source"),
                    "post_exit_snapshot_fetched_at": snapshot.get("fetched_at"),
                    "raw_position_count": snapshot.get("raw_position_count"),
                    "economically_active_position_count": snapshot.get(
                        "economically_active_position_count"
                    ),
                    "excluded_position_records": snapshot.get(
                        "excluded_position_records", []
                    ),
                    "deduplicated_occupied_market_ids": snapshot.get(
                        "deduplicated_occupied_market_ids", []
                    ),
                    "free_slots_after_refresh": snapshot.get("free_slots_after_refresh"),
                    "available_cash_after_refresh_usd": snapshot.get(
                        "available_cash_usd"
                    ),
                }
            )
        terminal_statuses = diagnostics.setdefault("exit_terminal_statuses", [])
        if isinstance(terminal_statuses, list):
            terminal_statuses[:] = [
                item
                for item in terminal_statuses
                if not isinstance(item, dict) or item.get("market_id") != record.market_id
            ]
            terminal_statuses.append(terminal_entry)
        reservations = diagnostics.get("replacement_reservations")
        if isinstance(reservations, list) and record.action in {"sell", "redeem"}:
            for reservation in reservations:
                if not isinstance(reservation, dict):
                    continue
                if reservation.get("exit_market_id") != record.market_id:
                    continue
                if result.status in INTENT_TERMINAL_SUCCESS_STATUSES and (
                    not isinstance(snapshot, dict)
                    or record.market_id
                    not in set(snapshot.get("deduplicated_occupied_market_ids") or [])
                ):
                    reservation["status"] = "confirmed"
                elif result.status in INTENT_TERMINAL_FAILURE_STATUSES:
                    reservation["status"] = "released"
                    reservation["reason"] = (
                        f"Exit ended in terminal status {result.status}; replacement reservation released."
                    )
                else:
                    reservation["status"] = "reserved"
                    reservation["reason"] = (
                        "Exit is submitted or partially filled; meaningful economic exposure still occupies the slot."
                    )
        break
    apply_run_to_record(run_record, run, user_id=record.user_id)


def persist_stage3_intent_diagnostics_sync(
    session: Session,
    *,
    record: PolymarketAutoLiveOrderIntentRecord,
) -> None:
    """Copy durable intent diagnostics into the saved run's Stage 3 payload."""

    run_record = session.get(PolymarketAutoLiveRunRecord, record.run_id)
    if run_record is None:
        return
    run = record_to_run(run_record)
    for stage in run.stage_results:
        if stage.stage_number != 3 and stage.outputs.get("workflow_stage_key") != "invest":
            continue
        diagnostics = stage.outputs.get("stage3_slot_diagnostics")
        if not isinstance(diagnostics, dict):
            break
        if record.action in {"sell", "redeem"}:
            intent_ids = diagnostics.setdefault("exit_intent_ids", [])
            if isinstance(intent_ids, list) and record.id not in intent_ids:
                intent_ids.append(record.id)
            retry_history = diagnostics.setdefault("exit_retry_history", [])
            if isinstance(retry_history, list):
                retry_history[:] = [
                    item
                    for item in retry_history
                    if not isinstance(item, dict) or item.get("intent_id") != record.id
                ]
                retry_history.append(
                    {
                        "intent_id": record.id,
                        "history": list(
                            record.execution_metadata_json.get(
                                "stage3_rpc_retry_history", []
                            )
                        ),
                    }
                )
            statuses = diagnostics.setdefault("exit_terminal_statuses", [])
            if isinstance(statuses, list):
                statuses[:] = [
                    item
                    for item in statuses
                    if not isinstance(item, dict)
                    or (
                        item.get("intent_id") != record.id
                        and item.get("market_id") != record.market_id
                    )
                ]
                statuses.append(
                    {
                        "intent_id": record.id,
                        "market_id": record.market_id,
                        "order_id": record.remote_order_id,
                        "status": record.status,
                        "stage3_status": record.execution_metadata_json.get(
                            "stage3_status"
                        ),
                    }
                )
            order_statuses = diagnostics.setdefault("exit_order_ids_and_statuses", [])
            if isinstance(order_statuses, list):
                order_statuses[:] = [
                    item
                    for item in order_statuses
                    if not isinstance(item, dict)
                    or (
                        item.get("intent_id") != record.id
                        and item.get("market_id") != record.market_id
                    )
                ]
                order_statuses.append(
                    {
                        "intent_id": record.id,
                        "market_id": record.market_id,
                        "order_id": record.remote_order_id,
                        "status": record.status,
                        "filled_shares": record.filled_shares,
                        "remaining_shares": record.remaining_shares,
                        "detail": record.last_error_message,
                    }
                )
        elif record.action == "buy":
            buy_ids = diagnostics.setdefault("planned_buy_ids", [])
            if isinstance(buy_ids, list) and record.id not in buy_ids:
                buy_ids.append(record.id)
            if record.status in {"SUBMITTED", "CONFIRMED", "FILLED"}:
                submitted_ids = diagnostics.setdefault("submitted_buy_ids", [])
                if isinstance(submitted_ids, list) and record.id not in submitted_ids:
                    submitted_ids.append(record.id)
        break
    apply_run_to_record(run_record, run, user_id=record.user_id)


def _persist_capacity_override_audit(
    session: Session,
    *,
    record: PolymarketAutoLiveOrderIntentRecord,
) -> None:
    if not record.execution_metadata_json.get("capacity_override_used"):
        return
    run_record = session.get(PolymarketAutoLiveRunRecord, record.run_id)
    if run_record is None:
        return
    run = record_to_run(run_record)
    audit = {
        "used": True,
        "run_id": record.run_id,
        "intent_id": record.id,
        "action": "stage3_capacity_override",
        "reason": "Explicit operator setting bypassed only the slot-capacity gate.",
        "recorded_at": utc_now_iso(),
    }
    run.payload = {
        **dict(run.payload or {}),
        "stage3_capacity_override_audit": audit,
    }
    for stage in run.stage_results:
        if stage.stage_number != 3 and stage.outputs.get("workflow_stage_key") != "invest":
            continue
        diagnostics = stage.outputs.get("stage3_slot_diagnostics")
        if isinstance(diagnostics, dict):
            diagnostics["operator_override_enabled"] = True
            diagnostics["operator_override_audit"] = audit
            diagnostics["final_block_bypass_reason"] = (
                "Explicit operator capacity override bypassed only the slot-capacity gate; all other guardrails remained active."
            )
        break
    apply_run_to_record(run_record, run, user_id=record.user_id)


def summarize_run_orders_sync(
    session: Session,
    *,
    user_id: int,
    run_id: str,
) -> BullpenAutoLiveRunOrdersResponse:
    run_record = session.get(PolymarketAutoLiveRunRecord, run_id)
    run = record_to_run(run_record) if run_record is not None else None
    intent_records = (
        session.execute(
            select(PolymarketAutoLiveOrderIntentRecord)
            .options(selectinload(PolymarketAutoLiveOrderIntentRecord.attempts))
            .options(selectinload(PolymarketAutoLiveOrderIntentRecord.reservations))
            .where(PolymarketAutoLiveOrderIntentRecord.user_id == user_id)
            .where(PolymarketAutoLiveOrderIntentRecord.run_id == run_id)
            .order_by(
                PolymarketAutoLiveOrderIntentRecord.priority.asc(),
                PolymarketAutoLiveOrderIntentRecord.created_at.asc(),
            )
        )
        .scalars()
        .all()
    )
    intents = [_intent_to_schema(record) for record in intent_records]
    funnel = build_order_funnel(intents)
    return BullpenAutoLiveRunOrdersResponse(
        run=run,
        orders=intents,
        order_funnel=funnel,
        action_funnels=_action_funnels(intents),
        retry_counts=_retry_counts(intents),
        provider_error_counts=_provider_error_counts(intents),
        average_confirmation_seconds=average_confirmation_seconds(intents),
        oldest_pending_order_age_seconds=oldest_pending_age_seconds(intents),
        pending_confirmation_count=sum(
            1 for intent in intents if intent.status in INTENT_PENDING_CONFIRMATION_STATUSES
        ),
        partial_fill_count=sum(1 for intent in intents if intent.status == "PARTIALLY_FILLED"),
        permanent_failure_count=sum(
            1 for intent in intents if intent.status == "FAILED_PERMANENT"
        ),
        transient_failure_count=sum(
            1
            for intent in intents
            if intent.last_error_code in TRANSIENT_ERROR_CODES
            and intent.status not in INTENT_TERMINAL_SUCCESS_STATUSES
        ),
    )


def sync_run_and_decisions_from_intents_sync(
    session: Session,
    *,
    user_id: int,
    run_id: str,
) -> BullpenAutoLiveRun | None:
    run_record = session.get(PolymarketAutoLiveRunRecord, run_id)
    if run_record is None or run_record.user_id != user_id:
        return None

    response = summarize_run_orders_sync(session, user_id=user_id, run_id=run_id)
    run = response.run or record_to_run(run_record)
    decisions = (
        session.execute(
            select(PolymarketAutoLiveDecisionRecord)
            .where(PolymarketAutoLiveDecisionRecord.user_id == user_id)
            .where(PolymarketAutoLiveDecisionRecord.run_id == run_id)
            .order_by(PolymarketAutoLiveDecisionRecord.created_at.asc())
        )
        .scalars()
        .all()
    )
    intents_by_decision_id = {
        intent.decision_id: intent
        for intent in response.orders
        if intent.decision_id
    }
    serialized_rows: list[dict[str, object]] = []
    for record in decisions:
        decision = record_to_decision(record)
        intent = intents_by_decision_id.get(decision.id)
        if intent and decision.order_plan is not None:
            decision.order_plan = build_order_plan_from_intent(decision.order_plan, intent)
        apply_decision_to_record(record, decision, user_id=user_id)
        serialized_rows.append(decision.model_dump(mode="json"))

    run.execution_version = "v2"
    run.order_funnel = response.order_funnel
    run.action_funnels = response.action_funnels
    run.retry_counts = response.retry_counts
    run.provider_error_counts = response.provider_error_counts
    run.average_confirmation_seconds = response.average_confirmation_seconds
    run.oldest_pending_order_age_seconds = response.oldest_pending_order_age_seconds
    run.pending_confirmation_count = response.pending_confirmation_count
    run.partial_fill_count = response.partial_fill_count
    run.permanent_failure_count = response.permanent_failure_count
    run.transient_failure_count = response.transient_failure_count
    run.order_intent_ids = [intent.id for intent in response.orders]
    run.orders_planned = response.order_funnel.planned
    run.orders_submitted = response.order_funnel.remotely_accepted
    run.status = derive_run_status_from_intents(response.orders)  # type: ignore[assignment]
    if run.status in {"completed", "partial_success", "failed"}:
        run.completed_at = run.completed_at or utc_now_iso()
    else:
        run.completed_at = None
    run.summary = _summary_text(run.status, response.order_funnel)
    _update_invest_stage_outputs(run, response)
    _preserve_unresolved_stage3_recovery(run)
    _preserve_recovered_auth_error(run)
    for stage in run.stage_results:
        if (
            stage.stage_number == 3
            or stage.outputs.get("workflow_stage_key") == "invest"
        ):
            stage.outputs["decision_rows"] = serialized_rows
            break

    apply_run_to_record(run_record, run, user_id=user_id)
    session.flush()
    return run


def create_or_refresh_run_order_intents_sync(
    session: Session,
    *,
    user_id: int,
    run: BullpenAutoLiveRun,
    decisions: Sequence[BullpenAutoLiveDecision],
) -> list[BullpenAutoLiveOrderIntent]:
    created_or_existing: list[PolymarketAutoLiveOrderIntentRecord] = []
    rpc_policy = _stage3_rpc_policy(run)
    for decision in decisions:
        order_plan = _base_order_plan_for(decision)
        if order_plan is None or order_plan.action not in {"buy", "sell", "redeem"}:
            continue
        if order_plan.dry_run:
            continue

        intent = session.get(PolymarketAutoLiveOrderIntentRecord, order_plan.id)
        if intent is None:
            initial_status = {
                "filled": "FILLED",
                "confirmed": "CONFIRMED",
                "already_redeemed": "CONFIRMED",
                "resolved_zero_payout": "CONFIRMED",
                "cancelled": "CANCELLED",
                "rejected": "REJECTED",
                "timed_out": "TIMED_OUT",
                "partially_filled": "PARTIALLY_FILLED",
                "settlement_pending": "SETTLEMENT_PENDING",
                # A CLI write can succeed without returning a remote order ID.
                # Preserve that submitted state and reconcile it from wallet or
                # trade history instead of ever issuing a duplicate write.
                "submitted": "SUBMITTED",
            }.get(order_plan.status, "READY")
            persisted_submission = initial_status not in {"READY", "RETRY_WAIT"}
            intent = PolymarketAutoLiveOrderIntentRecord(
                id=order_plan.id,
                user_id=user_id,
                run_id=run.id,
                decision_id=decision.id,
                dependency_group=order_plan.dependency_group,
                action=order_plan.action,
                market_id=decision.market_id,
                slug=decision.slug,
                condition_id=_condition_id_for_decision(decision),
                side=order_plan.side,
                requested_order_usd=order_plan.order_size_usd,
                requested_shares=order_plan.shares,
                requested_limit_price_cents=order_plan.limit_price_cents,
                current_order_usd=order_plan.order_size_usd,
                current_shares=order_plan.shares,
                current_limit_price_cents=order_plan.limit_price_cents,
                max_slippage_cents=order_plan.max_slippage_cents,
                status=initial_status,
                retryable=not persisted_submission,
                attempt_count=0,
                max_attempts=max(
                    1,
                    int(
                        rpc_policy["attempts"] + 1
                        if order_plan.action in {"sell", "redeem"}
                        else int(os.getenv("AUTO_LIVE_DEFAULT_MAX_ATTEMPTS", "4"))
                    ),
                ),
                next_attempt_at=utc_now() if not persisted_submission else None,
                priority=_intent_priority(order_plan.action),
                idempotency_key=build_stage3_order_intent_idempotency_key(
                    run_id=run.id,
                    decision_id=decision.id,
                    order_plan_id=order_plan.id,
                ),
                reserved_cash_usd=0,
                expected_release_usd=_expected_release_usd(order_plan),
                confirmed_release_usd=0,
                filled_shares=0,
                remaining_shares=order_plan.shares,
                average_fill_price_cents=None,
                dependency_metadata_json={
                    "state": "ready",
                    "source": "stage3_planning",
                },
                execution_metadata_json={
                    "idempotency_key_format": STAGE3_ORDER_INTENT_IDEMPOTENCY_KEY_FORMAT,
                    "reservation_state": None,
                    "run_status": run.status,
                    "stage3_status": (
                        "EXIT_SUBMITTED"
                        if order_plan.action in {"sell", "redeem"}
                        and persisted_submission
                        else "EXIT_NOT_SUBMITTED"
                        if order_plan.action in {"sell", "redeem"}
                        else order_plan.stage3_status or "BUY_READY"
                    ),
                    "stage3_rpc_retry_policy": rpc_policy,
                    "stage3_rpc_retry_total_wait_seconds": 0.0,
                    "stage3_rpc_retry_history": [],
                    "dependency_exit_market_id": _dependency_exit_market_id(
                        order_plan.dependency_group
                    ),
                    "stage3_capacity_policy": {
                        "slot_limit": 10,
                        "dust_threshold_usd": float(
                            run.audit_metadata.get("settings_snapshot", {}).get(
                                "bullpen_economic_dust_threshold_usd", 0.01
                            )
                        )
                        if isinstance(run.audit_metadata.get("settings_snapshot"), dict)
                        else 0.01,
                        "capacity_override": bool(
                            run.audit_metadata.get("settings_snapshot", {}).get(
                                "stage3_capacity_override", False
                            )
                        )
                        if isinstance(run.audit_metadata.get("settings_snapshot"), dict)
                        else False,
                    },
                },
                remote_order_id=order_plan.remote_order_id,
                remote_transaction_hash=order_plan.remote_transaction_hash,
                first_submitted_at=order_plan.executed_at if persisted_submission else None,
                last_submitted_at=order_plan.executed_at if persisted_submission else None,
                confirmed_at=order_plan.confirmed_at,
                terminal_at=order_plan.terminal_at
                if initial_status in INTENT_TERMINAL_SUCCESS_STATUSES | INTENT_TERMINAL_FAILURE_STATUSES
                else None,
                version=1,
            )
            session.add(intent)
        elif intent.status not in INTENT_TERMINAL_SUCCESS_STATUSES:
            intent.requested_order_usd = order_plan.order_size_usd
            intent.requested_shares = order_plan.shares
            intent.requested_limit_price_cents = order_plan.limit_price_cents
            if intent.status in {
                "PLANNED",
                "READY",
                "RETRY_WAIT",
                "WAITING_FOR_COLLATERAL",
                "WAITING_FOR_EXIT",
            }:
                intent.current_order_usd = order_plan.order_size_usd
                intent.current_shares = order_plan.shares
                intent.current_limit_price_cents = order_plan.limit_price_cents
                if intent.status == "PLANNED":
                    intent.status = "READY"
                intent.retryable = True
                if intent.status == "READY" and intent.next_attempt_at is None:
                    intent.next_attempt_at = utc_now()
            intent.dependency_group = order_plan.dependency_group
            existing_metadata = dict(intent.execution_metadata_json or {})
            existing_capacity_policy = existing_metadata.get("stage3_capacity_policy")
            settings_snapshot = run.audit_metadata.get("settings_snapshot")
            settings_snapshot = settings_snapshot if isinstance(settings_snapshot, dict) else {}
            intent.execution_metadata_json = {
                **existing_metadata,
                "stage3_status": (
                    "EXIT_NOT_SUBMITTED"
                    if order_plan.action in {"sell", "redeem"}
                    and not intent.remote_order_id
                    else "BUY_READY"
                    if order_plan.action == "buy"
                    else order_plan.stage3_status
                    or intent.execution_metadata_json.get("stage3_status")
                ),
                "stage3_rpc_retry_policy": rpc_policy,
                "dependency_exit_market_id": (
                    _dependency_exit_market_id(order_plan.dependency_group)
                    or existing_metadata.get("dependency_exit_market_id")
                ),
                "stage3_capacity_policy": {
                    "slot_limit": 10,
                    "dust_threshold_usd": float(
                        settings_snapshot.get("bullpen_economic_dust_threshold_usd", 0.01)
                        or 0.01
                    ),
                    "capacity_override": bool(
                        settings_snapshot.get("stage3_capacity_override", False)
                    ),
                }
                if not isinstance(existing_capacity_policy, dict)
                else existing_capacity_policy,
            }

        created_or_existing.append(intent)

    session.flush()
    return [_intent_to_schema(record) for record in created_or_existing]


def _active_reserved_cash(session: Session, *, user_id: int, exclude_intent_id: str | None = None) -> float:
    query = select(func.coalesce(func.sum(PolymarketAutoLiveCapitalReservationRecord.amount_usd), 0.0)).where(
        PolymarketAutoLiveCapitalReservationRecord.user_id == user_id
    ).where(PolymarketAutoLiveCapitalReservationRecord.status == "active")
    if exclude_intent_id:
        query = query.where(
            PolymarketAutoLiveCapitalReservationRecord.order_intent_id != exclude_intent_id
        )
    return float(session.execute(query).scalar() or 0.0)


def _upsert_reservation(
    session: Session,
    *,
    intent: PolymarketAutoLiveOrderIntentRecord,
    amount_usd: float,
    status: str,
) -> PolymarketAutoLiveCapitalReservationRecord:
    record = session.execute(
        select(PolymarketAutoLiveCapitalReservationRecord).where(
            PolymarketAutoLiveCapitalReservationRecord.order_intent_id == intent.id
        )
    ).scalar_one_or_none()
    if record is None:
        record = PolymarketAutoLiveCapitalReservationRecord(
            user_id=intent.user_id,
            order_intent_id=intent.id,
            amount_usd=amount_usd,
            status=status,
        )
        session.add(record)
    else:
        record.amount_usd = amount_usd
        record.status = status
        if status == "released":
            record.released_at = utc_now()
    intent.reserved_cash_usd = amount_usd if status == "active" else 0.0
    intent.execution_metadata_json = {
        **dict(intent.execution_metadata_json or {}),
        "reservation_state": status,
    }
    session.flush()
    return record


def _release_reservation(session: Session, intent: PolymarketAutoLiveOrderIntentRecord) -> None:
    _upsert_reservation(session, intent=intent, amount_usd=0.0, status="released")


def list_due_order_intent_ids_sync(
    session: Session,
    *,
    limit: int = 50,
    statuses: Sequence[str] | None = None,
    now: datetime | None = None,
) -> list[str]:
    due_at = now or utc_now()
    due_statuses = tuple(statuses or sorted(_EXECUTABLE_STATUSES | _RECONCILABLE_STATUSES))
    records = (
        session.execute(
            select(PolymarketAutoLiveOrderIntentRecord.id)
            .where(PolymarketAutoLiveOrderIntentRecord.status.in_(due_statuses))
            .where(
                or_(
                    PolymarketAutoLiveOrderIntentRecord.next_attempt_at.is_(None),
                    PolymarketAutoLiveOrderIntentRecord.next_attempt_at <= due_at,
                )
            )
            .order_by(
                PolymarketAutoLiveOrderIntentRecord.priority.asc(),
                PolymarketAutoLiveOrderIntentRecord.created_at.asc(),
            )
            .limit(limit)
        )
        .scalars()
        .all()
    )
    return [str(item) for item in records]


def watchdog_requeue_stale_order_intents_sync(
    session: Session,
    *,
    limit: int = 100,
    now: datetime | None = None,
) -> list[str]:
    """Promote or requeue stalled durable Stage 3 intents without duplicating writes.

    The root failure this protects is old/new Stage 3 plans persisted as
    ``PLANNED`` even though the beat dispatcher only scanned ``READY`` states.
    ``SUBMITTING`` is treated as ambiguous: if the worker did not finish within
    the stale window, reconciliation is dispatched instead of another write.
    """

    current = now or utc_now()
    submitting_stale_before = current - timedelta(
        seconds=max(60, int(os.getenv("AUTO_LIVE_SUBMITTING_STALE_SECONDS", "600")))
    )
    records = (
        session.execute(
            select(PolymarketAutoLiveOrderIntentRecord)
            .where(
                or_(
                    PolymarketAutoLiveOrderIntentRecord.status == "PLANNED",
                    and_(
                        PolymarketAutoLiveOrderIntentRecord.status.in_(
                            ("READY", "RETRY_WAIT", "WAITING_FOR_COLLATERAL", "WAITING_FOR_EXIT")
                        ),
                        or_(
                            PolymarketAutoLiveOrderIntentRecord.next_attempt_at.is_(None),
                            PolymarketAutoLiveOrderIntentRecord.next_attempt_at <= current,
                        ),
                    ),
                    and_(
                        PolymarketAutoLiveOrderIntentRecord.status == "SUBMITTING",
                        PolymarketAutoLiveOrderIntentRecord.updated_at <= submitting_stale_before,
                    ),
                )
            )
            .order_by(
                PolymarketAutoLiveOrderIntentRecord.priority.asc(),
                PolymarketAutoLiveOrderIntentRecord.created_at.asc(),
            )
            .limit(limit)
            .with_for_update(skip_locked=True)
        )
        .scalars()
        .all()
    )
    touched: list[str] = []
    for record in records:
        metadata = dict(record.execution_metadata_json or {})
        watchdog_events = list(metadata.get("watchdog_events") or [])
        event: dict[str, object] = {
            "at": _isoformat(current),
            "from_status": record.status,
            "next_attempt_at": _isoformat(record.next_attempt_at),
            "remote_order_id_present": bool(record.remote_order_id),
            "remote_transaction_hash_present": bool(record.remote_transaction_hash),
        }
        if record.status == "PLANNED":
            record.status = "READY"
            record.retryable = True
            record.next_attempt_at = current
            record.last_error_code = "PLANNED_NOT_PROMOTED"
            record.last_error_message = (
                "Durable Stage 3 intent was still PLANNED; watchdog atomically promoted it to READY for Celery dispatch."
            )
            event["resolution"] = "promoted_to_READY"
        elif record.status == "SUBMITTING":
            record.status = "CONFIRMING"
            record.retryable = True
            record.next_attempt_at = current
            record.last_error_code = "STALE_SUBMITTING_RECONCILE_REQUIRED"
            record.last_error_message = (
                "Worker submission timed out or was lost after entering SUBMITTING; reconciling remote state before any retry."
            )
            event["resolution"] = "moved_to_CONFIRMING_for_reconciliation"
        else:
            record.next_attempt_at = current
            record.retryable = True
            event["resolution"] = "requeued_due_intent"
        watchdog_events.append(event)
        metadata["watchdog_events"] = watchdog_events[-20:]
        metadata["current_blockage"] = record.last_error_message
        metadata["how_to_resolve"] = (
            "Use Reconcile for ambiguous submitted orders; otherwise Retry now after fixing auth, shares, quote, or RPC health."
        )
        if record.action in {"sell", "redeem"} and record.status in {"READY", "RETRY_WAIT"}:
            metadata["stage3_status"] = "EXIT_NOT_SUBMITTED"
        record.execution_metadata_json = metadata
        record.version += 1
        touched.append(record.id)
    session.flush()
    return touched



def recover_stale_planned_order_intents_sync(
    session: Session,
    *,
    run_id: str | None = None,
    limit: int = 50,
    stale_after_seconds: int = 10,
    now: datetime | None = None,
) -> list[str]:
    """Atomically promote due PLANNED Stage 3 intents for self-healing dispatch.

    This intentionally only moves not-yet-submitted rows to READY.  Rows that may
    have reached Bullpen (SUBMITTING/SUBMITTED/CONFIRMING) are left to the
    reconciliation path so a sell/redeem write is never duplicated.
    """

    current = now or utc_now()
    stale_before = current - timedelta(seconds=max(1, stale_after_seconds))
    query = (
        select(PolymarketAutoLiveOrderIntentRecord)
        .where(PolymarketAutoLiveOrderIntentRecord.status == "PLANNED")
        .where(PolymarketAutoLiveOrderIntentRecord.created_at <= stale_before)
        .order_by(
            PolymarketAutoLiveOrderIntentRecord.priority.asc(),
            PolymarketAutoLiveOrderIntentRecord.created_at.asc(),
        )
        .limit(limit)
        .with_for_update(skip_locked=True)
    )
    if run_id is not None:
        query = query.where(PolymarketAutoLiveOrderIntentRecord.run_id == run_id)
    records = session.execute(query).scalars().all()
    recovered: list[str] = []
    for record in records:
        metadata = dict(record.execution_metadata_json or {})
        events = list(metadata.get("dispatch_recovery_events") or [])
        event = {
            "at": _isoformat(current),
            "from_status": record.status,
            "queue": "ai",
            "reason": f"PLANNED intent older than {max(1, stale_after_seconds)} seconds recovered during backend poll/startup.",
            "resolution": "promoted_to_READY_for_execute_auto_live_order_intent",
        }
        events.append(event)
        metadata.update({
            "dispatch_recovery_events": events[-20:],
            "current_blockage": "Recovered from PLANNED: Celery Beat did not dispatch this intent before backend self-healing scanned it.",
            "how_to_resolve": "Ensure investor-celery-worker consumes the ai queue; backend polling/startup now re-enqueues READY intents automatically.",
            "required_queue": "ai",
            "last_dispatch_queue": "ai",
            "last_dispatch_task": "execute_auto_live_order_intent",
            "last_dispatch_at": _isoformat(current),
        })
        if record.action in {"sell", "redeem"}:
            metadata["stage3_status"] = "EXIT_NOT_SUBMITTED"
        record.status = "READY"
        record.retryable = True
        record.next_attempt_at = current
        record.last_error_code = "PLANNED_RECOVERED_AFTER_POLL"
        record.last_error_message = str(metadata["current_blockage"])
        record.execution_metadata_json = metadata
        record.version += 1
        recovered.append(record.id)
    session.flush()
    return recovered


def reconcile_interrupted_runs_on_startup_sync(
    session: Session,
    *,
    limit: int = 100,
    interrupted_at: datetime | None = None,
    stale_before: datetime | None = None,
) -> list[str]:
    """Abort abandoned runs and freeze unsubmitted Stage 3 writes on restart."""

    current = interrupted_at or utc_now()
    interrupted_at_iso = _isoformat(current) or utc_now_iso()
    active_task_ids = _active_celery_task_ids_sync()
    run_query = select(PolymarketAutoLiveRunRecord).where(
        PolymarketAutoLiveRunRecord.status.in_(("running", "confirming"))
    )
    if stale_before is not None:
        run_query = run_query.where(
            PolymarketAutoLiveRunRecord.updated_at <= stale_before
        )
    run_records = (
        session.execute(
            run_query.order_by(PolymarketAutoLiveRunRecord.started_at.asc())
            .limit(limit)
            .with_for_update(skip_locked=True)
        )
        .scalars()
        .all()
    )
    recovered_ids: list[str] = []
    for run_record in run_records:
        run = record_to_run(run_record)
        interrupted_run = mark_interrupted_run_for_restart(
            run,
            interrupted_at=interrupted_at_iso,
        )
        stage3_recovery = interrupted_run.audit_metadata.get("stage3_recovery")
        has_stage3_recovery = isinstance(stage3_recovery, dict) and bool(
            stage3_recovery.get("required")
        )
        intent_records: list[PolymarketAutoLiveOrderIntentRecord] = []
        if has_stage3_recovery:
            intent_records = (
                session.execute(
                    select(PolymarketAutoLiveOrderIntentRecord)
                    .where(PolymarketAutoLiveOrderIntentRecord.run_id == run_record.id)
                    .with_for_update(skip_locked=True)
                )
                .scalars()
                .all()
            )

        registered_run_task_id = get_registered_auto_live_run_task_id_sync(
            run_record.id
        )
        dispatched_intent_task_ids = {
            str(task_id)
            for intent in intent_records
            for task_id in [
                dict(intent.execution_metadata_json or {}).get(
                    "last_dispatch_task_id"
                )
            ]
            if isinstance(task_id, str) and task_id.strip()
        }
        if (
            registered_run_task_id in active_task_ids
            or active_task_ids.intersection(dispatched_intent_task_ids)
        ):
            logger.info(
                "Leaving Auto-Live run %s active because Celery still confirms "
                "its run/order task is executing on another worker.",
                run_record.id,
            )
            continue

        apply_run_to_record(run_record, interrupted_run, user_id=run_record.user_id)

        if has_stage3_recovery:
            for intent in intent_records:
                if intent.status in INTENT_TERMINAL_SUCCESS_STATUSES:
                    continue
                metadata = dict(intent.execution_metadata_json or {})
                metadata.update(
                    {
                        "recovery_required": True,
                        "automatic_resubmission": False,
                        "interrupted_at": interrupted_at_iso,
                        "current_blockage": (
                            "Stage 3 was interrupted by worker/service restart; "
                            "operator recovery is required."
                        ),
                        "how_to_resolve": (
                            "Reconcile persisted submissions first, then use the "
                            "explicit Stage 3 retry action for unsubmitted intents."
                        ),
                    }
                )
                if intent.status in _RECONCILABLE_STATUSES or (
                    _intent_has_persisted_submission_reference(intent)
                ):
                    intent.status = "CONFIRMING"
                    intent.retryable = True
                    intent.next_attempt_at = current
                    intent.last_error_code = (
                        "INTERRUPTED_SUBMISSION_RECONCILE_REQUIRED"
                    )
                    intent.last_error_message = (
                        "Restart interrupted an ambiguous or persisted submission; "
                        "reconciliation is required before any retry."
                    )
                else:
                    intent.status = "DEFERRED"
                    intent.retryable = True
                    intent.next_attempt_at = None
                    intent.last_error_code = "RESTART_RECOVERY_REQUIRED"
                    intent.last_error_message = (
                        "Restart interrupted this unsubmitted Stage 3 intent; it "
                        "was deferred and will not be automatically resubmitted."
                    )
                intent.execution_metadata_json = metadata
                intent.version += 1

            session.flush()
            sync_run_and_decisions_from_intents_sync(
                session,
                user_id=run_record.user_id,
                run_id=run_record.id,
            )

        state_record = session.get(PolymarketAutoLiveStateRecord, run_record.user_id)
        if state_record is not None:
            state = record_to_state(state_record)
            state.last_run_id = interrupted_run.id
            state.last_run_at = interrupted_at_iso
            state.last_action = interrupted_run.summary
            state.last_error = interrupted_run.summary
            apply_state_to_record(state_record, state)
        recovered_ids.append(run_record.id)

    session.flush()
    return recovered_ids


def _active_celery_task_ids_sync() -> set[str]:
    """Return task IDs actively executing across workers, if inspect responds."""

    try:
        payload = current_app.control.inspect(timeout=1.0).active() or {}
    except Exception:
        logger.warning(
            "Could not inspect active Celery tasks during Auto-Live restart recovery.",
            exc_info=True,
        )
        return set()

    task_ids: set[str] = set()

    def collect(value: object) -> None:
        if isinstance(value, dict):
            task_id = value.get("id")
            if isinstance(task_id, str) and task_id.strip():
                task_ids.add(task_id.strip())
            for nested in value.values():
                collect(nested)
        elif isinstance(value, list):
            for nested in value:
                collect(nested)

    collect(payload)
    return task_ids


def annotate_intent_dispatch_sync(
    session: Session,
    *,
    intent_id: str,
    task_id: str | None,
    queue: str = "ai",
    worker: str | None = None,
) -> None:
    record = session.get(PolymarketAutoLiveOrderIntentRecord, intent_id)
    if record is None:
        return
    metadata = dict(record.execution_metadata_json or {})
    metadata.update({
        "last_dispatch_at": utc_now_iso(),
        "last_dispatch_task_id": task_id,
        "last_dispatch_queue": queue,
        "last_dispatch_task": "execute_auto_live_order_intent",
        "required_queue": queue,
        "last_dispatch_worker": worker,
    })
    if record.status in {"PLANNED", "READY", "RETRY_WAIT", "WAITING_FOR_COLLATERAL", "WAITING_FOR_EXIT"}:
        metadata["current_blockage"] = "Dispatched to Celery; waiting for an ai worker to receive execute_auto_live_order_intent."
        metadata["how_to_resolve"] = "If this stays unchanged, restart investor-celery-worker with CELERY_WORKER_QUEUES including ai."
    record.execution_metadata_json = metadata
    session.flush()


def celery_ai_queue_consumer_diagnostics(timeout: float = 1.0) -> dict[str, object]:
    try:
        inspect = current_app.control.inspect(timeout=timeout)
        active_queues = inspect.active_queues() or {}
    except Exception as exc:
        return {"ok": False, "error": sanitize_message(str(exc)), "required_queue": "ai"}
    consumers = []
    for worker, queues in active_queues.items():
        names = [item.get("name") for item in queues if isinstance(item, dict)]
        if "ai" in names:
            consumers.append(worker)
    return {
        "ok": bool(consumers),
        "required_queue": "ai",
        "consuming_workers": consumers,
        "active_queues": active_queues,
        "error": None if consumers else "No Celery worker currently reports consuming the ai queue required by Stage 3 order intents.",
    }

def get_run_user_id_sync(session: Session, run_id: str) -> int | None:
    record = session.get(PolymarketAutoLiveRunRecord, run_id)
    return record.user_id if record is not None else None


def get_intent_user_id_sync(session: Session, intent_id: str) -> int | None:
    record = session.get(PolymarketAutoLiveOrderIntentRecord, intent_id)
    return record.user_id if record is not None else None


def retry_order_intent_sync(session: Session, *, user_id: int, intent_id: str) -> BullpenAutoLiveRunOrdersResponse:
    record = session.get(PolymarketAutoLiveOrderIntentRecord, intent_id)
    if record is None or record.user_id != user_id:
        raise ValueError("Order intent not found.")
    if record.status not in INTENT_RETRYABLE_STATUSES and record.status not in INTENT_TERMINAL_FAILURE_STATUSES:
        raise ValueError("This order is not in a retryable state.")
    _assert_intent_has_no_persisted_submission_reference(record)
    record.status = "READY"
    record.retryable = True
    record.next_attempt_at = utc_now()
    record.last_error_message = None
    record.execution_metadata_json = {
        **dict(record.execution_metadata_json or {}),
        "manual_retry_requested_at": utc_now_iso(),
    }
    session.flush()
    run = sync_run_and_decisions_from_intents_sync(
        session,
        user_id=user_id,
        run_id=record.run_id,
    )
    session.commit()
    return summarize_run_orders_sync(session, user_id=user_id, run_id=record.run_id)


def cancel_order_intent_sync(session: Session, *, user_id: int, intent_id: str) -> BullpenAutoLiveRunOrdersResponse:
    record = session.get(PolymarketAutoLiveOrderIntentRecord, intent_id)
    if record is None or record.user_id != user_id:
        raise ValueError("Order intent not found.")
    if record.status not in {"PLANNED", "READY", "RETRY_WAIT", "WAITING_FOR_COLLATERAL", "DEFERRED"}:
        raise ValueError("Only not-yet-submitted durable intents can be cancelled safely.")
    record.status = "CANCELLED"
    record.retryable = False
    record.terminal_at = utc_now()
    record.last_error_message = "Order cancelled by user before a remote submission was attempted."
    _release_reservation(session, record)
    sync_run_and_decisions_from_intents_sync(
        session,
        user_id=user_id,
        run_id=record.run_id,
    )
    session.commit()
    return summarize_run_orders_sync(session, user_id=user_id, run_id=record.run_id)


def _lock_intent_for_execution(session: Session, intent_id: str) -> PolymarketAutoLiveOrderIntentRecord | None:
    query = (
        select(PolymarketAutoLiveOrderIntentRecord)
        .where(PolymarketAutoLiveOrderIntentRecord.id == intent_id)
        .options(selectinload(PolymarketAutoLiveOrderIntentRecord.attempts))
        .with_for_update(skip_locked=True)
    )
    return session.execute(query).scalar_one_or_none()


def _defer_buy_until_exit(
    session: Session,
    *,
    record: PolymarketAutoLiveOrderIntentRecord,
    attempt: PolymarketAutoLiveOrderAttemptRecord,
) -> bool:
    """Keep a reserved replacement buy queued until its exit is terminal."""

    if record.action != "buy" or not record.dependency_group:
        return False
    sibling = session.execute(
        select(PolymarketAutoLiveOrderIntentRecord)
        .where(PolymarketAutoLiveOrderIntentRecord.run_id == record.run_id)
        .where(PolymarketAutoLiveOrderIntentRecord.dependency_group == record.dependency_group)
        .where(PolymarketAutoLiveOrderIntentRecord.action.in_(("sell", "redeem")))
        .where(PolymarketAutoLiveOrderIntentRecord.id != record.id)
        .order_by(PolymarketAutoLiveOrderIntentRecord.created_at.asc())
    ).scalars().first()
    if sibling is None or sibling.status in INTENT_TERMINAL_SUCCESS_STATUSES:
        return False
    record.status = "DEFERRED" if sibling.status == "FAILED_PERMANENT" else "WAITING_FOR_EXIT"
    record.retryable = record.status != "DEFERRED"
    record.next_attempt_at = utc_now() + timedelta(seconds=5) if record.retryable else None
    record.last_error_code = "SETTLEMENT_PENDING"
    record.last_error_message = (
        f"Replacement buy is reserved for exit {sibling.market_id}; exit status is {sibling.status}."
    )
    record.execution_metadata_json = {
        **dict(record.execution_metadata_json or {}),
        "stage3_status": "REPLACEMENT_SLOT_RESERVED",
        "dependency_exit_intent_id": sibling.id,
        "dependency_exit_market_id": sibling.market_id,
    }
    attempt.completed_at = utc_now()
    attempt.result_status = record.status
    attempt.error_code = "SETTLEMENT_PENDING"
    attempt.error_message = record.last_error_message
    return True


def _position_matches_intent(
    position: object,
    *,
    market_id: str | None,
    condition_id: str | None,
    side: str | None,
) -> bool:
    if side and str(getattr(position, "side", "")).upper() != side.upper():
        return False
    aliases = {
        str(value).strip().lower()
        for value in (
            getattr(position, "market_id", None),
            getattr(position, "condition_id", None),
        )
        if isinstance(value, str) and value.strip()
    }
    target_aliases = {
        str(value).strip().lower()
        for value in (market_id, condition_id)
        if isinstance(value, str) and value.strip()
    }
    return bool(aliases & target_aliases)


def _post_exit_snapshot_metadata(
    snapshot,
    *,
    dust_threshold_usd: float = 0.01,
) -> dict[str, object]:
    allocation = classify_economic_slots(
        snapshot.raw_positions or snapshot.positions,
        dust_threshold_usd=dust_threshold_usd,
    )
    payload: dict[str, object] = {
        "source": snapshot.source,
        "fetched_at": snapshot.fetched_at,
        "raw_position_count": snapshot.raw_position_count,
        "economically_active_position_count": allocation.economically_active_position_count,
        "excluded_position_records": allocation.excluded_position_records,
        "deduplicated_occupied_market_ids": allocation.deduplicated_occupied_market_ids,
        "free_slots_after_refresh": max(0, 10 - allocation.economically_active_position_count),
    }
    return payload


async def _prepare_intent_submission(intent: BullpenAutoLiveOrderIntent) -> PreparedIntentSubmission:
    live_controls = await refresh_live_controls(user_id=intent.user_id)
    if live_controls.emergency_stopped:
        raise AutoLiveExecutorError(
            code="EMERGENCY_STOP",
            message="Emergency stop is active.",
            retryable=False,
        )
    if not live_controls.unlocked:
        raise AutoLiveExecutorError(
            code="LIVE_LOCKED",
            message=live_controls.locked_reason or "Live execution is locked.",
            retryable=True,
        )
    if not live_controls.doctor.ok:
        raise AutoLiveExecutorError(
            code="DOCTOR_READ_FAILED",
            message=live_controls.doctor.message or "Bullpen doctor failed.",
            retryable=True,
        )
    if intent.action == "buy" and live_controls.balance.status != "ready":
        raise AutoLiveExecutorError(
            code="BALANCE_UNAVAILABLE",
            message=live_controls.balance.message or "Bullpen balance is unavailable.",
            retryable=True,
        )

    order_usd = intent.current_order_usd or intent.requested_order_usd
    shares = intent.current_shares or intent.requested_shares
    limit_price_cents = intent.current_limit_price_cents or intent.requested_limit_price_cents
    if intent.action == "buy":
        capacity_policy = intent.execution_metadata_json.get("stage3_capacity_policy")
        capacity_policy = capacity_policy if isinstance(capacity_policy, dict) else {}
        dust_threshold = float(capacity_policy.get("dust_threshold_usd", 0.01) or 0.01)
        live_snapshot = await read_console_wallet_positions_snapshot(
            force_fresh=True,
            caller_source="auto-live-stage3-buy-pre-submit",
            max_age_seconds=0,
        )
        if live_snapshot.source != "live-cli":
            raise AutoLiveExecutorError(
                code="BALANCE_UNAVAILABLE",
                message="Stage 3 buy pre-submit rejected a non-live wallet snapshot; retry after a fresh live-cli refresh.",
                retryable=True,
            )
        exit_confirmed_at = parse_datetime(
            str(intent.dependency_metadata_json.get("exit_confirmed_at"))
            if intent.dependency_metadata_json.get("exit_confirmed_at")
            else None
        )
        snapshot_fetched_at = parse_datetime(live_snapshot.fetched_at)
        if exit_confirmed_at is not None and (
            snapshot_fetched_at is None or snapshot_fetched_at <= exit_confirmed_at
        ):
            raise AutoLiveExecutorError(
                code="BALANCE_UNAVAILABLE",
                message="Stage 3 buy pre-submit rejected a wallet snapshot fetched before the confirmed exit; retry after a newer live-cli snapshot.",
                retryable=True,
            )
        allocation = classify_economic_slots(
            live_snapshot.raw_positions or live_snapshot.positions,
            dust_threshold_usd=dust_threshold,
        )
        if any(
            _position_matches_intent(
                position,
                market_id=intent.market_id,
                condition_id=intent.condition_id,
                side=intent.side,
            )
            for position in allocation.active_positions
        ):
            raise AutoLiveExecutorError(
                code="PERMANENT_REJECTION",
                message="Stage 3 buy pre-submit found existing economic exposure in this market after the live refresh; duplicate exposure is not allowed.",
                retryable=False,
            )
        replacement_confirmed = intent.dependency_metadata_json.get("exit_confirmed_at")
        dependency_exit_market_id = intent.execution_metadata_json.get(
            "dependency_exit_market_id"
        )
        if replacement_confirmed and isinstance(dependency_exit_market_id, str):
            if any(
                _position_matches_intent(
                    position,
                    market_id=dependency_exit_market_id,
                    condition_id=None,
                    side=None,
                )
                for position in allocation.active_positions
            ):
                raise AutoLiveExecutorError(
                    code="CAPACITY_BLOCKED",
                    message=(
                        "Stage 3 confirmed the replacement exit, but the fresh live-cli snapshot "
                        f"still shows meaningful exposure in exit market {dependency_exit_market_id}; "
                        "the replacement slot remains occupied."
                    ),
                    retryable=True,
                )
        override_enabled = bool(capacity_policy.get("capacity_override", False))
        slot_limit = int(capacity_policy.get("slot_limit", 10) or 10)
        intent.execution_metadata_json = {
            **dict(intent.execution_metadata_json or {}),
            "capacity_override_used": bool(
                override_enabled
                and allocation.economically_active_position_count >= slot_limit
                and not replacement_confirmed
            ),
        }
        if (
            allocation.economically_active_position_count >= slot_limit
            and not replacement_confirmed
            and not override_enabled
        ):
            raise AutoLiveExecutorError(
                code="CAPACITY_BLOCKED",
                message=(
                    "Stage 3 buy pre-submit found genuine economic capacity at "
                    f"{allocation.economically_active_position_count}/{slot_limit}; "
                    "the saved buy remains blocked until an exit is confirmed or the audited operator override is enabled."
                ),
                retryable=False,
            )
        if not intent.slug or not intent.side:
            raise AutoLiveExecutorError(
                code="QUOTE_UNAVAILABLE",
                message="Buy intent is missing slug or side for quote validation.",
                retryable=False,
            )
        quote = await refresh_execution_quote(slug=intent.slug, side=intent.side)
        if quote.market is None or quote.current_price_cents is None:
            raise AutoLiveExecutorError(
                code="QUOTE_UNAVAILABLE",
                message="Bullpen could not refresh a current quote for this buy intent.",
                retryable=True,
            )
        limit_price_cents = min(
            limit_price_cents or quote.current_price_cents,
            quote.current_price_cents + intent.max_slippage_cents,
        )
        shares = round((order_usd or 0.0) / max(0.01, limit_price_cents / 100), 6)
    elif intent.action == "sell" and (shares is None or shares <= 0):
        raise AutoLiveExecutorError(
            code="NO_SHARES_AVAILABLE",
            message="Sell intent has no verified shares available to submit.",
            retryable=False,
        )
    condition_ids = normalize_redeem_condition_ids([intent.condition_id] if intent.condition_id else [])
    if intent.action == "redeem" and not condition_ids:
        raise AutoLiveExecutorError(
            code="CONDITION_ID_UNAVAILABLE",
            message="Redeem intent requires a verified condition ID.",
            retryable=False,
        )

    return PreparedIntentSubmission(
        intent_id=intent.id,
        user_id=intent.user_id,
        action=intent.action,
        side=intent.side,
        market_id=intent.market_id,
        slug=intent.slug,
        condition_ids=condition_ids,
        order_usd=order_usd,
        shares=shares,
        limit_price_cents=limit_price_cents,
        available_balance_usd=live_controls.balance.available_balance_usd,
        provider_attempts=[
            (alias, _provider_env(endpoint))
            for alias, endpoint in _provider_candidates()
        ],
        detail="Preflight checks passed for durable execution.",
    )


def _buy_balance_buffer_usd() -> float:
    try:
        return max(0.0, float(os.getenv("AUTO_LIVE_BUY_BALANCE_BUFFER_USD", "1.0")))
    except ValueError:
        return 1.0


def _reserve_buy_if_possible(
    session: Session,
    *,
    intent_id: str,
    available_balance_usd: float | None,
    order_usd: float | None,
) -> bool:
    intent = session.get(PolymarketAutoLiveOrderIntentRecord, intent_id)
    if intent is None:
        return False
    needed = max(0.0, float(order_usd or 0.0))
    if available_balance_usd is None or needed <= 0:
        return False
    already_reserved = _active_reserved_cash(
        session,
        user_id=intent.user_id,
        exclude_intent_id=intent.id,
    )
    if available_balance_usd - already_reserved - _buy_balance_buffer_usd() < needed:
        return False
    _upsert_reservation(session, intent=intent, amount_usd=needed, status="active")
    session.commit()
    return True


async def _submit_prepared_intent(
    prepared: PreparedIntentSubmission,
) -> IntentSubmissionResult:
    if auto_live_execution_v2_shadow_only():
        return IntentSubmissionResult(
            status="CONFIRMING",
            detail="AUTO_LIVE_EXECUTION_V2_SHADOW_ONLY is enabled, so the durable intent stayed in shadow confirmation mode without a remote write.",
            retryable=True,
            current_order_usd=prepared.order_usd,
            current_shares=prepared.shares,
            current_limit_price_cents=prepared.limit_price_cents,
            next_attempt_at=utc_now() + timedelta(seconds=3),
        )

    last_error: AutoLiveExecutorError | None = None
    executor = BullpenLiveExecutor()
    for alias, extra_env in prepared.provider_attempts:
        try:
            if prepared.action == "buy":
                response = await executor.buy_limit(
                    market_id=stage3_execution_market_reference(
                        slug=prepared.slug,
                        market_id=prepared.market_id,
                    ),
                    outcome="Yes" if prepared.side == "YES" else "No",
                    amount_usd=prepared.order_usd or 0.0,
                    max_price=max(0.01, (prepared.limit_price_cents or 1) / 100),
                    extra_env=extra_env,
                )
                payload = _parse_response_payload(response)
                remote_order_id, remote_transaction_hash = _extract_remote_refs(payload)
                return IntentSubmissionResult(
                    status="SUBMITTED",
                    detail="Bullpen buy order submitted successfully.",
                    retryable=True,
                    current_order_usd=prepared.order_usd,
                    current_shares=prepared.shares,
                    current_limit_price_cents=prepared.limit_price_cents,
                    remote_order_id=remote_order_id,
                    remote_transaction_hash=remote_transaction_hash,
                    provider_alias=alias,
                    raw_response=payload,
                    next_attempt_at=utc_now() + timedelta(seconds=3),
                )
            if prepared.action == "sell":
                response = await executor.sell_limit(
                    market_id=stage3_execution_market_reference(
                        slug=prepared.slug,
                        market_id=prepared.market_id,
                    ),
                    outcome="Yes" if prepared.side == "YES" else "No",
                    shares=prepared.shares or 0.0,
                    min_price=max(0.01, (prepared.limit_price_cents or 1) / 100),
                    extra_env=extra_env,
                )
                payload = _parse_response_payload(response)
                remote_order_id, remote_transaction_hash = _extract_remote_refs(payload)
                return IntentSubmissionResult(
                    status="SUBMITTED",
                    detail="Bullpen sell order submitted successfully.",
                    retryable=True,
                    current_shares=prepared.shares,
                    current_limit_price_cents=prepared.limit_price_cents,
                    remote_order_id=remote_order_id,
                    remote_transaction_hash=remote_transaction_hash,
                    provider_alias=alias,
                    raw_response=payload,
                    next_attempt_at=utc_now() + timedelta(seconds=3),
                )
            redeem_result = await submit_scoped_redeem(
                user_id=prepared.user_id,
                condition_ids=prepared.condition_ids,
                source="auto_live_execution_v2",
                executor=executor,
                read_wallet_positions=read_console_wallet_positions,
            )
            outcome = next(iter(redeem_result.outcomes), None)
            detail = outcome.detail if outcome is not None else "Redeem submission completed."
            if outcome and outcome.status in {
                REDEEM_ATTEMPT_CONFIRMED,
                REDEEM_ATTEMPT_ALREADY_REDEEMED,
                REDEEM_ATTEMPT_RESOLVED_ZERO_PAYOUT,
            }:
                return IntentSubmissionResult(
                    status="CONFIRMED",
                    detail=detail,
                    retryable=False,
                    provider_alias=alias,
                    raw_response={
                        "outcomes": [item.__dict__ for item in redeem_result.outcomes],
                        "claim_attempted": redeem_result.claim_attempted,
                    },
                )
            if outcome and outcome.status == REDEEM_ATTEMPT_PENDING:
                return IntentSubmissionResult(
                    status="SETTLEMENT_PENDING",
                    detail=detail,
                    retryable=True,
                    provider_alias=alias,
                    raw_response={
                        "outcomes": [item.__dict__ for item in redeem_result.outcomes],
                        "claim_attempted": redeem_result.claim_attempted,
                    },
                    next_attempt_at=utc_now() + timedelta(seconds=3),
                )
            return IntentSubmissionResult(
                status="SUBMITTED",
                detail=detail,
                retryable=True,
                provider_alias=alias,
                raw_response={
                    "outcomes": [item.__dict__ for item in redeem_result.outcomes],
                    "claim_attempted": redeem_result.claim_attempted,
                },
                next_attempt_at=utc_now() + timedelta(seconds=3),
            )
        except AutoLiveExecutorError as exc:
            last_error = exc
        except Exception as exc:
            last_error = classify_executor_error(
                exc,
                during_write=True,
                provider_alias=alias,
            )
        if last_error and last_error.code == "RPC_RATE_LIMITED":
            continue
        if last_error and not last_error.retryable:
            raise last_error
    if last_error is not None:
        raise last_error
    raise AutoLiveExecutorError(
        code="ORDER_WRITE_UNAVAILABLE",
        message="No RPC provider was available to submit this intent.",
        retryable=True,
    )


def _apply_executor_error(
    session: Session,
    *,
    record: PolymarketAutoLiveOrderIntentRecord,
    attempt: PolymarketAutoLiveOrderAttemptRecord,
    exc: AutoLiveExecutorError,
) -> None:
    """Persist one failed attempt, including the bounded Stage 3 RPC policy."""

    now = utc_now()
    metadata = dict(record.execution_metadata_json or {})
    record.last_error_code = exc.code
    record.last_error_message = sanitize_message(exc.message)
    record.error_class = "transient" if exc.retryable else "permanent"
    attempt.completed_at = now
    attempt.error_code = exc.code
    attempt.error_message = sanitize_message(exc.message)
    attempt.reconciliation_json = {
        **dict(attempt.reconciliation_json or {}),
        "retryable": exc.retryable,
        "ambiguous_submission": exc.ambiguous_submission,
        "root_cause": sanitize_message("".join(traceback.format_exception_only(type(exc), exc))),
        "next_step": (
            "reconcile_remote_state_before_retry"
            if exc.ambiguous_submission
            else "retry_with_backoff"
            if exc.retryable
            else "operator_fix_required"
        ),
    }
    if exc.retry_after_seconds is not None:
        attempt.retry_after_seconds = exc.retry_after_seconds

    if exc.code == "RPC_RATE_LIMITED":
        policy = metadata.get("stage3_rpc_retry_policy")
        policy = policy if isinstance(policy, dict) else {}
        try:
            attempts = max(0, int(policy.get("attempts", 3)))
            initial_delay = max(0.0, float(policy.get("initial_delay_seconds", 1)))
            max_delay = max(initial_delay, float(policy.get("max_delay_seconds", 30)))
            max_total = max(0.0, float(policy.get("max_total_wait_seconds", 120)))
        except (TypeError, ValueError):
            attempts, initial_delay, max_delay, max_total = 3, 1.0, 30.0, 120.0

        history = metadata.get("stage3_rpc_retry_history")
        history = list(history) if isinstance(history, list) else []
        prior_total = float(metadata.get("stage3_rpc_retry_total_wait_seconds", 0) or 0)
        retry_index = len(history)
        retry_count = retry_index + 1
        delay = compute_rpc_retry_delay_seconds(
            attempt_number=retry_count,
            initial_delay_seconds=initial_delay,
            max_delay_seconds=max_delay,
            retry_after_seconds=extract_retry_after_seconds(exc),
        )
        total_wait = prior_total + delay
        history.append(
            {
                "attempt": record.attempt_count,
                "retry_count": retry_count,
                "error": sanitize_message(exc.message),
                "retry_after_seconds": exc.retry_after_seconds,
                "delay_seconds": round(delay, 3),
                "recorded_at": _isoformat(now),
            }
        )
        metadata.update(
            {
                "stage3_rpc_retry_policy": {
                    "attempts": attempts,
                    "initial_delay_seconds": initial_delay,
                    "max_delay_seconds": max_delay,
                    "max_total_wait_seconds": max_total,
                },
                "stage3_rpc_retry_history": history,
                "stage3_rpc_retry_total_wait_seconds": round(total_wait, 3),
            }
        )
        if retry_budget_allows(
            retry_count=retry_index,
            total_wait_seconds=total_wait,
            attempts=attempts,
            max_total_wait_seconds=max_total,
        ):
            record.status = "RETRY_WAIT"
            record.retryable = True
            record.next_attempt_at = now + timedelta(seconds=delay)
            metadata["stage3_status"] = "EXIT_RPC_RETRYING"
            attempt.result_status = "RETRY_WAIT"
        else:
            record.status = "FAILED_PERMANENT"
            record.retryable = False
            record.next_attempt_at = None
            record.terminal_at = now
            record.error_class = "transient_retry_exhausted"
            record.last_error_message = (
                f"Bullpen RPC rate-limit retry budget exhausted after {retry_count} retries "
                f"and {total_wait:.1f}s total wait. {sanitize_message(exc.message) or 'No remote order was submitted.'}"
            )
            metadata["stage3_status"] = "EXIT_FAILED_PERMANENTLY"
            metadata["stage3_rpc_retry_exhausted"] = True
            attempt.result_status = "FAILED_PERMANENT"
        record.execution_metadata_json = metadata
        return

    record.retryable = exc.retryable
    if exc.ambiguous_submission:
        record.status = "CONFIRMING"
        record.next_attempt_at = compute_next_retry_at(
            code="AMBIGUOUS_SUBMISSION",
            attempt_count=record.attempt_count,
            retry_after_seconds=exc.retry_after_seconds,
        )
        attempt.result_status = "CONFIRMING"
    elif exc.retryable:
        record.status = (
            "WAITING_FOR_COLLATERAL"
            if exc.code == "INSUFFICIENT_COLLATERAL"
            else "RETRY_WAIT"
        )
        record.next_attempt_at = compute_next_retry_at(
            code=exc.code,
            attempt_count=record.attempt_count,
            retry_after_seconds=exc.retry_after_seconds,
        )
        attempt.result_status = record.status
    elif exc.code == "CONDITION_ID_UNAVAILABLE":
        record.status = "DEFERRED"
        record.terminal_at = now
        attempt.result_status = "DEFERRED"
    elif exc.code == "CAPACITY_BLOCKED":
        record.status = "DEFERRED"
        record.retryable = True
        record.next_attempt_at = None
        attempt.result_status = "DEFERRED"
        record.last_error_message = sanitize_message(exc.message)
    else:
        record.status = "FAILED_PERMANENT"
        record.terminal_at = now
        attempt.result_status = "FAILED_PERMANENT"

    if record.action in {"sell", "redeem"}:
        metadata["stage3_status"] = (
            "EXIT_RPC_RETRYING" if record.retryable else "EXIT_FAILED_PERMANENTLY"
        )
    elif exc.code == "CAPACITY_BLOCKED":
        metadata["stage3_status"] = "GENUINE_CAPACITY_BLOCK"
    else:
        metadata["stage3_status"] = "BUY_FAILED"
    record.execution_metadata_json = metadata


def execute_order_intent_sync(intent_id: str, *, worker_task_id: str | None = None) -> str | None:
    with SyncSessionLocal() as session:
        record = _lock_intent_for_execution(session, intent_id)
        if record is None:
            return None
        if record.status not in _EXECUTABLE_STATUSES:
            return record.status
        recovery_block_reason = _run_recovery_block_reason(
            session,
            run_id=record.run_id,
        )
        if recovery_block_reason is not None:
            record.status = "DEFERRED"
            record.retryable = True
            record.next_attempt_at = None
            record.last_error_code = "RUN_RECOVERY_REQUIRED"
            record.last_error_message = recovery_block_reason
            record.execution_metadata_json = {
                **dict(record.execution_metadata_json or {}),
                "recovery_required": True,
                "automatic_resubmission": False,
                "current_blockage": recovery_block_reason,
            }
            sync_run_and_decisions_from_intents_sync(
                session,
                user_id=record.user_id,
                run_id=record.run_id,
            )
            session.commit()
            return record.status
        if _intent_has_persisted_submission_reference(record):
            record.status = "CONFIRMING"
            record.retryable = True
            record.next_attempt_at = utc_now()
            record.last_error_code = "PERSISTED_SUBMISSION_RECONCILE_REQUIRED"
            record.last_error_message = (
                "Persisted order/submission reference found before retry; remote "
                "state must be reconciled and no duplicate write was issued."
            )
            record.execution_metadata_json = {
                **dict(record.execution_metadata_json or {}),
                "current_blockage": record.last_error_message,
                "how_to_resolve": "Reconcile the persisted remote order before any operator retry.",
                "duplicate_order_prevented_at": utc_now_iso(),
            }
            sync_run_and_decisions_from_intents_sync(
                session,
                user_id=record.user_id,
                run_id=record.run_id,
            )
            session.commit()
            return record.status
        now = utc_now()
        if record.next_attempt_at and record.next_attempt_at > now:
            return record.status
        record.status = "SUBMITTING"
        record.attempt_count += 1
        record.next_attempt_at = None
        record.version += 1
        attempt = PolymarketAutoLiveOrderAttemptRecord(
            intent_id=record.id,
            attempt_number=record.attempt_count,
            worker_task_id=worker_task_id,
            rpc_provider=None,
            executor_path="bullpen",
            started_at=now,
            result_status="SUBMITTING",
            sanitized_request_json={},
            sanitized_response_json={},
            reconciliation_json={},
        )
        record.execution_metadata_json = {
            **dict(record.execution_metadata_json or {}),
            "reservation_state": record.execution_metadata_json.get("reservation_state"),
            "last_worker_task_id": worker_task_id,
        }
        session.add(attempt)
        session.commit()
        intent = _intent_to_schema(record)

    with SyncSessionLocal() as session:
        record = session.get(PolymarketAutoLiveOrderIntentRecord, intent_id)
        attempt = session.execute(
            select(PolymarketAutoLiveOrderAttemptRecord)
            .where(PolymarketAutoLiveOrderAttemptRecord.intent_id == intent_id)
            .where(PolymarketAutoLiveOrderAttemptRecord.attempt_number == record.attempt_count)
        ).scalar_one() if record is not None else None
        if record is not None and attempt is not None and _defer_buy_until_exit(
            session, record=record, attempt=attempt
        ):
            sync_run_and_decisions_from_intents_sync(
                session, user_id=record.user_id, run_id=record.run_id
            )
            session.commit()
            return record.status

    try:
        prepared = run_with_bullpen_runtime_cleanup(
            _prepare_intent_submission(intent)
        )
    except AutoLiveExecutorError as exc:
        with SyncSessionLocal() as session:
            record = session.get(PolymarketAutoLiveOrderIntentRecord, intent_id)
            if record is None:
                return None
            attempt = session.execute(
                select(PolymarketAutoLiveOrderAttemptRecord)
                .where(PolymarketAutoLiveOrderAttemptRecord.intent_id == intent_id)
                .where(PolymarketAutoLiveOrderAttemptRecord.attempt_number == record.attempt_count)
            ).scalar_one()
            _apply_executor_error(session, record=record, attempt=attempt, exc=exc)
            sync_run_and_decisions_from_intents_sync(
                session,
                user_id=record.user_id,
                run_id=record.run_id,
            )
            session.commit()
            return record.status

    if prepared.action == "buy" and prepared.intent_id:
        with SyncSessionLocal() as session:
            record = session.get(PolymarketAutoLiveOrderIntentRecord, prepared.intent_id)
            if record is not None:
                # _prepare_intent_submission marked this only after all other
                # capacity and duplicate-exposure checks passed.
                record.execution_metadata_json = {
                    **dict(record.execution_metadata_json or {}),
                    **{
                        key: value
                        for key, value in intent.execution_metadata_json.items()
                        if key in {"capacity_override_used"}
                    },
                }
                _persist_capacity_override_audit(session, record=record)
                session.commit()

    if prepared.action == "buy":
        reserved = False
        with SyncSessionLocal() as session:
            reserved = _reserve_buy_if_possible(
                session,
                intent_id=intent_id,
                available_balance_usd=prepared.available_balance_usd,
                order_usd=prepared.order_usd,
            )
            if not reserved:
                record = session.get(PolymarketAutoLiveOrderIntentRecord, intent_id)
                if record is None:
                    return None
                attempt = session.execute(
                    select(PolymarketAutoLiveOrderAttemptRecord)
                    .where(PolymarketAutoLiveOrderAttemptRecord.intent_id == intent_id)
                    .where(PolymarketAutoLiveOrderAttemptRecord.attempt_number == record.attempt_count)
                ).scalar_one()
                record.status = "WAITING_FOR_COLLATERAL"
                record.retryable = True
                record.last_error_code = "INSUFFICIENT_COLLATERAL"
                record.last_error_message = (
                    "Buy intent is waiting for confirmed collateral after subtracting active reservations."
                )
                record.next_attempt_at = compute_next_retry_at(
                    code="INSUFFICIENT_COLLATERAL",
                    attempt_count=record.attempt_count,
                )
                attempt.completed_at = utc_now()
                attempt.result_status = record.status
                attempt.error_code = "INSUFFICIENT_COLLATERAL"
                attempt.error_message = record.last_error_message
                sync_run_and_decisions_from_intents_sync(
                    session,
                    user_id=record.user_id,
                    run_id=record.run_id,
                )
                session.commit()
                return record.status

    # A restart or auth-recovery close can land while preflight is running.
    # Re-read the durable intent immediately before the remote write so a task
    # that was already in flight cannot ignore the recovery marker.
    with SyncSessionLocal() as session:
        record = _lock_intent_for_execution(session, intent_id)
        if record is None:
            return None
        recovery_block_reason = _run_recovery_block_reason(
            session,
            run_id=record.run_id,
        )
        if record.status != "SUBMITTING" or recovery_block_reason is not None:
            attempt = session.execute(
                select(PolymarketAutoLiveOrderAttemptRecord)
                .where(PolymarketAutoLiveOrderAttemptRecord.intent_id == intent_id)
                .where(
                    PolymarketAutoLiveOrderAttemptRecord.attempt_number
                    == record.attempt_count
                )
            ).scalar_one_or_none()
            if recovery_block_reason is not None and record.status in (
                _EXECUTABLE_STATUSES | {"SUBMITTING"}
            ):
                record.status = "DEFERRED"
                record.retryable = True
                record.next_attempt_at = None
                record.last_error_code = "RUN_RECOVERY_REQUIRED"
                record.last_error_message = recovery_block_reason
                record.execution_metadata_json = {
                    **dict(record.execution_metadata_json or {}),
                    "recovery_required": True,
                    "automatic_resubmission": False,
                    "current_blockage": recovery_block_reason,
                    "remote_write_prevented_at": utc_now_iso(),
                }
            if prepared.action == "buy" and record.status in {
                "DEFERRED",
                "CANCELLED",
                "FAILED_PERMANENT",
            }:
                _release_reservation(session, record)
            if attempt is not None and attempt.completed_at is None:
                attempt.completed_at = utc_now()
                attempt.result_status = record.status
                attempt.error_code = record.last_error_code
                attempt.error_message = record.last_error_message
            sync_run_and_decisions_from_intents_sync(
                session,
                user_id=record.user_id,
                run_id=record.run_id,
            )
            session.commit()
            return record.status

    try:
        result = run_with_bullpen_runtime_cleanup(
            _submit_prepared_intent(prepared)
        )
    except AutoLiveExecutorError as exc:
        with SyncSessionLocal() as session:
            record = session.get(PolymarketAutoLiveOrderIntentRecord, intent_id)
            if record is None:
                return None
            attempt = session.execute(
                select(PolymarketAutoLiveOrderAttemptRecord)
                .where(PolymarketAutoLiveOrderAttemptRecord.intent_id == intent_id)
                .where(PolymarketAutoLiveOrderAttemptRecord.attempt_number == record.attempt_count)
            ).scalar_one()
            _apply_executor_error(session, record=record, attempt=attempt, exc=exc)
            if record.status in {"DEFERRED", "FAILED_PERMANENT"}:
                _release_reservation(session, record)
            sync_run_and_decisions_from_intents_sync(
                session,
                user_id=record.user_id,
                run_id=record.run_id,
            )
            session.commit()
            return record.status

    with SyncSessionLocal() as session:
        record = session.get(PolymarketAutoLiveOrderIntentRecord, intent_id)
        if record is None:
            return None
        attempt = session.execute(
            select(PolymarketAutoLiveOrderAttemptRecord)
            .where(PolymarketAutoLiveOrderAttemptRecord.intent_id == intent_id)
            .where(PolymarketAutoLiveOrderAttemptRecord.attempt_number == record.attempt_count)
        ).scalar_one()
        now = utc_now()
        record.status = result.status
        record.retryable = result.retryable
        if record.action in {"sell", "redeem"}:
            stage3_status = {
                "SUBMITTED": "EXIT_SUBMITTED",
                "CONFIRMING": "EXIT_OPEN_UNFILLED",
                "PARTIALLY_FILLED": "EXIT_PARTIALLY_FILLED",
                "SETTLEMENT_PENDING": "POST_EXIT_REFRESH_PENDING",
                "CONFIRMED": "EXIT_SUBMITTED",
                "FILLED": "EXIT_SUBMITTED",
            }.get(result.status, "EXIT_NOT_SUBMITTED")
        else:
            stage3_status = "BUY_SUBMITTED" if result.status in {"SUBMITTED", "CONFIRMING"} else "BUY_READY"
        record.current_order_usd = result.current_order_usd if result.current_order_usd is not None else record.current_order_usd
        record.current_shares = result.current_shares if result.current_shares is not None else record.current_shares
        record.current_limit_price_cents = result.current_limit_price_cents if result.current_limit_price_cents is not None else record.current_limit_price_cents
        record.remote_order_id = result.remote_order_id or record.remote_order_id
        record.remote_transaction_hash = result.remote_transaction_hash or record.remote_transaction_hash
        record.last_error_code = result.last_error_code
        record.last_error_message = result.detail
        record.first_submitted_at = record.first_submitted_at or now
        record.last_submitted_at = now
        record.next_attempt_at = result.next_attempt_at
        if result.filled_shares is not None:
            record.filled_shares = float(result.filled_shares)
        elif record.filled_shares is None:
            record.filled_shares = 0.0
        record.remaining_shares = float(
            result.remaining_shares
            if result.remaining_shares is not None
            else max(0.0, float(record.current_shares or 0.0) - float(record.filled_shares or 0.0))
        )
        record.average_fill_price_cents = (
            result.average_fill_price_cents
            if result.average_fill_price_cents is not None
            else record.average_fill_price_cents
        )
        record.execution_metadata_json = {
            **dict(record.execution_metadata_json or {}),
            "provider_alias": result.provider_alias,
            "stage3_status": stage3_status,
        }
        attempt.completed_at = now
        attempt.result_status = result.status
        attempt.rpc_provider = result.provider_alias
        attempt.remote_order_id = result.remote_order_id
        attempt.remote_transaction_hash = result.remote_transaction_hash
        attempt.sanitized_response_json = dict(result.raw_response or {})
        if result.status in INTENT_TERMINAL_SUCCESS_STATUSES:
            record.confirmed_at = now
            record.terminal_at = now
            if record.action == "buy":
                _upsert_reservation(
                    session,
                    intent=record,
                    amount_usd=float(record.current_order_usd or 0.0),
                    status="consumed",
                )
            else:
                _release_reservation(session, record)
        sync_run_and_decisions_from_intents_sync(
            session,
            user_id=record.user_id,
            run_id=record.run_id,
        )
        session.commit()
        return record.status


def _matching_position(wallet_positions: Sequence[object], *, market_id: str, side: str | None) -> object | None:
    for position in wallet_positions:
        if getattr(position, "market_id", None) != market_id:
            continue
        if side is not None and getattr(position, "side", None) != side:
            continue
        return position
    return None


def _matching_trade(history: Sequence[object], *, market_id: str, side: str) -> object | None:
    for item in history:
        if getattr(item, "market_id", None) != market_id:
            continue
        if getattr(item, "side", None) != side:
            continue
        return item
    return None


def _remaining_position_is_economic_dust(
    intent: BullpenAutoLiveOrderIntent,
    *,
    remaining_shares: float,
) -> bool:
    capacity_policy = intent.execution_metadata_json.get("stage3_capacity_policy")
    capacity_policy = capacity_policy if isinstance(capacity_policy, dict) else {}
    dust_threshold = float(capacity_policy.get("dust_threshold_usd", 0.01) or 0.01)
    price_cents = float(
        intent.current_limit_price_cents
        or intent.requested_limit_price_cents
        or 0.0
    )
    return max(0.0, remaining_shares) * price_cents / 100 <= dust_threshold


async def _reconcile_intent_async(intent: BullpenAutoLiveOrderIntent) -> IntentSubmissionResult:
    if intent.action == "sell" and intent.remote_order_id:
        try:
            poll_payload = await BullpenLiveExecutor().poll_order(
                order_id=intent.remote_order_id,
                interval_seconds=1,
                timeout_seconds=5,
            )
            payload = poll_payload if isinstance(poll_payload, dict) else {}
            status = str(
                payload.get("status")
                or payload.get("orderStatus")
                or payload.get("state")
                or ""
            ).strip().lower().replace("-", "_")
            filled = _safe_float(
                payload.get("filledShares")
                or payload.get("filled_shares")
                or payload.get("filled")
            )
            remaining = _safe_float(
                payload.get("remainingShares")
                or payload.get("remaining_shares")
                or payload.get("remaining")
            )
            average = _safe_float(
                payload.get("averageFillPriceCents")
                or payload.get("average_fill_price_cents")
                or payload.get("avgPriceCents")
            )
            if status in {"filled", "confirmed", "complete", "completed", "redeemed"}:
                fresh_snapshot = await read_console_wallet_positions_snapshot(
                    force_fresh=True,
                    caller_source="auto-live-stage3-post-exit-intent-reconcile",
                    max_age_seconds=0,
                )
                submitted_at = parse_datetime(intent.last_submitted_at or intent.first_submitted_at)
                fetched_at = parse_datetime(fresh_snapshot.fetched_at)
                if fresh_snapshot.source != "live-cli" or (
                    submitted_at is not None
                    and (fetched_at is None or fetched_at <= submitted_at)
                ):
                    return IntentSubmissionResult(
                        status="SETTLEMENT_PENDING",
                        detail="Bullpen marked the exit filled, but the required fresh live-cli post-exit snapshot is not yet available.",
                        retryable=True,
                        next_attempt_at=_next_confirmation_attempt_at(intent),
                    )
                capacity_policy = intent.execution_metadata_json.get("stage3_capacity_policy")
                capacity_policy = capacity_policy if isinstance(capacity_policy, dict) else {}
                snapshot_metadata = _post_exit_snapshot_metadata(
                    fresh_snapshot,
                    dust_threshold_usd=float(
                        capacity_policy.get("dust_threshold_usd", 0.01) or 0.01
                    ),
                )
                allocation = classify_economic_slots(
                    fresh_snapshot.raw_positions or fresh_snapshot.positions,
                    dust_threshold_usd=float(
                        capacity_policy.get("dust_threshold_usd", 0.01) or 0.01
                    ),
                )
                try:
                    balance = await refresh_balance()
                    snapshot_metadata["available_cash_usd"] = (
                        balance.available_balance_usd
                        if balance.status == "ready"
                        else None
                    )
                    snapshot_metadata["balance_status"] = balance.status
                except Exception as balance_exc:
                    snapshot_metadata["available_cash_usd"] = None
                    snapshot_metadata["balance_status"] = "unavailable"
                    snapshot_metadata["balance_error"] = sanitize_message(str(balance_exc))
                remaining_positions = [
                    position
                    for position in allocation.active_positions
                    if _position_matches_intent(
                        position,
                        market_id=intent.market_id,
                        condition_id=intent.condition_id,
                        side=intent.side,
                    )
                    and float(getattr(position, "shares", 0.0) or 0.0) > 0
                ]
                if remaining_positions:
                    remaining_shares = sum(
                        float(getattr(position, "shares", 0.0) or 0.0)
                        for position in remaining_positions
                    )
                    return IntentSubmissionResult(
                        status="PARTIALLY_FILLED",
                        detail=(
                            "Bullpen reported the Event Exit filled, but the fresh live-cli "
                            "snapshot still shows meaningful economic exposure; the replacement slot remains occupied."
                        ),
                        retryable=True,
                        filled_shares=filled,
                        remaining_shares=remaining_shares,
                        average_fill_price_cents=average,
                        next_attempt_at=_next_confirmation_attempt_at(intent),
                        raw_response={"post_exit_snapshot": snapshot_metadata},
                    )
                return IntentSubmissionResult(
                    status="FILLED",
                    detail="Bullpen order polling confirmed the Event Exit is filled.",
                    retryable=False,
                    filled_shares=filled or intent.current_shares or intent.requested_shares,
                    remaining_shares=0.0,
                    average_fill_price_cents=average,
                    raw_response={"post_exit_snapshot": snapshot_metadata},
                )
            if status in {"partially_filled", "partial", "partial_fill"}:
                remaining_value = remaining if remaining is not None else max(
                    0.0,
                    float(intent.current_shares or intent.requested_shares or 0.0)
                    - float(filled or 0.0),
                )
                capacity_policy = intent.execution_metadata_json.get(
                    "stage3_capacity_policy"
                )
                capacity_policy = capacity_policy if isinstance(capacity_policy, dict) else {}
                dust_threshold = float(
                    capacity_policy.get("dust_threshold_usd", 0.01) or 0.01
                )
                remaining_value_usd = remaining_value * float(
                    intent.current_limit_price_cents
                    or intent.requested_limit_price_cents
                    or 0.0
                ) / 100
                if remaining_value_usd <= dust_threshold:
                    return IntentSubmissionResult(
                        status="CONFIRMED",
                        detail=(
                            "Bullpen partially filled the Event Exit; the remaining exposure is "
                            f"dust ({remaining_value_usd:.4f} USD) and does not occupy a slot."
                        ),
                        retryable=False,
                        filled_shares=filled,
                        remaining_shares=remaining_value,
                        average_fill_price_cents=average,
                    )
                return IntentSubmissionResult(
                    status="PARTIALLY_FILLED",
                    detail="Bullpen order polling found a partial Event Exit fill; remaining exposure stays occupied.",
                    retryable=True,
                    filled_shares=filled,
                    remaining_shares=remaining_value,
                    average_fill_price_cents=average,
                    next_attempt_at=_next_confirmation_attempt_at(intent),
                )
            if status in {"rejected", "failed", "error"}:
                return IntentSubmissionResult(
                    status="REJECTED",
                    detail="Bullpen order polling reported that the Event Exit was rejected.",
                    retryable=False,
                    filled_shares=filled,
                    remaining_shares=remaining,
                )
            if status in {"cancelled", "canceled"}:
                return IntentSubmissionResult(
                    status="CANCELLED",
                    detail="Bullpen order polling reported that the Event Exit was cancelled.",
                    retryable=False,
                    filled_shares=filled,
                    remaining_shares=remaining,
                )
            if status in {"timed_out", "timeout"}:
                return IntentSubmissionResult(
                    status="TIMED_OUT",
                    detail="Bullpen order polling timed out before the Event Exit filled.",
                    retryable=False,
                    filled_shares=filled,
                    remaining_shares=remaining or intent.remaining_shares,
                )
            if status in {"open", "unfilled", "pending", "submitted", "confirming"}:
                return IntentSubmissionResult(
                    status="CONFIRMING",
                    detail="Bullpen polling confirmed the Event Exit is submitted but still unfilled; the slot remains occupied.",
                    retryable=True,
                    filled_shares=filled,
                    remaining_shares=remaining or intent.remaining_shares,
                    average_fill_price_cents=average,
                    next_attempt_at=_next_confirmation_attempt_at(intent),
                )
        except AutoLiveExecutorError:
            raise
        except Exception as exc:
            classified = classify_executor_error(str(exc), during_write=False)
            if classified.code == "RPC_RATE_LIMITED":
                return IntentSubmissionResult(
                    status="CONFIRMING",
                    detail=f"Exit polling was rate limited; preserving the submitted intent: {classified.message}",
                    retryable=True,
                    next_attempt_at=_next_confirmation_attempt_at(intent),
                    last_error_code=classified.code,
                )

    if intent.action == "sell":
        live_snapshot = await read_console_wallet_positions_snapshot(
            force_fresh=True,
            caller_source="auto-live-stage3-post-exit-intent-reconcile",
            max_age_seconds=0,
        )
        submitted_at = parse_datetime(intent.last_submitted_at or intent.first_submitted_at)
        fetched_at = parse_datetime(live_snapshot.fetched_at)
        if live_snapshot.source != "live-cli" or (
            submitted_at is not None and (fetched_at is None or fetched_at <= submitted_at)
        ):
            return IntentSubmissionResult(
                status="SETTLEMENT_PENDING",
                detail=(
                    "Post-exit wallet refresh was not a fresh live-cli snapshot fetched after the exit attempt; "
                    "the economic slot remains occupied."
                ),
                retryable=True,
                next_attempt_at=_next_confirmation_attempt_at(intent),
            )
        wallet_positions = live_snapshot.positions
        fallback_snapshot_metadata = _post_exit_snapshot_metadata(live_snapshot)
    else:
        wallet_positions = await read_console_wallet_positions()
    trade_history = await BullpenTradeHistoryReader().refresh()
    redeemed_history = await BullpenRedeemedTradesReader().refresh()
    now = utc_now()
    if intent.action == "buy":
        position = next(
            (
                item
                for item in wallet_positions
                if _position_matches_intent(
                    item,
                    market_id=intent.market_id,
                    condition_id=intent.condition_id,
                    side=intent.side,
                )
            ),
            None,
        )
        if position is not None:
            current_shares = _safe_float(getattr(position, "shares", None)) or 0.0
            target_shares = float(intent.current_shares or intent.requested_shares or 0.0)
            if current_shares + 1e-6 >= max(0.0, target_shares):
                return IntentSubmissionResult(
                    status="FILLED",
                    detail="Wallet reconciliation confirmed the buy position is present.",
                    retryable=False,
                    filled_shares=current_shares,
                    remaining_shares=max(0.0, target_shares - current_shares),
                    average_fill_price_cents=intent.current_limit_price_cents,
                )
            if current_shares > 0:
                return IntentSubmissionResult(
                    status="PARTIALLY_FILLED",
                    detail="Wallet reconciliation found a partial buy fill.",
                    retryable=True,
                    filled_shares=current_shares,
                    remaining_shares=max(0.0, target_shares - current_shares),
                    average_fill_price_cents=intent.current_limit_price_cents,
                    next_attempt_at=_next_confirmation_attempt_at(intent),
                )
        trade = _matching_trade(trade_history, market_id=intent.market_id, side="BUY")
        if trade is not None:
            return IntentSubmissionResult(
                status="CONFIRMED",
                detail="Bullpen trade history shows the buy was accepted.",
                retryable=True,
                next_attempt_at=_next_confirmation_attempt_at(intent),
            )
        return IntentSubmissionResult(
            status="CONFIRMING",
            detail="Buy reconciliation remains inconclusive; keeping the intent in confirmation mode.",
            retryable=True,
            next_attempt_at=_next_confirmation_attempt_at(intent),
        )

    if intent.action == "sell":
        position = _matching_position(wallet_positions, market_id=intent.market_id, side=intent.side)
        current_shares = _safe_float(getattr(position, "shares", None)) if position is not None else 0.0
        baseline_shares = float(intent.current_shares or intent.requested_shares or 0.0)
        if position is None or current_shares + 1e-6 < max(0.0, baseline_shares):
            if position is None or current_shares <= 1e-6:
                return IntentSubmissionResult(
                    status="FILLED",
                    detail="Wallet reconciliation confirmed the sell reduced the position to zero.",
                    retryable=False,
                    filled_shares=baseline_shares,
                    remaining_shares=0.0,
                    raw_response={"post_exit_snapshot": fallback_snapshot_metadata},
                )
            if _remaining_position_is_economic_dust(
                intent,
                remaining_shares=current_shares,
            ):
                return IntentSubmissionResult(
                    status="CONFIRMED",
                    detail="Wallet reconciliation confirmed the sell left only economically inactive precision dust.",
                    retryable=False,
                    filled_shares=max(0.0, baseline_shares - current_shares),
                    remaining_shares=max(0.0, current_shares),
                    raw_response={"post_exit_snapshot": fallback_snapshot_metadata},
                )
            return IntentSubmissionResult(
                status="PARTIALLY_FILLED",
                detail="Wallet reconciliation found a partial sell fill.",
                retryable=True,
                filled_shares=max(0.0, baseline_shares - current_shares),
                remaining_shares=max(0.0, current_shares),
                next_attempt_at=_next_confirmation_attempt_at(intent),
            )
        trade = _matching_trade(trade_history, market_id=intent.market_id, side="SELL")
        if trade is not None:
            return IntentSubmissionResult(
                status="CONFIRMED",
                detail="Bullpen trade history shows the sell was accepted.",
                retryable=True,
                next_attempt_at=_next_confirmation_attempt_at(intent),
            )
        return IntentSubmissionResult(
            status="SETTLEMENT_PENDING",
            detail="Sell reconciliation is still waiting for wallet settlement.",
            retryable=True,
            next_attempt_at=_next_confirmation_attempt_at(intent),
        )

    for trade in redeemed_history:
        if getattr(trade, "market_id", None) == intent.market_id:
            return IntentSubmissionResult(
                status="CONFIRMED",
                detail="Bullpen redeem history shows the claim completed.",
                retryable=False,
            )
    matching_position = next(
        (
            position
            for position in wallet_positions
            if _position_matches_intent(
                position,
                market_id=intent.market_id,
                condition_id=intent.condition_id,
                side=None,
            )
        ),
        None,
    )
    if matching_position is None:
        return IntentSubmissionResult(
            status="CONFIRMED",
                detail="Wallet reconciliation no longer shows the redeemable condition.",
                retryable=False,
            )
    return IntentSubmissionResult(
        status="SETTLEMENT_PENDING",
        detail="Redeem reconciliation is still waiting for settlement.",
        retryable=True,
        next_attempt_at=_next_confirmation_attempt_at(intent),
    )


def reconcile_order_intent_sync(intent_id: str) -> str | None:
    with SyncSessionLocal() as session:
        record = session.get(PolymarketAutoLiveOrderIntentRecord, intent_id)
        if record is None:
            return None
        intent = _intent_to_schema(record)
    result = run_with_bullpen_runtime_cleanup(_reconcile_intent_async(intent))
    with SyncSessionLocal() as session:
        record = session.get(PolymarketAutoLiveOrderIntentRecord, intent_id)
        if record is None:
            return None
        record.status = result.status
        record.retryable = result.retryable
        record.last_error_message = result.detail
        record.last_error_code = result.last_error_code
        if record.action in {"sell", "redeem"}:
            record.execution_metadata_json = {
                **dict(record.execution_metadata_json or {}),
                "stage3_status": {
                    "SUBMITTED": "EXIT_SUBMITTED",
                    "CONFIRMING": "EXIT_OPEN_UNFILLED",
                    "PARTIALLY_FILLED": "EXIT_PARTIALLY_FILLED",
                    "CONFIRMED": "EXIT_SUBMITTED",
                    "FILLED": "EXIT_SUBMITTED",
                    "REJECTED": "EXIT_FAILED_PERMANENTLY",
                    "CANCELLED": "EXIT_FAILED_PERMANENTLY",
                    "TIMED_OUT": "EXIT_FAILED_PERMANENTLY",
                }.get(result.status, "POST_EXIT_REFRESH_PENDING"),
            }
        elif record.action == "buy" and result.status in {"SUBMITTED", "CONFIRMING"}:
            record.execution_metadata_json = {
                **dict(record.execution_metadata_json or {}),
                "stage3_status": "BUY_SUBMITTED",
            }
        if result.filled_shares is not None:
            record.filled_shares = float(result.filled_shares)
        elif record.filled_shares is None:
            record.filled_shares = 0.0
        if result.remaining_shares is not None:
            record.remaining_shares = float(result.remaining_shares)
        elif record.remaining_shares is None:
            record.remaining_shares = 0.0
        record.average_fill_price_cents = (
            result.average_fill_price_cents
            if result.average_fill_price_cents is not None
            else record.average_fill_price_cents
        )
        record.next_attempt_at = result.next_attempt_at
        if result.status in INTENT_TERMINAL_FAILURE_STATUSES:
            record.terminal_at = utc_now()
            record.retryable = False
            if record.dependency_group:
                for replacement in session.execute(
                    select(PolymarketAutoLiveOrderIntentRecord)
                    .where(PolymarketAutoLiveOrderIntentRecord.run_id == record.run_id)
                    .where(PolymarketAutoLiveOrderIntentRecord.dependency_group == record.dependency_group)
                    .where(PolymarketAutoLiveOrderIntentRecord.action == "buy")
                    .where(
                        PolymarketAutoLiveOrderIntentRecord.status.in_(
                            ("READY", "WAITING_FOR_EXIT", "RETRY_WAIT")
                        )
                    )
                ).scalars():
                    replacement.status = "DEFERRED"
                    replacement.retryable = False
                    replacement.next_attempt_at = None
                    replacement.last_error_code = "SETTLEMENT_PENDING"
                    replacement.last_error_message = (
                        f"Replacement slot released because exit {record.market_id} ended in {result.status}."
                    )
                    replacement.execution_metadata_json = {
                        **dict(replacement.execution_metadata_json or {}),
                        "stage3_status": "BUY_FAILED",
                        "replacement_reservation_released_at": utc_now_iso(),
                    }
        if result.status in INTENT_TERMINAL_SUCCESS_STATUSES:
            record.confirmed_at = utc_now()
            record.terminal_at = utc_now()
            if record.action == "buy":
                _upsert_reservation(
                    session,
                    intent=record,
                    amount_usd=float(record.current_order_usd or 0.0),
                    status="consumed",
                )
            else:
                _release_reservation(session, record)
            for waiting in session.execute(
                select(PolymarketAutoLiveOrderIntentRecord).where(
                    PolymarketAutoLiveOrderIntentRecord.run_id == record.run_id
                ).where(
                    PolymarketAutoLiveOrderIntentRecord.status.in_(
                        ("WAITING_FOR_COLLATERAL", "WAITING_FOR_EXIT")
                    )
                )
            ).scalars():
                waiting_for_exit = waiting.status == "WAITING_FOR_EXIT"
                if waiting_for_exit and waiting.dependency_group != record.dependency_group:
                    continue
                waiting.status = "READY"
                waiting.retryable = True
                waiting.next_attempt_at = utc_now()
                waiting.execution_metadata_json = {
                    **dict(waiting.execution_metadata_json or {}),
                    "stage3_status": "BUY_READY",
                    "dependency_exit_market_id": record.market_id,
                }
                if waiting_for_exit:
                    waiting.dependency_metadata_json = {
                        **dict(waiting.dependency_metadata_json or {}),
                        "state": "ready",
                        "exit_confirmed_at": utc_now_iso(),
                        "exit_intent_id": record.id,
                    }
        _persist_stage3_reconciliation_diagnostics(
            session,
            record=record,
            result=result,
        )
        sync_run_and_decisions_from_intents_sync(
            session,
            user_id=record.user_id,
            run_id=record.run_id,
        )
        session.commit()
        return record.status


def get_run_orders_for_user_sync(*, user_id: int, run_id: str) -> BullpenAutoLiveRunOrdersResponse:
    with SyncSessionLocal() as session:
        sync_run_and_decisions_from_intents_sync(session, user_id=user_id, run_id=run_id)
        session.commit()
        return summarize_run_orders_sync(session, user_id=user_id, run_id=run_id)


def retry_order_intent_for_user_sync(*, user_id: int, intent_id: str) -> BullpenAutoLiveRunOrdersResponse:
    with SyncSessionLocal() as session:
        return retry_order_intent_sync(session, user_id=user_id, intent_id=intent_id)


def retry_failed_exits_and_continue_buys_sync(
    *,
    user_id: int,
    run_id: str,
) -> BullpenAutoLiveRunOrdersResponse:
    """Resume one saved run without rebuilding its Stage 1/2 analysis."""

    with SyncSessionLocal() as session:
        run_record = session.get(PolymarketAutoLiveRunRecord, run_id)
        if run_record is None or run_record.user_id != user_id:
            raise ValueError("Saved Auto-Live run not found.")
        run = record_to_run(run_record)

        # Older runs may have been persisted by the legacy synchronous path.
        # Backfill only the already persisted order plans; never infer a new
        # order from an LLM row or rerun analysis here.
        existing = session.execute(
            select(PolymarketAutoLiveOrderIntentRecord)
            .where(PolymarketAutoLiveOrderIntentRecord.run_id == run_id)
        ).scalars().all()
        if not existing:
            decision_records = session.execute(
                select(PolymarketAutoLiveDecisionRecord)
                .where(PolymarketAutoLiveDecisionRecord.user_id == user_id)
                .where(PolymarketAutoLiveDecisionRecord.run_id == run_id)
                .order_by(PolymarketAutoLiveDecisionRecord.created_at.asc())
            ).scalars().all()
            saved_decisions = [record_to_decision(item) for item in decision_records]
            replacement_by_buy_market: dict[str, str] = {}
            for stage in run.stage_results:
                diagnostics = stage.outputs.get("stage3_slot_diagnostics")
                if not isinstance(diagnostics, dict):
                    continue
                reservations = diagnostics.get("replacement_reservations")
                if not isinstance(reservations, list):
                    continue
                for reservation in reservations:
                    if not isinstance(reservation, dict):
                        continue
                    buy_market = reservation.get("replacement_market_id")
                    exit_market = reservation.get("exit_market_id")
                    if isinstance(buy_market, str) and isinstance(exit_market, str):
                        replacement_by_buy_market[buy_market] = exit_market
            for decision in saved_decisions:
                if decision.order_plan is None or decision.order_plan.action != "buy":
                    continue
                exit_market_id = replacement_by_buy_market.get(decision.market_id)
                if exit_market_id:
                    decision.order_plan = decision.order_plan.model_copy(
                        update={
                            "dependency_group": (
                                f"stage3-replacement:{run_id}:{exit_market_id}"
                            )
                        }
                    )
            create_or_refresh_run_order_intents_sync(
                session,
                user_id=user_id,
                run=run,
                decisions=saved_decisions,
            )
            existing = session.execute(
                select(PolymarketAutoLiveOrderIntentRecord)
                .where(PolymarketAutoLiveOrderIntentRecord.run_id == run_id)
            ).scalars().all()

        resumed_at = utc_now_iso()
        for intent in existing:
            if _intent_has_persisted_submission_reference(intent):
                intent.status = "CONFIRMING"
                intent.retryable = True
                intent.next_attempt_at = utc_now()
                intent.last_error_code = "PERSISTED_SUBMISSION_RECONCILE_REQUIRED"
                intent.last_error_message = (
                    "Persisted order/submission reference found during Stage 3 "
                    "retry; reconciliation was scheduled instead of a duplicate write."
                )
                intent.execution_metadata_json = {
                    **dict(intent.execution_metadata_json or {}),
                    "operator_resume_action": "Reconcile persisted submission",
                    "operator_resume_at": resumed_at,
                    "duplicate_order_prevented_at": resumed_at,
                }
                continue
            if intent.action in {"sell", "redeem"} and intent.status in {
                "READY",
                "RETRY_WAIT",
                "WAITING_FOR_COLLATERAL",
                "WAITING_FOR_EXIT",
                "DEFERRED",
                "FAILED_PERMANENT",
            }:
                intent.status = "READY"
                intent.retryable = True
                intent.terminal_at = None
                intent.next_attempt_at = utc_now()
                intent.last_error_code = None
                intent.last_error_message = None
                intent.execution_metadata_json = {
                    **dict(intent.execution_metadata_json or {}),
                    "stage3_status": "EXIT_NOT_SUBMITTED",
                    "operator_resume_action": "Retry failed exits and continue buys",
                    "operator_resume_at": resumed_at,
                    "recovery_required": False,
                    "current_blockage": None,
                }
            elif intent.action == "buy" and intent.status in {
                "READY",
                "RETRY_WAIT",
                "WAITING_FOR_COLLATERAL",
                "WAITING_FOR_EXIT",
                "DEFERRED",
            }:
                intent.status = "READY"
                intent.retryable = True
                intent.next_attempt_at = utc_now()
                intent.last_error_code = None
                intent.last_error_message = None
                intent.execution_metadata_json = {
                    **dict(intent.execution_metadata_json or {}),
                    "stage3_status": "BUY_READY",
                    "operator_resume_action": "Retry failed exits and continue buys",
                    "operator_resume_at": resumed_at,
                    "recovery_required": False,
                    "current_blockage": None,
                }

        recovery = run.audit_metadata.get("stage3_recovery")
        recovery = dict(recovery) if isinstance(recovery, dict) else {}
        auth_recovery = run.audit_metadata.get("auth_recovery")
        auth_recovery = (
            dict(auth_recovery) if isinstance(auth_recovery, dict) else {}
        )
        run.audit_metadata = {
            **run.audit_metadata,
            "stage3_recovery": {
                **recovery,
                "required": False,
                "resolved_at": resumed_at,
                "resolution": "operator_retry",
            },
            "auth_recovery": {
                **auth_recovery,
                "operator_resume_at": resumed_at,
                "operator_resume_action": "Retry failed exits and continue buys",
                "operator_resume_same_run": True,
            },
            "stage3_resume_action": {
                "action": "Retry failed exits and continue buys",
                "at": resumed_at,
                "same_run": True,
                "llm_analysis_rerun": False,
            },
        }
        apply_run_to_record(run_record, run, user_id=user_id)
        session.flush()
        sync_run_and_decisions_from_intents_sync(session, user_id=user_id, run_id=run_id)
        session.commit()
        return summarize_run_orders_sync(session, user_id=user_id, run_id=run_id)


def retry_failed_exits_and_continue_buys_for_user_sync(
    *, user_id: int, run_id: str
) -> BullpenAutoLiveRunOrdersResponse:
    return retry_failed_exits_and_continue_buys_sync(user_id=user_id, run_id=run_id)


def cancel_order_intent_for_user_sync(*, user_id: int, intent_id: str) -> BullpenAutoLiveRunOrdersResponse:
    with SyncSessionLocal() as session:
        return cancel_order_intent_sync(session, user_id=user_id, intent_id=intent_id)


def refresh_run_order_state_for_user_sync(*, user_id: int, run_id: str) -> BullpenAutoLiveRunOrdersResponse:
    with SyncSessionLocal() as session:
        sync_run_and_decisions_from_intents_sync(session, user_id=user_id, run_id=run_id)
        session.commit()
        return summarize_run_orders_sync(session, user_id=user_id, run_id=run_id)
