import os
from datetime import date, datetime

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://test:test@localhost:5432/testdb",
)
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

from app.domains.api_usage.router import _usage_day_string, _window_utc


def test_usage_day_string_uses_provider_console_local_day_for_naive_utc_timestamp():
    assert _usage_day_string(datetime(2026, 7, 13, 20, 0, 0)) == "2026-07-14"


def test_custom_window_uses_asia_kolkata_day_boundaries_in_utc():
    start, end, label = _window_utc(
        "custom",
        custom_start=date(2026, 7, 13),
        custom_end=date(2026, 7, 13),
    )

    assert start == datetime(2026, 7, 12, 18, 30, 0)
    assert end == datetime(2026, 7, 13, 18, 30, 0)
    assert label == "Custom (2026-07-13 to 2026-07-13)"
