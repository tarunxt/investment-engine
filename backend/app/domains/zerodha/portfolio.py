from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")


def current_snapshot_date() -> date:
    return snapshot_date_from_datetime(datetime.now(tz=timezone.utc))


def snapshot_date_from_datetime(value: datetime) -> date:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(IST).date()


def _as_float(value: Any) -> float:
    try:
        if value is None or value == "":
            return 0.0
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _as_int(value: Any) -> int:
    try:
        if value is None or value == "":
            return 0
        return int(value)
    except (TypeError, ValueError):
        return 0


def _as_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _as_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes"}
    return bool(value)


def normalize_holding(item: dict[str, Any]) -> dict[str, Any]:
    quantity = _as_int(item.get("quantity"))
    last_price = _as_float(item.get("last_price"))
    average_price = _as_float(item.get("average_price"))
    day_change = _as_float(item.get("day_change"))

    return {
        "tradingsymbol": _as_str(item.get("tradingsymbol")) or "",
        "exchange": _as_str(item.get("exchange")) or "",
        "instrument_token": _as_int(item.get("instrument_token")) or None,
        "isin": _as_str(item.get("isin")),
        "product": _as_str(item.get("product")),
        "quantity": quantity,
        "used_quantity": _as_int(item.get("used_quantity")),
        "t1_quantity": _as_int(item.get("t1_quantity")),
        "realised_quantity": _as_int(item.get("realised_quantity")),
        "authorised_quantity": _as_int(item.get("authorised_quantity")),
        "authorised_date": _as_str(item.get("authorised_date")),
        "opening_quantity": _as_int(item.get("opening_quantity")),
        "short_quantity": _as_int(item.get("short_quantity")),
        "collateral_quantity": _as_int(item.get("collateral_quantity")),
        "collateral_type": _as_str(item.get("collateral_type")),
        "discrepancy": _as_bool(item.get("discrepancy")),
        "average_price": average_price,
        "last_price": last_price,
        "close_price": _as_float(item.get("close_price")),
        "pnl": _as_float(item.get("pnl")),
        "day_change": day_change,
        "day_change_percentage": _as_float(item.get("day_change_percentage")),
        "market_value": round(quantity * last_price, 2),
        "invested_value": round(quantity * average_price, 2),
        "day_change_value": round(quantity * day_change, 2),
    }


def normalize_position(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "tradingsymbol": _as_str(item.get("tradingsymbol")) or "",
        "exchange": _as_str(item.get("exchange")) or "",
        "instrument_token": _as_int(item.get("instrument_token")) or None,
        "product": _as_str(item.get("product")),
        "quantity": _as_int(item.get("quantity")),
        "overnight_quantity": _as_int(item.get("overnight_quantity")),
        "multiplier": _as_float(item.get("multiplier")),
        "average_price": _as_float(item.get("average_price")),
        "close_price": _as_float(item.get("close_price")),
        "last_price": _as_float(item.get("last_price")),
        "value": _as_float(item.get("value")),
        "pnl": _as_float(item.get("pnl")),
        "m2m": _as_float(item.get("m2m")),
        "unrealised": _as_float(item.get("unrealised")),
        "realised": _as_float(item.get("realised")),
        "buy_quantity": _as_int(item.get("buy_quantity")),
        "buy_price": _as_float(item.get("buy_price")),
        "buy_value": _as_float(item.get("buy_value")),
        "buy_m2m": _as_float(item.get("buy_m2m")),
        "sell_quantity": _as_int(item.get("sell_quantity")),
        "sell_price": _as_float(item.get("sell_price")),
        "sell_value": _as_float(item.get("sell_value")),
        "sell_m2m": _as_float(item.get("sell_m2m")),
        "day_buy_quantity": _as_int(item.get("day_buy_quantity")),
        "day_buy_price": _as_float(item.get("day_buy_price")),
        "day_buy_value": _as_float(item.get("day_buy_value")),
        "day_sell_quantity": _as_int(item.get("day_sell_quantity")),
        "day_sell_price": _as_float(item.get("day_sell_price")),
        "day_sell_value": _as_float(item.get("day_sell_value")),
    }


def build_portfolio_snapshot(
    holdings_payload: list[dict[str, Any]],
    positions_payload: dict[str, Any],
    *,
    captured_at: datetime | None = None,
    source: str = "manual",
) -> dict[str, Any]:
    captured_at = captured_at or datetime.now(tz=timezone.utc)
    if captured_at.tzinfo is None:
        captured_at = captured_at.replace(tzinfo=timezone.utc)

    holdings = [normalize_holding(item) for item in holdings_payload]
    holdings.sort(key=lambda item: item["market_value"], reverse=True)

    net_positions = [normalize_position(item) for item in positions_payload.get("net", [])]
    net_positions.sort(key=lambda item: abs(item["value"]), reverse=True)

    day_positions = [normalize_position(item) for item in positions_payload.get("day", [])]
    day_positions.sort(
        key=lambda item: abs(item["day_buy_value"]) + abs(item["day_sell_value"]),
        reverse=True,
    )

    return {
        "snapshot_date": snapshot_date_from_datetime(captured_at),
        "captured_at": captured_at,
        "source": source,
        "holdings_count": len(holdings),
        "net_positions_count": len(net_positions),
        "day_positions_count": len(day_positions),
        "holdings_market_value": round(sum(item["market_value"] for item in holdings), 2),
        "holdings_pnl": round(sum(item["pnl"] for item in holdings), 2),
        "holdings_day_change_value": round(
            sum(item["day_change_value"] for item in holdings), 2
        ),
        "positions_pnl": round(sum(item["pnl"] for item in net_positions), 2),
        "positions_m2m": round(sum(item["m2m"] for item in net_positions), 2),
        "holdings": holdings,
        "net_positions": net_positions,
        "day_positions": day_positions,
    }
