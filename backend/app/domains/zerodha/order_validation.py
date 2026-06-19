from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, ROUND_CEILING, ROUND_FLOOR, ROUND_HALF_UP
from typing import Literal

DEFAULT_EQUITY_TICK_SIZE = Decimal("0.05")
OrderSide = Literal["BUY", "SELL"]


@dataclass(frozen=True)
class ZerodhaPriceGuardInput:
    side: OrderSide
    requested_price: float | int | str | None
    last_price: float | int | str | None
    lower_circuit_limit: float | int | str | None = None
    upper_circuit_limit: float | int | str | None = None
    tick_size: float | int | str | None = None
    instrument_kind: Literal["EQ", "FUT", "OPT"] = "EQ"


@dataclass(frozen=True)
class ZerodhaPriceGuardResult:
    price: float
    tick_size: float
    reference_price: float
    lower_circuit_limit: float | None
    upper_circuit_limit: float | None
    adjusted: bool
    reasons: tuple[str, ...]


def _decimal_or_none(value: float | int | str | None) -> Decimal | None:
    if value is None:
        return None
    try:
        parsed = Decimal(str(value))
    except Exception:
        return None
    if not parsed.is_finite() or parsed <= 0:
        return None
    return parsed


def _round_to_tick(
    value: Decimal, tick_size: Decimal, rounding: str = ROUND_HALF_UP
) -> Decimal:
    ticks = (value / tick_size).to_integral_value(rounding=rounding)
    return ticks * tick_size


def _clamp_to_circuit(
    value: Decimal, lower: Decimal | None, upper: Decimal | None
) -> Decimal:
    if lower is not None and value < lower:
        return lower
    if upper is not None and value > upper:
        return upper
    return value


def _protection_pct(
    last_price: Decimal, instrument_kind: Literal["EQ", "FUT", "OPT"]
) -> Decimal:
    """Return Zerodha default market-protection percentage as a ratio."""
    if instrument_kind == "OPT":
        if last_price < Decimal("10"):
            return Decimal("0.05")
        if last_price <= Decimal("100"):
            return Decimal("0.03")
        if last_price <= Decimal("500"):
            return Decimal("0.02")
        return Decimal("0.01")

    # Zerodha default bands for equities and futures.
    if last_price < Decimal("100"):
        return Decimal("0.02")
    if last_price <= Decimal("500"):
        return Decimal("0.01")
    return Decimal("0.005")


def guard_zerodha_limit_price(order: ZerodhaPriceGuardInput) -> ZerodhaPriceGuardResult:
    """Return a Kite-safe marketable limit price.

    Zerodha Publisher baskets are submitted as LIMIT rows. The recommendation
    price can be stale, off-circuit, or have arbitrary decimal precision, so the
    safest executable value is derived from the current Kite LTP with a small
    directional buffer and then constrained to exchange circuit/tick rules.
    """
    tick_size = _decimal_or_none(order.tick_size) or DEFAULT_EQUITY_TICK_SIZE
    last_price = _decimal_or_none(order.last_price)
    requested_price = _decimal_or_none(order.requested_price)
    lower = _decimal_or_none(order.lower_circuit_limit)
    upper = _decimal_or_none(order.upper_circuit_limit)
    reasons: list[str] = []

    reference = last_price or requested_price
    if reference is None:
        raise ValueError("A positive last_price or requested_price is required")

    if order.side == "BUY":
        raw_price = (
            reference
            * (Decimal("1") + _protection_pct(reference, order.instrument_kind))
            if last_price
            else reference
        )
        rounding = ROUND_CEILING
    else:
        raw_price = (
            reference
            * (Decimal("1") - _protection_pct(reference, order.instrument_kind))
            if last_price
            else reference
        )
        rounding = ROUND_FLOOR

    if requested_price is not None and last_price is not None:
        requested_clamped = _clamp_to_circuit(requested_price, lower, upper)
        requested_safe = _round_to_tick(requested_clamped, tick_size, rounding)
        if requested_safe != requested_price:
            reasons.append("requested_price_not_exchange_safe")
        # Always prefer LTP-derived marketable limit prices for Publisher rows.
        if abs(requested_price - raw_price) >= tick_size:
            reasons.append("using_ltp_derived_marketable_limit")

    clamped = _clamp_to_circuit(raw_price, lower, upper)
    if clamped != raw_price:
        reasons.append("clamped_to_circuit_limit")

    rounded = _round_to_tick(clamped, tick_size, rounding)
    if upper is not None and rounded > upper:
        rounded = _round_to_tick(upper, tick_size, ROUND_FLOOR)
        reasons.append("rounded_down_to_upper_circuit_tick")
    if lower is not None and rounded < lower:
        rounded = _round_to_tick(lower, tick_size, ROUND_CEILING)
        reasons.append("rounded_up_to_lower_circuit_tick")

    if rounded <= 0:
        raise ValueError("Computed order price is not positive")

    requested_comparison = requested_price if requested_price is not None else rounded
    adjusted = rounded != requested_comparison or bool(reasons)

    return ZerodhaPriceGuardResult(
        price=float(rounded),
        tick_size=float(tick_size),
        reference_price=float(reference),
        lower_circuit_limit=float(lower) if lower is not None else None,
        upper_circuit_limit=float(upper) if upper is not None else None,
        adjusted=adjusted,
        reasons=tuple(dict.fromkeys(reasons)),
    )
