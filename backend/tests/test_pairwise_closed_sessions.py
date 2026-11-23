from datetime import datetime

from app.domains.scorecards.pair_evidence import reconcile
from app.domains.scorecards.pair_plan import ready
from app.domains.scorecards.research import INDIA, bar
from app.domains.scorecards.technical_sources import session_calendar


def test_repair_uses_completed_sessions_and_keeps_verified_prices_without_volume():
    cutoff = datetime.fromisoformat("2026-11-23T16:16:20+05:30")
    calendar = session_calendar(cutoff, "NSE", [], 21)
    listing = "NSE:EXAMPLE"
    source = "https://example.org/history"
    bars = [bar(datetime.fromisoformat(day).date(), INDIA, [100, 110, 90, 105, None],
                source, cutoff, optional_volume=True) for day in calendar]
    manifest = {"as_of": cutoff.isoformat(), "stocks": [{"listing": listing}]}
    history = {"calendars": {"NSE": {**calendar, "2026-11-25": "2026-11-25T15:30:00+05:30"}},
               "listings": {listing: bars},
               "technical": {listing: {"sources": {"stock": {"action_url": source}}}}}
    packet = reconcile(manifest, history, {})["packets"][listing]
    assert ready(packet)
    assert packet["features"]["sessions"] == 21
    assert packet["features"]["return_5_pct"] == 0
    assert packet["features"]["relative_volume_20"] is None
    assert packet["features"]["volume_note"]
    bars.pop()
    missing = reconcile(manifest, history, {})["packets"][listing]
    assert not ready(missing)
    assert "2026-11-23" in missing["features"]["issue"]
    assert "https://" in missing["features"]["issue"]
