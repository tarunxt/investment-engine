from __future__ import annotations

from typing import Any


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
