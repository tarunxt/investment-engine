from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime

from app.core.logging import get_logger
from app.domains.polymarket.bullpen import BullpenCommandError, BullpenLiveExecutor
from app.domains.polymarket_auto_live.order_intents import (
    AutoLiveExecutorError,
    classify_executor_error,
    sanitize_json_payload,
    sanitize_message,
)

IMMEDIATE_SELL_STRATEGY_VERSION = "v1"
IMMEDIATE_SELL_MIN_PRICE = 0.01
IMMEDIATE_SELL_LAYER_PATHS = (
    ("primary", "market_sell_explicit"),
    ("secondary", "market_sell_max"),
    ("tertiary", "limit_sell_fak"),
)

_ACCEPTED_STATUSES = frozenset(
    {
        "matched",
        "filled",
        "complete",
        "completed",
        "executed",
        "submitted",
        "open",
        "live",
        "delayed",
        "pending",
        "confirming",
        "partially_filled",
        "partial",
    }
)
_NON_ACCEPTING_STATUSES = frozenset(
    {
        "unmatched",
        "no_match",
        "rejected",
        "failed",
        "error",
        "invalid",
        "unsupported",
        "cancelled",
        "canceled",
    }
)
_SAFE_ZERO_FILL_STATUSES = frozenset({"unmatched", "no_match"})
_SAFE_ARGUMENT_STATUSES = frozenset({"invalid", "unsupported"})
_REMOTE_REFERENCE_KEYS = frozenset(
    {
        "orderid",
        "order_id",
        "remoteorderid",
        "remote_order_id",
        "transactionhash",
        "transaction_hash",
        "txhash",
        "tx_hash",
        "remote_transaction_hash",
        "transaction_hashes",
        "trade_ids",
    }
)
_FILL_AMOUNT_KEYS = frozenset(
    {
        "filledamount",
        "filled_amount",
        "filledsize",
        "filled_size",
        "filledshares",
        "filled_shares",
        "matchedamount",
        "matched_amount",
        "matchedsize",
        "matched_size",
        "makingamount",
        "making_amount",
        "soldshares",
        "sold_shares",
        "takingamount",
        "taking_amount",
    }
)
_ERROR_CODE_KEYS = frozenset(
    {"code", "errorcode", "error_code", "reasoncode", "reason_code"}
)
_SAFE_ARGUMENT_ERROR_CODES = frozenset(
    {
        "invalid_argument",
        "invalid_command",
        "invalid_price_precision",
        "invalid_share_precision",
        "invalid_tick_size",
        "unsupported_argument",
        "unsupported_command",
    }
)
_SAFE_CLI_PARSE_FAILURE_MARKERS = (
    "unrecognized subcommand",
    "unknown command",
    "no such command",
    "invalid subcommand",
    "unexpected argument",
    "missing required argument",
    "required arguments were not provided",
)
_SAFE_ARGUMENT_FAILURE_MARKERS = (
    "invalid value for",
    "invalid share precision",
    "shares must",
    "share precision",
    "tick size",
    "price precision",
)

logger = get_logger("app.domains.polymarket_auto_live.immediate_sell")


@dataclass(frozen=True)
class ImmediateSellResponseValidation:
    accepted: bool
    safe_to_fallback: bool
    validation: str
    reason: str


@dataclass(frozen=True)
class ImmediateSellSubmission:
    raw_response: str
    payload: dict[str, object]
    selected_layer: str
    execution_path: str
    fallback_history: list[dict[str, object]]


def _utc_now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _normalize_status(value: object) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    return value.strip().lower().replace("-", "_").replace(" ", "_")


def _walk_payload(value: object):
    if isinstance(value, dict):
        yield value
        for nested in value.values():
            yield from _walk_payload(nested)
    elif isinstance(value, list):
        for nested in value:
            yield from _walk_payload(nested)


