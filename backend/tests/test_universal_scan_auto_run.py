from datetime import UTC, datetime

from app.domains.trading_bots.universal_scan import next_scheduled_time


def test_universal_scan_schedule_stays_anchored_to_configured_start():
    start = "2026-08-22T12:30:00+00:00"

    assert next_scheduled_time(
        datetime(2026, 8, 22, 12, 29, tzinfo=UTC),
        start_at=start,
        refresh_minutes=360,
    ) == datetime(2026, 8, 22, 12, 30, tzinfo=UTC)
    assert next_scheduled_time(
        datetime(2026, 8, 22, 12, 30, tzinfo=UTC),
        start_at=start,
        refresh_minutes=360,
    ) == datetime(2026, 8, 22, 18, 30, tzinfo=UTC)
    assert next_scheduled_time(
        datetime(2026, 9, 15, 13, 0, tzinfo=UTC),
        start_at=start,
        refresh_minutes=360,
    ) == datetime(2026, 9, 15, 18, 30, tzinfo=UTC)

