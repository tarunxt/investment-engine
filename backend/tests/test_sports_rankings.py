from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest

from app.domains.sports_rankings.catalogue import CATALOGUE, SOURCE_IDS, normalize_name
from app.domains.sports_rankings.providers import parse_football, parse_valve
from app.domains.sports_rankings.schemas import RankingQuery
from app.domains.sports_rankings.service import ranking_rows, resolve, source_status


def test_complete_import():
    assert len(CATALOGUE) == 95
    assert len({c['code'] for c in CATALOGUE}) == 75
    assert sum(len(c['events']) for c in CATALOGUE) == 346
    assert sum(len(c['participants']) for c in CATALOGUE) == 388
    assert len({c['id'] for c in CATALOGUE}) == len(CATALOGUE)
    assert all(c['source_id'] is None or c['source_id'] in SOURCE_IDS for c in CATALOGUE)


def test_normalization_preserves_identity_boundaries():
    assert normalize_name('Žilina') == normalize_name('Zilina')
    assert normalize_name('ЯЧЁ123')
    assert normalize_name('Spirit') != normalize_name('Spirit Academy')
    assert normalize_name('Spain') != normalize_name('Spain U20')
    assert normalize_name('Manchester City FC') != normalize_name('Manchester City WFC')


def test_results_table_and_shared_rank():
    csv = 'Div,Date,HomeTeam,AwayTeam,FTHG,FTAG,FTR\nE0,01/08/2026,A,B,2,0,H\nE0,02/08/2026,C,D,2,0,H\nE0,03/08/2026,A,C,1,1,D\n'
    rows, date = parse_football(csv, 'E0', datetime(2026, 9, 1, tzinfo=UTC))
    assert date == '2026-08-03'
    assert [(r['name'], r['rank'], r['points']) for r in rows] == [('A', 1, 4), ('C', 1, 4), ('B', 3, 0), ('D', 3, 0)]
    assert rows[0]['played'] == 2
    assert sum(r['goals_for'] for r in rows) == sum(r['goals_against'] for r in rows)


@pytest.mark.parametrize('record', ['E1,01/08/2026,A,B,2,0,H', 'E0,01/08/2026,A,B,2,0,A', 'E0,01/08/2029,A,B,2,0,H', 'E0,01/08/2026,A,B,-1,0,A'])
def test_reject_bad_results(record):
    with pytest.raises(ValueError):
        parse_football('Div,Date,HomeTeam,AwayTeam,FTHG,FTAG,FTR\n' + record, 'E0', datetime(2026, 9, 1, tzinfo=UTC))


def test_duplicate_match_rejected():
    with pytest.raises(ValueError, match='Duplicate'):
        parse_football('Div,Date,HomeTeam,AwayTeam,FTHG,FTAG,FTR\n' + 'E0,01/08/2026,A,B,2,0,H\n' * 2, 'E0', datetime(2026, 9, 1, tzinfo=UTC))


def test_valve_publication_and_partial_rejection():
    text = '### Standings as of 2026_09_07<br />\n' + '\n'.join(f'| {i} | {2000-i} | Team {i} | roster | link |' for i in range(1, 11))
    rows, date = parse_valve(text)
    assert date == '2026-09-07' and len(rows) == 10
    assert rows[0]['points'] == 1999
    with pytest.raises(ValueError):
        parse_valve('### Standings as of 2026_09_07<br />\n| 1 | 2000 | A | roster |')


def test_unmatched_names_are_not_zero_ranked():
    c = {'participants': [{'name': 'Spirit Academy', 'aliases': []}]}
    snap = SimpleNamespace(rows=[{'name': 'Spirit', 'rank': 1, 'points': 2000}])
    rows = ranking_rows(c, snap)
    assert rows[1]['name'] == 'Spirit Academy' and rows[1]['rank'] is None


def test_duplicate_names_with_distinct_rosters_remain_ambiguous():
    text = '### Standings as of 2026_09_07<br />\n' + '\n'.join(f'| {i} | {2000-i} | Team | roster {i} | link |' for i in range(1, 11))
    rows, _ = parse_valve(text)
    c = {'participants': [{'name': 'Team', 'aliases': []}]}
    result = ranking_rows(c, SimpleNamespace(rows=rows))
    assert result[-1]['match_status'] == 'ambiguous'
    assert result[-1]['rank'] is None


def test_unavailable_stale_and_failed():
    assert source_status(None, None) == 'unavailable'
    assert source_status(None, 'valve-global') == 'pending'
    snap = SimpleNamespace(checked_at=datetime.now(UTC), status='failed')
    assert source_status(snap, 'valve-global') == 'failed'
    snap.checked_at -= timedelta(hours=2)
    assert source_status(snap, 'valve-global') == 'stale'


def test_code_scoped_resolution_does_not_enable_analysis():
    result = resolve(RankingQuery(code='argpn', name='CA San Miguel'), {})
    assert result['match_status'] == 'matched'
    assert result['candidates'][0]['rank'] is None
    assert result['candidates'][0]['status'] == 'unavailable'
    assert result['automatic_analysis_enabled'] is False
    assert resolve(RankingQuery(code='arg', name='CA San Miguel'), {})['match_status'] == 'unmatched'


def test_ambiguous_alias_does_not_choose_arbitrary_team():
    c = {'participants': [{'name': 'United', 'aliases': ['United A', 'United B']}]}
    snap = SimpleNamespace(rows=[{'name': 'United A', 'rank': 1}, {'name': 'United B', 'rank': 2}])
    assert ranking_rows(c, snap)[-1]['match_status'] == 'ambiguous'