def _payload_facts(
    payload: dict[str, object],
) -> tuple[set[str], set[bool], bool, list[str], list[float], set[str]]:
    statuses: set[str] = set()
    successes: set[bool] = set()
    has_remote_reference = False
    messages: list[str] = []
    fill_amounts: list[float] = []
    error_codes: set[str] = set()
    for row in _walk_payload(payload):
        for key, value in row.items():
            normalized_key = str(key).lower()
            if normalized_key == "status":
                status = _normalize_status(value)
                if status:
                    statuses.add(status)
            elif normalized_key == "success" and isinstance(value, bool):
                successes.add(value)
            elif normalized_key in _REMOTE_REFERENCE_KEYS:
                if isinstance(value, list):
                    has_remote_reference = has_remote_reference or any(
                        isinstance(item, (str, int)) and str(item).strip()
                        for item in value
                    )
                elif isinstance(value, (str, int)) and str(value).strip():
                    has_remote_reference = True
            elif normalized_key in {"error", "message", "detail", "reason"}:
                if isinstance(value, str) and value.strip():
                    messages.append(value.strip())
            elif normalized_key in _FILL_AMOUNT_KEYS:
                try:
                    numeric = float(value)
                except (TypeError, ValueError):
                    continue
                if numeric >= 0:
                    fill_amounts.append(numeric)
            elif normalized_key in _ERROR_CODE_KEYS:
                normalized_code = _normalize_status(value)
                if normalized_code:
                    error_codes.add(normalized_code)
    return (
        statuses,
        successes,
        has_remote_reference,
        messages,
        fill_amounts,
        error_codes,
    )


def _message_proves_cli_parse_failure(message: str | None) -> bool:
    normalized = (sanitize_message(message) or "").lower()
    return any(marker in normalized for marker in _SAFE_CLI_PARSE_FAILURE_MARKERS)


def _message_proves_argument_failure(message: str | None) -> bool:
    normalized = (sanitize_message(message) or "").lower()
    return any(marker in normalized for marker in _SAFE_ARGUMENT_FAILURE_MARKERS)


def _parse_response(raw_response: str) -> tuple[dict[str, object], bool]:
    try:
        parsed = json.loads(raw_response)
    except (json.JSONDecodeError, TypeError):
        return {"message": sanitize_message(raw_response) or ""}, False
    if not isinstance(parsed, dict):
        return {"data": parsed}, False
    return sanitize_json_payload(parsed), True


def validate_immediate_sell_response(
    payload: dict[str, object],
    *,
    parsed_json_object: bool = True,
) -> ImmediateSellResponseValidation:
    """Validate one CLI response before accepting it or advancing a fallback."""

    (
        statuses,
        successes,
        has_remote_reference,
        messages,
        fill_amounts,
        error_codes,
    ) = _payload_facts(payload)
    joined_message = "; ".join(messages)
    has_positive_fill = any(amount > 0 for amount in fill_amounts)
    has_explicit_zero_fill = bool(fill_amounts) and not has_positive_fill

    if has_remote_reference:
        return ImmediateSellResponseValidation(
            accepted=True,
            safe_to_fallback=False,
            validation="remote_reference_present",
            reason="Bullpen returned a remote order, transaction, or trade reference.",
        )
    if has_positive_fill:
        return ImmediateSellResponseValidation(
            accepted=True,
            safe_to_fallback=False,
            validation="positive_fill_present",
            reason="Bullpen reported a positive sell fill; reconciliation is required.",
        )
    accepted_statuses = sorted(statuses & _ACCEPTED_STATUSES)
    if accepted_statuses:
        return ImmediateSellResponseValidation(
            accepted=True,
            safe_to_fallback=False,
            validation=f"accepted_status:{accepted_statuses[0]}",
            reason=f"Bullpen returned accepted sell status {accepted_statuses[0]}.",
        )
    if True in successes and not (statuses & _NON_ACCEPTING_STATUSES):
        return ImmediateSellResponseValidation(
            accepted=True,
            safe_to_fallback=False,
            validation="explicit_success",
            reason="Bullpen explicitly marked the sell submission successful.",
        )

    zero_fill_statuses = sorted(statuses & _SAFE_ZERO_FILL_STATUSES)
    if zero_fill_statuses and has_explicit_zero_fill:
        return ImmediateSellResponseValidation(
            accepted=False,
            safe_to_fallback=True,
            validation=f"verified_zero_fill:{zero_fill_statuses[0]}",
            reason=(
                joined_message
                or f"Bullpen returned verified zero-fill status {zero_fill_statuses[0]}."
            ),
        )
    argument_statuses = sorted(statuses & _SAFE_ARGUMENT_STATUSES)
    has_safe_argument_error = bool(
        error_codes & _SAFE_ARGUMENT_ERROR_CODES
    ) or _message_proves_argument_failure(joined_message)
    if "unsupported" in argument_statuses:
        has_safe_argument_error = True
    if (
        parsed_json_object
        and has_explicit_zero_fill
        and has_safe_argument_error
        and (argument_statuses or False in successes)
    ):
        return ImmediateSellResponseValidation(
            accepted=False,
            safe_to_fallback=True,
            validation="verified_zero_write_argument_failure",
            reason=joined_message or "Bullpen rejected a validated command argument.",
        )

    return ImmediateSellResponseValidation(
        accepted=False,
        safe_to_fallback=False,
        validation=(
            "invalid_json_response"
            if not parsed_json_object
            else "invalid_or_ambiguous_response"
        ),
        reason=(
            joined_message
            or "Bullpen returned no accepted status or remote reference, so remote write state is ambiguous."
        ),
    )


