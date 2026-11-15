from __future__ import annotations

import math
from typing import Any


def signed_holding_return_percent(
    percent: float | None,
    *,
    pnl: float | None,
    invested_value: float | None,
) -> float | None:
    """Keep a pasted percentage's precision but use its signed dollar return.

    Copied portfolio text can lose an arrow/color that conveys the sign. For
    long holdings with a positive cost basis the percentage and P&L must have
    the same sign. Do not infer direction for missing/zero or short cost bases.
    This also repairs presentation of older imports without rewriting records.
    """
    if (
        percent is None or pnl is None or invested_value is None
        or invested_value <= 0 or pnl == 0
        or not all(math.isfinite(value) for value in (percent, pnl, invested_value))
    ):
        return percent
    return math.copysign(abs(percent), pnl)


def _number(value: Any, default: float = 0) -> float:
    if value is None or isinstance(value, bool):
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def build_persisted_portfolio_summary(
    holdings: object,
    *,
    total_value: float | None,
    limit: int = 4,
) -> tuple[list[dict[str, object]], float | None]:
    """Build the small snapshot projection used by dashboard reads."""

    if not isinstance(holdings, list):
        return [], None

    normalized: list[dict[str, object]] = []
    invested_total = 0.0
    saw_invested_value = False
    portfolio_value = _number(total_value)
    for raw in holdings:
        if not isinstance(raw, dict):
            continue
        current_value = _number(raw.get("market_value", raw.get("current_value")))
        invested_raw = raw.get("invested_value")
        invested_value = _number(invested_raw)
        if invested_raw is not None:
            saw_invested_value = True
            invested_total += invested_value
        weight = raw.get("portfolio_weight_percent")
        weight_value = _number(weight) if weight is not None else None
        if weight_value is None and portfolio_value > 0:
            weight_value = current_value / portfolio_value * 100
        normalized.append(
            {
                "symbol": str(
                    raw.get("tradingsymbol") or raw.get("symbol") or "Unknown"
                ),
                "company_name": (
                    str(raw["company_name"])
                    if raw.get("company_name") is not None
                    else None
                ),
                "current_value": current_value,
                "invested_value": invested_value,
                "pnl": _number(raw.get("pnl", raw.get("total_pnl"))),
                "pnl_percent": _number(
                    raw.get("pnl_percent", raw.get("total_pnl_percent"))
                ),
                "weight_percent": weight_value,
            }
        )

    normalized.sort(
        key=lambda holding: float(holding["current_value"]),
        reverse=True,
    )
    return (
        normalized[:limit],
        invested_total if saw_invested_value else None,
    )
