from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, time
from typing import Any, Literal
from zoneinfo import ZoneInfo

BullpenPositionClassificationState = Literal[
    "active",
    "positive_payout_claimable",
    "settlement_pending",
    "resolved_zero_payout",
    "stale_or_unknown",
    "closed",
]

_VALUE_EPSILON = 0.000001
_EASTERN_TIMEZONE = ZoneInfo("America/New_York")
_CLAIMABLE_FLAG_KEYS = (
    "redeemable",
    "isRedeemable",
    "claimable",
    "isClaimable",
)


@dataclass(frozen=True)
class BullpenPositionClassification:
    state: BullpenPositionClassificationState
    reason: str
    is_claimable: bool
    claimable_value_usd: float | None
    expected_payout_usdc: float | None
    resolution_status: str | None


def _read_string(value: object) -> str | None:
    if isinstance(value, str):
        normalized = value.strip()
        return normalized or None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value)
    return None


def _read_number(value: object) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    if isinstance(value, str):
        cleaned = value.replace("%", "").replace("$", "").replace(",", "").strip()
        if not cleaned:
            return None
        try:
            return float(cleaned)
        except ValueError:
            return None
    return None


def _read_boolean(value: object) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return bool(value)
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "1", "yes", "claimable", "redeemable"}:
            return True
        if normalized in {"false", "0", "no", "open"}:
            return False
    return None


def _is_positive_value(value: float | None) -> bool:
    return value is not None and value > _VALUE_EPSILON


def _is_explicit_zero_value(value: float | None) -> bool:
    return value is not None and abs(value) <= _VALUE_EPSILON


def _parse_close_time(close_time: str | None) -> datetime | None:
    if not close_time:
        return None
    raw = close_time.strip()
    if not raw:
        return None
    if len(raw) == 10:
        try:
            date_only = datetime.strptime(raw, "%Y-%m-%d").date()
        except ValueError:
            return None
        return datetime.combine(
            date_only,
            time(hour=23, minute=59, second=59, tzinfo=_EASTERN_TIMEZONE),
        ).astimezone(UTC)
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def extract_bullpen_claimable_flag(row: dict[str, Any]) -> bool:
    for key in _CLAIMABLE_FLAG_KEYS:
        parsed = _read_boolean(row.get(key))
        if parsed is not None:
            return parsed
    claim_text = " ".join(
        value.strip()
        for key in ("action", "status")
        if isinstance((value := row.get(key)), str) and value.strip()
    ).lower()
    return any(
        token in claim_text
        for token in ("claim", "redeem", "claimable", "redeemable")
    )


def extract_bullpen_expected_payout_usdc(row: dict[str, Any]) -> float | None:
    for key in ("expected_payout_usdc", "expectedPayoutUSDC", "expectedPayoutUsd"):
        parsed = _read_number(row.get(key))
        if parsed is not None:
            return parsed
    return None


def extract_bullpen_claimable_value_usd(row: dict[str, Any]) -> float | None:
    for key in (
        "claimableValue",
        "claimable_value",
        "redeemableValue",
        "redeemable_value",
    ):
        parsed = _read_number(row.get(key))
        if parsed is not None:
            return parsed
    return None


def extract_bullpen_resolution_status(row: dict[str, Any]) -> str | None:
    for key in ("resolution_status", "resolutionStatus", "status"):
        parsed = _read_string(row.get(key))
        if parsed:
            return parsed
    return None


