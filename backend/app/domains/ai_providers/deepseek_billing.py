"""Chat Completions pricing in USD. Source: https://api-docs.deepseek.com/quick_start/pricing/"""
from __future__ import annotations

import math
from datetime import UTC, datetime

from holidays import country_holidays

_CHINA_HOLIDAYS = country_holidays("CN")
_OFF_PEAK_RATES = {
    "deepseek-v4-flash": {"cache_hit_input": 0.003, "cache_miss_input": 0.15, "output": 0.6},
    "deepseek-v4-pro": {"cache_hit_input": 0.022, "cache_miss_input": 0.66, "output": 1.98},
}


def tariff_rates(model: str, when: datetime | None = None) -> dict[str, float]:
    instant = (when or datetime.now(UTC)).astimezone(UTC)
    rates = _OFF_PEAK_RATES[model]
    # Both UTC peak windows fall on the same calendar day in China.
    if (instant.weekday() < 5 and (1 <= instant.hour < 4 or 6 <= instant.hour < 10)
            and instant.date() not in _CHINA_HOLIDAYS):
        return {key: value * 2 for key, value in rates.items()}
    return rates


def reported_cost_usd(usage: object) -> float | None:
    """Only accept explicitly USD-denominated response metadata."""
    def field(name: str):
        return usage.get(name) if isinstance(usage, dict) else getattr(usage, name, None)

    value = field("cost_usd")
    if value is None and str(field("currency")).upper() == "USD":
        value = field("cost")
    if not isinstance(value, (str, int, float)) or isinstance(value, bool):
        return None
    try:
        amount = float(value)
    except (ValueError, OverflowError):
        return None
    return amount if math.isfinite(amount) and amount >= 0 else None
