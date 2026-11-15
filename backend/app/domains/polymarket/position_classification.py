from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import UTC, datetime, time
from typing import Any, Generic, Literal, TypeVar
from zoneinfo import ZoneInfo

BullpenPositionClassificationState = Literal[
    "active",
    "positive_payout_claimable",
    "settlement_pending",
    "resolved_zero_payout",
    "stale_or_unknown",
    "closed",
]

BULLPEN_POSITION_CLASSIFIER_VERSION = 4

_VALUE_EPSILON = 0.000001
_EASTERN_TIMEZONE = ZoneInfo("America/New_York")
_CLAIMABLE_FLAG_KEYS = (
    "redeemable",
    "isRedeemable",
    "claimable",
    "isClaimable",
)
_UPSTREAM_REDEEMABLE_FLAG_KEYS = (
    "upstream_redeemable",
    "upstreamRedeemable",
)
_CLOSED_STATUS_TOKENS = (
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
_OPEN_STATUS_TOKENS = (
    "open",
    "active",
    "live",
    "trading",
    "unresolved",
    "pending",
)

T = TypeVar("T")


@dataclass(frozen=True)
class BullpenPositionClassification:
    state: BullpenPositionClassificationState
    reason: str
    is_claimable: bool
    claimable_value_usd: float | None
    expected_payout_usdc: float | None
    resolution_status: str | None


@dataclass(frozen=True)
class BullpenPositionPartitions(Generic[T]):
    active_positions: list[T]
    positive_claimable_positions: list[T]
    settlement_pending_positions: list[T]
    stale_or_unknown_positions: list[T]
    resolved_zero_payout_positions: list[T]
    closed_positions: list[T]


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


def extract_bullpen_upstream_redeemable_flag(row: dict[str, Any]) -> bool:
    for key in _UPSTREAM_REDEEMABLE_FLAG_KEYS:
        parsed = _read_boolean(row.get(key))
        if parsed is not None:
            return parsed
    return False


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


def _normalized_resolution_status_tokens(
    resolution_status: str | None,
) -> tuple[str | None, bool, bool]:
    normalized_resolution_status = (
        resolution_status.strip().lower() if resolution_status else None
    )
    resolved_by_status = bool(
        normalized_resolution_status
        and any(token in normalized_resolution_status for token in _CLOSED_STATUS_TOKENS)
    )
    open_by_status = bool(
        normalized_resolution_status
        and any(token in normalized_resolution_status for token in _OPEN_STATUS_TOKENS)
    )
    return normalized_resolution_status, resolved_by_status, open_by_status


def _position_state(
    classification: BullpenPositionClassification | BullpenPositionClassificationState,
) -> BullpenPositionClassificationState:
    if isinstance(classification, BullpenPositionClassification):
        return classification.state
    return classification


def classify_bullpen_position(
    row: dict[str, Any],
    *,
    shares: float | None = None,
    current_price: float | None = None,
    current_value: float | None = None,
    close_time: str | None = None,
    claimable_flag: bool | None = None,
    upstream_redeemable_flag: bool | None = None,
    expected_payout_usdc: float | None = None,
    claimable_value_usd: float | None = None,
    authoritative_market_is_open: bool | None = None,
    now: datetime | None = None,
) -> BullpenPositionClassification:
    current_time = (now or datetime.now(UTC)).astimezone(UTC)
    parsed_shares = shares if shares is not None else (_read_number(row.get("shares")) or 0.0)
    raw_current_price = row.get("current_price")
    if raw_current_price is None:
        raw_current_price = row.get("currentPrice")
    parsed_current_price = (
        current_price
        if current_price is not None
        else _read_number(raw_current_price)
    )
    parsed_current_value = current_value
    if parsed_current_value is None:
        raw_current_value = row.get("current_value")
        if raw_current_value is None:
            raw_current_value = row.get("currentValue")
        parsed_current_value = _read_number(raw_current_value)
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
    normalized_claimable_flag = (
        claimable_flag
        if claimable_flag is not None
        else extract_bullpen_claimable_flag(row)
    )
    parsed_upstream_redeemable_flag = (
        upstream_redeemable_flag
        if upstream_redeemable_flag is not None
        else extract_bullpen_upstream_redeemable_flag(row)
    )
    parsed_expected_payout_usdc = (
        expected_payout_usdc
        if expected_payout_usdc is not None
        else extract_bullpen_expected_payout_usdc(row)
    )
    parsed_claimable_value_usd = (
        claimable_value_usd
        if claimable_value_usd is not None
        else extract_bullpen_claimable_value_usd(row)
    )
    resolution_status = extract_bullpen_resolution_status(row)
    (
        normalized_resolution_status,
        resolved_by_status,
        open_by_status,
    ) = _normalized_resolution_status_tokens(resolution_status)
    past_close_time = (
        parsed_close_time <= current_time if parsed_close_time is not None else None
    )
    current_market_is_open = authoritative_market_is_open is True
    current_market_is_closed = authoritative_market_is_open is False
    # A fresh Gamma market snapshot is stronger evidence than a stale wallet
    # flag or an old payout field.  In particular, Bullpen has returned
    # `redeemable` for still-open child markets; those rows are holdings, not
    # claimable payouts.  Do not let any wallet claim evidence promote an
    # authoritatively open market into the Stage 1 claim queue.
    positive_payout_verified = not current_market_is_open and (
        _is_positive_value(parsed_expected_payout_usdc)
        or _is_positive_value(parsed_claimable_value_usd)
        or (
            (past_close_time is True or resolved_by_status)
            and _is_positive_value(parsed_current_value)
        )
    )
    redeemability_exists = normalized_claimable_flag or parsed_upstream_redeemable_flag
    close_time_is_past = past_close_time is True and not current_market_is_open

    if parsed_shares <= _VALUE_EPSILON and not positive_payout_verified:
        return BullpenPositionClassification(
            state="closed",
            reason="No economically meaningful Bullpen exposure remains for this row.",
            is_claimable=False,
            claimable_value_usd=None,
            expected_payout_usdc=parsed_expected_payout_usdc,
            resolution_status=resolution_status,
        )

    if positive_payout_verified:
        return BullpenPositionClassification(
            state="positive_payout_claimable",
            reason="Bullpen reported verified positive payout evidence for this resolved position.",
            is_claimable=True,
            claimable_value_usd=(
                parsed_claimable_value_usd
                if parsed_claimable_value_usd is not None
                else parsed_expected_payout_usdc
                if parsed_expected_payout_usdc is not None
                else parsed_current_value
            ),
            expected_payout_usdc=parsed_expected_payout_usdc,
            resolution_status=resolution_status,
        )

    if (
        close_time_is_past
        and _is_explicit_zero_value(parsed_current_value)
        and _is_explicit_zero_value(parsed_expected_payout_usdc)
    ):
        return BullpenPositionClassification(
            state="resolved_zero_payout",
            reason=(
                "The market has closed and both current value and expected payout are explicitly zero."
            ),
            is_claimable=False,
            claimable_value_usd=None,
            expected_payout_usdc=parsed_expected_payout_usdc,
            resolution_status=resolution_status,
        )

    if close_time_is_past and redeemability_exists:
        return BullpenPositionClassification(
            state="settlement_pending",
            reason=(
                "The market has closed and Bullpen exposes redeemability, but no verified payout amount is available yet."
            ),
            is_claimable=False,
            claimable_value_usd=None,
            expected_payout_usdc=parsed_expected_payout_usdc,
            resolution_status=resolution_status,
        )

    if parsed_current_price is None and parsed_current_value is None:
        return BullpenPositionClassification(
            state="stale_or_unknown",
            reason=(
                "Bullpen did not provide enough fresh pricing to treat this row as an economically active position."
            ),
            is_claimable=False,
            claimable_value_usd=None,
            expected_payout_usdc=parsed_expected_payout_usdc,
            resolution_status=resolution_status,
        )

    if close_time_is_past:
        return BullpenPositionClassification(
            state="stale_or_unknown",
            reason=(
                "The event close time has passed, but Bullpen did not provide enough settlement evidence to keep it active."
            ),
            is_claimable=False,
            claimable_value_usd=None,
            expected_payout_usdc=parsed_expected_payout_usdc,
            resolution_status=resolution_status,
        )

    if resolved_by_status and not current_market_is_open:
        return BullpenPositionClassification(
            state="stale_or_unknown",
            reason=(
                "Bullpen marked the row as resolved or closed, but did not provide verified payout evidence."
            ),
            is_claimable=False,
            claimable_value_usd=None,
            expected_payout_usdc=parsed_expected_payout_usdc,
            resolution_status=resolution_status,
        )

    if current_market_is_closed:
        return BullpenPositionClassification(
            state="stale_or_unknown",
            reason=(
                "An authoritative market lookup confirmed that this market is "
                "not open, but no verified settlement payout is available."
            ),
            is_claimable=False,
            claimable_value_usd=None,
            expected_payout_usdc=parsed_expected_payout_usdc,
            resolution_status=resolution_status,
        )

    return BullpenPositionClassification(
        state="active",
        reason=(
            "An authoritative live market lookup confirmed that this position is still open."
            if current_market_is_open
            else "This row still looks like an economically active Bullpen position."
        ),
        is_claimable=False,
        claimable_value_usd=None,
        expected_payout_usdc=parsed_expected_payout_usdc,
        resolution_status=resolution_status,
    )


def is_active_bullpen_position(
    classification: BullpenPositionClassification | BullpenPositionClassificationState,
) -> bool:
    return _position_state(classification) == "active"


def is_claimable_bullpen_position(
    classification: BullpenPositionClassification | BullpenPositionClassificationState,
) -> bool:
    return _position_state(classification) == "positive_payout_claimable"


def is_diagnostic_bullpen_position(
    classification: BullpenPositionClassification | BullpenPositionClassificationState,
) -> bool:
    return _position_state(classification) in {
        "settlement_pending",
        "stale_or_unknown",
        "resolved_zero_payout",
        "closed",
    }


def is_displayable_bullpen_position(
    classification: BullpenPositionClassification | BullpenPositionClassificationState,
) -> bool:
    return (
        is_active_bullpen_position(classification)
        or is_claimable_bullpen_position(classification)
        or is_diagnostic_bullpen_position(classification)
    )


def partition_bullpen_positions(
    positions: Iterable[T],
    get_classification: Callable[[T], BullpenPositionClassification | BullpenPositionClassificationState],
) -> BullpenPositionPartitions[T]:
    active_positions: list[T] = []
    positive_claimable_positions: list[T] = []
    settlement_pending_positions: list[T] = []
    stale_or_unknown_positions: list[T] = []
    resolved_zero_payout_positions: list[T] = []
    closed_positions: list[T] = []

    for position in positions:
        state = _position_state(get_classification(position))
        if state == "active":
            active_positions.append(position)
        elif state == "positive_payout_claimable":
            positive_claimable_positions.append(position)
        elif state == "settlement_pending":
            settlement_pending_positions.append(position)
        elif state == "stale_or_unknown":
            stale_or_unknown_positions.append(position)
        elif state == "resolved_zero_payout":
            resolved_zero_payout_positions.append(position)
        else:
            closed_positions.append(position)

    return BullpenPositionPartitions(
        active_positions=active_positions,
        positive_claimable_positions=positive_claimable_positions,
        settlement_pending_positions=settlement_pending_positions,
        stale_or_unknown_positions=stale_or_unknown_positions,
        resolved_zero_payout_positions=resolved_zero_payout_positions,
        closed_positions=closed_positions,
    )
