"""Public page fixtures captured 2026-09-14; only ranking/table data retained."""
import json
from pathlib import Path
from datetime import UTC, datetime

import pytest

from app.domains.sports_rankings.cricket import parse_cricket
from app.domains.sports_rankings.feeds import FEEDS, CRICKET_SOURCE_IDS
from app.domains.sports_rankings.public_providers import fetch_public

ROOT = Path(__file__).parent / "fixtures" / "cricket"


def hydration(data):
    return '<script>self.__next_f.push(' + json.dumps([1, '1:' + json.dumps(data)]) + ')</script>'


def fixture(source):
    feed = FEEDS[source]
    if feed['parser'] == 'cricket-rankings':
        return hydration(json.loads((ROOT / (feed['gender'] + '.json')).read_text()))
    if feed['parser'] == 'cricket-table':
        return hydration(json.loads((ROOT / (source.removeprefix('cricket-') + '.json')).read_text()))
    name = 'hundred' if 'hundred' in source else 'ecb' if 'championship' in source else 'county'
    return (ROOT / (name + '.html')).read_text()


@pytest.mark.parametrize('source,count', [
    ('cricket-men-test', 10), ('cricket-men-odi', 20), ('cricket-men-t20', 102),
    ('cricket-women-odi', 16), ('cricket-women-t20', 80),
    ('cricket-hundred-men', 8), ('cricket-hundred-women', 8),
    ('cricket-county-championship', 18), ('cricket-one-day-cup', 18),
    ('cricket-t10', 8), ('cricket-ipl', 10), ('cricket-cpl', 7),
])
def test_published_cricket_tables(source, count):
    rows, date, season = parse_cricket(fixture(source), FEEDS[source])
    assert len(rows) == count
    assert rows[0]['rank'] == 1
    assert all(r['group'] and r['name'] for r in rows)
    if source == 'cricket-men-odi':
        assert (rows[0]['name'], rows[0]['rating'], rows[0]['points'], rows[0]['played']) == ('India', 116, 3841, 33)
        assert date is None  # Retrieval date must never become publication date.
    if source == 'cricket-t10':
        assert season == '2025'
    if source == 'cricket-county-championship':
        assert len({r['group'] for r in rows}) == 2
        assert rows[0]['points'] == 189  # Keep official bonus/penalty-adjusted points.


def test_missing_ratings_and_published_ties_are_preserved():
    rows, _, _ = parse_cricket(fixture('cricket-men-t20'), FEEDS['cricket-men-t20'])
    assert len([r for r in rows if r['rank'] == 94]) == 9
    assert rows[-1]['rating'] is None  # Do not invent a numeric value for omitted fields.


def test_scope_conflicts_truncation_and_wrong_edition_fail_closed():
    with pytest.raises(ValueError, match='scope'):
        parse_cricket(fixture('cricket-women-odi'), FEEDS['cricket-men-odi'])
    with pytest.raises(ValueError, match='edition'):
        parse_cricket(fixture('cricket-ipl'), FEEDS['cricket-t10'])
    data = json.loads((ROOT / 'men.json').read_text())
    data['formatTypesData']['odi']['rank'] = data['formatTypesData']['odi']['rank'][:2]
    with pytest.raises(ValueError, match='Incomplete'):
        parse_cricket(hydration(data), FEEDS['cricket-men-odi'])
    with pytest.raises(ValueError, match='conflicting'):
        parse_cricket(fixture('cricket-men-odi') + fixture('cricket-women-odi'), FEEDS['cricket-men-odi'])


def test_invalid_records_and_future_publication_are_rejected(monkeypatch):
    data = json.loads((ROOT / 'ipl.json').read_text())
    data['pointsTableData']['pointsTable'][0]['pointsTableInfo'][0]['matchesPlayed'] = 1
    with pytest.raises(ValueError, match='counts'):
        parse_cricket(hydration(data), FEEDS['cricket-ipl'])
    monkeypatch.setattr('app.domains.sports_rankings.public_providers.read_public', lambda *_: (fixture('cricket-cpl'), FEEDS['cricket-cpl']['url']))
    with pytest.raises(ValueError, match='Future'):
        fetch_public('cricket-cpl', None, datetime(2026, 1, 1, tzinfo=UTC))


def test_all_six_cricket_formats_have_connected_sources():
    assert {FEEDS[k]['sport_id'] for k in CRICKET_SOURCE_IDS} == {
        'test-cricket', 'odi-cricket', 't20-cricket', 't10-cricket', 'the-hundred', 'domestic-cricket'}
    assert 'cricket-women-test' not in FEEDS


def test_reconciliation_dispatches_independent_background_jobs(monkeypatch):
    from app.domains.sports_rankings.tasks import reconcile_cricket, refresh_source
    queued = []
    monkeypatch.setattr(refresh_source, 'apply_async', lambda **kwargs: queued.extend(kwargs['args']))
    assert reconcile_cricket.run()['sources'] == len(CRICKET_SOURCE_IDS)
    assert set(queued) == CRICKET_SOURCE_IDS


def test_reconciliation_has_daily_schedule_and_existing_refresh_remains():
    from app.infrastructure.messaging.celery_app import celery
    entry = celery.conf.beat_schedule['cricket-rankings-daily-reconciliation']
    assert entry['schedule'].hour == {3} and entry['schedule'].minute == {10}
    assert 'sports-rankings-refresh' in celery.conf.beat_schedule
