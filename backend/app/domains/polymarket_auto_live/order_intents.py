from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
import hashlib
import math
import os
from typing import Iterable, Sequence

from app.domains.polymarket.logger import redact_secrets
from app.domains.polymarket_auto_live.rpc_retry import (
    extract_retry_after_seconds,
    is_rpc_rate_limited,
)
from app.domains.polymarket_auto_live.schemas import (
    BullpenAutoLiveOrderFunnel,
    BullpenAutoLiveOrderIntent,
    BullpenAutoLiveOrderPlan,
)

INTENT_PENDING_CONFIRMATION_STATUSES = frozenset(
    {
        "SUBMITTING",
        "SUBMITTED",
        "CONFIRMING",
        "PARTIALLY_FILLED",
        "SETTLEMENT_PENDING",
        "WAITING_FOR_COLLATERAL",
        "WAITING_FOR_EXIT",
    }
)
INTENT_TERMINAL_SUCCESS_STATUSES = frozenset({"CONFIRMED", "FILLED"})
INTENT_TERMINAL_FAILURE_STATUSES = frozenset(
    {"DEFERRED", "CANCELLED", "FAILED_PERMANENT", "REJECTED", "TIMED_OUT"}
)
INTENT_READY_STATUSES = frozenset(
    {"READY", "RETRY_WAIT", "WAITING_FOR_COLLATERAL", "WAITING_FOR_EXIT"}
)
INTENT_RETRYABLE_STATUSES = frozenset(
    {"RETRY_WAIT", "WAITING_FOR_COLLATERAL", "WAITING_FOR_EXIT", "DEFERRED"}
)
TRANSIENT_ERROR_CODES = frozenset(
    {
        "RPC_RATE_LIMITED",
        "RPC_UNAVAILABLE",
        "HTTP_502",
        "HTTP_503",
        "HTTP_504",
        "NETWORK_TIMEOUT",
        "CONNECTION_RESET",
        "AUTH_EXPIRED",
        "SESSION_INVALID",
        "LIVE_LOCKED",
        "DOCTOR_READ_FAILED",
        "ORDER_WRITE_UNAVAILABLE",
        "BALANCE_UNAVAILABLE",
        "INSUFFICIENT_COLLATERAL",
        "SETTLEMENT_PENDING",
        "QUOTE_UNAVAILABLE",
        "QUOTE_STALE",
        "AMBIGUOUS_SUBMISSION",
    }
)


def utc_now() -> datetime:
    return datetime.now(UTC)


def utc_now_iso() -> str:
    return utc_now().isoformat()


def read_bool_env(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "y", "on"}


