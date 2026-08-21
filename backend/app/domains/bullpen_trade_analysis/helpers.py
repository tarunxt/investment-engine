from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

SENSITIVE_KEY_SNIPPETS = {
    "authorization",
    "cookie",
    "jwt",
    "password",
    "private",
    "refresh_token",
    "secret",
    "token",
}


def utc_now() -> datetime:
    return datetime.now(UTC)


def parse_datetime(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value.astimezone(UTC) if value.tzinfo else value.replace(tzinfo=UTC)
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed.astimezone(UTC) if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def parse_float(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        cleaned = value.replace("$", "").replace("%", "").replace(",", "").strip()
        if not cleaned:
            return None
        try:
            return float(cleaned)
        except ValueError:
            return None
    return None


def redact_sensitive_value(key: str, value: Any) -> Any:
    normalized = key.strip().lower()
    if any(snippet in normalized for snippet in SENSITIVE_KEY_SNIPPETS):
        return "[redacted]"
    return sanitize_json_value(value)


def sanitize_json_value(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            str(key): redact_sensitive_value(str(key), nested)
            for key, nested in value.items()
        }
    if isinstance(value, list):
        return [sanitize_json_value(item) for item in value]
    if isinstance(value, tuple):
        return [sanitize_json_value(item) for item in value]
    return value


def safe_json_loads(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return sanitize_json_value(value)
    if not isinstance(value, str) or not value.strip():
        return {}
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return {"raw_text": value}
    return sanitize_json_value(parsed) if isinstance(parsed, dict) else {"payload": sanitize_json_value(parsed)}


def recursive_find(value: Any, keys: tuple[str, ...]) -> Any:
    lowered = {item.lower() for item in keys}
    stack = [value]
    seen: set[int] = set()
    while stack:
        current = stack.pop()
        if current is None:
            continue
        current_id = id(current)
        if current_id in seen:
            continue
        seen.add(current_id)
        if isinstance(current, dict):
            for key, item in current.items():
                if str(key).lower() in lowered:
                    return item
            stack.extend(current.values())
        elif isinstance(current, list):
            stack.extend(current)
    return None


def normalize_title(value: Any) -> str:
    if value is None:
        return ""
    return " ".join(str(value).strip().lower().split())


def confidence_score_from_value(value: Any) -> float | None:
    numeric = parse_float(value)
    if numeric is not None:
        if numeric > 1:
            return round(min(1.0, max(0.0, numeric / 100)), 4)
        return round(min(1.0, max(0.0, numeric)), 4)
    if not isinstance(value, str):
        return None
    normalized = value.strip().lower()
    if normalized == "high":
        return 0.85
    if normalized == "medium":
        return 0.6
    if normalized == "low":
        return 0.25
    return None


def risk_score_from_status(value: Any) -> float | None:
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"blocked", "fail", "failed"}:
            return 0.9
        if normalized in {"watch", "warning"}:
            return 0.55
        if normalized in {"ready", "pass", "passed"}:
            return 0.2
    return confidence_score_from_value(value)


def bounded_score(
    value: float | None,
    *,
    lower: float,
    upper: float,
    inverse: bool = False,
) -> float | None:
    if value is None:
        return None
    if upper <= lower:
        return None
    clipped = min(max(value, lower), upper)
    normalized = (clipped - lower) / (upper - lower)
    result = 1 - normalized if inverse else normalized
    return round(min(1.0, max(0.0, result)), 4)


def compute_trade_tags(
    *,
    category: str | None,
    topic: str | None,
    liquidity_score: float | None,
    volume_score: float | None,
    spread_score: float | None,
    confidence_score: float | None,
    probability_delta: float | None,
    evidence_status: str | None,
    event_state: str | None,
) -> list[str]:
    tags: list[str] = []
    if category:
        tags.append(category.strip())
    if topic and topic.strip().lower() != (category or "").strip().lower():
        tags.append(topic.strip())
    if liquidity_score is not None:
        tags.append("strong_liquidity" if liquidity_score >= 0.6 else "low_liquidity")
    if volume_score is not None:
        tags.append("healthy_volume" if volume_score >= 0.6 else "thin_volume")
    if spread_score is not None:
        tags.append("tight_spread" if spread_score >= 0.6 else "wide_spread")
    if confidence_score is not None:
        if confidence_score >= 0.75:
            tags.append("high_confidence")
        elif confidence_score >= 0.4:
            tags.append("medium_confidence")
        else:
            tags.append("low_confidence")
    if probability_delta is not None:
        if probability_delta >= 8:
            tags.append("strong_edge")
        elif probability_delta >= 3:
            tags.append("moderate_edge")
        elif probability_delta > -3:
            tags.append("weak_edge")
        else:
            tags.append("negative_edge")
    if evidence_status:
        tags.append(f"evidence_{normalize_title(evidence_status).replace(' ', '_')}")
    if event_state:
        tags.append(f"event_{normalize_title(event_state).replace(' ', '_')}")
    deduped: list[str] = []
    seen: set[str] = set()
    for tag in tags:
        key = normalize_title(tag)
        if not key or key in seen:
            continue
        seen.add(key)
        deduped.append(tag)
    return deduped


def build_rule_checks(
    *,
    liquidity_score: float | None,
    spread_score: float | None,
    confidence_score: float | None,
    probability_delta: float | None,
    has_llm_output: bool,
    expired: bool | None = None,
) -> list[dict[str, Any]]:
    checks = [
        {
            "label": "Liquidity check",
            "passed": liquidity_score is None or liquidity_score >= 0.35,
            "value": liquidity_score,
            "detail": "Scores below 0.35 are treated as weak liquidity.",
        },
        {
            "label": "Spread check",
            "passed": spread_score is None or spread_score >= 0.35,
            "value": spread_score,
            "detail": "Scores below 0.35 suggest a wide spread.",
        },
        {
            "label": "Confidence check",
            "passed": confidence_score is None or confidence_score >= 0.4,
            "value": confidence_score,
            "detail": "Scores below 0.4 indicate weak confidence.",
        },
        {
            "label": "Edge check",
            "passed": probability_delta is None or probability_delta >= 3,
            "value": probability_delta,
            "detail": "Probability delta should exceed 3 points for a cleaner edge.",
        },
        {
            "label": "LLM output present",
            "passed": has_llm_output,
            "value": has_llm_output,
            "detail": "At least one model output was attached to the decision context.",
        },
    ]
    if expired is not None:
        checks.append(
            {
                "label": "Expiry check",
                "passed": not expired,
                "value": expired,
                "detail": "Expired markets should not be entered or held.",
            }
        )
    return checks


def extract_execution_summary(
    payload: dict[str, Any],
    *,
    requested_amount: float | None,
    requested_shares: float | None,
    requested_price: float | None,
) -> dict[str, Any]:
    order_id = recursive_find(
        payload,
        (
            "orderId",
            "order_id",
            "id",
            "transactionHash",
            "txHash",
        ),
    )
    client_order_id = recursive_find(
        payload,
        ("clientOrderId", "client_order_id", "clientOrderID"),
    )
    status = recursive_find(payload, ("status", "state", "result"))
    filled_amount = recursive_find(
        payload,
        ("filledAmount", "filled_amount", "amount", "notional", "value"),
    )
    filled_shares = recursive_find(
        payload,
        ("filledShares", "filled_shares", "shares", "quantity", "size", "qty"),
    )
    average_fill_price = recursive_find(
        payload,
        ("avgPrice", "averagePrice", "average_fill_price", "price", "fillPrice"),
    )
    fees = recursive_find(payload, ("fees", "fee", "totalFees"))

    avg_price = parse_float(average_fill_price) or requested_price
    shares = parse_float(filled_shares) or requested_shares
    amount = parse_float(filled_amount)
    if amount is None and avg_price is not None and shares is not None:
        amount = round(avg_price * shares, 6)

    return {
        "order_id": str(order_id).strip() if order_id is not None else None,
        "client_order_id": (
            str(client_order_id).strip() if client_order_id is not None else None
        ),
        "status": str(status).strip() if status is not None else None,
        "filled_amount": amount if amount is not None else requested_amount,
        "filled_shares": shares,
        "average_fill_price": avg_price,
        "average_fill_odds": round(avg_price * 100, 4) if avg_price is not None else None,
        "fees": parse_float(fees),
    }
