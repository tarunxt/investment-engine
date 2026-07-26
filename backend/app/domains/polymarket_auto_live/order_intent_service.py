from __future__ import annotations

import hashlib
import json
import os
import traceback
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from datetime import UTC, datetime, timedelta
from typing import Iterable, Sequence

from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session, aliased, selectinload

from app.core.logging import get_logger
from app.domains.auth.models import User
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
    ConsoleWalletPositionsSnapshot,
    enrich_console_wallet_positions_authoritatively,
    read_console_wallet_positions,
    read_console_wallet_positions_snapshot,
)
from app.domains.polymarket_auto_live.execution import (
    refresh_balance,
    refresh_execution_quote,
    refresh_live_controls,
)
from app.domains.polymarket_auto_live.immediate_sell import (
    IMMEDIATE_SELL_MIN_PRICE,
    IMMEDIATE_SELL_STRATEGY_VERSION,
    submit_immediate_sell_with_fallbacks,
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
    INTENT_REMOTE_CONFIRMATION_STATUSES,
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
from app.domains.polymarket_auto_live.stage3_slots import (
    auto_live_buy_balance_buffer_usd,
    classify_economic_slots,
    spendable_buy_cash_usd,
)
from app.domains.polymarket_auto_live.repository import (
    apply_decision_to_record,
    apply_run_to_record,
    apply_state_to_record,
    record_to_decision,
    record_to_run,
    record_to_state,
    visible_auto_live_decision_filter,
)
from app.domains.polymarket_auto_live.run_recovery import (
    reconcile_running_auto_live_run,
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


def _configured_celery_app():
    """Return the Redis-backed project app without creating an import cycle.

    FastAPI does not import the worker bootstrap module during normal startup,
    so Celery's global ``current_app`` proxy can still point at its default
    AMQP application in an API process. Importing the project app at inspection
    time makes readiness and restart recovery query the same broker as the
    systemd workers.
    """

    from app.infrastructure.messaging.celery_app import celery

    return celery


_EXECUTABLE_STATUSES = frozenset(
    {"PLANNED", "READY", "RETRY_WAIT", "WAITING_FOR_COLLATERAL", "WAITING_FOR_EXIT"}
)
_RECONCILABLE_STATUSES = frozenset(
    {"SUBMITTED", "CONFIRMING", "PARTIALLY_FILLED", "SETTLEMENT_PENDING", "SUBMITTING"}
)
_USER_CANCELLABLE_INTENT_STATUSES = frozenset(
    {"PLANNED", "READY", "RETRY_WAIT", "WAITING_FOR_COLLATERAL", "WAITING_FOR_EXIT", "DEFERRED"}
)
_USER_CANCELLED_RUN_ERROR = "Cancelled by user"


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
    available_balance_checked_at: str | None = None
    sell_preflight_metadata: dict[str, object] = field(default_factory=dict)
    wallet_lineage_comparison: dict[str, object] = field(default_factory=dict)
    wallet_snapshot_lineage: dict[str, object] = field(default_factory=dict)
    redeem_preflight_wallet_positions: tuple[object, ...] = field(
        default_factory=tuple
    )


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
    execution_path: str | None = None
    fallback_history: list[dict[str, object]] | None = None
    selected_fallback_layer: str | None = None


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


def _first_present_value(
    mapping: dict[str, object],
    *keys: str,
) -> object | None:
    """Return the first explicit value without treating numeric zero as absent."""

    for key in keys:
        if key in mapping and mapping[key] is not None:
            return mapping[key]
    return None


def _walk_response_payload(value: object):
    if isinstance(value, dict):
        yield value
        for nested in value.values():
            yield from _walk_response_payload(nested)
    elif isinstance(value, list):
        for nested in value:
            yield from _walk_response_payload(nested)


def _extract_remote_refs(payload: dict[str, object]) -> tuple[str | None, str | None]:
    remote_order_id = None
    remote_transaction_hash = None
    order_keys = {"orderid", "order_id", "remoteorderid", "remote_order_id"}
    transaction_keys = {
        "transactionhash",
        "transaction_hash",
        "txhash",
        "tx_hash",
        "remote_transaction_hash",
    }
    for row in _walk_response_payload(payload):
        for key, value in row.items():
            normalized_key = str(key).lower()
            if (
                remote_order_id is None
                and normalized_key in order_keys
                and isinstance(value, (str, int))
                and str(value).strip()
            ):
                remote_order_id = str(value).strip()
            if (
                remote_transaction_hash is None
                and normalized_key in transaction_keys
                and isinstance(value, (str, int))
                and str(value).strip()
            ):
                remote_transaction_hash = str(value).strip()
            if (
                remote_transaction_hash is None
                and normalized_key == "transaction_hashes"
                and isinstance(value, list)
            ):
                remote_transaction_hash = next(
                    (
                        str(item).strip()
                        for item in value
                        if isinstance(item, (str, int)) and str(item).strip()
                    ),
                    None,
                )
    return remote_order_id, remote_transaction_hash


def _matched_buy_submission_fill(
    payload: dict[str, object],
) -> tuple[float, float | None] | None:
    result = payload.get("result")
    if not isinstance(result, dict):
        return None
    status = str(result.get("status") or "").strip().lower().replace("-", "_")
    if status not in {"matched", "filled", "complete", "completed", "executed"}:
        return None
    if result.get("success") is False:
        return None
    filled_shares = _safe_float(
        _first_present_value(
            result,
            "filled_size",
            "filledSize",
            "shares",
            "taking_amount",
        )
    )
    if filled_shares is None or filled_shares <= 0:
        return None
    average_price = _safe_float(
        _first_present_value(
            result,
            "avg_price",
            "avgPrice",
            "average_fill_price",
        )
    )
    average_price_cents = None
    if average_price is not None:
        average_price_cents = average_price * 100 if average_price <= 1 else average_price
        average_price_cents = max(0.0, min(100.0, average_price_cents))
    return filled_shares, average_price_cents


def _matched_sell_submission_fill(
    payload: dict[str, object],
) -> tuple[float, float | None] | None:
    rows: list[dict[str, object]] = []

    def _collect_rows(value: object) -> None:
        if isinstance(value, dict):
            rows.append(value)
            for nested in value.values():
                _collect_rows(nested)
        elif isinstance(value, list):
            for nested in value:
                _collect_rows(nested)

    _collect_rows(payload)
    filled_shares = None
    for key in (
        "filled_size",
        "filledSize",
        "filled_shares",
        "filledShares",
        "sold_shares",
        "soldShares",
        "matched_size",
        "matchedSize",
    ):
        candidates = [
            value
            for row in rows
            if (value := _safe_float(row.get(key))) is not None and value > 0
        ]
        if candidates:
            filled_shares = max(candidates)
            break
    if filled_shares is None or filled_shares <= 0:
        return None
    average_price = None
    for key in ("avg_price", "avgPrice", "average_fill_price", "averageFillPrice"):
        average_price = next(
            (
                value
                for row in rows
                if (value := _safe_float(row.get(key))) is not None
            ),
            None,
        )
        if average_price is not None:
            break
    average_price_cents = None
    if average_price is not None:
        average_price_cents = average_price * 100 if average_price <= 1 else average_price
        average_price_cents = max(0.0, min(100.0, average_price_cents))
    return filled_shares, average_price_cents


def _immediate_sell_submission_detail(
    *,
    fallback_count: int,
    execution_path: str,
    fully_filled: bool,
    partially_filled: bool,
) -> str:
    outcome = (
        "filled"
        if fully_filled
        else "partially filled"
        if partially_filled
        else "accepted"
    )
    if fallback_count == 0:
        if partially_filled:
            return (
                "Bullpen immediate market sell partially filled through the primary "
                "explicit-share path; the durable intent will reconcile the remaining "
                "wallet exposure."
            )
        return (
            f"Bullpen immediate market sell was {outcome} by the primary "
            "explicit-share path."
        )
    failure_label = "failure" if fallback_count == 1 else "failures"
    return (
        f"Bullpen immediate market sell was {outcome} through fallback "
        f"{fallback_count + 1} of 3 ({execution_path}) after {fallback_count} "
        f"verified pre-submit/no-fill {failure_label}."
    )


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
    if run_status == "running":
        terminal_count = (
            funnel.confirmed
            + funnel.filled
            + funnel.deferred
            + funnel.cancelled
            + funnel.permanently_failed
        )
        waiting_count = max(0, funnel.planned - terminal_count)
        return (
            f"Stage 3 attempted {funnel.attempted} of {funnel.planned} durable "
            f"order intent{'s' if funnel.planned != 1 else ''}; "
            f"{waiting_count} still await execution or retry and "
            f"{funnel.remotely_accepted} have remote acceptance evidence."
        )
    if run_status == "confirming":
        return (
            f"Stage 3 queued {funnel.planned} durable order intent"
            f"{'s' if funnel.planned != 1 else ''}; "
            f"{funnel.confirming} still need confirmation."
        )
    if run_status == "partial_success":
        terminal_success = funnel.confirmed + funnel.filled
        terminal_failure = max(
            funnel.permanently_failed + funnel.deferred + funnel.cancelled,
            funnel.planned - terminal_success,
        )
        return (
            f"Stage 3 confirmed {terminal_success} of {funnel.planned} durable "
            f"order intents; {terminal_failure} finished deferred or failed."
        )
    if run_status == "failed":
        terminal_failure = max(
            funnel.permanently_failed + funnel.deferred + funnel.cancelled,
            funnel.planned,
        )
        return (
            f"Stage 3 did not confirm any durable order intents and recorded "
            f"{terminal_failure} failures."
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


def _safe_wallet_credential_artifact(value: object) -> dict[str, object]:
    if isinstance(value, dict):
        return {
            "inode": value.get("inode"),
            "mtime_ns": value.get("mtime_ns"),
            "size": value.get("size"),
        }
    return {
        "inode": getattr(value, "inode", None),
        "mtime_ns": getattr(value, "mtime_ns", None),
        "size": getattr(value, "size", None),
    }


def _wallet_snapshot_lineage(snapshot: object) -> dict[str, object]:
    return {
        "source": getattr(snapshot, "source", None),
        "fetched_at": getattr(snapshot, "fetched_at", None),
        "freshness_state": getattr(snapshot, "freshness_state", None),
        "account_identity": getattr(snapshot, "account_identity", None),
        "credential_artifact": _safe_wallet_credential_artifact(
            getattr(snapshot, "credential_artifact", {})
        ),
        "position_classifier_version": getattr(
            snapshot,
            "position_classifier_version",
            None,
        ),
    }


def _expected_stage1_wallet_lineage(
    run: BullpenAutoLiveRun,
) -> dict[str, object]:
    for stage in reversed(run.stage_results):
        outputs = stage.outputs
        if not (
            stage.stage_number == 1
            or outputs.get("workflow_stage_key") == "scan"
        ):
            continue
        raw_artifact = (
            outputs.get("wallet_credential_artifact")
            if isinstance(outputs.get("wallet_credential_artifact"), dict)
            else {}
        )
        lineage = {
            "source": outputs.get("wallet_source"),
            "fetched_at": outputs.get("wallet_snapshot_fetched_at"),
            "freshness_state": outputs.get(
                "wallet_snapshot_freshness_state",
                outputs.get("wallet_freshness_state"),
            ),
            "account_identity": outputs.get("wallet_account_identity"),
            "credential_artifact": {
                "inode": outputs.get(
                    "wallet_credential_artifact_inode",
                    raw_artifact.get("inode"),
                ),
                "mtime_ns": outputs.get(
                    "wallet_credential_artifact_mtime_ns",
                    raw_artifact.get("mtime_ns"),
                ),
                "size": outputs.get(
                    "wallet_credential_artifact_size",
                    raw_artifact.get("size"),
                ),
            },
            "position_classifier_version": outputs.get(
                "wallet_position_classifier_version",
                outputs.get("position_classifier_version"),
            ),
        }
        if any(
            value is not None
            for key, value in lineage.items()
            if key != "credential_artifact"
        ) or any(
            value is not None
            for value in lineage["credential_artifact"].values()  # type: ignore[union-attr]
        ):
            return lineage
    return {}


def _compare_wallet_snapshot_lineage(
    *,
    expected: object,
    actual: dict[str, object],
) -> dict[str, object]:
    if not isinstance(expected, dict) or not expected:
        return {
            "status": "unavailable",
            "compared_fields": [],
            "mismatches": [],
        }

    compared_fields: list[str] = []
    mismatches: list[str] = []
    for field_name in ("account_identity", "position_classifier_version"):
        expected_value = expected.get(field_name)
        if expected_value is None:
            continue
        compared_fields.append(field_name)
        if actual.get(field_name) != expected_value:
            mismatches.append(field_name)

    expected_artifact = (
        expected.get("credential_artifact")
        if isinstance(expected.get("credential_artifact"), dict)
        else {}
    )
    actual_artifact = (
        actual.get("credential_artifact")
        if isinstance(actual.get("credential_artifact"), dict)
        else {}
    )
    for artifact_field in ("inode", "mtime_ns", "size"):
        expected_value = expected_artifact.get(artifact_field)
        if expected_value is None:
            continue
        field_name = f"credential_artifact.{artifact_field}"
        compared_fields.append(field_name)
        if actual_artifact.get(artifact_field) != expected_value:
            mismatches.append(field_name)

    expected_fetched_at = parse_datetime(
        str(expected.get("fetched_at"))
        if expected.get("fetched_at")
        else None
    )
    actual_fetched_at = parse_datetime(
        str(actual.get("fetched_at"))
        if actual.get("fetched_at")
        else None
    )
    if expected_fetched_at is not None:
        compared_fields.append("fetched_at_not_older")
        if actual_fetched_at is None or actual_fetched_at < expected_fetched_at:
            mismatches.append("fetched_at_not_older")

    return {
        "status": (
            "mismatch"
            if mismatches
            else "match"
            if compared_fields
            else "unavailable"
        ),
        "compared_fields": compared_fields,
        "mismatches": mismatches,
    }


def _validate_force_fresh_wallet_snapshot(
    *,
    snapshot: object,
    request_started_at: datetime,
) -> dict[str, object]:
    lineage = _wallet_snapshot_lineage(snapshot)
    source = lineage.get("source")
    freshness_state = str(lineage.get("freshness_state") or "").lower()
    fetched_at = parse_datetime(
        str(lineage.get("fetched_at")) if lineage.get("fetched_at") else None
    )
    if (
        source not in {"live-cli", "redis-cache"}
        or freshness_state != "fresh"
        or fetched_at is None
        or fetched_at <= request_started_at
    ):
        raise AutoLiveExecutorError(
            code="POSITION_UNAVAILABLE",
            message=(
                "Forced Bullpen wallet refresh lacked fresh, fetched-after-request "
                "lineage proof; no external order write was issued."
            ),
            retryable=True,
        )
    return lineage


def _condition_id_for_decision(decision: BullpenAutoLiveDecision) -> str | None:
    for stage in reversed(decision.stage_results):
        value = stage.outputs.get("condition_id")
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _intent_has_persisted_submission_reference(intent: object) -> bool:
    """Return true when a retry could duplicate an already accepted write."""

    if any(
        bool(getattr(intent, field_name, None))
        for field_name in (
            "remote_order_id",
            "remote_transaction_hash",
            "first_submitted_at",
            "last_submitted_at",
        )
    ):
        return True
    execution_metadata = getattr(intent, "execution_metadata_json", None)
    return bool(
        isinstance(execution_metadata, dict)
        and execution_metadata.get("uncertain_remote_write_boundary")
    )


def _intent_requires_operator_resume_reconciliation(intent: object) -> bool:
    """Reconcile persisted writes unless the intent already succeeded terminally."""

    status = str(getattr(intent, "status", "") or "")
    return (
        status not in INTENT_TERMINAL_SUCCESS_STATUSES
        and _intent_has_persisted_submission_reference(intent)
    )


def _assert_intent_has_no_persisted_submission_reference(intent: object) -> None:
    if not _intent_has_persisted_submission_reference(intent):
        return
    raise ValueError(
        "This order has a persisted order/submission reference and must be "
        "reconciled instead of retried; retrying could create a duplicate order."
    )


def _assert_intent_retry_allowed(
    intent: object,
    *,
    remote_absence_verified: bool = False,
) -> None:
    status = str(getattr(intent, "status", "") or "")
    if status == "CONFIRMING":
        if not remote_absence_verified:
            raise ValueError(
                "This order is awaiting confirmation. Verify that Bullpen has no "
                "matching trade or open order before requesting an operator retry."
            )
        _assert_intent_has_no_persisted_submission_reference(intent)
        return
    if (
        status not in INTENT_RETRYABLE_STATUSES
        and status not in INTENT_TERMINAL_FAILURE_STATUSES
    ):
        raise ValueError("This order is not in a retryable state.")
    _assert_intent_has_no_persisted_submission_reference(intent)


def _reconciliation_snapshot_is_current(
    record: object,
    snapshot: BullpenAutoLiveOrderIntent,
) -> bool:
    return (
        str(getattr(record, "status", "") or "")
        in INTENT_PENDING_CONFIRMATION_STATUSES
        and int(getattr(record, "version", 0) or 0) == snapshot.version
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


def _run_was_cancelled_by_user(
    session: Session,
    *,
    run_id: str,
) -> bool:
    """Read the durable terminal cancellation marker, never a cached run."""
    run_record = session.execute(
        select(PolymarketAutoLiveRunRecord)
        .where(PolymarketAutoLiveRunRecord.id == run_id)
        .execution_options(populate_existing=True)
    ).scalar_one_or_none()
    if run_record is None:
        return False
    return (
        run_record.status == "failed"
        and run_record.error_message == _USER_CANCELLED_RUN_ERROR
    )


def _cancel_unsubmitted_intent_for_user(
    session: Session,
    *,
    record: PolymarketAutoLiveOrderIntentRecord,
    remote_write_prevented: bool = False,
) -> bool:
    """Cancel an intent only while no remote write could have happened."""
    cancellable_statuses = _USER_CANCELLABLE_INTENT_STATUSES | (
        {"SUBMITTING"} if remote_write_prevented else set()
    )
    if record.status not in cancellable_statuses:
        return False
    cancelled_at = utc_now()
    record.status = "CANCELLED"
    record.retryable = False
    record.next_attempt_at = None
    record.terminal_at = cancelled_at
    record.last_error_code = "RUN_CANCELLED_BY_USER"
    record.last_error_message = (
        "Order cancelled because its Auto-Live run was terminated by the user before "
        "a remote submission was attempted."
    )
    record.execution_metadata_json = {
        **dict(record.execution_metadata_json or {}),
        "stage3_status": "EXIT_NOT_SUBMITTED"
        if record.action in {"sell", "redeem"}
        else "BUY_FAILED",
        "run_cancelled_by_user_at": utc_now_iso(),
        "remote_write_prevented_at": utc_now_iso() if remote_write_prevented else None,
    }
    _release_reservation(session, record)
    return True


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
    intents: Sequence[BullpenAutoLiveOrderIntent],
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
    elif planned == 0 or all(
        intent.status
        in INTENT_TERMINAL_SUCCESS_STATUSES | INTENT_TERMINAL_FAILURE_STATUSES
        for intent in intents
    ):
        status = "completed"
        detail = "" if planned > 0 else "No persisted orders were planned for this step."
    elif any(
        intent.status in INTENT_REMOTE_CONFIRMATION_STATUSES
        for intent in intents
    ):
        status = "confirming"
        detail = "Persisted orders are awaiting remote confirmation or settlement."
    else:
        status = "running"
        detail = "Persisted orders are awaiting execution or a bounded retry."
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


def _repair_legacy_replacement_exit_dependency_groups(
    session: Session,
    *,
    limit: int,
) -> list[str]:
    """Repair legacy EXIT rows whose replacement group existed only on BUY.

    Earlier planners persisted the deterministic dependency group on the
    replacement BUY but not on its paired EXIT.  Read the exit market encoded
    in that group, lock the EXIT first (the canonical dependency lock order),
    and fill only a missing group.  A conflicting non-empty group is never
    overwritten.
    """

    waiting_dependencies = session.execute(
        select(
            PolymarketAutoLiveOrderIntentRecord.run_id,
            PolymarketAutoLiveOrderIntentRecord.dependency_group,
            PolymarketAutoLiveOrderIntentRecord.execution_metadata_json,
        )
        .where(PolymarketAutoLiveOrderIntentRecord.action == "buy")
        .where(
            PolymarketAutoLiveOrderIntentRecord.status
            == "WAITING_FOR_EXIT"
        )
        .where(
            PolymarketAutoLiveOrderIntentRecord.dependency_group.is_not(None)
        )
        .order_by(PolymarketAutoLiveOrderIntentRecord.created_at.asc())
        .limit(max(1, int(limit)))
    ).all()
    repaired: list[str] = []
    for run_id, dependency_group, execution_metadata in waiting_dependencies:
        normalized_group = str(dependency_group or "").strip()
        if not normalized_group:
            continue
        metadata = (
            execution_metadata
            if isinstance(execution_metadata, dict)
            else {}
        )
        exit_market_id = metadata.get("dependency_exit_market_id")
        if not isinstance(exit_market_id, str) or not exit_market_id.strip():
            exit_market_id = _dependency_exit_market_id(normalized_group)
        if not exit_market_id:
            continue
        exit_record = session.execute(
            select(PolymarketAutoLiveOrderIntentRecord)
            .where(PolymarketAutoLiveOrderIntentRecord.run_id == run_id)
            .where(
                PolymarketAutoLiveOrderIntentRecord.action.in_(
                    ("sell", "redeem")
                )
            )
            .where(
                PolymarketAutoLiveOrderIntentRecord.market_id
                == exit_market_id
            )
            .order_by(
                PolymarketAutoLiveOrderIntentRecord.created_at.asc()
            )
            .with_for_update(skip_locked=True)
        ).scalars().first()
        if exit_record is None or exit_record.dependency_group:
            continue
        exit_record.dependency_group = normalized_group
        repaired.append(exit_record.id)
    if repaired:
        session.flush()
    return repaired


def _update_invest_stage_outputs(run: BullpenAutoLiveRun, response: BullpenAutoLiveRunOrdersResponse) -> None:
    persisted_counts = _persisted_stage3_counts(response.orders)
    total_counts = persisted_counts["total"]
    sell_counts = persisted_counts["sell"]
    redeem_counts = persisted_counts["redeem"]
    buy_counts = persisted_counts["buy"]
    sell_intents = [
        intent for intent in response.orders if intent.action in {"sell", "redeem"}
    ]
    buy_intents = [intent for intent in response.orders if intent.action == "buy"]
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
    cancelled_by_user = (
        run.status == "failed" and run.error_message == _USER_CANCELLED_RUN_ERROR
    )
    for stage in run.stage_results:
        if (
            stage.stage_number == 3
            or stage.outputs.get("workflow_stage_key") == "invest"
        ):
            stage.outputs = {
                **stage.outputs,
                "phase_status": "cancelled"
                if cancelled_by_user
                else "running"
                if run.status == "running"
                else "confirming"
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
                            intents=sell_intents,
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
                        intents=buy_intents,
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
                if run.status in {"running", "confirming", "partial_success"}
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
        "sizing_basis": "live-economic-plus-current-run-accepted-v2",
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
            audit.update(
                {
                    key: diagnostics.get(key)
                    for key in (
                        "capacity_gate_occupied_market_count",
                        "capacity_sizing_occupied_market_count",
                        "pending_submitted_buy_market_count",
                        "current_run_submitted_buy_market_count",
                    )
                    if diagnostics.get(key) is not None
                }
            )
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
    run_record = session.scalar(
        select(PolymarketAutoLiveRunRecord)
        .where(PolymarketAutoLiveRunRecord.id == run_id)
        .where(PolymarketAutoLiveRunRecord.user_id == user_id)
        .limit(1)
    )
    if run_record is None:
        raise ValueError("Saved Auto-Live run not found.")
    run = record_to_run(run_record)
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
            1
            for intent in intents
            if intent.status in INTENT_REMOTE_CONFIRMATION_STATUSES
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
    decisions = _visible_run_decision_records_sync(
        session,
        user_id=user_id,
        run_id=run_id,
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
    cancelled_by_user = (
        run.status == "failed" and run.error_message == _USER_CANCELLED_RUN_ERROR
    )
    if not cancelled_by_user:
        run.status = derive_run_status_from_intents(response.orders)  # type: ignore[assignment]
        if run.status in {"completed", "partial_success", "failed"}:
            run.completed_at = run.completed_at or utc_now_iso()
        else:
            run.completed_at = None
        run.summary = _summary_text(run.status, response.order_funnel)
    else:
        # Order reconciliations can continue to report the factual outcome of
        # a write that was already submitted, but they must never resurrect a
        # user-killed run into confirming/running.
        run.completed_at = run.completed_at or utc_now_iso()
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


def _visible_run_decision_records_sync(
    session: Session,
    *,
    user_id: int,
    run_id: str,
) -> list[PolymarketAutoLiveDecisionRecord]:
    """Load only decisions that remain visible after reconciliation."""

    return list(
        session.execute(
            select(PolymarketAutoLiveDecisionRecord)
            .where(PolymarketAutoLiveDecisionRecord.user_id == user_id)
            .where(PolymarketAutoLiveDecisionRecord.run_id == run_id)
            .where(visible_auto_live_decision_filter())
            .order_by(PolymarketAutoLiveDecisionRecord.created_at.asc())
        )
        .scalars()
        .all()
    )


def create_or_refresh_run_order_intents_sync(
    session: Session,
    *,
    user_id: int,
    run: BullpenAutoLiveRun,
    decisions: Sequence[BullpenAutoLiveDecision],
) -> list[BullpenAutoLiveOrderIntent]:
    created_or_existing: list[PolymarketAutoLiveOrderIntentRecord] = []
    rpc_policy = _stage3_rpc_policy(run)
    expected_stage1_wallet_lineage = _expected_stage1_wallet_lineage(run)
    settings_snapshot = run.audit_metadata.get("settings_snapshot")
    settings_snapshot = (
        settings_snapshot if isinstance(settings_snapshot, dict) else {}
    )
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
            if (
                order_plan.action == "buy"
                and order_plan.dependency_group
                and initial_status == "READY"
            ):
                initial_status = "WAITING_FOR_EXIT"
            persisted_submission = initial_status not in _EXECUTABLE_STATUSES
            post_exit_sizing_policy = {
                "version": "v1",
                "enabled": bool(
                    order_plan.action == "buy"
                    and order_plan.dependency_group
                ),
                "min_order_usd": max(
                    0.01,
                    float(settings_snapshot.get("min_order_usd", 1.0) or 1.0),
                ),
                "max_order_usd": max(
                    0.01,
                    float(settings_snapshot.get("max_order_usd", 25.0) or 25.0),
                ),
                "balance_buffer_usd": auto_live_buy_balance_buffer_usd(),
                "sizing_source": "forced_fresh_post_exit_balance",
            }
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
                next_attempt_at=(
                    utc_now()
                    if initial_status == "READY" and not persisted_submission
                    else None
                ),
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
                    "state": (
                        "waiting_for_exit"
                        if initial_status == "WAITING_FOR_EXIT"
                        else "ready"
                    ),
                    "source": "stage3_planning",
                },
                execution_metadata_json={
                    "idempotency_key_format": STAGE3_ORDER_INTENT_IDEMPOTENCY_KEY_FORMAT,
                    "capacity_override_used": bool(
                        order_plan.stage3_status == "CAPACITY_OVERRIDE_USED"
                    ),
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
                    "post_exit_sizing_policy": post_exit_sizing_policy,
                    "stage3_rpc_retry_policy": rpc_policy,
                    "stage3_rpc_retry_total_wait_seconds": 0.0,
                    "stage3_rpc_retry_history": [],
                    "expected_stage1_wallet_lineage": (
                        expected_stage1_wallet_lineage
                        if expected_stage1_wallet_lineage
                        else None
                    ),
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
            intent.execution_metadata_json = {
                **existing_metadata,
                "capacity_override_used": bool(
                    existing_metadata.get("capacity_override_used")
                    or order_plan.stage3_status == "CAPACITY_OVERRIDE_USED"
                ),
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
                "expected_stage1_wallet_lineage": (
                    expected_stage1_wallet_lineage
                    if expected_stage1_wallet_lineage
                    else existing_metadata.get(
                        "expected_stage1_wallet_lineage"
                    )
                ),
                "dependency_exit_market_id": (
                    _dependency_exit_market_id(order_plan.dependency_group)
                    or existing_metadata.get("dependency_exit_market_id")
                ),
                "post_exit_sizing_policy": (
                    existing_metadata.get("post_exit_sizing_policy")
                    or {
                        "version": "v1",
                        "enabled": bool(
                            order_plan.action == "buy"
                            and order_plan.dependency_group
                        ),
                        "min_order_usd": max(
                            0.01,
                            float(
                                settings_snapshot.get("min_order_usd", 1.0)
                                or 1.0
                            ),
                        ),
                        "max_order_usd": max(
                            0.01,
                            float(
                                settings_snapshot.get("max_order_usd", 25.0)
                                or 25.0
                            ),
                        ),
                        "balance_buffer_usd": auto_live_buy_balance_buffer_usd(),
                        "sizing_source": "forced_fresh_post_exit_balance",
                    }
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


_BUY_RESERVATION_HOLD_STATUSES = frozenset(
    {
        "PLANNED",
        "READY",
        "SUBMITTING",
        "SUBMITTED",
        "CONFIRMING",
        "PARTIALLY_FILLED",
        "SETTLEMENT_PENDING",
        "RETRY_WAIT",
        "WAITING_FOR_COLLATERAL",
        "WAITING_FOR_EXIT",
    }
)
_DEFINITIVE_NO_FILL_TERMINAL_STATUSES = frozenset(
    {"FAILED_PERMANENT", "REJECTED", "CANCELLED"}
)
_DEFINITIVE_EXIT_DEPENDENCY_FAILURE_STATUSES = frozenset(
    {"DEFERRED", *_DEFINITIVE_NO_FILL_TERMINAL_STATUSES}
)
_BUY_MARKET_REMOTE_PENDING_STATUSES = frozenset(
    {
        "SUBMITTED",
        "CONFIRMING",
        "PARTIALLY_FILLED",
        "SETTLEMENT_PENDING",
    }
)
_BUY_MARKET_CONFLICT_PROOF_MAX_ROWS = 16


def _result_definitively_proves_no_fill(
    result: IntentSubmissionResult,
) -> bool:
    """Require explicit remote zero-fill evidence before releasing buy cash."""

    return (
        result.status in _DEFINITIVE_NO_FILL_TERMINAL_STATUSES
        and result.filled_shares is not None
        and float(result.filled_shares) <= 0
    )


def _result_fill_evidence(
    result: IntentSubmissionResult,
) -> dict[str, object]:
    quantity_known = result.filled_shares is not None
    return {
        "version": "v1",
        "quantity_known": quantity_known,
        "filled_shares": (
            float(result.filled_shares)
            if result.filled_shares is not None
            else None
        ),
        "definitive_zero_fill": (
            _result_definitively_proves_no_fill(result)
        ),
        "recorded_at": utc_now_iso(),
    }


def _normalized_buy_market_aliases(intent: object) -> set[str]:
    """Return exact, case-insensitive economic-market identities."""

    return {
        normalized
        for field_name in ("market_id", "condition_id", "slug")
        if (
            normalized := str(
                getattr(intent, field_name, None) or ""
            ).strip().lower()
        )
    }


def _buy_intent_definitively_proves_zero_fill(intent: object) -> bool:
    """Accept only explicit, quantity-known terminal no-fill evidence."""

    status = str(getattr(intent, "status", "") or "").upper()
    execution_metadata = getattr(intent, "execution_metadata_json", None)
    fill_evidence = (
        execution_metadata.get("reconciliation_fill_evidence")
        if isinstance(execution_metadata, dict)
        and isinstance(
            execution_metadata.get("reconciliation_fill_evidence"),
            dict,
        )
        else {}
    )
    try:
        filled_shares = float(fill_evidence.get("filled_shares"))
    except (TypeError, ValueError):
        return False
    return bool(
        status in _DEFINITIVE_NO_FILL_TERMINAL_STATUSES
        and fill_evidence.get("quantity_known") is True
        and fill_evidence.get("definitive_zero_fill") is True
        and filled_shares <= 0
    )


def _buy_intent_has_active_reservation(intent: object) -> bool:
    execution_metadata = getattr(intent, "execution_metadata_json", None)
    if (
        (_safe_float(getattr(intent, "reserved_cash_usd", 0.0)) or 0.0) > 0
        or (
            isinstance(execution_metadata, dict)
            and execution_metadata.get("reservation_state") == "active"
        )
    ):
        return True
    reservations = getattr(intent, "reservations", None)
    return bool(
        isinstance(reservations, (list, tuple))
        and any(
            str(getattr(reservation, "status", "") or "").lower()
            == "active"
            and (
                _safe_float(getattr(reservation, "amount_usd", 0.0))
                or 0.0
            )
            > 0
            for reservation in reservations
        )
    )


def _intent_evidence_datetime(value: object) -> datetime | None:
    """Parse ORM datetimes and legacy serialized timestamps consistently."""

    if isinstance(value, datetime):
        return parse_datetime(_isoformat(value))
    if isinstance(value, str):
        return parse_datetime(value)
    return None


def _buy_intent_is_unresolved_market_conflict(
    intent: object,
    *,
    verified_absent_after: datetime | None,
) -> bool:
    """Keep every possible prior BUY fill fenced until zero is proven."""

    status = str(getattr(intent, "status", "") or "").upper()
    if status in INTENT_TERMINAL_SUCCESS_STATUSES:
        terminal_evidence_at = next(
            (
                parsed
                for field_name in (
                    "confirmed_at",
                    "terminal_at",
                    "last_submitted_at",
                    "first_submitted_at",
                )
                if (
                    parsed := _intent_evidence_datetime(
                        getattr(intent, field_name, None)
                    )
                )
                is not None
            ),
            None,
        )
        # The forced-fresh wallet read may safely supersede a known settled
        # BUY only when it was fetched after that terminal evidence and found
        # no matching exposure. A fill racing after the wallet read therefore
        # remains fenced by this database check.
        return bool(
            verified_absent_after is None
            or terminal_evidence_at is None
            or verified_absent_after <= terminal_evidence_at
        )
    if _buy_intent_definitively_proves_zero_fill(intent):
        return False
    if status in _BUY_MARKET_REMOTE_PENDING_STATUSES:
        return True
    if _intent_has_persisted_submission_reference(intent):
        return True
    return bool(
        status in _BUY_RESERVATION_HOLD_STATUSES
        and _buy_intent_has_active_reservation(intent)
    )


def _matching_unresolved_buy_market_intents(
    session: Session,
    *,
    intent: PolymarketAutoLiveOrderIntentRecord,
) -> list[PolymarketAutoLiveOrderIntentRecord]:
    """Read exact same-market BUY fences inside the singleton account lock."""

    target_aliases = _normalized_buy_market_aliases(intent)
    if not target_aliases:
        return []
    execution_metadata = getattr(intent, "execution_metadata_json", None)
    wallet_snapshot_lineage = (
        execution_metadata.get("wallet_snapshot_lineage")
        if isinstance(execution_metadata, dict)
        and isinstance(
            execution_metadata.get("wallet_snapshot_lineage"),
            dict,
        )
        else {}
    )
    verified_absent_after = parse_datetime(
        str(wallet_snapshot_lineage.get("fetched_at"))
        if wallet_snapshot_lineage.get("fetched_at")
        else None
    )
    model = PolymarketAutoLiveOrderIntentRecord
    alias_predicates = [
        func.lower(func.trim(column)).in_(target_aliases)
        for column in (model.market_id, model.condition_id, model.slug)
    ]
    candidates = (
        session.execute(
            select(model)
            .where(model.id != intent.id)
            .where(model.action == "buy")
            .where(or_(*alias_predicates))
            .options(selectinload(model.reservations))
            .order_by(model.created_at.asc(), model.id.asc())
        )
        .scalars()
        .all()
    )
    return [
        candidate
        for candidate in candidates
        if _normalized_buy_market_aliases(candidate) & target_aliases
        and _buy_intent_is_unresolved_market_conflict(
            candidate,
            verified_absent_after=verified_absent_after,
        )
    ]


def _buy_market_exposure_preflight_proof(
    *,
    intent: object,
    conflicts: Sequence[object],
) -> dict[str, object]:
    target_aliases = sorted(_normalized_buy_market_aliases(intent))
    conflict_rows = [
        {
            "intent_id": str(getattr(conflict, "id", "") or ""),
            "status": str(getattr(conflict, "status", "") or ""),
            "matched_aliases": sorted(
                _normalized_buy_market_aliases(conflict)
                & set(target_aliases)
            ),
            "persisted_write_evidence": (
                _intent_has_persisted_submission_reference(conflict)
            ),
            "active_reservation": _buy_intent_has_active_reservation(
                conflict
            ),
            "definitive_zero_fill": (
                _buy_intent_definitively_proves_zero_fill(conflict)
            ),
        }
        for conflict in conflicts[:_BUY_MARKET_CONFLICT_PROOF_MAX_ROWS]
    ]
    return {
        "version": "v1",
        "checked_at": utc_now_iso(),
        "market_wide": True,
        "scope": "singleton_bullpen_runtime",
        "target_aliases": target_aliases,
        "conflict_count": len(conflicts),
        "conflicts": conflict_rows,
        "conflicts_truncated": (
            len(conflicts) > _BUY_MARKET_CONFLICT_PROOF_MAX_ROWS
        ),
        "result": "blocked" if conflicts else "pass",
    }


def _persist_buy_market_exposure_preflight(
    session: Session,
    *,
    intent: PolymarketAutoLiveOrderIntentRecord,
    proof: dict[str, object],
) -> None:
    _persist_buy_preflight_evidence(
        session,
        intent=intent,
        metadata_key="buy_market_exposure_preflight",
        attempt_key="_stage3_buy_market_exposure_preflight",
        proof=proof,
    )


def _persist_buy_preflight_evidence(
    session: Session,
    *,
    intent: PolymarketAutoLiveOrderIntentRecord,
    metadata_key: str,
    attempt_key: str,
    proof: dict[str, object],
) -> None:
    execution_metadata = getattr(intent, "execution_metadata_json", None)
    intent.execution_metadata_json = {
        **dict(execution_metadata or {}),
        metadata_key: proof,
    }
    if int(getattr(intent, "attempt_count", 0) or 0) <= 0:
        return
    attempt = session.execute(
        select(PolymarketAutoLiveOrderAttemptRecord)
        .where(
            PolymarketAutoLiveOrderAttemptRecord.intent_id == intent.id
        )
        .where(
            PolymarketAutoLiveOrderAttemptRecord.attempt_number
            == intent.attempt_count
        )
    ).scalar_one_or_none()
    if attempt is not None:
        attempt.sanitized_request_json = {
            **dict(attempt.sanitized_request_json or {}),
            attempt_key: proof,
        }


def _buy_cash_reservation_preflight_proof(
    *,
    available_balance_usd: float,
    available_balance_checked_at: datetime | None,
    balance_buffer_usd: float,
    spendable_cash_usd: float,
    held_reservation_usd: float,
    needed_usd: float,
    unreserved_cash_usd: float,
    can_reserve: bool,
) -> dict[str, object]:
    """Freeze the exact singleton-collateral calculation before a BUY write."""

    return {
        "version": "v2",
        "checked_at": utc_now_iso(),
        "balance_checked_at": _isoformat(
            available_balance_checked_at
        ),
        "scope": "singleton_bullpen_runtime",
        "available_balance_usd": round(available_balance_usd, 2),
        "balance_buffer_usd": round(balance_buffer_usd, 2),
        "spendable_cash_usd": round(spendable_cash_usd, 2),
        "held_reservation_usd": round(held_reservation_usd, 2),
        "requested_order_usd": round(needed_usd, 2),
        "unreserved_cash_usd": round(unreserved_cash_usd, 2),
        "includes_unseen_consumed_reservations": True,
        "result": "pass" if can_reserve else "blocked",
    }


def _active_reserved_cash(
    session: Session,
    *,
    user_id: int,
    exclude_intent_id: str | None = None,
    verified_balance_checked_at: datetime | None = None,
) -> float:
    """Count singleton-runtime debits absent from the verified cash snapshot.

    Older rows could retain ``active`` after their buy intent became terminal
    or deferred. Joining the intent state makes those leaked rows harmless
    immediately, while ambiguous or persisted submissions remain fenced.
    The Bullpen CLI credential store is host-global, so reservations from every
    app user share one collateral scope even though ownership remains per user.
    A successful BUY moves its reservation to ``consumed``. Keep that debit in
    the sum until a balance read strictly newer than the terminal fill exists;
    otherwise a concurrent worker could reserve against pre-fill cash.
    """

    del user_id
    intent = PolymarketAutoLiveOrderIntentRecord
    reservation = PolymarketAutoLiveCapitalReservationRecord
    active_reservation_holds_cash = and_(
        reservation.status == "active",
        or_(
            intent.status.in_(_BUY_RESERVATION_HOLD_STATUSES),
            and_(
                intent.status.in_(
                    (
                        "DEFERRED",
                        "FAILED_PERMANENT",
                        "REJECTED",
                        "CANCELLED",
                        "TIMED_OUT",
                    )
                ),
                or_(
                    intent.remote_order_id.is_not(None),
                    intent.remote_transaction_hash.is_not(None),
                    intent.first_submitted_at.is_not(None),
                    intent.last_submitted_at.is_not(None),
                ),
            ),
        ),
    )
    consumed_at = func.coalesce(
        intent.terminal_at,
        intent.confirmed_at,
        intent.last_submitted_at,
        intent.first_submitted_at,
        reservation.updated_at,
    )
    consumed_reservation_is_unseen = and_(
        reservation.status == "consumed",
        (
            True
            if verified_balance_checked_at is None
            else or_(
                consumed_at.is_(None),
                consumed_at >= verified_balance_checked_at,
            )
        ),
    )
    query = (
        select(func.coalesce(func.sum(reservation.amount_usd), 0.0))
        .join(intent, intent.id == reservation.order_intent_id)
        .where(intent.action == "buy")
        .where(
            or_(
                active_reservation_holds_cash,
                consumed_reservation_is_unseen,
            )
        )
    )
    if exclude_intent_id:
        query = query.where(
            reservation.order_intent_id != exclude_intent_id
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


def _release_buy_reservation_if_no_remote_evidence(
    session: Session,
    record: PolymarketAutoLiveOrderIntentRecord,
    *,
    reason: str,
    definitive_no_fill: bool = False,
) -> bool:
    """Release terminal/deferred buy cash only when no write may exist."""

    if record.action != "buy":
        return False
    if record.status not in (INTENT_TERMINAL_FAILURE_STATUSES | {"DEFERRED"}):
        return False
    if (
        _intent_has_persisted_submission_reference(record)
        and not definitive_no_fill
    ):
        return False
    metadata = dict(record.execution_metadata_json or {})
    reservation_active = (
        float(record.reserved_cash_usd or 0.0) > 0
        or metadata.get("reservation_state") == "active"
    )
    if not reservation_active:
        return False
    _release_reservation(session, record)
    record.execution_metadata_json = {
        **dict(record.execution_metadata_json or {}),
        "reservation_release_reason": reason,
        "reservation_released_at": utc_now_iso(),
    }
    return True


def _wake_waiting_buys_after_exit_success(
    session: Session,
    *,
    exit_record: PolymarketAutoLiveOrderIntentRecord,
    confirmed_at: datetime | None = None,
) -> list[str]:
    """Wake only dependency-compatible buys after a durable exit succeeds."""

    if exit_record.action not in {"sell", "redeem"}:
        return []
    ready_at = confirmed_at or utc_now()
    ready_at_iso = _isoformat(ready_at) or utc_now_iso()
    awakened: list[str] = []
    waiting_records = session.execute(
        select(PolymarketAutoLiveOrderIntentRecord)
        .where(PolymarketAutoLiveOrderIntentRecord.run_id == exit_record.run_id)
        .where(
            PolymarketAutoLiveOrderIntentRecord.status.in_(
                ("WAITING_FOR_COLLATERAL", "WAITING_FOR_EXIT")
            )
        )
        .with_for_update(skip_locked=True)
    ).scalars()
    for waiting in waiting_records:
        waiting_for_exit = waiting.status == "WAITING_FOR_EXIT"
        waiting_metadata = (
            waiting.execution_metadata_json
            if isinstance(waiting.execution_metadata_json, dict)
            else {}
        )
        legacy_exit_market_id = waiting_metadata.get(
            "dependency_exit_market_id"
        )
        if (
            not isinstance(legacy_exit_market_id, str)
            or not legacy_exit_market_id.strip()
        ):
            legacy_exit_market_id = _dependency_exit_market_id(
                waiting.dependency_group
            )
        legacy_pair_matches = bool(
            waiting_for_exit
            and not exit_record.dependency_group
            and waiting.dependency_group
            and legacy_exit_market_id == exit_record.market_id
        )
        if (
            waiting_for_exit
            and waiting.dependency_group != exit_record.dependency_group
            and not legacy_pair_matches
        ):
            continue
        if legacy_pair_matches:
            exit_record.dependency_group = waiting.dependency_group
        waiting.status = "READY"
        waiting.retryable = True
        waiting.next_attempt_at = ready_at
        waiting.execution_metadata_json = {
            **dict(waiting.execution_metadata_json or {}),
            "stage3_status": "BUY_READY",
            "dependency_exit_market_id": exit_record.market_id,
        }
        if waiting_for_exit:
            waiting.dependency_metadata_json = {
                **dict(waiting.dependency_metadata_json or {}),
                "state": "ready",
                "exit_confirmed_at": ready_at_iso,
                "exit_intent_id": exit_record.id,
            }
        awakened.append(waiting.id)
    return awakened


def list_due_order_intent_ids_sync(
    session: Session,
    *,
    limit: int = 50,
    statuses: Sequence[str] | None = None,
    now: datetime | None = None,
    run_id: str | None = None,
) -> list[str]:
    due_at = now or utc_now()
    due_statuses = tuple(
        statuses
        or sorted(
            (_EXECUTABLE_STATUSES - {"WAITING_FOR_EXIT"})
            | _RECONCILABLE_STATUSES
        )
    )
    query = (
        select(PolymarketAutoLiveOrderIntentRecord.id)
        .where(PolymarketAutoLiveOrderIntentRecord.status.in_(due_statuses))
        .where(
            or_(
                PolymarketAutoLiveOrderIntentRecord.next_attempt_at.is_(None),
                PolymarketAutoLiveOrderIntentRecord.next_attempt_at <= due_at,
            )
        )
    )
    if run_id is not None:
        query = query.where(PolymarketAutoLiveOrderIntentRecord.run_id == run_id)
    query = query.order_by(
        PolymarketAutoLiveOrderIntentRecord.priority.asc(),
        PolymarketAutoLiveOrderIntentRecord.created_at.asc(),
    ).limit(limit)
    records = session.execute(query).scalars().all()
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
    A replacement buy left in ``WAITING_FOR_EXIT`` after a lost wake-up is
    promoted only when a committed terminal-success sibling proves the exit.
    """

    current = now or utc_now()
    submitting_stale_before = current - timedelta(
        seconds=max(60, int(os.getenv("AUTO_LIVE_SUBMITTING_STALE_SECONDS", "600")))
    )
    # Backward compatibility for already-persisted runs created while only
    # replacement BUY rows received a dependency group.  Repair the paired
    # EXIT before the correlated terminal-sibling query below.
    _repair_legacy_replacement_exit_dependency_groups(
        session,
        limit=limit,
    )
    dependency_exit = aliased(PolymarketAutoLiveOrderIntentRecord)
    terminal_dependency_exit_exists = (
        select(dependency_exit.id)
        .where(
            dependency_exit.run_id
            == PolymarketAutoLiveOrderIntentRecord.run_id
        )
        .where(
            dependency_exit.dependency_group
            == PolymarketAutoLiveOrderIntentRecord.dependency_group
        )
        .where(dependency_exit.action.in_(("sell", "redeem")))
        .where(
            dependency_exit.status.in_(
                tuple(INTENT_TERMINAL_SUCCESS_STATUSES)
            )
        )
        .exists()
    )
    records = (
        session.execute(
            select(PolymarketAutoLiveOrderIntentRecord)
            .where(
                or_(
                    PolymarketAutoLiveOrderIntentRecord.status == "PLANNED",
                    and_(
                        PolymarketAutoLiveOrderIntentRecord.status.in_(
                            ("READY", "RETRY_WAIT", "WAITING_FOR_COLLATERAL")
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
                    and_(
                        PolymarketAutoLiveOrderIntentRecord.status
                        == "WAITING_FOR_EXIT",
                        PolymarketAutoLiveOrderIntentRecord.action == "buy",
                        terminal_dependency_exit_exists,
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
        elif record.status == "WAITING_FOR_EXIT":
            confirmed_exit = session.execute(
                select(PolymarketAutoLiveOrderIntentRecord)
                .where(
                    PolymarketAutoLiveOrderIntentRecord.run_id
                    == record.run_id
                )
                .where(
                    PolymarketAutoLiveOrderIntentRecord.dependency_group
                    == record.dependency_group
                )
                .where(
                    PolymarketAutoLiveOrderIntentRecord.action.in_(
                        ("sell", "redeem")
                    )
                )
                .where(
                    PolymarketAutoLiveOrderIntentRecord.status.in_(
                        tuple(INTENT_TERMINAL_SUCCESS_STATUSES)
                    )
                )
                .order_by(
                    PolymarketAutoLiveOrderIntentRecord.created_at.asc()
                )
            ).scalars().first()
            if confirmed_exit is None:
                # The correlated EXISTS row can only disappear if historical
                # state was mutated unexpectedly. Leave the dependency fenced.
                continue
            exit_confirmed_at = (
                confirmed_exit.confirmed_at
                or confirmed_exit.terminal_at
                or confirmed_exit.updated_at
                or current
            )
            record.status = "READY"
            record.retryable = True
            record.next_attempt_at = current
            record.last_error_code = "DEPENDENCY_WAKE_RECOVERED"
            record.last_error_message = (
                "Watchdog recovered a replacement buy after its durable exit "
                "had already completed."
            )
            record.dependency_metadata_json = {
                **dict(record.dependency_metadata_json or {}),
                "state": "ready",
                "exit_confirmed_at": (
                    _isoformat(exit_confirmed_at) or utc_now_iso()
                ),
                "exit_intent_id": confirmed_exit.id,
                "wake_recovered_at": _isoformat(current),
            }
            metadata["stage3_status"] = "BUY_READY"
            metadata["dependency_exit_market_id"] = (
                confirmed_exit.market_id
            )
            event["resolution"] = "recovered_lost_exit_wake_to_READY"
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
    """Recover proven-lost runs after restart without racing redelivery.

    This function used to call ``mark_interrupted_run_for_restart`` before it
    had established that a planning task was actually lost.  A systemd restart
    can legitimately leave a late-acknowledged task queued/reserved until a
    new worker receives it.  Reuse normal lifecycle-aware recovery so queued,
    reserved, fresh-heartbeat, PENDING, and partial-inspect cases remain
    recoverable.  ``confirming`` runs already handed Stage 3 to durable intents
    and are intentionally left for reconciliation rather than terminalized.
    """

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
        if run.status == "confirming":
            logger.info(
                "Leaving confirming Auto-Live run %s for durable order-intent reconciliation.",
                run_record.id,
            )
            continue

        registered_run_task_id = get_registered_auto_live_run_task_id_sync(
            run_record.id
        )
        if registered_run_task_id in active_task_ids:
            logger.info(
                "Leaving Auto-Live run %s active because Celery confirms its planning task.",
                run_record.id,
            )
            continue

        interrupted_run = reconcile_running_auto_live_run(
            run,
            started_at=run_record.started_at,
            updated_at=run_record.updated_at,
            now=current,
        )
        if interrupted_run is None:
            # This includes QUEUED/RESERVED, fresh heartbeat, ambiguous
            # PENDING, redelivery, and incomplete Celery inspect responses.
            continue

        # Persisted terminal workflow stages can be finalized by recovery but
        # must not be treated as a restart interruption or mutate order intents.
        if interrupted_run.status in {"completed", "partial_success", "skipped"}:
            apply_run_to_record(run_record, interrupted_run, user_id=run_record.user_id)
            state_record = session.get(PolymarketAutoLiveStateRecord, run_record.user_id)
            if state_record is not None:
                state = record_to_state(state_record)
                state.last_run_id = interrupted_run.id
                state.last_run_at = interrupted_run.completed_at
                state.last_action = interrupted_run.summary
                state.last_error = None
                apply_state_to_record(state_record, state)
            recovered_ids.append(run_record.id)
            continue

        if interrupted_run.status != "failed":
            continue

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
        if active_task_ids.intersection(dispatched_intent_task_ids):
            logger.info(
                "Leaving Auto-Live run %s active because Celery still confirms "
                "its order task is executing on another worker.",
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
                _release_buy_reservation_if_no_remote_evidence(
                    session,
                    intent,
                    reason=(
                        "Startup recovery deferred an unsubmitted buy until an "
                        "operator can safely resume the run."
                    ),
                )
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
        app = _configured_celery_app()
        payload = app.control.inspect(timeout=1.0).active() or {}
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
    task_name: str = "execute_auto_live_order_intent",
    operation: str = "execute",
) -> None:
    record = session.get(PolymarketAutoLiveOrderIntentRecord, intent_id)
    if record is None:
        return
    metadata = dict(record.execution_metadata_json or {})
    metadata.update({
        "last_dispatch_at": utc_now_iso(),
        "last_dispatch_task_id": task_id,
        "last_dispatch_queue": queue,
        "last_dispatch_task": task_name,
        "last_dispatch_operation": operation,
        "required_queue": queue,
        "last_dispatch_worker": worker,
    })
    if record.status in {"PLANNED", "READY", "RETRY_WAIT", "WAITING_FOR_COLLATERAL", "WAITING_FOR_EXIT"}:
        metadata["current_blockage"] = (
            "Dispatched to Celery; waiting for an ai worker to receive "
            f"{task_name}."
        )
        metadata["how_to_resolve"] = "If this stays unchanged, restart investor-celery-worker with CELERY_WORKER_QUEUES including ai."
    record.execution_metadata_json = metadata
    session.flush()


def celery_ai_queue_consumer_diagnostics(timeout: float = 1.0) -> dict[str, object]:
    try:
        inspect = _configured_celery_app().control.inspect(timeout=timeout)
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


def _intent_user_mutation_lock_query(*, user_id: int, intent_id: str):
    """Serialize operator state changes with worker submission transitions."""

    model = PolymarketAutoLiveOrderIntentRecord
    return (
        select(model)
        .where(model.id == intent_id)
        .where(model.user_id == user_id)
        .execution_options(populate_existing=True)
        .with_for_update()
    )


def _lock_intent_for_user_mutation(
    session: Session,
    *,
    user_id: int,
    intent_id: str,
) -> PolymarketAutoLiveOrderIntentRecord | None:
    return session.execute(
        _intent_user_mutation_lock_query(
            user_id=user_id,
            intent_id=intent_id,
        )
    ).scalar_one_or_none()


def retry_order_intent_sync(
    session: Session,
    *,
    user_id: int,
    intent_id: str,
    remote_absence_verified: bool = False,
) -> BullpenAutoLiveRunOrdersResponse:
    record = _lock_intent_for_user_mutation(
        session,
        user_id=user_id,
        intent_id=intent_id,
    )
    if record is None:
        raise ValueError("Order intent not found.")
    previous_status = record.status
    _assert_intent_retry_allowed(
        record,
        remote_absence_verified=remote_absence_verified,
    )
    retried_at = utc_now_iso()
    record.status = "READY"
    record.retryable = True
    record.next_attempt_at = utc_now()
    record.last_error_message = None
    record.max_attempts = max(record.max_attempts, record.attempt_count + 1)
    record.version += 1
    record.execution_metadata_json = {
        **dict(record.execution_metadata_json or {}),
        "manual_retry_requested_at": retried_at,
        "manual_retry_previous_status": previous_status,
        "remote_absence_verified": bool(remote_absence_verified),
        "remote_absence_verified_at": (
            retried_at if remote_absence_verified else None
        ),
        "recovery_required": False,
        "current_blockage": None,
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
    record = _lock_intent_for_user_mutation(
        session,
        user_id=user_id,
        intent_id=intent_id,
    )
    if record is None:
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


def cancel_unsubmitted_run_order_intents_for_user_sync(
    *,
    user_id: int,
    run_id: str,
) -> list[str]:
    """Cancel every safe-to-stop intent for a user-cancelled Auto-Live run.

    Submitted or reconciling intents are deliberately left alone: their remote
    state is ambiguous and must be reconciled instead of being represented as a
    local cancellation.  The execution worker checks the same run marker again
    immediately before its remote write.
    """
    with SyncSessionLocal() as session:
        run_record = session.execute(
            select(PolymarketAutoLiveRunRecord)
            .where(PolymarketAutoLiveRunRecord.id == run_id)
            .where(PolymarketAutoLiveRunRecord.user_id == user_id)
            .execution_options(populate_existing=True)
        ).scalar_one_or_none()
        if (
            run_record is None
            or run_record.status != "failed"
            or run_record.error_message != _USER_CANCELLED_RUN_ERROR
        ):
            return []

        records = (
            session.execute(
                select(PolymarketAutoLiveOrderIntentRecord)
                .where(PolymarketAutoLiveOrderIntentRecord.user_id == user_id)
                .where(PolymarketAutoLiveOrderIntentRecord.run_id == run_id)
                .where(
                    PolymarketAutoLiveOrderIntentRecord.status.in_(
                        _USER_CANCELLABLE_INTENT_STATUSES
                    )
                )
                .with_for_update(skip_locked=True)
            )
            .scalars()
            .all()
        )
        cancelled_ids = [
            record.id
            for record in records
            if _cancel_unsubmitted_intent_for_user(session, record=record)
        ]
        if cancelled_ids:
            sync_run_and_decisions_from_intents_sync(
                session,
                user_id=user_id,
                run_id=run_id,
            )
        session.commit()
        return cancelled_ids


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
    """Keep a reserved replacement buy queued until its exit is terminal.

    Lock the exit row before deciding to persist ``WAITING_FOR_EXIT``. Exit
    reconciliation updates that same row before scanning for dependent buys,
    so either this transaction queues the buy first and the wake scan observes
    it, or this transaction waits and observes the committed terminal exit.
    """

    if record.action != "buy" or not record.dependency_group:
        return False
    raw_execution_metadata = getattr(
        record,
        "execution_metadata_json",
        None,
    )
    metadata = (
        raw_execution_metadata
        if isinstance(raw_execution_metadata, dict)
        else {}
    )
    legacy_exit_market_id = metadata.get("dependency_exit_market_id")
    if (
        not isinstance(legacy_exit_market_id, str)
        or not legacy_exit_market_id.strip()
    ):
        legacy_exit_market_id = _dependency_exit_market_id(
            record.dependency_group
        )
    dependency_predicates = [
        PolymarketAutoLiveOrderIntentRecord.dependency_group
        == record.dependency_group
    ]
    if legacy_exit_market_id:
        dependency_predicates.append(
            and_(
                PolymarketAutoLiveOrderIntentRecord.dependency_group.is_(None),
                PolymarketAutoLiveOrderIntentRecord.market_id
                == legacy_exit_market_id,
            )
        )
    sibling = session.execute(
        select(PolymarketAutoLiveOrderIntentRecord)
        .where(PolymarketAutoLiveOrderIntentRecord.run_id == record.run_id)
        .where(or_(*dependency_predicates))
        .where(PolymarketAutoLiveOrderIntentRecord.action.in_(("sell", "redeem")))
        .where(PolymarketAutoLiveOrderIntentRecord.id != record.id)
        .order_by(PolymarketAutoLiveOrderIntentRecord.created_at.asc())
        .with_for_update()
    ).scalars().first()
    if sibling is None:
        record.status = "DEFERRED"
        record.retryable = False
        record.next_attempt_at = None
        record.last_error_code = "DEPENDENCY_EXIT_MISSING"
        record.last_error_message = (
            "Replacement buy dependency is missing its durable exit intent; "
            "no external buy write was issued."
        )
        record.execution_metadata_json = {
            **dict(raw_execution_metadata or {}),
            "stage3_status": "BUY_FAILED",
            "current_blockage": record.last_error_message,
            "automatic_resubmission": False,
        }
        _release_buy_reservation_if_no_remote_evidence(
            session,
            record,
            reason=(
                "Replacement buy was deferred because its durable exit "
                "dependency record is missing."
            ),
            definitive_no_fill=True,
        )
        attempt.completed_at = utc_now()
        attempt.result_status = record.status
        attempt.error_code = record.last_error_code
        attempt.error_message = record.last_error_message
        return True
    if not sibling.dependency_group:
        sibling.dependency_group = record.dependency_group
    if sibling.status in INTENT_TERMINAL_SUCCESS_STATUSES:
        return False
    definitive_exit_failure = (
        sibling.status in _DEFINITIVE_EXIT_DEPENDENCY_FAILURE_STATUSES
    )
    record.status = "DEFERRED" if definitive_exit_failure else "WAITING_FOR_EXIT"
    record.retryable = record.status != "DEFERRED"
    record.next_attempt_at = utc_now() + timedelta(seconds=5) if record.retryable else None
    record.last_error_code = "SETTLEMENT_PENDING"
    record.last_error_message = (
        f"Replacement buy is reserved for exit {sibling.market_id}; exit status is {sibling.status}."
    )
    record.execution_metadata_json = {
        **dict(raw_execution_metadata or {}),
        "stage3_status": "REPLACEMENT_SLOT_RESERVED",
        "dependency_exit_intent_id": sibling.id,
        "dependency_exit_market_id": sibling.market_id,
    }
    _release_buy_reservation_if_no_remote_evidence(
        session,
        record,
        reason=(
            f"Replacement exit {sibling.market_id} failed before the dependent "
            "buy could be submitted."
        ),
        definitive_no_fill=definitive_exit_failure,
    )
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
    slug: str | None = None,
) -> bool:
    if side and str(getattr(position, "side", "")).upper() != side.upper():
        return False
    aliases = {
        str(value).strip().lower()
        for value in (
            getattr(position, "market_id", None),
            getattr(position, "condition_id", None),
            getattr(position, "slug", None),
        )
        if isinstance(value, str) and value.strip()
    }
    target_aliases = {
        str(value).strip().lower()
        for value in (market_id, condition_id, slug)
        if isinstance(value, str) and value.strip()
    }
    return bool(aliases & target_aliases)


_SELL_REDEEM_CLASSIFICATIONS = frozenset(
    {"positive_payout_claimable", "positive_payout", "claimable"}
)
_SELL_NON_TRADABLE_CLASSIFICATIONS = frozenset(
    {
        "closed",
        "closed_position",
        "fully_exited",
        "fully_redeemed",
        "fully_redeemed_position",
        "redeemed",
        "resolved_zero_payout",
        "settled",
        "settlement",
        "settlement-only",
        "settlement_only",
        "settlement_pending",
        "stale_or_unknown",
    }
)


def _position_requires_redeem(position: object, *, dust_threshold_usd: float) -> bool:
    classification = str(getattr(position, "classification", "") or "").lower()
    is_claimable = bool(getattr(position, "is_claimable", False))
    if classification == "active" and not is_claimable:
        return False
    if classification in _SELL_REDEEM_CLASSIFICATIONS or is_claimable:
        return True
    classifier_unavailable = classification in {"", "unknown", "unclassified"}
    return bool(
        classifier_unavailable
        and (
            float(getattr(position, "claimable_value_usd", 0.0) or 0.0)
            > dust_threshold_usd
            or float(getattr(position, "expected_payout_usdc", 0.0) or 0.0)
            > dust_threshold_usd
        )
    )


def _position_is_non_tradable(position: object) -> bool:
    classification = str(getattr(position, "classification", "") or "").lower()
    resolution_status = str(
        getattr(position, "resolution_status", "") or ""
    ).lower()
    if classification == "active":
        return False
    if classification in _SELL_NON_TRADABLE_CLASSIFICATIONS:
        return True
    classifier_unavailable = classification in {"", "unknown", "unclassified"}
    return bool(
        classifier_unavailable
        and resolution_status
        in {"closed", "resolved", "redeemed", "settled", "finalized"}
    )


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


def _expected_reconciliation_wallet_lineage(
    intent: BullpenAutoLiveOrderIntent,
) -> dict[str, object]:
    metadata = dict(intent.execution_metadata_json or {})
    for candidate in (
        metadata.get("wallet_snapshot_lineage"),
        metadata.get("sell_live_preflight"),
        metadata.get("expected_stage1_wallet_lineage"),
    ):
        if isinstance(candidate, dict) and candidate:
            return dict(candidate)
    return {}


async def _read_post_submit_wallet_snapshot(
    intent: BullpenAutoLiveOrderIntent,
    *,
    caller_source: str,
) -> tuple[
    ConsoleWalletPositionsSnapshot,
    dict[str, object],
    dict[str, object],
]:
    """Read one force-fresh, post-attempt, same-lineage wallet snapshot."""

    request_started_at = utc_now()
    snapshot = await read_console_wallet_positions_snapshot(
        force_fresh=True,
        caller_source=caller_source,
        max_age_seconds=0,
    )
    actual_lineage = _validate_force_fresh_wallet_snapshot(
        snapshot=snapshot,
        request_started_at=request_started_at,
    )
    submitted_at = parse_datetime(
        intent.last_submitted_at or intent.first_submitted_at
    )
    fetched_at = parse_datetime(snapshot.fetched_at)
    if submitted_at is not None and (
        fetched_at is None or fetched_at <= submitted_at
    ):
        raise AutoLiveExecutorError(
            code="POSITION_UNAVAILABLE",
            message=(
                "Post-submit wallet reconciliation requires a force-fresh "
                "snapshot fetched after the external order attempt."
            ),
            retryable=True,
            ambiguous_submission=True,
        )
    expected_lineage = _expected_reconciliation_wallet_lineage(intent)
    comparison = _compare_wallet_snapshot_lineage(
        expected=expected_lineage,
        actual=actual_lineage,
    )
    if comparison["status"] == "mismatch":
        raise AutoLiveExecutorError(
            code="POSITION_LINEAGE_MISMATCH",
            message=(
                "Post-submit wallet reconciliation rejected a different "
                "account, credential, classifier, or older wallet lineage."
            ),
            retryable=True,
            ambiguous_submission=True,
        )
    return snapshot, actual_lineage, comparison


def _post_exit_replacement_sizing(
    *,
    available_balance_usd: float | None,
    economically_active_position_count: int,
    slot_limit: int,
    min_order_usd: float,
    max_order_usd: float,
    balance_buffer_usd: float,
) -> dict[str, float | int]:
    """Calculate a replacement order only from fresh post-exit state."""

    gross_cash_cents = _usd_to_cents(available_balance_usd)
    buffer_cents = _usd_to_cents(balance_buffer_usd)
    spendable_cash_cents = max(0, gross_cash_cents - buffer_cents)
    minimum_cents = max(1, _usd_to_cents(min_order_usd))
    maximum_cents = max(minimum_cents, _usd_to_cents(max_order_usd))
    available_slots = max(
        0,
        int(slot_limit) - max(0, int(economically_active_position_count)),
    )
    cash_affordable_slots = spendable_cash_cents // minimum_cents
    affordable_slots = min(available_slots, cash_affordable_slots)
    order_cents = (
        min(
            maximum_cents,
            int(
                (
                    Decimal(spendable_cash_cents)
                    / Decimal(affordable_slots)
                ).to_integral_value(rounding=ROUND_HALF_UP)
            ),
        )
        if affordable_slots > 0
        else 0
    )
    return {
        "gross_cash_in_hand_usd": gross_cash_cents / 100,
        "balance_buffer_usd": buffer_cents / 100,
        "spendable_cash_usd": spendable_cash_cents / 100,
        "economically_active_position_count": max(
            0,
            int(economically_active_position_count),
        ),
        "available_slots": available_slots,
        "cash_affordable_slot_count": cash_affordable_slots,
        "affordable_slot_count": affordable_slots,
        "min_order_usd": minimum_cents / 100,
        "max_order_usd": maximum_cents / 100,
        "order_usd": order_cents / 100,
    }


async def _prepare_intent_submission(intent: BullpenAutoLiveOrderIntent) -> PreparedIntentSubmission:
    live_controls = await refresh_live_controls(user_id=intent.user_id)
    if live_controls.emergency_stopped:
        raise AutoLiveExecutorError(
            code="EMERGENCY_STOP",
            message="Emergency stop is active.",
            retryable=False,
        )
    if not live_controls.doctor.ok:
        raise AutoLiveExecutorError(
            code="DOCTOR_READ_FAILED",
            message=live_controls.doctor.message or "Bullpen doctor failed.",
            retryable=True,
        )
    if not live_controls.unlocked:
        raise AutoLiveExecutorError(
            code="LIVE_LOCKED",
            message=live_controls.locked_reason or "Live execution is locked.",
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
    sell_preflight_metadata: dict[str, object] = {}
    wallet_lineage_comparison: dict[str, object] = {
        "status": "unavailable",
        "compared_fields": [],
        "mismatches": [],
    }
    wallet_snapshot_lineage: dict[str, object] = {}
    redeem_preflight_wallet_positions: tuple[object, ...] = ()
    if intent.action == "buy":
        capacity_policy = intent.execution_metadata_json.get("stage3_capacity_policy")
        capacity_policy = capacity_policy if isinstance(capacity_policy, dict) else {}
        dust_threshold = float(capacity_policy.get("dust_threshold_usd", 0.01) or 0.01)
        snapshot_request_started_at = utc_now()
        live_snapshot = await read_console_wallet_positions_snapshot(
            force_fresh=True,
            caller_source="auto-live-stage3-buy-pre-submit",
            max_age_seconds=0,
        )
        actual_lineage = _validate_force_fresh_wallet_snapshot(
            snapshot=live_snapshot,
            request_started_at=snapshot_request_started_at,
        )
        wallet_snapshot_lineage = actual_lineage
        expected_stage1_wallet_lineage = (
            intent.execution_metadata_json.get(
                "expected_stage1_wallet_lineage"
            )
        )
        wallet_lineage_comparison = _compare_wallet_snapshot_lineage(
            expected=expected_stage1_wallet_lineage,
            actual=actual_lineage,
        )
        if (
            not _wallet_identity_lineage_is_complete(actual_lineage)
            or not _wallet_identity_lineage_is_complete(
                expected_stage1_wallet_lineage
            )
        ):
            raise AutoLiveExecutorError(
                code="POSITION_LINEAGE_UNAVAILABLE",
                message=(
                    "Stage 3 buy pre-submit requires complete matching Stage 1 "
                    "and forced-fresh account, credential-artifact, and "
                    "position-classifier lineage; no external buy write was "
                    "issued."
                ),
                retryable=True,
            )
        if wallet_lineage_comparison["status"] == "mismatch":
            raise AutoLiveExecutorError(
                code="POSITION_LINEAGE_MISMATCH",
                message=(
                    "Stage 3 buy pre-submit rejected wallet state from a "
                    "different account, credential, classifier, or older "
                    "Stage 1 lineage; no external buy write was issued."
                ),
                retryable=False,
            )
        if wallet_lineage_comparison["status"] != "match":
            raise AutoLiveExecutorError(
                code="POSITION_LINEAGE_UNAVAILABLE",
                message=(
                    "Stage 3 buy pre-submit requires complete matching Stage 1 "
                    "and forced-fresh account, credential-artifact, and "
                    "position-classifier lineage; no external buy write was "
                    "issued."
                ),
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
        (
            enriched_buy_positions,
            buy_market_enrichment,
        ) = await enrich_console_wallet_positions_authoritatively(
            live_snapshot.raw_positions or live_snapshot.positions
        )
        if buy_market_enrichment.get("unresolved_position_count"):
            raise AutoLiveExecutorError(
                code="POSITION_UNAVAILABLE",
                message=(
                    "Stage 3 buy pre-submit could not establish authoritative "
                    "market identity and open/closed state for every wallet row; "
                    "no external buy write was issued."
                ),
                retryable=True,
            )
        allocation = classify_economic_slots(
            enriched_buy_positions,
            dust_threshold_usd=dust_threshold,
        )
        if any(
            _position_matches_intent(
                position,
                market_id=intent.market_id,
                condition_id=intent.condition_id,
                side=None,
                slug=intent.slug,
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
        post_exit_sizing_policy = intent.execution_metadata_json.get(
            "post_exit_sizing_policy"
        )
        post_exit_sizing_policy = (
            post_exit_sizing_policy
            if isinstance(post_exit_sizing_policy, dict)
            else {}
        )
        if replacement_confirmed and post_exit_sizing_policy.get("enabled"):
            post_exit_sizing = _post_exit_replacement_sizing(
                available_balance_usd=live_controls.balance.available_balance_usd,
                economically_active_position_count=(
                    allocation.economically_active_position_count
                ),
                slot_limit=int(capacity_policy.get("slot_limit", 10) or 10),
                min_order_usd=float(
                    post_exit_sizing_policy.get("min_order_usd", 1.0) or 1.0
                ),
                max_order_usd=float(
                    post_exit_sizing_policy.get("max_order_usd", 25.0) or 25.0
                ),
                balance_buffer_usd=float(
                    post_exit_sizing_policy.get(
                        "balance_buffer_usd",
                        auto_live_buy_balance_buffer_usd(),
                    )
                    or 0.0
                ),
            )
            if int(post_exit_sizing["available_slots"]) <= 0:
                raise AutoLiveExecutorError(
                    code="CAPACITY_BLOCKED",
                    message=(
                        "Fresh post-exit wallet state still has no economic slot "
                        "for the reserved replacement buy."
                    ),
                    retryable=True,
                )
            order_usd = float(post_exit_sizing["order_usd"])
            if order_usd < float(post_exit_sizing["min_order_usd"]):
                raise AutoLiveExecutorError(
                    code="INSUFFICIENT_COLLATERAL",
                    message=(
                        "Fresh post-exit balance does not yet fund the minimum "
                        "replacement order after preserving the execution buffer."
                    ),
                    retryable=True,
                )
            intent.execution_metadata_json = {
                **dict(intent.execution_metadata_json or {}),
                "post_exit_sizing": {
                    "version": "v1",
                    "source": "forced_fresh_post_exit_balance",
                    "applied_at": utc_now_iso(),
                    **post_exit_sizing,
                },
            }
        override_enabled = bool(capacity_policy.get("capacity_override", False))
        slot_limit = int(capacity_policy.get("slot_limit", 10) or 10)
        planned_capacity_override = bool(
            intent.execution_metadata_json.get("capacity_override_used")
            or intent.execution_metadata_json.get("stage3_status")
            == "CAPACITY_OVERRIDE_USED"
        )
        intent.execution_metadata_json = {
            **dict(intent.execution_metadata_json or {}),
            "capacity_override_used": bool(
                override_enabled
                and (
                    planned_capacity_override
                    or allocation.economically_active_position_count >= slot_limit
                )
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
    elif intent.action == "sell":
        if shares is None or shares <= 0:
            raise AutoLiveExecutorError(
                code="NO_SHARES_AVAILABLE",
                message="Sell intent has no planned shares available to verify.",
                retryable=False,
            )
        capacity_policy = intent.execution_metadata_json.get(
            "stage3_capacity_policy"
        )
        capacity_policy = (
            capacity_policy if isinstance(capacity_policy, dict) else {}
        )
        dust_threshold = float(
            capacity_policy.get("dust_threshold_usd", 0.01) or 0.01
        )
        snapshot_request_started_at = utc_now()
        live_snapshot = await read_console_wallet_positions_snapshot(
            force_fresh=True,
            caller_source="auto-live-stage3-sell-pre-submit",
            max_age_seconds=0,
        )
        actual_lineage = _validate_force_fresh_wallet_snapshot(
            snapshot=live_snapshot,
            request_started_at=snapshot_request_started_at,
        )
        wallet_snapshot_lineage = actual_lineage
        wallet_lineage_comparison = _compare_wallet_snapshot_lineage(
            expected=intent.execution_metadata_json.get(
                "expected_stage1_wallet_lineage"
            ),
            actual=actual_lineage,
        )
        if wallet_lineage_comparison["status"] == "mismatch":
            raise AutoLiveExecutorError(
                code="POSITION_LINEAGE_MISMATCH",
                message=(
                    "Stage 3 sell pre-submit rejected wallet state from a "
                    "different account, credential, classifier, or older "
                    "Stage 1 lineage; no external sell write was issued."
                ),
                retryable=False,
            )
        live_positions = live_snapshot.raw_positions or live_snapshot.positions
        matching_positions = [
            position
            for position in live_positions
            if _position_matches_intent(
                position,
                market_id=intent.market_id,
                condition_id=intent.condition_id,
                slug=intent.slug,
                side=intent.side,
            )
        ]
        if not matching_positions:
            raise AutoLiveExecutorError(
                code="NO_SHARES_AVAILABLE",
                message=(
                    "Fresh Bullpen wallet state has no matching sellable "
                    "position for this intent; no external sell write was issued."
                ),
                retryable=False,
            )
        (
            matching_positions,
            sell_market_enrichment,
        ) = await enrich_console_wallet_positions_authoritatively(
            matching_positions
        )
        if sell_market_enrichment.get("unresolved_position_count"):
            raise AutoLiveExecutorError(
                code="POSITION_UNAVAILABLE",
                message=(
                    "Stage 3 sell pre-submit could not establish the exact "
                    "authoritative market identity and open/closed state; no "
                    "external sell write was issued."
                ),
                retryable=True,
            )
        if any(
            _position_requires_redeem(
                position,
                dust_threshold_usd=dust_threshold,
            )
            for position in matching_positions
        ):
            raise AutoLiveExecutorError(
                code="SELL_REQUIRES_REDEEM",
                message=(
                    "Fresh Bullpen wallet state classifies this position as "
                    "positive-payout claimable. Stage 3 blocked the CLOB sell; "
                    "the condition must use the scoped redeem path."
                ),
                retryable=False,
            )
        if any(_position_is_non_tradable(position) for position in matching_positions):
            classifications = sorted(
                {
                    str(getattr(position, "classification", "unknown") or "unknown")
                    for position in matching_positions
                }
            )
            raise AutoLiveExecutorError(
                code="NO_SELLABLE_EXPOSURE",
                message=(
                    "Fresh Bullpen wallet state classifies this position as "
                    f"non-tradable ({', '.join(classifications)}); no external "
                    "sell write was issued."
                ),
                retryable=False,
            )
        allocation = classify_economic_slots(
            matching_positions,
            dust_threshold_usd=dust_threshold,
        )
        verified_positions = [
            position
            for position in allocation.active_positions
            if float(getattr(position, "shares", 0.0) or 0.0) > 0
        ]
        if not verified_positions:
            raise AutoLiveExecutorError(
                code="NO_SHARES_AVAILABLE",
                message=(
                    "Fresh Bullpen wallet state found no economically active "
                    "shares for this sell intent; no external sell write was issued."
                ),
                retryable=False,
            )
        verified_position = max(
            verified_positions,
            key=lambda position: float(getattr(position, "shares", 0.0) or 0.0),
        )
        verified_shares = float(
            getattr(verified_position, "shares", 0.0) or 0.0
        )
        requested_shares = float(shares)
        shares = round(min(requested_shares, verified_shares), 6)
        if shares <= 0:
            raise AutoLiveExecutorError(
                code="NO_SHARES_AVAILABLE",
                message=(
                    "Fresh Bullpen wallet state did not verify a positive "
                    "share amount for this sell intent."
                ),
                retryable=False,
            )
        sell_preflight_metadata = {
            "version": "v1",
            **actual_lineage,
            "lineage_comparison": wallet_lineage_comparison,
            "market_enrichment": sell_market_enrichment,
            "classification": str(
                getattr(verified_position, "classification", "active") or "active"
            ),
            "condition_id": getattr(verified_position, "condition_id", None),
            "wallet_market_id": getattr(verified_position, "market_id", None),
            "wallet_slug": getattr(verified_position, "slug", None),
            "side": getattr(verified_position, "side", None),
            "requested_shares": round(requested_shares, 6),
            "verified_shares": round(verified_shares, 6),
            "submitted_shares": shares,
            "dust_threshold_usd": dust_threshold,
            "sellable": True,
        }
    elif intent.action == "redeem":
        snapshot_request_started_at = utc_now()
        live_snapshot = await read_console_wallet_positions_snapshot(
            force_fresh=True,
            caller_source="auto-live-stage3-redeem-pre-submit",
            max_age_seconds=0,
        )
        actual_lineage = _validate_force_fresh_wallet_snapshot(
            snapshot=live_snapshot,
            request_started_at=snapshot_request_started_at,
        )
        wallet_snapshot_lineage = actual_lineage
        wallet_lineage_comparison = _compare_wallet_snapshot_lineage(
            expected=intent.execution_metadata_json.get(
                "expected_stage1_wallet_lineage"
            ),
            actual=actual_lineage,
        )
        if wallet_lineage_comparison["status"] == "mismatch":
            raise AutoLiveExecutorError(
                code="POSITION_LINEAGE_MISMATCH",
                message=(
                    "Stage 3 redeem pre-submit rejected wallet state from a "
                    "different account, credential, classifier, or older "
                    "Stage 1 lineage; no external redeem write was issued."
                ),
                retryable=False,
            )
        redeem_preflight_wallet_positions = tuple(
            live_snapshot.raw_positions or live_snapshot.positions
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
        available_balance_checked_at=getattr(
            live_controls.balance,
            "checked_at",
            None,
        ),
        sell_preflight_metadata=sell_preflight_metadata,
        wallet_lineage_comparison=wallet_lineage_comparison,
        wallet_snapshot_lineage=wallet_snapshot_lineage,
        redeem_preflight_wallet_positions=redeem_preflight_wallet_positions,
    )


def _usd_to_cents(value: float | None) -> int:
    """Normalize one USD amount to exact integer cents."""

    try:
        decimal_value = Decimal(str(value or 0.0))
    except (InvalidOperation, ValueError):
        return 0
    if not decimal_value.is_finite():
        return 0
    return max(
        0,
        int(
            (decimal_value * Decimal("100")).to_integral_value(
                rounding=ROUND_HALF_UP
            )
        ),
    )


def _buy_reservation_scope_lock_query(*, user_id: int):
    """Return one stable row lock for the host-global Bullpen account."""

    del user_id
    user_id_column = User.__table__.c.id
    return (
        select(user_id_column)
        .order_by(user_id_column.asc())
        .limit(1)
        .with_for_update()
    )


def _lock_buy_reservation_scope(session: Session, *, user_id: int) -> bool:
    """Serialize singleton reservations and market fences under READ COMMITTED."""

    return (
        session.execute(
            _buy_reservation_scope_lock_query(user_id=user_id)
        ).scalar_one_or_none()
        is not None
    )


def _reserve_buy_if_possible(
    session: Session,
    *,
    intent_id: str,
    available_balance_usd: float | None,
    order_usd: float | None,
    available_balance_checked_at: str | datetime | None = None,
) -> bool:
    intent = session.get(PolymarketAutoLiveOrderIntentRecord, intent_id)
    if intent is None:
        return False
    needed = max(0.0, float(order_usd or 0.0))
    if available_balance_usd is None or needed <= 0:
        return False
    if not _lock_buy_reservation_scope(session, user_id=intent.user_id):
        return False
    unresolved_market_conflicts = _matching_unresolved_buy_market_intents(
        session,
        intent=intent,
    )
    market_preflight = _buy_market_exposure_preflight_proof(
        intent=intent,
        conflicts=unresolved_market_conflicts,
    )
    _persist_buy_market_exposure_preflight(
        session,
        intent=intent,
        proof=market_preflight,
    )
    if unresolved_market_conflicts:
        return False
    verified_balance_checked_at = _intent_evidence_datetime(
        available_balance_checked_at
    )
    already_reserved = _active_reserved_cash(
        session,
        user_id=intent.user_id,
        exclude_intent_id=intent.id,
        verified_balance_checked_at=verified_balance_checked_at,
    )
    spendable_cash = spendable_buy_cash_usd(
        available_balance_usd,
        balance_buffer_usd=auto_live_buy_balance_buffer_usd(),
    )
    if spendable_cash is None:
        return False
    needed_cents = _usd_to_cents(needed)
    unreserved_cents = (
        _usd_to_cents(spendable_cash) - _usd_to_cents(already_reserved)
    )
    can_reserve = bool(
        verified_balance_checked_at is not None
        and needed_cents > 0
        and unreserved_cents >= needed_cents
    )
    _persist_buy_preflight_evidence(
        session,
        intent=intent,
        metadata_key="buy_cash_reservation_preflight",
        attempt_key="_stage3_buy_cash_reservation_preflight",
        proof=_buy_cash_reservation_preflight_proof(
            available_balance_usd=available_balance_usd,
            available_balance_checked_at=verified_balance_checked_at,
            balance_buffer_usd=auto_live_buy_balance_buffer_usd(),
            spendable_cash_usd=spendable_cash,
            held_reservation_usd=already_reserved,
            needed_usd=needed_cents / 100,
            unreserved_cash_usd=max(0, unreserved_cents) / 100,
            can_reserve=can_reserve,
        ),
    )
    if not can_reserve:
        return False
    _upsert_reservation(
        session,
        intent=intent,
        amount_usd=needed_cents / 100,
        status="active",
    )
    session.commit()
    return True


_UNCERTAIN_WRITE_BOUNDARY_ERROR_CODES = frozenset(
    {
        "RPC_RATE_LIMITED",
        "HTTP_502",
        "HTTP_503",
        "HTTP_504",
        "NETWORK_TIMEOUT",
        "CONNECTION_RESET",
        "ORDER_WRITE_UNAVAILABLE",
    }
)


def _fence_uncertain_write_error(
    error: AutoLiveExecutorError,
    *,
    action: str,
    provider_alias: str,
) -> AutoLiveExecutorError:
    """Prevent provider fall-through once a buy/redeem write may exist."""

    if action not in {"buy", "redeem"}:
        return error
    if (
        error.ambiguous_submission
        or error.code in _UNCERTAIN_WRITE_BOUNDARY_ERROR_CODES
    ):
        return AutoLiveExecutorError(
            code="AMBIGUOUS_SUBMISSION",
            message=(
                f"Uncertain {action} write boundary on provider "
                f"{provider_alias}: {sanitize_message(error.message)}"
            ),
            retryable=True,
            retry_after_seconds=error.retry_after_seconds,
            ambiguous_submission=True,
            provider_alias=error.provider_alias or provider_alias,
        )
    return error


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
                matched_fill = _matched_buy_submission_fill(payload)
                return IntentSubmissionResult(
                    status="FILLED" if matched_fill is not None else "SUBMITTED",
                    detail=(
                        "Bullpen buy response confirmed the order matched."
                        if matched_fill is not None
                        else "Bullpen buy order submitted successfully."
                    ),
                    retryable=matched_fill is None,
                    current_order_usd=prepared.order_usd,
                    current_shares=prepared.shares,
                    current_limit_price_cents=prepared.limit_price_cents,
                    remote_order_id=remote_order_id,
                    remote_transaction_hash=remote_transaction_hash,
                    provider_alias=alias,
                    raw_response=payload,
                    next_attempt_at=(
                        None if matched_fill is not None else utc_now() + timedelta(seconds=3)
                    ),
                    filled_shares=matched_fill[0] if matched_fill is not None else None,
                    remaining_shares=0.0 if matched_fill is not None else None,
                    average_fill_price_cents=(
                        matched_fill[1] if matched_fill is not None else None
                    ),
                )
            if prepared.action == "sell":
                sell_submission = await submit_immediate_sell_with_fallbacks(
                    executor=executor,
                    market_id=stage3_execution_market_reference(
                        slug=prepared.slug,
                        market_id=prepared.market_id,
                    ),
                    outcome="Yes" if prepared.side == "YES" else "No",
                    shares=prepared.shares or 0.0,
                    extra_env=extra_env,
                    provider_alias=alias,
                )
                payload = dict(sell_submission.payload)
                immediate_sell_audit = {
                    "version": IMMEDIATE_SELL_STRATEGY_VERSION,
                    "selected_layer": sell_submission.selected_layer,
                    "execution_path": sell_submission.execution_path,
                    "fallback_count": sum(
                        1
                        for item in sell_submission.fallback_history[:-1]
                        if item.get("result") == "fallback"
                    ),
                    "attempts": list(sell_submission.fallback_history),
                }
                payload["_stage3_immediate_sell"] = immediate_sell_audit
                remote_order_id, remote_transaction_hash = _extract_remote_refs(payload)
                fallback_count = int(immediate_sell_audit["fallback_count"])
                matched_fill = _matched_sell_submission_fill(payload)
                requested_shares = max(0.0, float(prepared.shares or 0.0))
                filled_shares = matched_fill[0] if matched_fill is not None else None
                remaining_shares = (
                    max(0.0, requested_shares - filled_shares)
                    if filled_shares is not None
                    else None
                )
                fully_filled = (
                    filled_shares is not None and remaining_shares <= 0.000001
                )
                submission_status = (
                    "SETTLEMENT_PENDING"
                    if fully_filled
                    else "PARTIALLY_FILLED"
                    if filled_shares is not None
                    else "SUBMITTED"
                )
                return IntentSubmissionResult(
                    status=submission_status,
                    detail=_immediate_sell_submission_detail(
                        fallback_count=fallback_count,
                        execution_path=sell_submission.execution_path,
                        fully_filled=fully_filled,
                        partially_filled=filled_shares is not None and not fully_filled,
                    ),
                    retryable=True,
                    current_shares=prepared.shares,
                    current_limit_price_cents=IMMEDIATE_SELL_MIN_PRICE * 100,
                    remote_order_id=remote_order_id,
                    remote_transaction_hash=remote_transaction_hash,
                    provider_alias=alias,
                    raw_response=payload,
                    next_attempt_at=(
                        utc_now() + timedelta(seconds=3)
                    ),
                    filled_shares=filled_shares,
                    remaining_shares=remaining_shares,
                    average_fill_price_cents=(
                        matched_fill[1] if matched_fill is not None else None
                    ),
                    execution_path=sell_submission.execution_path,
                    fallback_history=list(sell_submission.fallback_history),
                    selected_fallback_layer=sell_submission.selected_layer,
                )
            redeem_preflight_snapshot_consumed = False

            async def read_lineage_fenced_redeem_positions() -> list[object]:
                nonlocal redeem_preflight_snapshot_consumed
                if not redeem_preflight_snapshot_consumed:
                    redeem_preflight_snapshot_consumed = True
                    return list(prepared.redeem_preflight_wallet_positions)

                snapshot_request_started_at = utc_now()
                post_submit_snapshot = (
                    await read_console_wallet_positions_snapshot(
                        force_fresh=True,
                        caller_source=(
                            "auto-live-stage3-redeem-post-submit-reconcile"
                        ),
                        max_age_seconds=0,
                    )
                )
                post_submit_lineage = _validate_force_fresh_wallet_snapshot(
                    snapshot=post_submit_snapshot,
                    request_started_at=snapshot_request_started_at,
                )
                post_submit_comparison = _compare_wallet_snapshot_lineage(
                    expected=prepared.wallet_snapshot_lineage,
                    actual=post_submit_lineage,
                )
                if post_submit_comparison["status"] == "mismatch":
                    raise AutoLiveExecutorError(
                        code="POSITION_LINEAGE_MISMATCH",
                        message=(
                            "Stage 3 redeem reconciliation rejected wallet "
                            "state from a different pre-submit lineage after "
                            "the external write."
                        ),
                        retryable=False,
                        ambiguous_submission=True,
                    )
                return list(
                    post_submit_snapshot.raw_positions
                    or post_submit_snapshot.positions
                )

            redeem_result = await submit_scoped_redeem(
                user_id=prepared.user_id,
                condition_ids=prepared.condition_ids,
                source="auto_live_execution_v2",
                executor=executor,
                read_wallet_positions=read_lineage_fenced_redeem_positions,
            )
            outcome = next(iter(redeem_result.outcomes), None)
            detail = outcome.detail if outcome is not None else "Redeem submission completed."
            if outcome and outcome.status in {
                REDEEM_ATTEMPT_CONFIRMED,
                REDEEM_ATTEMPT_ALREADY_REDEEMED,
                REDEEM_ATTEMPT_RESOLVED_ZERO_PAYOUT,
            }:
                return IntentSubmissionResult(
                    status="SETTLEMENT_PENDING",
                    detail=(
                        f"{detail} Stage 3 will terminalize the exit only after "
                        "a separate lineage-fenced post-submit wallet reconciliation."
                    ),
                    retryable=True,
                    provider_alias=alias,
                    raw_response={
                        "outcomes": [item.__dict__ for item in redeem_result.outcomes],
                        "claim_attempted": redeem_result.claim_attempted,
                    },
                    next_attempt_at=utc_now() + timedelta(seconds=3),
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
            last_error = _fence_uncertain_write_error(
                exc,
                action=prepared.action,
                provider_alias=alias,
            )
        except Exception as exc:
            last_error = _fence_uncertain_write_error(
                classify_executor_error(
                    exc,
                    during_write=True,
                    provider_alias=alias,
                ),
                action=prepared.action,
                provider_alias=alias,
            )
        if last_error and (prepared.action == "sell" or last_error.ambiguous_submission):
            raise last_error
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
    if exc.fallback_history:
        fallback_history = [dict(item) for item in exc.fallback_history]
        immediate_sell_audit = {
            "version": IMMEDIATE_SELL_STRATEGY_VERSION,
            "selected_layer": None,
            "execution_path": None,
            "fallback_count": sum(
                1
                for item in fallback_history[:-1]
                if item.get("result") == "fallback"
            ),
            "attempts": fallback_history,
        }
        metadata["immediate_sell_strategy"] = immediate_sell_audit
        attempt.sanitized_response_json = {
            **dict(attempt.sanitized_response_json or {}),
            "_stage3_immediate_sell": immediate_sell_audit,
        }
        latest_path = fallback_history[-1].get("path") if fallback_history else None
        if isinstance(latest_path, str) and latest_path:
            attempt.executor_path = latest_path
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
    if exc.ambiguous_submission:
        # Crossing an uncertain write boundary is itself durable remote-write
        # evidence. Persist the timestamp even when Bullpen returned no order
        # ID so reconciliation can correlate only post-attempt history, cash
        # remains reserved, and every automatic/operator retry stays fenced.
        record.first_submitted_at = (
            getattr(record, "first_submitted_at", None) or now
        )
        record.last_submitted_at = now
        write_boundary = {
            "recorded_at": _isoformat(now),
            "attempt_number": record.attempt_count,
            "provider_alias": exc.provider_alias,
            "ambiguous_submission": True,
            "automatic_resubmission": False,
        }
        metadata["uncertain_remote_write_boundary"] = write_boundary
        metadata["automatic_resubmission"] = False
        attempt.reconciliation_json = {
            **dict(attempt.reconciliation_json or {}),
            "uncertain_remote_write_boundary": write_boundary,
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


def _automatic_attempt_budget_allows(
    record: PolymarketAutoLiveOrderIntentRecord,
    *,
    now: datetime,
    session: Session | None = None,
) -> bool:
    if record.max_attempts <= 0:
        # Older durable rows used zero as "not configured". Preserve their
        # ability to make one fenced attempt instead of terminalizing them
        # before any remote write.
        record.max_attempts = 1
    if record.attempt_count < record.max_attempts:
        return True

    record.status = "FAILED_PERMANENT"
    record.retryable = False
    record.next_attempt_at = None
    record.terminal_at = now
    record.last_error_code = "ATTEMPT_BUDGET_EXHAUSTED"
    record.last_error_message = (
        f"Automatic Stage 3 execution stopped after the bounded "
        f"{record.max_attempts}-attempt budget. No additional remote write was issued."
    )
    record.execution_metadata_json = {
        **dict(record.execution_metadata_json or {}),
        "attempt_budget_exhausted": True,
        "stage3_status": (
            "EXIT_FAILED_PERMANENTLY"
            if record.action in {"sell", "redeem"}
            else "BUY_FAILED"
        ),
        "current_blockage": record.last_error_message,
        "how_to_resolve": (
            "Inspect the stored attempts and verify remote absence before "
            "requesting one explicit operator retry."
        ),
    }
    if session is not None:
        _release_buy_reservation_if_no_remote_evidence(
            session,
            record,
            reason="Automatic execution attempt budget exhausted before any persisted remote write.",
        )
    return False


def execute_order_intent_sync(intent_id: str, *, worker_task_id: str | None = None) -> str | None:
    with SyncSessionLocal() as session:
        record = _lock_intent_for_execution(session, intent_id)
        if record is None:
            return None
        if record.status not in _EXECUTABLE_STATUSES:
            return record.status
        if _run_was_cancelled_by_user(session, run_id=record.run_id):
            _cancel_unsubmitted_intent_for_user(session, record=record)
            session.commit()
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
            _release_buy_reservation_if_no_remote_evidence(
                session,
                record,
                reason="Run recovery blocked automatic execution before a remote write.",
            )
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
        if not _automatic_attempt_budget_allows(
            record,
            now=now,
            session=session,
        ):
            sync_run_and_decisions_from_intents_sync(
                session,
                user_id=record.user_id,
                run_id=record.run_id,
            )
            session.commit()
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
            _release_buy_reservation_if_no_remote_evidence(
                session,
                record,
                reason=f"Buy preflight ended in {record.status} before any remote write.",
            )
            sync_run_and_decisions_from_intents_sync(
                session,
                user_id=record.user_id,
                run_id=record.run_id,
            )
            session.commit()
            return record.status

    if prepared.intent_id and prepared.wallet_lineage_comparison:
        with SyncSessionLocal() as session:
            record = session.get(
                PolymarketAutoLiveOrderIntentRecord,
                prepared.intent_id,
            )
            if record is not None:
                record.execution_metadata_json = {
                    **dict(record.execution_metadata_json or {}),
                    "wallet_snapshot_lineage": dict(
                        prepared.wallet_snapshot_lineage
                    ),
                    "wallet_lineage_comparison": dict(
                        prepared.wallet_lineage_comparison
                    ),
                }
                attempt = session.execute(
                    select(PolymarketAutoLiveOrderAttemptRecord)
                    .where(
                        PolymarketAutoLiveOrderAttemptRecord.intent_id
                        == prepared.intent_id
                    )
                    .where(
                        PolymarketAutoLiveOrderAttemptRecord.attempt_number
                        == record.attempt_count
                    )
                ).scalar_one_or_none()
                if attempt is not None:
                    attempt.sanitized_request_json = {
                        **dict(attempt.sanitized_request_json or {}),
                        "_wallet_snapshot_lineage": dict(
                            prepared.wallet_snapshot_lineage
                        ),
                        "_wallet_lineage_comparison": dict(
                            prepared.wallet_lineage_comparison
                        ),
                    }
                session.commit()

    if prepared.action == "sell" and prepared.intent_id:
        with SyncSessionLocal() as session:
            record = session.get(
                PolymarketAutoLiveOrderIntentRecord,
                prepared.intent_id,
            )
            if record is not None:
                record.current_shares = prepared.shares
                record.execution_metadata_json = {
                    **dict(record.execution_metadata_json or {}),
                    "sell_live_preflight": dict(
                        prepared.sell_preflight_metadata
                    ),
                }
                attempt = session.execute(
                    select(PolymarketAutoLiveOrderAttemptRecord)
                    .where(
                        PolymarketAutoLiveOrderAttemptRecord.intent_id
                        == prepared.intent_id
                    )
                    .where(
                        PolymarketAutoLiveOrderAttemptRecord.attempt_number
                        == record.attempt_count
                    )
                ).scalar_one_or_none()
                if attempt is not None:
                    attempt.sanitized_request_json = {
                        **dict(attempt.sanitized_request_json or {}),
                        "_stage3_sell_preflight": dict(
                            prepared.sell_preflight_metadata
                        ),
                    }
                session.commit()

    if prepared.action == "buy" and prepared.intent_id:
        with SyncSessionLocal() as session:
            record = session.get(PolymarketAutoLiveOrderIntentRecord, prepared.intent_id)
            if record is not None:
                # _prepare_intent_submission marked this only after all other
                # capacity and duplicate-exposure checks passed.
                record.current_order_usd = prepared.order_usd
                record.current_shares = prepared.shares
                record.current_limit_price_cents = prepared.limit_price_cents
                record.execution_metadata_json = {
                    **dict(record.execution_metadata_json or {}),
                    **{
                        key: value
                        for key, value in intent.execution_metadata_json.items()
                        if key
                        in {
                            "capacity_override_used",
                            "post_exit_sizing",
                        }
                    },
                }
                attempt = session.execute(
                    select(PolymarketAutoLiveOrderAttemptRecord)
                    .where(
                        PolymarketAutoLiveOrderAttemptRecord.intent_id
                        == prepared.intent_id
                    )
                    .where(
                        PolymarketAutoLiveOrderAttemptRecord.attempt_number
                        == record.attempt_count
                    )
                ).scalar_one_or_none()
                if attempt is not None:
                    post_exit_sizing = intent.execution_metadata_json.get(
                        "post_exit_sizing"
                    )
                    attempt.sanitized_request_json = {
                        **dict(attempt.sanitized_request_json or {}),
                        "_post_exit_sizing": (
                            dict(post_exit_sizing)
                            if isinstance(post_exit_sizing, dict)
                            else {}
                        ),
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
                available_balance_checked_at=(
                    prepared.available_balance_checked_at
                ),
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
                market_preflight = (
                    record.execution_metadata_json.get(
                        "buy_market_exposure_preflight"
                    )
                    if isinstance(
                        record.execution_metadata_json.get(
                            "buy_market_exposure_preflight"
                        ),
                        dict,
                    )
                    else {}
                )
                duplicate_market_blocked = bool(
                    market_preflight.get("result") == "blocked"
                    and int(market_preflight.get("conflict_count") or 0) > 0
                )
                if duplicate_market_blocked:
                    record.status = "DEFERRED"
                    record.retryable = False
                    record.last_error_code = "DUPLICATE_MARKET_EXPOSURE"
                    record.last_error_message = (
                        "Stage 3 blocked this BUY because another durable BUY "
                        "for the same market may still fill. Reconcile the "
                        "conflicting intent to an explicit zero fill before "
                        "requesting an operator retry."
                    )
                    record.next_attempt_at = None
                    record.terminal_at = utc_now()
                    record.execution_metadata_json = {
                        **dict(record.execution_metadata_json or {}),
                        "stage3_status": "BUY_FAILED",
                        "automatic_resubmission": False,
                        "current_blockage": record.last_error_message,
                        "how_to_resolve": (
                            "Verify the conflicting Bullpen order and wallet, "
                            "then persist explicit definitive-zero-fill "
                            "reconciliation evidence before retrying."
                        ),
                    }
                    _release_buy_reservation_if_no_remote_evidence(
                        session,
                        record,
                        reason=(
                            "The singleton market-exposure fence blocked this "
                            "BUY before any remote write."
                        ),
                        definitive_no_fill=True,
                    )
                else:
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
                attempt.error_code = record.last_error_code
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
        run_cancelled_by_user = _run_was_cancelled_by_user(
            session,
            run_id=record.run_id,
        )
        recovery_block_reason = _run_recovery_block_reason(
            session,
            run_id=record.run_id,
        )
        if (
            record.status != "SUBMITTING"
            or recovery_block_reason is not None
            or run_cancelled_by_user
        ):
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
            if run_cancelled_by_user:
                _cancel_unsubmitted_intent_for_user(
                    session,
                    record=record,
                    remote_write_prevented=True,
                )
            _release_buy_reservation_if_no_remote_evidence(
                session,
                record,
                reason=(
                    "The final pre-write fence stopped this buy before any remote "
                    f"submission ({record.status})."
                ),
            )
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
            _release_buy_reservation_if_no_remote_evidence(
                session,
                record,
                reason=f"Buy submission ended in {record.status} with no persisted remote evidence.",
            )
            sync_run_and_decisions_from_intents_sync(
                session,
                user_id=record.user_id,
                run_id=record.run_id,
            )
            session.commit()
            return record.status

    submission_result_received_at = utc_now()
    post_buy_terminal_wallet_refresh: dict[str, object] | None = None
    if (
        prepared.action == "buy"
        and result.status in INTENT_TERMINAL_SUCCESS_STATUSES
    ):
        # Persist the accepted response and write-boundary timestamp before the
        # bounded broker refresh. A crash during that refresh must leave enough
        # durable evidence for reconciliation and must never permit a second
        # BUY write.
        with SyncSessionLocal() as session:
            record = session.get(
                PolymarketAutoLiveOrderIntentRecord,
                intent_id,
            )
            if record is None:
                return None
            attempt = session.execute(
                select(PolymarketAutoLiveOrderAttemptRecord)
                .where(
                    PolymarketAutoLiveOrderAttemptRecord.intent_id == intent_id
                )
                .where(
                    PolymarketAutoLiveOrderAttemptRecord.attempt_number
                    == record.attempt_count
                )
            ).scalar_one()
            record.remote_order_id = (
                result.remote_order_id or record.remote_order_id
            )
            record.remote_transaction_hash = (
                result.remote_transaction_hash
                or record.remote_transaction_hash
            )
            record.first_submitted_at = (
                record.first_submitted_at or submission_result_received_at
            )
            record.last_submitted_at = submission_result_received_at
            record.execution_metadata_json = {
                **dict(record.execution_metadata_json or {}),
                "automatic_resubmission": False,
                "post_buy_terminal_wallet_refresh": {
                    "status": "pending",
                    "caller_source": (
                        "auto-live-stage3-buy-matched-post-submit-refresh"
                    ),
                    "write_boundary_recorded_at": _isoformat(
                        submission_result_received_at
                    ),
                },
            }
            attempt.remote_order_id = (
                result.remote_order_id or attempt.remote_order_id
            )
            attempt.remote_transaction_hash = (
                result.remote_transaction_hash
                or attempt.remote_transaction_hash
            )
            attempt.sanitized_response_json = dict(
                result.raw_response or {}
            )
            attempt.reconciliation_json = {
                **dict(attempt.reconciliation_json or {}),
                "terminal_buy_wallet_refresh_pending": True,
                "write_boundary_recorded_at": _isoformat(
                    submission_result_received_at
                ),
            }
            session.commit()
        terminal_refresh_intent = intent.model_copy(
            update={
                "first_submitted_at": _isoformat(
                    submission_result_received_at
                ),
                "last_submitted_at": _isoformat(
                    submission_result_received_at
                ),
                "execution_metadata_json": {
                    **dict(intent.execution_metadata_json or {}),
                    "wallet_snapshot_lineage": dict(
                        prepared.wallet_snapshot_lineage
                    ),
                },
            }
        )
        post_buy_terminal_wallet_refresh = run_with_bullpen_runtime_cleanup(
            _terminal_buy_wallet_refresh_metadata(
                terminal_refresh_intent,
                caller_source=(
                    "auto-live-stage3-buy-matched-post-submit-refresh"
                ),
            )
        )

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
        recorded_submission_at = (
            submission_result_received_at
            if record.action == "buy"
            else now
        )
        record.first_submitted_at = (
            record.first_submitted_at or recorded_submission_at
        )
        record.last_submitted_at = recorded_submission_at
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
            **(
                {
                    "post_buy_terminal_wallet_refresh": (
                        post_buy_terminal_wallet_refresh
                    )
                }
                if post_buy_terminal_wallet_refresh is not None
                else {}
            ),
            **(
                {
                    "reconciliation_fill_evidence": (
                        _result_fill_evidence(result)
                    )
                }
                if record.action == "buy"
                and result.status in INTENT_TERMINAL_FAILURE_STATUSES
                else {}
            ),
            **(
                {
                    "execution_path": result.execution_path,
                    "immediate_sell_strategy": {
                        "version": IMMEDIATE_SELL_STRATEGY_VERSION,
                        "selected_layer": result.selected_fallback_layer,
                        "execution_path": result.execution_path,
                        "fallback_count": sum(
                            1
                            for item in (result.fallback_history or [])[:-1]
                            if item.get("result") == "fallback"
                        ),
                        "attempts": list(result.fallback_history or []),
                    },
                }
                if record.action == "sell" and result.execution_path
                else {}
            ),
        }
        attempt.completed_at = now
        attempt.result_status = result.status
        attempt.rpc_provider = result.provider_alias
        attempt.executor_path = result.execution_path or attempt.executor_path
        attempt.remote_order_id = result.remote_order_id
        attempt.remote_transaction_hash = result.remote_transaction_hash
        attempt.sanitized_response_json = {
            **dict(result.raw_response or {}),
            **(
                {
                    "_post_buy_terminal_wallet_refresh": (
                        post_buy_terminal_wallet_refresh
                    )
                }
                if post_buy_terminal_wallet_refresh is not None
                else {}
            ),
        }
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
        elif result.status in INTENT_TERMINAL_FAILURE_STATUSES:
            record.terminal_at = now
            definitive_no_fill = _result_definitively_proves_no_fill(result)
            _release_buy_reservation_if_no_remote_evidence(
                session,
                record,
                reason=(
                    f"Bullpen definitively ended this buy as {result.status} "
                    "without a fill."
                ),
                definitive_no_fill=definitive_no_fill,
            )
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


_BUY_RECONCILIATION_MAX_AGE_SECONDS_DEFAULT = 15 * 60
_BUY_RECONCILIATION_MAX_AGE_SECONDS_ENV = (
    "AUTO_LIVE_BUY_RECONCILIATION_MAX_AGE_SECONDS"
)
_BUY_HISTORY_TIMESTAMP_TOLERANCE_SECONDS = 2


def _buy_reconciliation_max_age_seconds() -> int:
    configured = os.getenv(_BUY_RECONCILIATION_MAX_AGE_SECONDS_ENV)
    if configured is None:
        return _BUY_RECONCILIATION_MAX_AGE_SECONDS_DEFAULT
    try:
        # Keep the automatic confirmation window explicitly bounded even when
        # an operator supplies an unexpectedly large or negative value.
        return max(30, min(24 * 60 * 60, int(float(configured))))
    except (TypeError, ValueError):
        return _BUY_RECONCILIATION_MAX_AGE_SECONDS_DEFAULT


def _buy_reconciliation_age_seconds(
    intent: BullpenAutoLiveOrderIntent,
    *,
    now: datetime | None = None,
) -> float:
    started_at = parse_datetime(
        intent.first_submitted_at
        or intent.last_submitted_at
        or intent.created_at
    )
    if started_at is None:
        return 0.0
    return max(0.0, ((now or utc_now()) - started_at).total_seconds())


def _buy_ambiguity_result(
    intent: BullpenAutoLiveOrderIntent,
    *,
    detail: str,
    last_error_code: str = "AMBIGUOUS_SUBMISSION",
) -> IntentSubmissionResult:
    age_seconds = _buy_reconciliation_age_seconds(intent)
    max_age_seconds = _buy_reconciliation_max_age_seconds()
    remaining_shares = max(
        0.0,
        float(
            intent.remaining_shares
            or intent.current_shares
            or intent.requested_shares
            or 0.0
        ),
    )
    if age_seconds >= max_age_seconds:
        remote_reference = (
            f"remote order {intent.remote_order_id}"
            if intent.remote_order_id
            else "the persisted submission reference"
        )
        return IntentSubmissionResult(
            status="TIMED_OUT",
            detail=(
                "BUY_RECONCILIATION_OPERATOR_BLOCKED: "
                f"{detail} The buy remained ambiguous for {int(age_seconds)}s, "
                f"exceeding the bounded {max_age_seconds}s confirmation window. "
                f"{remote_reference} is retained and automatic resubmission is "
                "prohibited. An operator must verify the order and wallet with "
                "Bullpen support before any manual recovery."
            ),
            retryable=False,
            filled_shares=float(intent.filled_shares or 0.0),
            remaining_shares=remaining_shares,
            last_error_code=last_error_code,
            raw_response={
                "buy_reconciliation_operator_block": {
                    "version": "v1",
                    "blocked_at": utc_now_iso(),
                    "age_seconds": int(age_seconds),
                    "max_age_seconds": max_age_seconds,
                    "last_error_code": last_error_code,
                    "automatic_resubmission": False,
                    "support_verification_required": True,
                },
            },
        )
    return IntentSubmissionResult(
        status="CONFIRMING",
        detail=detail,
        retryable=True,
        filled_shares=float(intent.filled_shares or 0.0),
        remaining_shares=remaining_shares,
        next_attempt_at=_next_confirmation_attempt_at(intent),
        last_error_code=last_error_code,
    )


def _buy_poll_fields(
    value: object,
) -> tuple[str | None, float | None, float | None, float | None]:
    status_aliases = {
        "filled": "filled",
        "confirmed": "filled",
        "complete": "filled",
        "completed": "filled",
        "executed": "filled",
        "success": "filled",
        "partially_filled": "partially_filled",
        "partiallyfilled": "partially_filled",
        "partial": "partially_filled",
        "partial_fill": "partially_filled",
        "rejected": "rejected",
        "reject": "rejected",
        "failed": "rejected",
        "failure": "rejected",
        "error": "rejected",
        "cancelled": "cancelled",
        "canceled": "cancelled",
        "expired": "cancelled",
        "cancel": "cancelled",
        "timed_out": "timed_out",
        "timedout": "timed_out",
        "timeout": "timed_out",
        "open": "open",
        "unfilled": "open",
        "pending": "open",
        "working": "open",
        "live": "open",
        "submitted": "open",
        "accepted": "open",
        "confirming": "open",
    }
    status = None
    filled = None
    remaining = None
    average = None
    rows = list(_walk_response_payload(value))
    for row in rows:
        if status is None:
            for key in ("status", "orderStatus", "order_status", "state", "result"):
                raw_status = row.get(key)
                if not isinstance(raw_status, str):
                    continue
                normalized = (
                    raw_status.strip()
                    .lower()
                    .replace("-", "_")
                    .replace(" ", "_")
                )
                status = status_aliases.get(normalized)
                if status is not None:
                    break
        if filled is None:
            for key in (
                "filledShares",
                "filled_shares",
                "filledSize",
                "filled_size",
                "filled",
            ):
                filled = _safe_float(row.get(key))
                if filled is not None:
                    break
        if remaining is None:
            for key in (
                "remainingShares",
                "remaining_shares",
                "remainingSize",
                "remaining_size",
                "remaining",
            ):
                remaining = _safe_float(row.get(key))
                if remaining is not None:
                    break
        if average is None:
            for key in (
                "averageFillPriceCents",
                "average_fill_price_cents",
                "avgPriceCents",
                "avg_price_cents",
            ):
                average = _safe_float(row.get(key))
                if average is not None:
                    break
    return status, filled, remaining, average


def _evidence_aliases(value: object) -> set[str]:
    aliases = {
        str(candidate).strip().lower()
        for candidate in (
            getattr(value, "market_id", None),
            getattr(value, "condition_id", None),
            getattr(value, "slug", None),
        )
        if isinstance(candidate, str) and candidate.strip()
    }
    raw = getattr(value, "raw", None)
    for row in _walk_response_payload(raw):
        for key in (
            "marketId",
            "market_id",
            "conditionId",
            "condition_id",
            "slug",
            "marketSlug",
            "market_slug",
        ):
            candidate = row.get(key)
            if isinstance(candidate, str) and candidate.strip():
                aliases.add(candidate.strip().lower())
    return aliases


def _wallet_identity_lineage_is_complete(lineage: object) -> bool:
    if not isinstance(lineage, dict):
        return False
    artifact = lineage.get("credential_artifact")
    return bool(
        lineage.get("account_identity")
        and lineage.get("position_classifier_version") is not None
        and isinstance(artifact, dict)
        and all(
            artifact.get(field_name) is not None
            for field_name in ("inode", "mtime_ns", "size")
        )
    )


def _matching_post_submit_buy_trade(
    history: Sequence[object],
    *,
    intent: BullpenAutoLiveOrderIntent,
) -> object | None:
    submitted_at = parse_datetime(
        intent.last_submitted_at or intent.first_submitted_at
    )
    if submitted_at is None:
        return None
    target_aliases = {
        value.strip().lower()
        for value in (intent.market_id, intent.condition_id, intent.slug)
        if isinstance(value, str) and value.strip()
    }
    target_shares = max(
        0.0,
        float(intent.current_shares or intent.requested_shares or 0.0),
    )
    target_notional = max(
        0.0,
        float(intent.current_order_usd or intent.requested_order_usd or 0.0),
    )
    earliest_correlated_at = submitted_at - timedelta(
        seconds=_BUY_HISTORY_TIMESTAMP_TOLERANCE_SECONDS
    )
    latest_correlated_at = submitted_at + timedelta(
        seconds=_buy_reconciliation_max_age_seconds()
    )
    for item in history:
        if str(getattr(item, "side", "") or "").upper() != "BUY":
            continue
        trade_at = parse_datetime(str(getattr(item, "timestamp", "") or ""))
        if (
            trade_at is None
            or trade_at < earliest_correlated_at
            or trade_at > latest_correlated_at
        ):
            continue
        raw = getattr(item, "raw", None)
        raw_order_id, _ = (
            _extract_remote_refs(raw) if isinstance(raw, dict) else (None, None)
        )
        reference_matches = bool(
            intent.remote_order_id
            and (
                str(getattr(item, "id", "") or "") == intent.remote_order_id
                or raw_order_id == intent.remote_order_id
            )
        )
        if not reference_matches and not (
            target_aliases and target_aliases.intersection(_evidence_aliases(item))
        ):
            continue
        outcome = str(getattr(item, "outcome", "") or "").strip().upper()
        if (
            intent.side
            and outcome not in {"", "—", "-"}
            and outcome != intent.side.upper()
        ):
            continue
        trade_shares = max(
            0.0,
            float(_safe_float(getattr(item, "shares", None)) or 0.0),
        )
        trade_notional = max(
            0.0,
            float(_safe_float(getattr(item, "amount", None)) or 0.0),
        )
        # A same-market row is not sufficient: require positive execution
        # quantity/notional bounded by this intent. This prevents a later,
        # unrelated BUY in the same market from terminalizing the fenced row.
        if trade_shares <= 0 and trade_notional <= 0:
            continue
        share_tolerance = max(1e-6, target_shares * 0.01)
        notional_tolerance = max(0.01, target_notional * 0.02)
        if (
            target_shares > 0
            and trade_shares > target_shares + share_tolerance
        ):
            continue
        if (
            target_notional > 0
            and trade_notional > target_notional + notional_tolerance
        ):
            continue
        return item
    return None


_HISTORY_TIMESTAMP_TOLERANCE_SECONDS = 5


def _matching_post_submit_exit_history(
    history: Sequence[object],
    *,
    intent: BullpenAutoLiveOrderIntent,
    action: str,
) -> object | None:
    """Return only alias/reference-correlated history from this submission."""

    submitted_at = parse_datetime(
        intent.last_submitted_at or intent.first_submitted_at
    )
    if submitted_at is None:
        return None
    target_aliases = {
        value.strip().lower()
        for value in (intent.market_id, intent.condition_id, intent.slug)
        if isinstance(value, str) and value.strip()
    }
    expected_side = action.upper()
    for item in history:
        item_side = str(getattr(item, "side", "") or "").strip().upper()
        if expected_side not in item_side:
            continue
        item_status = str(
            getattr(item, "status", "") or ""
        ).strip().lower().replace("-", "_")
        if item_status in {
            "cancelled",
            "canceled",
            "failed",
            "rejected",
            "timed_out",
            "timeout",
        }:
            continue
        evidence_at = parse_datetime(
            str(getattr(item, "timestamp", "") or "")
        )
        if (
            evidence_at is None
            or evidence_at
            < submitted_at
            - timedelta(seconds=_HISTORY_TIMESTAMP_TOLERANCE_SECONDS)
        ):
            continue

        raw = getattr(item, "raw", None)
        raw_order_id, raw_transaction_hash = (
            _extract_remote_refs(raw)
            if isinstance(raw, dict)
            else (None, None)
        )
        item_id = str(getattr(item, "id", "") or "")
        reference_matches = bool(
            (intent.remote_order_id and intent.remote_order_id in {
                item_id,
                raw_order_id,
            })
            or (
                intent.remote_transaction_hash
                and intent.remote_transaction_hash
                in {item_id, raw_transaction_hash}
            )
        )
        aliases_match = bool(
            target_aliases
            and target_aliases.intersection(_evidence_aliases(item))
        )
        if not reference_matches and not aliases_match:
            continue
        target_shares = max(
            0.0,
            float(
                intent.current_shares
                or intent.requested_shares
                or 0.0
            ),
        )
        evidence_shares = max(
            0.0,
            float(_safe_float(getattr(item, "shares", None)) or 0.0),
        )
        share_tolerance = max(0.000001, target_shares * 0.02)
        if (
            target_shares > 0
            and evidence_shares > target_shares + share_tolerance
        ):
            continue
        # Without an exact remote reference, a same-market row must carry a
        # compatible positive size. This prevents a later unrelated action in
        # the same market from becoming evidence for this intent.
        if not reference_matches and evidence_shares <= 0:
            continue
        if action == "sell":
            outcome = str(
                getattr(item, "outcome", "") or ""
            ).strip().upper()
            if (
                intent.side
                and outcome not in {"", "—", "-"}
                and outcome != intent.side.upper()
            ):
                continue
        return item
    return None


async def _terminal_buy_wallet_refresh_metadata(
    intent: BullpenAutoLiveOrderIntent,
    *,
    caller_source: str,
) -> dict[str, object]:
    """Publish one bounded force-fresh wallet snapshot after a terminal buy."""

    try:
        snapshot, lineage, comparison = await _read_post_submit_wallet_snapshot(
            intent,
            caller_source=caller_source,
        )
    except Exception as exc:
        error = (
            exc
            if isinstance(exc, AutoLiveExecutorError)
            else classify_executor_error(str(exc), during_write=False)
        )
        return {
            "status": "refresh_failed",
            "caller_source": caller_source,
            "error_code": getattr(error, "code", "POSITION_UNAVAILABLE"),
            "error": sanitize_message(str(getattr(error, "message", error))),
            "refreshed_at": utc_now_iso(),
        }
    return {
        "status": "published",
        "caller_source": caller_source,
        "source": lineage.get("source"),
        "fetched_at": lineage.get("fetched_at"),
        "freshness_state": lineage.get("freshness_state"),
        "account_identity": lineage.get("account_identity"),
        "credential_artifact": dict(
            lineage.get("credential_artifact")
            if isinstance(lineage.get("credential_artifact"), dict)
            else {}
        ),
        "position_classifier_version": lineage.get(
            "position_classifier_version"
        ),
        "lineage_comparison": comparison,
        "raw_position_count": snapshot.raw_position_count,
        "published_at": utc_now_iso(),
    }


async def _reconcile_buy_intent_async(
    intent: BullpenAutoLiveOrderIntent,
) -> IntentSubmissionResult:
    target_shares = max(
        0.0,
        float(intent.current_shares or intent.requested_shares or 0.0),
    )
    remote_status = None
    remote_poll_detail = None
    if intent.remote_order_id:
        try:
            poll_payload = await BullpenLiveExecutor().poll_order(
                order_id=intent.remote_order_id,
                interval_seconds=1,
                timeout_seconds=5,
            )
            (
                remote_status,
                filled,
                remaining,
                average,
            ) = _buy_poll_fields(poll_payload)
            if remote_status == "filled":
                terminal_intent = intent.model_copy(
                    update={
                        "last_submitted_at": (
                            intent.last_submitted_at
                            or intent.first_submitted_at
                            or utc_now_iso()
                        )
                    }
                )
                refresh_metadata = await _terminal_buy_wallet_refresh_metadata(
                    terminal_intent,
                    caller_source=(
                        "auto-live-stage3-buy-filled-post-submit-reconcile"
                    ),
                )
                return IntentSubmissionResult(
                    status="FILLED",
                    detail=(
                        "Bullpen order polling confirmed the buy is filled; "
                        "the worker forced a post-fill portfolio refresh."
                    ),
                    retryable=False,
                    filled_shares=(
                        filled if filled is not None else target_shares
                    ),
                    remaining_shares=0.0,
                    average_fill_price_cents=(
                        average or intent.current_limit_price_cents
                    ),
                    raw_response={
                        "post_buy_wallet_refresh": refresh_metadata,
                    },
                )
            if remote_status == "partially_filled":
                filled_value = max(0.0, float(filled or 0.0))
                remaining_value = (
                    max(0.0, float(remaining))
                    if remaining is not None
                    else max(0.0, target_shares - filled_value)
                )
                return IntentSubmissionResult(
                    status="PARTIALLY_FILLED",
                    detail=(
                        "Bullpen order polling confirmed a partial buy fill; "
                        "automatic resubmission remains prohibited while the "
                        "remote order is active."
                    ),
                    retryable=True,
                    filled_shares=filled_value,
                    remaining_shares=remaining_value,
                    average_fill_price_cents=average,
                    next_attempt_at=_next_confirmation_attempt_at(intent),
                )
            if remote_status == "rejected":
                return IntentSubmissionResult(
                    status="REJECTED",
                    detail=(
                        "Bullpen order polling definitively rejected the buy; "
                        "the persisted remote reference is retained for audit."
                    ),
                    retryable=False,
                    filled_shares=(
                        max(0.0, float(filled))
                        if filled is not None
                        else None
                    ),
                    remaining_shares=(
                        max(0.0, float(remaining))
                        if remaining is not None
                        else target_shares
                    ),
                    last_error_code="PERMANENT_REJECTION",
                )
            if remote_status == "cancelled":
                explicit_fill_evidence = filled is not None
                return IntentSubmissionResult(
                    status="CANCELLED",
                    detail=(
                        "Bullpen order polling cancelled the buy. "
                        + (
                            "The response included explicit fill quantity evidence."
                            if explicit_fill_evidence
                            else (
                                "The response omitted fill quantity, so reserved "
                                "cash and the retry fence remain in place pending "
                                "operator verification with Bullpen support."
                            )
                        )
                    ),
                    retryable=False,
                    filled_shares=(
                        max(0.0, float(filled))
                        if filled is not None
                        else None
                    ),
                    remaining_shares=(
                        max(0.0, float(remaining))
                        if remaining is not None
                        else target_shares
                    ),
                    last_error_code=(
                        "PERMANENT_REJECTION"
                        if explicit_fill_evidence
                        else "AMBIGUOUS_SUBMISSION"
                    ),
                )
            if remote_status == "timed_out":
                return IntentSubmissionResult(
                    status="TIMED_OUT",
                    detail=(
                        "Bullpen order polling timed out the buy without a "
                        "definitive fill. The persisted remote reference remains "
                        "fenced; an operator must verify it with Bullpen support "
                        "before any recovery."
                    ),
                    retryable=False,
                    filled_shares=max(0.0, float(filled or 0.0)),
                    remaining_shares=(
                        max(0.0, float(remaining))
                        if remaining is not None
                        else target_shares
                    ),
                    last_error_code="AMBIGUOUS_SUBMISSION",
                )
            if remote_status == "open":
                remote_poll_detail = (
                    "Bullpen polling still reports the persisted buy order as "
                    "open; forced-fresh wallet and correlated history evidence "
                    "did not yet prove a fill."
                )
            else:
                remote_poll_detail = (
                    "Bullpen polling returned no recognized terminal state for "
                    "the persisted buy order."
                )
        except Exception as exc:
            classified = (
                exc
                if isinstance(exc, AutoLiveExecutorError)
                else classify_executor_error(str(exc), during_write=False)
            )
            remote_poll_detail = (
                "Bullpen buy-order polling was inconclusive "
                f"({getattr(classified, 'code', 'ORDER_WRITE_UNAVAILABLE')}): "
                f"{sanitize_message(str(getattr(classified, 'message', classified)))}"
            )

    try:
        live_snapshot, lineage, lineage_comparison = (
            await _read_post_submit_wallet_snapshot(
                intent,
                caller_source="auto-live-stage3-buy-post-submit-reconcile",
            )
        )
    except Exception as exc:
        classified = (
            exc
            if isinstance(exc, AutoLiveExecutorError)
            else classify_executor_error(str(exc), during_write=False)
        )
        return _buy_ambiguity_result(
            intent,
            detail=(
                f"{remote_poll_detail + ' ' if remote_poll_detail else ''}"
                "Forced-fresh post-submit wallet reconciliation was rejected: "
                f"{sanitize_message(str(getattr(classified, 'message', classified)))}"
            ),
            last_error_code=str(
                getattr(classified, "code", "POSITION_UNAVAILABLE")
            ),
        )

    lineage_checks: dict[str, dict[str, object]] = {}
    incomplete_lineages: list[str] = []
    if not _wallet_identity_lineage_is_complete(lineage):
        incomplete_lineages.append("actual")
    for lineage_name, expected_lineage in (
        (
            "preflight",
            intent.execution_metadata_json.get("wallet_snapshot_lineage"),
        ),
        (
            "stage1",
            intent.execution_metadata_json.get(
                "expected_stage1_wallet_lineage"
            ),
        ),
    ):
        if not isinstance(expected_lineage, dict) or not expected_lineage:
            continue
        if not _wallet_identity_lineage_is_complete(expected_lineage):
            incomplete_lineages.append(lineage_name)
        comparison = _compare_wallet_snapshot_lineage(
            expected=expected_lineage,
            actual=lineage,
        )
        lineage_checks[lineage_name] = comparison
        if comparison.get("status") == "mismatch":
            return _buy_ambiguity_result(
                intent,
                detail=(
                    f"{remote_poll_detail + ' ' if remote_poll_detail else ''}"
                    "The forced-fresh wallet snapshot failed the persisted "
                    f"{lineage_name} account, credential, classifier, or "
                    "timestamp lineage comparison."
                ),
                last_error_code="POSITION_LINEAGE_MISMATCH",
            )

    if (
        lineage_comparison.get("status") != "match"
        or not lineage_checks
        or bool(incomplete_lineages)
        or any(
            comparison.get("status") != "match"
            for comparison in lineage_checks.values()
        )
    ):
        return _buy_ambiguity_result(
            intent,
            detail=(
                f"{remote_poll_detail + ' ' if remote_poll_detail else ''}"
                "The fresh wallet snapshot has no persisted Stage 1/preflight "
                "account, credential, and classifier lineage proof, so it cannot "
                "confirm this buy."
            ),
            last_error_code="POSITION_LINEAGE_UNAVAILABLE",
        )

    matching_positions = [
        position
        for position in live_snapshot.positions
        if _position_matches_intent(
            position,
            market_id=intent.market_id,
            condition_id=intent.condition_id,
            side=intent.side,
            slug=intent.slug,
        )
    ]
    current_shares = sum(
        max(0.0, float(getattr(position, "shares", 0.0) or 0.0))
        for position in matching_positions
    )
    wallet_evidence = {
        "source": lineage.get("source"),
        "fetched_at": lineage.get("fetched_at"),
        "account_identity": lineage.get("account_identity"),
        "position_classifier_version": lineage.get(
            "position_classifier_version"
        ),
        "lineage_comparison": lineage_comparison,
        "lineage_checks": lineage_checks,
    }
    if current_shares > 0:
        if target_shares <= 0 or current_shares + 1e-6 >= target_shares:
            return IntentSubmissionResult(
                status="FILLED",
                detail=(
                    "Forced-fresh, same-lineage wallet reconciliation confirmed "
                    "the buy position is present."
                ),
                retryable=False,
                filled_shares=current_shares,
                remaining_shares=max(0.0, target_shares - current_shares),
                average_fill_price_cents=intent.current_limit_price_cents,
                raw_response={"post_buy_wallet_refresh": wallet_evidence},
            )
        return IntentSubmissionResult(
            status="PARTIALLY_FILLED",
            detail=(
                "Forced-fresh, same-lineage wallet reconciliation confirmed a "
                "partial buy fill."
            ),
            retryable=True,
            filled_shares=current_shares,
            remaining_shares=max(0.0, target_shares - current_shares),
            average_fill_price_cents=intent.current_limit_price_cents,
            next_attempt_at=_next_confirmation_attempt_at(intent),
            raw_response={"post_buy_wallet_refresh": wallet_evidence},
        )

    try:
        trade_history = await BullpenTradeHistoryReader().refresh()
    except Exception as exc:
        return _buy_ambiguity_result(
            intent,
            detail=(
                f"{remote_poll_detail + ' ' if remote_poll_detail else ''}"
                "The fresh wallet contains no matching position and Bullpen "
                "trade-history correlation failed: "
                f"{sanitize_message(str(exc))}"
            ),
        )
    trade = _matching_post_submit_buy_trade(trade_history, intent=intent)
    if trade is not None:
        trade_shares = max(
            0.0,
            float(_safe_float(getattr(trade, "shares", None)) or 0.0),
        )
        trade_notional = max(
            0.0,
            float(_safe_float(getattr(trade, "amount", None)) or 0.0),
        )
        trade_price = _safe_float(getattr(trade, "price", None))
        average_price_cents = None
        if trade_price is not None:
            average_price_cents = (
                trade_price * 100 if trade_price <= 1 else trade_price
            )
            average_price_cents = max(
                0.0,
                min(100.0, average_price_cents),
            )
        if (
            trade_shares <= 0
            and trade_notional > 0
            and average_price_cents is not None
            and average_price_cents > 0
        ):
            trade_shares = trade_notional / (
                average_price_cents / 100
            )
        if (
            target_shares > 0
            and trade_shares
            > target_shares + max(1e-6, target_shares * 0.01)
        ):
            return _buy_ambiguity_result(
                intent,
                detail=(
                    "A post-attempt alias-correlated history row has a fill "
                    "quantity incompatible with the planned buy and cannot "
                    "terminalize it."
                ),
            )
        if trade_shares <= 0:
            target_notional = max(
                0.0,
                float(
                    intent.current_order_usd
                    or intent.requested_order_usd
                    or 0.0
                ),
            )
            full_notional_tolerance = max(
                0.01,
                target_notional * 0.02,
            )
            if (
                target_notional <= 0
                or trade_notional
                < target_notional - full_notional_tolerance
            ):
                return _buy_ambiguity_result(
                    intent,
                    detail=(
                        "A post-attempt alias-correlated history row exists, "
                        "but it lacks compatible fill quantity/full-notional "
                        "evidence and cannot terminalize the buy."
                    ),
                )
            trade_shares = target_shares
        if trade_shares > 0 and target_shares > 0 and (
            trade_shares + 1e-6 < target_shares
        ):
            return IntentSubmissionResult(
                status="PARTIALLY_FILLED",
                detail=(
                    "Post-attempt, alias-correlated Bullpen trade history "
                    "confirmed a partial buy fill."
                ),
                retryable=True,
                filled_shares=trade_shares,
                remaining_shares=max(0.0, target_shares - trade_shares),
                average_fill_price_cents=average_price_cents,
                next_attempt_at=_next_confirmation_attempt_at(intent),
                raw_response={"post_buy_wallet_refresh": wallet_evidence},
            )
        return IntentSubmissionResult(
            status="FILLED",
            detail=(
                "Post-attempt, alias-correlated Bullpen trade history confirmed "
                "the buy execution."
            ),
            retryable=False,
            filled_shares=trade_shares,
            remaining_shares=0.0,
            average_fill_price_cents=average_price_cents,
            raw_response={"post_buy_wallet_refresh": wallet_evidence},
        )

    return _buy_ambiguity_result(
        intent,
        detail=(
            f"{remote_poll_detail + ' ' if remote_poll_detail else ''}"
            "The forced-fresh, same-lineage wallet snapshot and post-attempt "
            "alias-correlated trade history contain no definitive buy fill."
        ),
    )


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
    if intent.action == "buy":
        return await _reconcile_buy_intent_async(intent)

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
                _first_present_value(
                    payload,
                    "filledShares",
                    "filled_shares",
                    "filled",
                )
            )
            remaining = _safe_float(
                _first_present_value(
                    payload,
                    "remainingShares",
                    "remaining_shares",
                    "remaining",
                )
            )
            average = _safe_float(
                _first_present_value(
                    payload,
                    "averageFillPriceCents",
                    "average_fill_price_cents",
                    "avgPriceCents",
                )
            )
            if status in {"filled", "confirmed", "complete", "completed", "redeemed"}:
                try:
                    (
                        fresh_snapshot,
                        post_exit_lineage,
                        post_exit_lineage_comparison,
                    ) = await _read_post_submit_wallet_snapshot(
                        intent,
                        caller_source=(
                            "auto-live-stage3-post-exit-intent-reconcile"
                        ),
                    )
                except AutoLiveExecutorError as snapshot_error:
                    return IntentSubmissionResult(
                        status="SETTLEMENT_PENDING",
                        detail=(
                            "Bullpen marked the exit filled, but Stage 3 could not "
                            f"verify a same-lineage post-exit wallet snapshot: "
                            f"{snapshot_error.message}"
                        ),
                        retryable=True,
                        next_attempt_at=_next_confirmation_attempt_at(intent),
                        last_error_code=snapshot_error.code,
                    )
                capacity_policy = intent.execution_metadata_json.get("stage3_capacity_policy")
                capacity_policy = capacity_policy if isinstance(capacity_policy, dict) else {}
                dust_threshold = float(
                    capacity_policy.get("dust_threshold_usd", 0.01) or 0.01
                )
                snapshot_metadata = _post_exit_snapshot_metadata(
                    fresh_snapshot,
                    dust_threshold_usd=dust_threshold,
                )
                snapshot_metadata["wallet_snapshot_lineage"] = post_exit_lineage
                snapshot_metadata["wallet_lineage_comparison"] = (
                    post_exit_lineage_comparison
                )
                (
                    enriched_post_exit_positions,
                    post_exit_market_enrichment,
                ) = await enrich_console_wallet_positions_authoritatively(
                    fresh_snapshot.raw_positions or fresh_snapshot.positions
                )
                snapshot_metadata["market_enrichment"] = (
                    post_exit_market_enrichment
                )
                if post_exit_market_enrichment.get("unresolved_position_count"):
                    return IntentSubmissionResult(
                        status="SETTLEMENT_PENDING",
                        detail=(
                            "Bullpen marked the Event Exit filled, but positive "
                            "wallet exposure could not be authoritatively classified; "
                            "the replacement slot remains occupied."
                        ),
                        retryable=True,
                        next_attempt_at=_next_confirmation_attempt_at(intent),
                        last_error_code="POSITION_UNAVAILABLE",
                        raw_response={
                            "post_exit_snapshot": snapshot_metadata,
                        },
                    )
                allocation = classify_economic_slots(
                    enriched_post_exit_positions,
                    dust_threshold_usd=dust_threshold,
                )
                snapshot_metadata.update(
                    {
                        "economically_active_position_count": (
                            allocation.economically_active_position_count
                        ),
                        "excluded_position_records": (
                            allocation.excluded_position_records
                        ),
                        "deduplicated_occupied_market_ids": (
                            allocation.deduplicated_occupied_market_ids
                        ),
                        "free_slots_after_refresh": max(
                            0,
                            10
                            - allocation.economically_active_position_count,
                        ),
                    }
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
                matching_post_exit_positions = [
                    position
                    for position in enriched_post_exit_positions
                    if _position_matches_intent(
                        position,
                        market_id=intent.market_id,
                        condition_id=intent.condition_id,
                        side=intent.side,
                        slug=intent.slug,
                    )
                ]
                active_position_ids = {
                    id(position) for position in allocation.active_positions
                }
                remaining_positions = [
                    position
                    for position in matching_post_exit_positions
                    if id(position) in active_position_ids
                    or _position_requires_redeem(
                        position,
                        dust_threshold_usd=dust_threshold,
                    )
                ]
                if remaining_positions:
                    remaining_shares = sum(
                        float(getattr(position, "shares", 0.0) or 0.0)
                        for position in remaining_positions
                    )
                    return IntentSubmissionResult(
                        status="SETTLEMENT_PENDING",
                        detail=(
                            "Bullpen reported the Event Exit filled, but the fresh lineage-fenced "
                            "snapshot still shows meaningful or redeemable exposure; "
                            "the replacement buy remains blocked."
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
                if remaining_value_usd > dust_threshold:
                    return IntentSubmissionResult(
                        status="PARTIALLY_FILLED",
                        detail="Bullpen order polling found a partial Event Exit fill; remaining exposure stays occupied.",
                        retryable=True,
                        filled_shares=filled,
                        remaining_shares=remaining_value,
                        average_fill_price_cents=average,
                        next_attempt_at=_next_confirmation_attempt_at(intent),
                    )
                # A remote remaining-size estimate is not authoritative enough
                # to release a slot. Fall through to the force-fresh,
                # lineage-fenced wallet reconciliation below.
            if status in {"rejected", "failed", "error"}:
                if filled is not None and filled <= 0:
                    return IntentSubmissionResult(
                        status="REJECTED",
                        detail="Bullpen order polling explicitly reported that the Event Exit was rejected without a fill.",
                        retryable=False,
                        filled_shares=0.0,
                        remaining_shares=remaining,
                    )
                # Rejection with an omitted or positive fill quantity may have
                # crossed a partial-fill boundary. Fall through to the fresh
                # wallet snapshot instead of stranding a released slot.
            if status in {"cancelled", "canceled"}:
                if filled is not None and filled <= 0:
                    return IntentSubmissionResult(
                        status="CANCELLED",
                        detail="Bullpen order polling explicitly reported that the Event Exit was cancelled without a fill.",
                        retryable=False,
                        filled_shares=0.0,
                        remaining_shares=remaining,
                    )
                # Cancellation can follow a partial match. Require the same
                # lineage-fenced wallet proof used by filled exits.
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

    try:
        (
            live_snapshot,
            post_exit_lineage,
            post_exit_lineage_comparison,
        ) = await _read_post_submit_wallet_snapshot(
            intent,
            caller_source="auto-live-stage3-post-exit-intent-reconcile",
        )
    except AutoLiveExecutorError as snapshot_error:
        return IntentSubmissionResult(
            status="SETTLEMENT_PENDING",
            detail=(
                "Stage 3 could not verify a force-fresh, same-lineage "
                f"post-exit wallet snapshot: {snapshot_error.message}"
            ),
            retryable=True,
            next_attempt_at=_next_confirmation_attempt_at(intent),
            last_error_code=snapshot_error.code,
        )

    (
        wallet_positions,
        post_exit_market_enrichment,
    ) = await enrich_console_wallet_positions_authoritatively(
        live_snapshot.raw_positions or live_snapshot.positions
    )
    capacity_policy = intent.execution_metadata_json.get(
        "stage3_capacity_policy"
    )
    capacity_policy = capacity_policy if isinstance(capacity_policy, dict) else {}
    dust_threshold = float(
        capacity_policy.get("dust_threshold_usd", 0.01) or 0.01
    )
    allocation = classify_economic_slots(
        wallet_positions,
        dust_threshold_usd=dust_threshold,
    )
    fallback_snapshot_metadata = _post_exit_snapshot_metadata(
        live_snapshot,
        dust_threshold_usd=dust_threshold,
    )
    fallback_snapshot_metadata.update(
        {
            "wallet_snapshot_lineage": post_exit_lineage,
            "wallet_lineage_comparison": post_exit_lineage_comparison,
            "market_enrichment": post_exit_market_enrichment,
            "economically_active_position_count": (
                allocation.economically_active_position_count
            ),
            "excluded_position_records": allocation.excluded_position_records,
            "deduplicated_occupied_market_ids": (
                allocation.deduplicated_occupied_market_ids
            ),
            "free_slots_after_refresh": max(
                0,
                10 - allocation.economically_active_position_count,
            ),
        }
    )
    if post_exit_market_enrichment.get("unresolved_position_count"):
        return IntentSubmissionResult(
            status="SETTLEMENT_PENDING",
            detail=(
                "The post-exit wallet still contains positive exposure that "
                "could not be authoritatively classified; the replacement buy "
                "remains blocked."
            ),
            retryable=True,
            next_attempt_at=_next_confirmation_attempt_at(intent),
            last_error_code="POSITION_UNAVAILABLE",
            raw_response={
                "post_exit_snapshot": fallback_snapshot_metadata,
            },
        )

    matching_positions = [
        position
        for position in wallet_positions
        if _position_matches_intent(
            position,
            market_id=intent.market_id,
            condition_id=intent.condition_id,
            side=intent.side if intent.action == "sell" else None,
            slug=intent.slug,
        )
    ]
    active_position_ids = {
        id(position) for position in allocation.active_positions
    }
    blocking_positions = [
        position
        for position in matching_positions
        if id(position) in active_position_ids
        or _position_requires_redeem(
            position,
            dust_threshold_usd=dust_threshold,
        )
    ]

    if intent.action == "sell":
        current_shares = sum(
            max(0.0, float(getattr(position, "shares", 0.0) or 0.0))
            for position in blocking_positions
        )
        baseline_shares = max(
            0.0,
            float(intent.current_shares or intent.requested_shares or 0.0),
        )
        if not blocking_positions:
            return IntentSubmissionResult(
                status="FILLED",
                detail=(
                    "Forced-fresh, same-lineage wallet reconciliation confirmed "
                    "that no meaningful or redeemable sell exposure remains."
                ),
                retryable=False,
                filled_shares=baseline_shares,
                remaining_shares=0.0,
                raw_response={
                    "post_exit_snapshot": fallback_snapshot_metadata,
                },
            )
        if current_shares + 1e-6 < baseline_shares:
            return IntentSubmissionResult(
                status="PARTIALLY_FILLED",
                detail=(
                    "Forced-fresh, same-lineage wallet reconciliation found a "
                    "partial sell fill; remaining exposure stays blocked."
                ),
                retryable=True,
                filled_shares=max(0.0, baseline_shares - current_shares),
                remaining_shares=current_shares,
                next_attempt_at=_next_confirmation_attempt_at(intent),
                raw_response={
                    "post_exit_snapshot": fallback_snapshot_metadata,
                },
            )
        try:
            trade_history = await BullpenTradeHistoryReader().refresh()
            trade = _matching_post_submit_exit_history(
                trade_history,
                intent=intent,
                action="sell",
            )
        except Exception:
            trade = None
        return IntentSubmissionResult(
            status="SETTLEMENT_PENDING",
            detail=(
                "A post-attempt Bullpen sell-history row exists, but the fresh "
                "wallet still shows the full exposure; history is acceptance "
                "evidence only and cannot release the replacement buy."
                if trade is not None
                else (
                    "Sell reconciliation is still waiting for the fresh wallet "
                    "to prove that exposure was reduced."
                )
            ),
            retryable=True,
            filled_shares=max(0.0, baseline_shares - current_shares),
            remaining_shares=current_shares,
            next_attempt_at=_next_confirmation_attempt_at(intent),
            raw_response={
                "post_exit_snapshot": fallback_snapshot_metadata,
                "correlated_sell_history": trade is not None,
            },
        )

    try:
        redeemed_history = await BullpenRedeemedTradesReader().refresh()
        redeemed_trade = _matching_post_submit_exit_history(
            redeemed_history,
            intent=intent,
            action="redeem",
        )
    except Exception:
        redeemed_trade = None
    if not blocking_positions:
        return IntentSubmissionResult(
            status="CONFIRMED",
            detail=(
                "Forced-fresh, same-lineage wallet reconciliation no longer "
                "shows meaningful or redeemable exposure for this condition."
            ),
            retryable=False,
            raw_response={
                "post_exit_snapshot": fallback_snapshot_metadata,
                "correlated_redeem_history": redeemed_trade is not None,
            },
        )
    return IntentSubmissionResult(
        status="SETTLEMENT_PENDING",
        detail=(
            "A post-attempt Bullpen redeem-history row exists, but the fresh "
            "wallet still shows redeemable exposure; history cannot terminalize "
            "the intent by itself."
            if redeemed_trade is not None
            else (
                "Redeem reconciliation is still waiting for the fresh wallet "
                "to prove settlement."
            )
        ),
        retryable=True,
        next_attempt_at=_next_confirmation_attempt_at(intent),
        raw_response={
            "post_exit_snapshot": fallback_snapshot_metadata,
            "correlated_redeem_history": redeemed_trade is not None,
        },
    )


def reconcile_order_intent_sync(intent_id: str) -> str | None:
    with SyncSessionLocal() as session:
        record = session.get(PolymarketAutoLiveOrderIntentRecord, intent_id)
        if record is None:
            return None
        latest_attempt = session.execute(
            select(PolymarketAutoLiveOrderAttemptRecord)
            .where(PolymarketAutoLiveOrderAttemptRecord.intent_id == intent_id)
            .order_by(PolymarketAutoLiveOrderAttemptRecord.attempt_number.desc())
        ).scalars().first()
        persisted_response = (
            dict(latest_attempt.sanitized_response_json or {})
            if latest_attempt is not None
            else {}
        )
        remote_order_id, remote_transaction_hash = _extract_remote_refs(
            persisted_response
        )
        if remote_order_id:
            record.remote_order_id = record.remote_order_id or remote_order_id
            if latest_attempt is not None:
                latest_attempt.remote_order_id = (
                    latest_attempt.remote_order_id or remote_order_id
                )
        if remote_transaction_hash:
            record.remote_transaction_hash = (
                record.remote_transaction_hash or remote_transaction_hash
            )
            if latest_attempt is not None:
                latest_attempt.remote_transaction_hash = (
                    latest_attempt.remote_transaction_hash or remote_transaction_hash
                )
        matched_fill = (
            _matched_buy_submission_fill(persisted_response)
            if record.action == "buy"
            else None
        )
        if matched_fill is not None:
            now = utc_now()
            persisted_submission_at = (
                record.last_submitted_at
                or record.first_submitted_at
                or (
                    latest_attempt.started_at
                    if latest_attempt is not None
                    else None
                )
                or record.created_at
            )
            terminal_refresh_intent = _intent_to_schema(record).model_copy(
                update={
                    "last_submitted_at": _isoformat(persisted_submission_at),
                }
            )
            post_buy_terminal_wallet_refresh = (
                run_with_bullpen_runtime_cleanup(
                    _terminal_buy_wallet_refresh_metadata(
                        terminal_refresh_intent,
                        caller_source=(
                            "auto-live-stage3-buy-persisted-match-refresh"
                        ),
                    )
                )
            )
            record.status = "FILLED"
            record.retryable = False
            record.last_error_code = None
            record.last_error_message = (
                "Persisted Bullpen buy response confirmed the order matched."
            )
            record.next_attempt_at = None
            record.filled_shares = matched_fill[0]
            record.remaining_shares = 0.0
            record.average_fill_price_cents = matched_fill[1]
            record.first_submitted_at = record.first_submitted_at or now
            record.last_submitted_at = record.last_submitted_at or now
            record.confirmed_at = record.confirmed_at or now
            record.terminal_at = record.terminal_at or now
            record.execution_metadata_json = {
                **dict(record.execution_metadata_json or {}),
                "stage3_status": "BUY_SUBMITTED",
                "confirmation_source": "persisted_bullpen_matched_response",
                "post_buy_terminal_wallet_refresh": (
                    post_buy_terminal_wallet_refresh
                ),
            }
            if latest_attempt is not None:
                latest_attempt.completed_at = latest_attempt.completed_at or now
                latest_attempt.result_status = "FILLED"
                latest_attempt.reconciliation_json = {
                    **dict(latest_attempt.reconciliation_json or {}),
                    "_post_buy_terminal_wallet_refresh": (
                        post_buy_terminal_wallet_refresh
                    ),
                }
            _upsert_reservation(
                session,
                intent=record,
                amount_usd=float(record.current_order_usd or 0.0),
                status="consumed",
            )
            sync_run_and_decisions_from_intents_sync(
                session,
                user_id=record.user_id,
                run_id=record.run_id,
            )
            session.commit()
            return record.status
        session.commit()
        if record.status not in INTENT_PENDING_CONFIRMATION_STATUSES:
            return record.status
        intent = _intent_to_schema(record)
    result = run_with_bullpen_runtime_cleanup(_reconcile_intent_async(intent))
    with SyncSessionLocal() as session:
        record = session.get(PolymarketAutoLiveOrderIntentRecord, intent_id)
        if record is None:
            return None
        if not _reconciliation_snapshot_is_current(record, intent):
            return record.status
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
        if (
            record.action == "buy"
            and isinstance(result.raw_response, dict)
            and isinstance(
                result.raw_response.get("post_buy_wallet_refresh"),
                dict,
            )
        ):
            post_buy_refresh = dict(
                result.raw_response["post_buy_wallet_refresh"]
            )
            record.execution_metadata_json = {
                **dict(record.execution_metadata_json or {}),
                "post_buy_terminal_wallet_refresh": post_buy_refresh,
            }
            latest_attempt = session.execute(
                select(PolymarketAutoLiveOrderAttemptRecord)
                .where(
                    PolymarketAutoLiveOrderAttemptRecord.intent_id
                    == record.id
                )
                .order_by(
                    PolymarketAutoLiveOrderAttemptRecord.attempt_number.desc()
                )
            ).scalars().first()
            if latest_attempt is not None:
                latest_attempt.reconciliation_json = {
                    **dict(latest_attempt.reconciliation_json or {}),
                    "_post_buy_terminal_wallet_refresh": post_buy_refresh,
                }
        if (
            record.action == "buy"
            and isinstance(result.raw_response, dict)
            and isinstance(
                result.raw_response.get(
                    "buy_reconciliation_operator_block"
                ),
                dict,
            )
        ):
            operator_block = dict(
                result.raw_response[
                    "buy_reconciliation_operator_block"
                ]
            )
            record.execution_metadata_json = {
                **dict(record.execution_metadata_json or {}),
                "automatic_resubmission": False,
                "buy_reconciliation_operator_block": operator_block,
            }
            latest_attempt = session.execute(
                select(PolymarketAutoLiveOrderAttemptRecord)
                .where(
                    PolymarketAutoLiveOrderAttemptRecord.intent_id
                    == record.id
                )
                .order_by(
                    PolymarketAutoLiveOrderAttemptRecord.attempt_number.desc()
                )
            ).scalars().first()
            if latest_attempt is not None:
                latest_attempt.reconciliation_json = {
                    **dict(latest_attempt.reconciliation_json or {}),
                    "buy_reconciliation_operator_block": operator_block,
                }
        if (
            record.action == "buy"
            and result.status in INTENT_TERMINAL_FAILURE_STATUSES
        ):
            record.execution_metadata_json = {
                **dict(record.execution_metadata_json or {}),
                "reconciliation_fill_evidence": (
                    _result_fill_evidence(result)
                ),
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
            definitive_no_fill = _result_definitively_proves_no_fill(result)
            _release_buy_reservation_if_no_remote_evidence(
                session,
                record,
                reason=(
                    f"Reconciliation terminalized this buy as {result.status} "
                    "without persisted remote evidence."
                ),
                definitive_no_fill=definitive_no_fill,
            )
            if (
                record.dependency_group
                and result.status
                in _DEFINITIVE_EXIT_DEPENDENCY_FAILURE_STATUSES
            ):
                for replacement in session.execute(
                    select(PolymarketAutoLiveOrderIntentRecord)
                    .where(PolymarketAutoLiveOrderIntentRecord.run_id == record.run_id)
                    .where(PolymarketAutoLiveOrderIntentRecord.dependency_group == record.dependency_group)
                    .where(PolymarketAutoLiveOrderIntentRecord.action == "buy")
                    .where(
                        PolymarketAutoLiveOrderIntentRecord.status.in_(
                            (
                                "READY",
                                "WAITING_FOR_COLLATERAL",
                                "WAITING_FOR_EXIT",
                                "RETRY_WAIT",
                            )
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
                    _release_buy_reservation_if_no_remote_evidence(
                        session,
                        replacement,
                        reason=(
                            f"Dependent exit {record.market_id} ended in "
                            f"{result.status} before the replacement buy was submitted."
                        ),
                        definitive_no_fill=True,
                    )
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
            # Preserve the dependency lock order used by
            # ``_defer_buy_until_exit``: EXIT row first, dependent BUY row
            # second. Do not rely on an incidental reservation flush here;
            # SyncSessionLocal disables autoflush.
            session.flush([record])
            _wake_waiting_buys_after_exit_success(
                session,
                exit_record=record,
                confirmed_at=record.confirmed_at,
            )
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


def retry_order_intent_for_user_sync(
    *,
    user_id: int,
    intent_id: str,
    remote_absence_verified: bool = False,
) -> BullpenAutoLiveRunOrdersResponse:
    with SyncSessionLocal() as session:
        return retry_order_intent_sync(
            session,
            user_id=user_id,
            intent_id=intent_id,
            remote_absence_verified=remote_absence_verified,
        )


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
            decision_records = _visible_run_decision_records_sync(
                session,
                user_id=user_id,
                run_id=run_id,
            )
            saved_decisions = [record_to_decision(item) for item in decision_records]
            replacement_group_by_buy_market: dict[str, str] = {}
            replacement_group_by_exit_market: dict[str, str] = {}
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
                        saved_group = reservation.get("dependency_group")
                        dependency_group = (
                            saved_group.strip()
                            if isinstance(saved_group, str)
                            and saved_group.strip()
                            else f"stage3-replacement:{run_id}:{exit_market}"
                        )
                        replacement_group_by_buy_market[
                            buy_market
                        ] = dependency_group
                        replacement_group_by_exit_market[
                            exit_market
                        ] = dependency_group
            for decision in saved_decisions:
                if decision.order_plan is None:
                    continue
                dependency_group = (
                    replacement_group_by_buy_market.get(decision.market_id)
                    if decision.order_plan.action == "buy"
                    else replacement_group_by_exit_market.get(
                        decision.market_id
                    )
                    if decision.order_plan.action in {"sell", "redeem"}
                    else None
                )
                if dependency_group:
                    decision.order_plan = decision.order_plan.model_copy(
                        update={
                            "dependency_group": dependency_group
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
            if _intent_requires_operator_resume_reconciliation(intent):
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
                dependency_exit = next(
                    (
                        candidate
                        for candidate in existing
                        if candidate.id != intent.id
                        and candidate.dependency_group
                        == intent.dependency_group
                        and candidate.action in {"sell", "redeem"}
                    ),
                    None,
                )
                dependency_confirmed = bool(
                    intent.dependency_group
                    and dependency_exit is not None
                    and dependency_exit.status
                    in INTENT_TERMINAL_SUCCESS_STATUSES
                    and intent.dependency_metadata_json.get(
                        "exit_confirmed_at"
                    )
                )
                if intent.dependency_group and not dependency_confirmed:
                    intent.status = "WAITING_FOR_EXIT"
                    intent.retryable = True
                    intent.terminal_at = None
                    intent.next_attempt_at = None
                    intent.last_error_code = "SETTLEMENT_PENDING"
                    intent.last_error_message = (
                        "Operator resume kept this replacement buy blocked "
                        "until its matching exit is durably confirmed."
                    )
                    intent.dependency_metadata_json = {
                        **dict(intent.dependency_metadata_json or {}),
                        "state": "waiting_for_exit",
                    }
                    intent.execution_metadata_json = {
                        **dict(intent.execution_metadata_json or {}),
                        "stage3_status": "REPLACEMENT_SLOT_RESERVED",
                        "operator_resume_action": (
                            "Retry failed exits and continue buys"
                        ),
                        "operator_resume_at": resumed_at,
                        "recovery_required": False,
                        "current_blockage": intent.last_error_message,
                    }
                    continue
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
