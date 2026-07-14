import os
from datetime import date, datetime

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://test:test@localhost:5432/testdb",
)
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

from app.domains.api_usage.router import _usage_day_string, _window_utc


def test_usage_day_string_uses_utc_provider_console_day_for_naive_timestamp():
    assert _usage_day_string(datetime(2026, 7, 13, 20, 0, 0)) == "2026-07-13"


def test_custom_window_uses_utc_day_boundaries():
    start, end, label = _window_utc(
        "custom",
        custom_start=date(2026, 7, 13),
        custom_end=date(2026, 7, 13),
    )

    assert start == datetime(2026, 7, 13, 0, 0, 0)
    assert end == datetime(2026, 7, 14, 0, 0, 0)
    assert label == "Custom (2026-07-13 to 2026-07-13)"