def classify_bullpen_position(
    row: dict[str, Any],
    *,
    shares: float | None = None,
    current_price: float | None = None,
    current_value: float | None = None,
    close_time: str | None = None,
    now: datetime | None = None,
) -> BullpenPositionClassification:
    current_time = (now or datetime.now(UTC)).astimezone(UTC)
    parsed_shares = shares if shares is not None else (_read_number(row.get("shares")) or 0.0)
    parsed_current_price = (
        current_price
        if current_price is not None
        else _read_number(row.get("current_price") or row.get("currentPrice"))
    )
    parsed_current_value = current_value
    if parsed_current_value is None:
        parsed_current_value = _read_number(
            row.get("current_value") or row.get("currentValue")
        )
        if parsed_current_value is None and parsed_current_price is not None:
            normalized_price = (
                parsed_current_price / 100
                if 0 <= parsed_current_price <= 100
                else parsed_current_price
            )
            parsed_current_value = parsed_shares * normalized_price
    parsed_close_time = _parse_close_time(
        close_time
        or _read_string(row.get("end_date"))
        or _read_string(row.get("endDate"))
    )
    claimable_flag = extract_bullpen_claimable_flag(row)
    expected_payout_usdc = extract_bullpen_expected_payout_usdc(row)
    claimable_value_usd = extract_bullpen_claimable_value_usd(row)
    resolution_status = extract_bullpen_resolution_status(row)
    normalized_resolution_status = (
        resolution_status.strip().lower() if resolution_status else None
    )
    past_close_time = (
        parsed_close_time <= current_time if parsed_close_time is not None else None
    )
    resolved_by_status = bool(
        normalized_resolution_status
        and any(
            token in normalized_resolution_status
            for token in (
                "won",
                "resolved",
                "closed",
                "expired",
                "settled",
                "redeemed",
                "claimable",
                "redeemable",
                "final",
            )
        )
    )
    open_by_status = bool(
        normalized_resolution_status
        and any(
            token in normalized_resolution_status
            for token in ("open", "active", "live", "trading", "unresolved", "pending")
        )
    )
    positive_payout_verified = _is_positive_value(expected_payout_usdc) or (
        claimable_flag
        and (
            _is_positive_value(claimable_value_usd)
            or _is_positive_value(parsed_current_value)
        )
    )

    if parsed_shares <= _VALUE_EPSILON and not claimable_flag:
        return BullpenPositionClassification(
            state="closed",
            reason="No positive Bullpen shares remain for this row.",
            is_claimable=False,
            claimable_value_usd=None,
            expected_payout_usdc=expected_payout_usdc,
            resolution_status=resolution_status,
        )

    if positive_payout_verified:
        return BullpenPositionClassification(
            state="positive_payout_claimable",
            reason="Bullpen reported fresh positive payout evidence for this resolved position.",
            is_claimable=True,
            claimable_value_usd=(
                claimable_value_usd
                if claimable_value_usd is not None
                else expected_payout_usdc
                if expected_payout_usdc is not None
                else parsed_current_value
            ),
            expected_payout_usdc=expected_payout_usdc,
            resolution_status=resolution_status,
        )

    if (
        claimable_flag
        and (past_close_time is not False or resolved_by_status)
        and _is_explicit_zero_value(parsed_current_value)
        and _is_explicit_zero_value(expected_payout_usdc)
    ):
        return BullpenPositionClassification(
            state="resolved_zero_payout",
            reason=(
                "Bullpen marked the row redeemable after close, but both current value "
                "and expected payout are explicitly zero."
            ),
            is_claimable=False,
            claimable_value_usd=None,
            expected_payout_usdc=expected_payout_usdc,
            resolution_status=resolution_status,
        )

    if claimable_flag and (past_close_time is not False or resolved_by_status):
        return BullpenPositionClassification(
            state="settlement_pending",
            reason=(
                "Bullpen marked the row claimable, but no fresh positive payout value "
                "has been proven yet."
            ),
            is_claimable=False,
            claimable_value_usd=None,
            expected_payout_usdc=expected_payout_usdc,
            resolution_status=resolution_status,
        )

    if parsed_current_price is None and parsed_current_value is None and not resolved_by_status:
        return BullpenPositionClassification(
            state="stale_or_unknown",
            reason=(
                "The market still looks open or unresolved, but Bullpen did not provide "
                "enough fresh pricing to value it safely."
            ),
            is_claimable=False,
            claimable_value_usd=None,
            expected_payout_usdc=expected_payout_usdc,
            resolution_status=resolution_status,
        )

    if past_close_time and not open_by_status and not resolved_by_status:
        return BullpenPositionClassification(
            state="stale_or_unknown",
            reason=(
                "The event close time has passed, but Bullpen did not provide enough "
                "settlement evidence to classify it safely."
            ),
            is_claimable=False,
            claimable_value_usd=None,
            expected_payout_usdc=expected_payout_usdc,
            resolution_status=resolution_status,
        )

    return BullpenPositionClassification(
        state="active",
        reason="This row still looks like an economically active Bullpen position.",
        is_claimable=False,
        claimable_value_usd=None,
        expected_payout_usdc=expected_payout_usdc,
        resolution_status=resolution_status,
    )


def is_displayable_bullpen_position(
    classification: BullpenPositionClassification | BullpenPositionClassificationState,
) -> bool:
    state = classification.state if isinstance(classification, BullpenPositionClassification) else classification
    return state in {
        "active",
        "positive_payout_claimable",
        "settlement_pending",
        "stale_or_unknown",
    }