def read_int_env(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        return int(float(value))
    except ValueError:
        return default


def parse_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def sanitize_message(message: str | None) -> str | None:
    if message is None:
        return None
    cleaned = redact_secrets(str(message)).strip()
    return cleaned or None


def sanitize_json_payload(value: object) -> dict[str, object]:
    if not isinstance(value, dict):
        return {}
    redacted: dict[str, object] = {}
    for key, item in value.items():
        lowered = str(key).lower()
        if any(
            secret_marker in lowered
            for secret_marker in (
                "cookie",
                "secret",
                "token",
                "auth",
                "authorization",
                "private",
                "rpc_url",
            )
        ):
            continue
        if isinstance(item, str):
            redacted[str(key)] = redact_secrets(item)
        elif isinstance(item, dict):
            redacted[str(key)] = sanitize_json_payload(item)
        elif isinstance(item, list):
            redacted[str(key)] = [
                sanitize_json_payload(entry) if isinstance(entry, dict) else entry
                for entry in item
            ]
        else:
            redacted[str(key)] = item
    return redacted


@dataclass(frozen=True)
class AutoLiveExecutorError(Exception):
    code: str
    message: str
    retryable: bool
    retry_after_seconds: int | None = None
    ambiguous_submission: bool = False
    provider_alias: str | None = None

    def __str__(self) -> str:
        return self.message


def _message_has_any(message: str, markers: Sequence[str]) -> bool:
    lowered = message.lower()
    return any(marker in lowered for marker in markers)


def classify_executor_error(
    message: object,
    *,
    during_write: bool = False,
    provider_alias: str | None = None,
) -> AutoLiveExecutorError:
    sanitized = sanitize_message(str(message)) or "Unknown Bullpen execution failure."
    lowered = sanitized.lower()

    def _error(
        code: str,
        *,
        retryable: bool,
        retry_after_seconds: int | None = None,
        ambiguous_submission: bool = False,
    ) -> AutoLiveExecutorError:
        return AutoLiveExecutorError(
            code=code,
            message=sanitized,
            retryable=retryable,
            retry_after_seconds=retry_after_seconds,
            ambiguous_submission=ambiguous_submission,
            provider_alias=provider_alias,
        )

    if is_rpc_rate_limited(sanitized):
        retry_after = extract_retry_after_seconds(message)
        return _error(
            "RPC_RATE_LIMITED",
            retryable=True,
            retry_after_seconds=(math.ceil(retry_after) if retry_after is not None else None),
        )
    if "504" in lowered or "gateway timeout" in lowered:
        return _error(
            "AMBIGUOUS_SUBMISSION" if during_write else "HTTP_504",
            retryable=True,
            ambiguous_submission=during_write,
        )
    if "503" in lowered or "service unavailable" in lowered:
        return _error("HTTP_503", retryable=True)
    if "502" in lowered or "bad gateway" in lowered:
        return _error("HTTP_502", retryable=True)
    if _message_has_any(lowered, ("connection reset", "socket hang up")):
        return _error(
            "AMBIGUOUS_SUBMISSION" if during_write else "CONNECTION_RESET",
            retryable=True,
            ambiguous_submission=during_write,
        )
    if _message_has_any(lowered, ("timed out", "timeout")):
        return _error(
            "AMBIGUOUS_SUBMISSION" if during_write else "NETWORK_TIMEOUT",
            retryable=True,
            ambiguous_submission=during_write,
        )
    if _message_has_any(
        lowered,
        (
            "refresh token rejected",
            "invalid refresh token",
            "jwt expired",
            "session expired",
        ),
    ):
        return _error("AUTH_EXPIRED", retryable=True)
    if _message_has_any(lowered, ("not logged in", "login required", "requires_login")):
        return _error("SESSION_INVALID", retryable=True)
    if "insufficient collateral" in lowered:
        return _error("INSUFFICIENT_COLLATERAL", retryable=True)
    if _message_has_any(lowered, ("quote unavailable", "quote missing")):
        return _error("QUOTE_UNAVAILABLE", retryable=True)
    if _message_has_any(lowered, ("quote stale", "stale quote")):
        return _error("QUOTE_STALE", retryable=True)
    if _message_has_any(lowered, ("market closed", "trading disabled")):
        return _error("MARKET_CLOSED", retryable=False)
    if "resolved" in lowered and "market" in lowered:
        return _error("MARKET_RESOLVED", retryable=False)
    if "unsupported side" in lowered:
        return _error("UNSUPPORTED_SIDE", retryable=False)
    if "tick size" in lowered:
        return _error("INVALID_TICK_SIZE", retryable=False)
    if "precision" in lowered and "price" in lowered:
        return _error("INVALID_PRICE_PRECISION", retryable=False)
    if "precision" in lowered and "share" in lowered:
        return _error("INVALID_SHARE_PRECISION", retryable=False)
    if "minimum order" in lowered or "below minimum" in lowered:
        return _error("BELOW_MINIMUM_ORDER", retryable=False)
    if _message_has_any(lowered, ("no shares", "insufficient shares")):
        return _error("NO_SHARES_AVAILABLE", retryable=False)
    if "condition id" in lowered:
        return _error("CONDITION_ID_UNAVAILABLE", retryable=False)
    if "emergency stop" in lowered:
        return _error("EMERGENCY_STOP", retryable=False)
    if _message_has_any(lowered, ("doctor failed", "preflight failed")):
        return _error("DOCTOR_READ_FAILED", retryable=True)
    if _message_has_any(lowered, ("balance unavailable", "cash in hand unavailable")):
        return _error("BALANCE_UNAVAILABLE", retryable=True)
    if _message_has_any(lowered, ("locked", "unlock is required")):
        return _error("LIVE_LOCKED", retryable=True)
    return _error("PERMANENT_REJECTION", retryable=False)


def max_attempts_for_error(code: str) -> int:
    configured = read_int_env(f"AUTO_LIVE_{code}_MAX_ATTEMPTS", -1)
    if configured >= 0:
        return configured
    if code == "RPC_RATE_LIMITED":
        return 6
    if code in {"HTTP_502", "HTTP_503", "HTTP_504", "NETWORK_TIMEOUT", "CONNECTION_RESET"}:
        return 4
    if code in {"AUTH_EXPIRED", "SESSION_INVALID"}:
        return 2
    if code in {"QUOTE_STALE", "QUOTE_UNAVAILABLE"}:
        return 3
    if code in {"INSUFFICIENT_COLLATERAL", "SETTLEMENT_PENDING", "BALANCE_UNAVAILABLE"}:
        return 5
    if code == "AMBIGUOUS_SUBMISSION":
        return 2
    return 1


def _stable_jitter_fraction(seed: str) -> float:
    digest = hashlib.sha256(seed.encode("utf-8")).hexdigest()
    return int(digest[:8], 16) / 0xFFFFFFFF


def compute_retry_delay_seconds(
    *,
    code: str,
    attempt_count: int,
    retry_after_seconds: int | None = None,
) -> int:
    if retry_after_seconds is not None and retry_after_seconds > 0:
        return retry_after_seconds

    base_delay = max(1, read_int_env("AUTO_LIVE_RETRY_BASE_DELAY_SECONDS", 5))
    max_delay = max(base_delay, read_int_env("AUTO_LIVE_RETRY_MAX_DELAY_SECONDS", 300))
    exponent = max(0, attempt_count - 1)
    raw_delay = min(max_delay, base_delay * (2**exponent))
    jitter_seed = f"{code}:{attempt_count}"
    jitter = _stable_jitter_fraction(jitter_seed)
    return max(1, math.floor(raw_delay * max(0.25, jitter)))


def compute_next_retry_at(
    *,
    code: str,
    attempt_count: int,
    retry_after_seconds: int | None = None,
    now: datetime | None = None,
) -> datetime:
    return (now or utc_now()) + timedelta(
        seconds=compute_retry_delay_seconds(
            code=code,
            attempt_count=attempt_count,
            retry_after_seconds=retry_after_seconds,
        )
    )


def intent_status_to_order_plan_status(status: str) -> str:
    return {
        "PLANNED": "planned",
        "READY": "ready",
        "RETRY_WAIT": "retry_wait",
        "SUBMITTING": "submitting",
        "SUBMITTED": "submitted",
        "CONFIRMING": "confirming",
        "PARTIALLY_FILLED": "partially_filled",
        "SETTLEMENT_PENDING": "settlement_pending",
        "WAITING_FOR_COLLATERAL": "waiting_for_collateral",
        "WAITING_FOR_EXIT": "waiting_for_exit",
        "CONFIRMED": "confirmed",
        "FILLED": "filled",
        "DEFERRED": "deferred",
        "CANCELLED": "cancelled",
        "FAILED_PERMANENT": "failed_permanent",
        "REJECTED": "rejected",
        "TIMED_OUT": "timed_out",
    }.get(status, "failed")


def build_order_plan_from_intent(
    existing: BullpenAutoLiveOrderPlan,
    intent: BullpenAutoLiveOrderIntent,
) -> BullpenAutoLiveOrderPlan:
    return existing.model_copy(
        update={
            "status": intent_status_to_order_plan_status(intent.status),
            "dependency_group": intent.dependency_group,
            "order_size_usd": intent.current_order_usd
            if intent.current_order_usd is not None
            else existing.order_size_usd,
            "shares": intent.current_shares
            if intent.current_shares is not None
            else existing.shares,
            "limit_price_cents": intent.current_limit_price_cents
            if intent.current_limit_price_cents is not None
            else existing.limit_price_cents,
            "detail": intent.last_error_message
            or existing.detail,
            "retryable": intent.retryable,
            "attempt_count": intent.attempt_count,
            "next_retry_at": intent.next_attempt_at,
            "remote_order_id": intent.remote_order_id,
            "remote_transaction_hash": intent.remote_transaction_hash,
            "provider_alias": str(intent.execution_metadata_json.get("provider_alias"))
            if intent.execution_metadata_json.get("provider_alias")
            else existing.provider_alias,
            "latest_error_code": intent.last_error_code,
            "dependency_state": str(intent.dependency_metadata_json.get("state"))
            if intent.dependency_metadata_json.get("state") is not None
            else existing.dependency_state,
            "reservation_state": str(intent.execution_metadata_json.get("reservation_state"))
            if intent.execution_metadata_json.get("reservation_state") is not None
            else existing.reservation_state,
            "reservation_amount_usd": intent.reserved_cash_usd,
            "stage3_status": str(intent.execution_metadata_json.get("stage3_status"))
            if intent.execution_metadata_json.get("stage3_status")
            else existing.stage3_status,
            "filled_shares": intent.filled_shares,
            "remaining_shares": intent.remaining_shares,
            "average_fill_price_cents": intent.average_fill_price_cents,
            "executed_at": intent.last_submitted_at or existing.executed_at,
            "confirmed_at": intent.confirmed_at,
            "terminal_at": intent.terminal_at,
        }
    )


def build_order_funnel(intents: Iterable[BullpenAutoLiveOrderIntent]) -> BullpenAutoLiveOrderFunnel:
    counts = BullpenAutoLiveOrderFunnel()
    items = list(intents)
    for intent in items:
        counts.planned += 1
        status = intent.status
        if status == "READY":
            counts.ready += 1
        elif status == "RETRY_WAIT":
            counts.retry_wait += 1
        elif status == "WAITING_FOR_COLLATERAL":
            counts.waiting_for_collateral += 1
        elif status == "SETTLEMENT_PENDING":
            counts.settlement_pending += 1
        elif status == "PARTIALLY_FILLED":
            counts.partially_filled += 1
        elif status == "DEFERRED":
            counts.deferred += 1
        elif status == "CANCELLED":
            counts.cancelled += 1
        elif status == "FAILED_PERMANENT":
            counts.permanently_failed += 1

        if intent.attempt_count > 0:
            counts.attempted += 1
        if intent.first_submitted_at:
            counts.remotely_accepted += 1
        if status in {"SUBMITTED", "CONFIRMING"}:
            counts.submitted += 1
        if status in INTENT_PENDING_CONFIRMATION_STATUSES:
            counts.confirming += 1
        if status == "CONFIRMED":
            counts.confirmed += 1
        if status == "FILLED":
            counts.filled += 1

    planned = max(1, counts.planned)
    attempted = max(1, counts.attempted)
    accepted = max(1, counts.remotely_accepted)
    confirmed_or_filled = counts.confirmed + counts.filled
    counts.attempt_rate = round(counts.attempted / planned, 4)
    counts.acceptance_rate = round(counts.remotely_accepted / attempted, 4)
    counts.confirmation_rate = round(confirmed_or_filled / accepted, 4)
    counts.fill_rate = round(counts.filled / accepted, 4)
    counts.terminal_success_rate = round(confirmed_or_filled / planned, 4)
    return counts


def derive_run_status_from_intents(intents: Sequence[BullpenAutoLiveOrderIntent]) -> str:
    if not intents:
        return "completed"
    success_count = sum(1 for intent in intents if intent.status in INTENT_TERMINAL_SUCCESS_STATUSES)
    pending_count = sum(1 for intent in intents if intent.status in INTENT_PENDING_CONFIRMATION_STATUSES)
    hard_failure_count = sum(1 for intent in intents if intent.status == "FAILED_PERMANENT")
    soft_failure_count = sum(1 for intent in intents if intent.status in {"DEFERRED", "CANCELLED"})

    if pending_count > 0:
        return "confirming"
    if success_count == len(intents):
        return "completed"
    if success_count > 0 and (hard_failure_count > 0 or soft_failure_count > 0):
        return "partial_success"
    if success_count > 0:
        return "completed"
    if hard_failure_count > 0 or soft_failure_count > 0:
        return "failed"
    return "running"


def oldest_pending_age_seconds(intents: Sequence[BullpenAutoLiveOrderIntent], *, now: datetime | None = None) -> float | None:
    pending_created = [
        parse_datetime(intent.created_at)
        for intent in intents
        if intent.status in INTENT_PENDING_CONFIRMATION_STATUSES
    ]
    pending_created = [value for value in pending_created if value is not None]
    if not pending_created:
        return None
    oldest = min(pending_created)
    return max(0.0, ((now or utc_now()) - oldest).total_seconds())


def average_confirmation_seconds(intents: Sequence[BullpenAutoLiveOrderIntent]) -> float | None:
    durations: list[float] = []
    for intent in intents:
        submitted_at = parse_datetime(intent.first_submitted_at)
        confirmed_at = parse_datetime(intent.confirmed_at or intent.terminal_at)
        if submitted_at is None or confirmed_at is None:
            continue
        durations.append(max(0.0, (confirmed_at - submitted_at).total_seconds()))
    if not durations:
        return None
    return round(sum(durations) / len(durations), 3)
