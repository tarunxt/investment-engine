"""Chat Completions pricing in USD. Source: https://api-docs.deepseek.com/quick_start/pricing/"""
from __future__ import annotations

import math
from datetime import UTC, datetime

# State Council public holiday schedules. Refresh when a new year is announced.
# https://en.bjhd.gov.cn/workinginhaidian/supportingservices/publicholidays/202512/t20251211_4797062.shtml
# https://english.www.gov.cn/policies/latestreleases/202611/06/content_WS6aed74dcc6d00ca5f9a0e22e.html
# (month, first day, last day). Unpublished years use the ordinary weekday estimate.
_HOLIDAY_PERIODS = {
    2026: [(1, 1, 3), (2, 15, 23), (4, 4, 6), (5, 1, 5), (6, 19, 21), (9, 25, 27), (10, 1, 7)],
    2027: [(1, 1, 3), (2, 5, 13), (4, 3, 5), (5, 1, 5), (6, 9, 9), (9, 15, 15), (10, 1, 7)],
}
_OFF_PEAK_RATES = {
    "deepseek-v4-flash": {"cache_hit_input": 0.003, "cache_miss_input": 0.15, "output": 0.6},
    "deepseek-v4-pro": {"cache_hit_input": 0.022, "cache_miss_input": 0.66, "output": 1.98},
}


def tariff_rates(model: str, when: datetime | None = None) -> dict[str, float]:
    instant = (when or datetime.now(UTC)).astimezone(UTC)
    rates = _OFF_PEAK_RATES[model]
    # Both UTC peak windows fall on the same calendar day in China.
    holiday = any(instant.month == month and start <= instant.day <= end
                  for month, start, end in _HOLIDAY_PERIODS.get(instant.year, ()))
    if instant.weekday() < 5 and not holiday and (1 <= instant.hour < 4 or 6 <= instant.hour < 10):
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
