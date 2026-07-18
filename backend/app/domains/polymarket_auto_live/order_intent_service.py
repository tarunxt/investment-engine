from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Iterable, Sequence

from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session, selectinload

from app.core.logging import get_logger
from app.domains.polymarket import bullpen as bullpen_module
from app.domains.polymarket.bullpen import (
    BullpenBalanceReader,
    BullpenLiveExecutor,
    BullpenRedeemedTradesReader,
    BullpenTradeHistoryReader,
)
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
from app.domains.polymarket_auto_live.console_profile import read_console_wallet_positions
from app.domains.polymarket_auto_live.execution import refresh_execution_quote, refresh_live_controls
from app.domains.polymarket_auto_live.models import (
    PolymarketAutoLiveCapitalReservationRecord,
    PolymarketAutoLiveDecisionRecord,
    PolymarketAutoLiveOrderAttemptRecord,
    PolymarketAutoLiveOrderIntentRecord,
    PolymarketAutoLiveRunRecord,
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
from app.domains.polymarket_auto_live.repository import (
    apply_decision_to_record,
    apply_run_to_record,
    record_to_decision,
    record_to_run,
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

logger = get_logger("app.domains.polymarket_auto_live.order_intent_service")

_EXECUTABLE_STATUSES = frozenset({"READY", "RETRY_WAIT", "WAITING_FOR_COLLATERAL"})
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


def _update_invest_stage_outputs(run: BullpenAutoLiveRun, response: BullpenAutoLiveRunOrdersResponse) -> None:
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
    for decision in decisions:
        order_plan = _base_order_plan_for(decision)
        if order_plan is None or order_plan.action not in {"buy", "sell", "redeem"}:
            continue
        if order_plan.dry_run:
            continue

        intent = session.get(PolymarketAutoLiveOrderIntentRecord, order_plan.id)
        if intent is None:
            intent = PolymarketAutoLiveOrderIntentRecord(
                id=order_plan.id,
                user_id=user_id,
                run_id=run.id,
                decision_id=decision.id,
                dependency_group=order_plan.dependency_group,
                action=order_plan.action,
                market_id=decision.market_id,
                slug=decision.slug,
                condition_id=(
                    decision.stage_results[-1].outputs.get("condition_id")
                    if decision.stage_results
                    else None
                ),
                side=order_plan.side,
                requested_order_usd=order_plan.order_size_usd,
                requested_shares=order_plan.shares,
                requested_limit_price_cents=order_plan.limit_price_cents,
                current_order_usd=order_plan.order_size_usd,
                current_shares=order_plan.shares,
                current_limit_price_cents=order_plan.limit_price_cents,
                max_slippage_cents=order_plan.max_slippage_cents,
                status="READY",
                retryable=True,
                attempt_count=0,
                max_attempts=max(1, int(os.getenv("AUTO_LIVE_DEFAULT_MAX_ATTEMPTS", "4"))),
                next_attempt_at=utc_now(),
                priority=_intent_priority(order_plan.action),
                idempotency_key=f"auto-live:{run.id}:{decision.id}:{order_plan.id}",
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
                    "reservation_state": None,
                    "run_status": run.status,
                },
                version=1,
            )
            session.add(intent)
        elif intent.status not in INTENT_TERMINAL_SUCCESS_STATUSES:
            intent.requested_order_usd = order_plan.order_size_usd
            intent.requested_shares = order_plan.shares
            intent.requested_limit_price_cents = order_plan.limit_price_cents
            if intent.status in {"PLANNED", "READY", "RETRY_WAIT", "WAITING_FOR_COLLATERAL"}:
                intent.current_order_usd = order_plan.order_size_usd
                intent.current_shares = order_plan.shares
                intent.current_limit_price_cents = order_plan.limit_price_cents
                if intent.status == "PLANNED":
                    intent.status = "READY"
                intent.retryable = True
                intent.next_attempt_at = utc_now()
            intent.dependency_group = order_plan.dependency_group

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
    if record.status not in {"READY", "RETRY_WAIT", "WAITING_FOR_COLLATERAL", "DEFERRED"}:
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
                    market_id=prepared.market_id,
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
                    market_id=prepared.market_id,
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
                str(exc),
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


def execute_order_intent_sync(intent_id: str, *, worker_task_id: str | None = None) -> str | None:
    with SyncSessionLocal() as session:
        record = _lock_intent_for_execution(session, intent_id)
        if record is None:
            return None
        if record.status not in _EXECUTABLE_STATUSES:
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

    try:
        prepared = asyncio.run(_prepare_intent_submission(intent))
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
            record.last_error_code = exc.code
            record.last_error_message = sanitize_message(exc.message)
            record.retryable = exc.retryable
            record.error_class = "transient" if exc.retryable else "permanent"
            if exc.retryable:
                record.status = "RETRY_WAIT"
                record.next_attempt_at = compute_next_retry_at(
                    code=exc.code,
                    attempt_count=record.attempt_count,
                    retry_after_seconds=exc.retry_after_seconds,
                )
            elif exc.code == "CONDITION_ID_UNAVAILABLE":
                record.status = "DEFERRED"
                record.terminal_at = utc_now()
            else:
                record.status = "FAILED_PERMANENT"
                record.terminal_at = utc_now()
            attempt.completed_at = utc_now()
            attempt.result_status = record.status
            attempt.error_code = exc.code
            attempt.error_message = sanitize_message(exc.message)
            sync_run_and_decisions_from_intents_sync(
                session,
                user_id=record.user_id,
                run_id=record.run_id,
            )
            session.commit()
            return record.status

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

    try:
        result = asyncio.run(_submit_prepared_intent(prepared))
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
            record.last_error_code = exc.code
            record.last_error_message = sanitize_message(exc.message)
            record.retryable = exc.retryable
            record.error_class = "transient" if exc.retryable else "permanent"
            attempt.completed_at = utc_now()
            attempt.error_code = exc.code
            attempt.error_message = sanitize_message(exc.message)
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
                record.terminal_at = utc_now()
                attempt.result_status = "DEFERRED"
            else:
                record.status = "FAILED_PERMANENT"
                record.terminal_at = utc_now()
                attempt.result_status = "FAILED_PERMANENT"
            if record.status in {"RETRY_WAIT", "WAITING_FOR_COLLATERAL", "DEFERRED", "FAILED_PERMANENT"}:
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


async def _reconcile_intent_async(intent: BullpenAutoLiveOrderIntent) -> IntentSubmissionResult:
    wallet_positions = await read_console_wallet_positions()
    trade_history = await BullpenTradeHistoryReader().refresh()
    redeemed_history = await BullpenRedeemedTradesReader().refresh()
    now = utc_now()
    if intent.action == "buy":
        position = _matching_position(wallet_positions, market_id=intent.market_id, side=intent.side)
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
            if getattr(position, "condition_id", None) == intent.condition_id
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
    result = asyncio.run(_reconcile_intent_async(intent))
    with SyncSessionLocal() as session:
        record = session.get(PolymarketAutoLiveOrderIntentRecord, intent_id)
        if record is None:
            return None
        record.status = result.status
        record.retryable = result.retryable
        record.last_error_message = result.detail
        record.last_error_code = result.last_error_code
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
                ).where(PolymarketAutoLiveOrderIntentRecord.status == "WAITING_FOR_COLLATERAL")
            ).scalars():
                waiting.status = "READY"
                waiting.next_attempt_at = utc_now()
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


def cancel_order_intent_for_user_sync(*, user_id: int, intent_id: str) -> BullpenAutoLiveRunOrdersResponse:
    with SyncSessionLocal() as session:
        return cancel_order_intent_sync(session, user_id=user_id, intent_id=intent_id)


def refresh_run_order_state_for_user_sync(*, user_id: int, run_id: str) -> BullpenAutoLiveRunOrdersResponse:
    with SyncSessionLocal() as session:
        sync_run_and_decisions_from_intents_sync(session, user_id=user_id, run_id=run_id)
        session.commit()
        return summarize_run_orders_sync(session, user_id=user_id, run_id=run_id)