def _exception_proves_safe_prewrite_failure(exc: Exception) -> bool:
    """Return true only for CLI parsing or structured zero-write failures."""

    if not isinstance(exc, BullpenCommandError):
        return False
    message = str(exc)
    if _message_proves_cli_parse_failure(message):
        return True
    payload, parsed_json_object = _parse_response(message)
    if not parsed_json_object:
        return False
    return validate_immediate_sell_response(
        payload,
        parsed_json_object=True,
    ).safe_to_fallback


def _ambiguous_error(
    *,
    message: str,
    provider_alias: str,
    history: list[dict[str, object]],
) -> AutoLiveExecutorError:
    return AutoLiveExecutorError(
        code="AMBIGUOUS_SUBMISSION",
        message=message,
        retryable=True,
        ambiguous_submission=True,
        provider_alias=provider_alias,
        fallback_history=tuple(history),
    )


async def submit_immediate_sell_with_fallbacks(
    *,
    executor: BullpenLiveExecutor,
    market_id: str,
    outcome: str,
    shares: float,
    extra_env: dict[str, str],
    provider_alias: str,
) -> ImmediateSellSubmission:
    """Run a bounded three-layer immediate sell under one durable intent lease.

    A later layer is allowed only after the prior layer proves that no remote
    order was accepted. Any transport ambiguity or unvalidated success response
    stops immediately so the durable intent enters reconciliation.
    """

    layers: tuple[
        tuple[str, str, Callable[[], Awaitable[str]]],
        ...,
    ] = (
        (
            "primary",
            "market_sell_explicit",
            lambda: executor.sell_limit(
                market_id=market_id,
                outcome=outcome,
                shares=shares,
                min_price=IMMEDIATE_SELL_MIN_PRICE,
                max_reprice_attempts=0,
                extra_env=extra_env,
            ),
        ),
        (
            "secondary",
            "market_sell_max",
            lambda: executor.sell_max_market(
                market_id=market_id,
                outcome=outcome,
                min_price=IMMEDIATE_SELL_MIN_PRICE,
                extra_env=extra_env,
            ),
        ),
        (
            "tertiary",
            "limit_sell_fak",
            lambda: executor.sell_fak_limit(
                market_id=market_id,
                outcome=outcome,
                shares=shares,
                price=IMMEDIATE_SELL_MIN_PRICE,
                extra_env=extra_env,
            ),
        ),
    )
    history: list[dict[str, object]] = []

    for sequence, (layer, path, submit) in enumerate(layers, start=1):
        started_at = _utc_now_iso()
        try:
            raw_response = await submit()
        except Exception as exc:
            classified = (
                exc
                if isinstance(exc, AutoLiveExecutorError)
                else classify_executor_error(
                    exc,
                    during_write=True,
                    provider_alias=provider_alias,
                )
            )
            safe_to_fallback = _exception_proves_safe_prewrite_failure(exc)
            result = "fallback" if safe_to_fallback else "ambiguous"
            reason = sanitize_message(classified.message) or classified.code
            history.append(
                {
                    "sequence": sequence,
                    "layer": layer,
                    "path": path,
                    "result": result,
                    "reason": reason,
                    "validation": f"exception:{classified.code}",
                    "safe_to_fallback": safe_to_fallback,
                    "provider_alias": provider_alias,
                    "started_at": started_at,
                    "completed_at": _utc_now_iso(),
                }
            )
            if safe_to_fallback and sequence < len(layers):
                logger.warning(
                    "Stage 3 immediate sell fallback triggered market=%s provider=%s "
                    "from_layer=%s next_layer=%s reason=%s",
                    market_id,
                    provider_alias,
                    layer,
                    layers[sequence][0],
                    reason,
                )
                continue
            if result == "ambiguous":
                raise _ambiguous_error(
                    message=(
                        f"Immediate sell {path} returned an ambiguous write result; "
                        "no fallback write was attempted. Reconcile Bullpen orders, "
                        f"trades, and wallet position before retrying. {reason}"
                    ),
                    provider_alias=provider_alias,
                    history=history,
                ) from exc
            raise AutoLiveExecutorError(
                code="SELL_FALLBACK_EXHAUSTED",
                message=(
                    "All bounded immediate-sell paths failed before remote acceptance. "
                    f"Latest: {reason}"
                ),
                retryable=False,
                provider_alias=provider_alias,
                fallback_history=tuple(history),
            ) from exc

        payload, parsed_json_object = _parse_response(raw_response)
        validation = validate_immediate_sell_response(
            payload,
            parsed_json_object=parsed_json_object,
        )
        result = (
            "accepted"
            if validation.accepted
            else "fallback"
            if validation.safe_to_fallback
            else "ambiguous"
        )
        history.append(
            {
                "sequence": sequence,
                "layer": layer,
                "path": path,
                "result": result,
                "reason": sanitize_message(validation.reason) or validation.validation,
                "validation": validation.validation,
                "safe_to_fallback": validation.safe_to_fallback,
                "provider_alias": provider_alias,
                "started_at": started_at,
                "completed_at": _utc_now_iso(),
            }
        )
        if validation.accepted:
            logger.info(
                "Stage 3 immediate sell accepted market=%s provider=%s layer=%s path=%s",
                market_id,
                provider_alias,
                layer,
                path,
            )
            return ImmediateSellSubmission(
                raw_response=raw_response,
                payload=payload,
                selected_layer=layer,
                execution_path=path,
                fallback_history=history,
            )
        if validation.safe_to_fallback and sequence < len(layers):
            logger.warning(
                "Stage 3 immediate sell fallback triggered market=%s provider=%s "
                "from_layer=%s next_layer=%s reason=%s",
                market_id,
                provider_alias,
                layer,
                layers[sequence][0],
                validation.reason,
            )
            continue
        if not validation.safe_to_fallback:
            raise _ambiguous_error(
                message=(
                    f"Immediate sell {path} returned an invalid or ambiguous response; "
                    "no fallback write was attempted. Reconcile Bullpen orders, trades, "
                    f"and wallet position before retrying. {validation.reason}"
                ),
                provider_alias=provider_alias,
                history=history,
            )
        raise AutoLiveExecutorError(
            code="SELL_FALLBACK_EXHAUSTED",
            message=(
                "All bounded immediate-sell paths returned a verified failure or no-fill "
                f"result. Latest: {validation.reason}"
            ),
            retryable=False,
            provider_alias=provider_alias,
            fallback_history=tuple(history),
        )

    raise AutoLiveExecutorError(
        code="SELL_FALLBACK_EXHAUSTED",
        message="No immediate-sell execution path was available.",
        retryable=False,
        provider_alias=provider_alias,
        fallback_history=tuple(history),
    )
