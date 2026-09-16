from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest

from app.domains.sports_rankings.catalogue import CATALOGUE, IMPORTED_CATALOGUE, SOURCE_IDS, normalize_name
from app.domains.sports_rankings.providers import parse_football, parse_valve
from app.domains.sports_rankings.public_providers import parse_json
from app.domains.sports_rankings.schemas import EventComparisonsQuery, RankingQuery
from app.domains.sports_rankings.service import event_comparisons, ranking_rows, resolve, source_status
from app.domains.sports_rankings.router import _comparison_source_ids


def test_complete_import():
    assert len(IMPORTED_CATALOGUE) == 95
    assert len({c['code'] for c in IMPORTED_CATALOGUE}) == 75
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


@pytest.mark.parametrize('imported,provider', [
    ('Manchester City FC', 'Man City'),
    ('Manchester United FC', 'Man United'),
    ('Brighton & Hove Albion FC', 'Brighton'),
    ('Coventry City FC', 'Coventry'),
])
def test_explicit_feed_alias_resolves_imported_name(imported, provider):
    snap = SimpleNamespace(rows=[{'name': provider, 'rank': 1, 'points': 9}], status='ready', checked_at=datetime.now(UTC), source_as_of='2026-09-06')
    result = resolve(RankingQuery(code='epl', name=imported), {'football-data-E0': snap})
    assert result['match_status'] == 'matched'
    assert result['candidates'][0]['name'] == provider
    assert result['candidates'][0]['rank'] == 1
    assert resolve(RankingQuery(code='wsl', name=imported), {'football-data-E0': snap})['candidates'] == []


def test_team_designator_suffix_resolves_unique_provider_team():
    snap = SimpleNamespace(
        rows=[
            {'name': 'Brentford', 'rank': 7, 'points': 4},
            {'name': 'Chelsea', 'rank': 2, 'points': 9},
        ],
        status='ready', checked_at=datetime.now(UTC), source_as_of='2026-09-16',
    )
    assert resolve(RankingQuery(code='epl', name='Brentford FC'), {'football-data-E0': snap})['candidates'][0]['rank'] == 7
    assert resolve(RankingQuery(code='epl', name='Chelsea FC'), {'football-data-E0': snap})['candidates'][0]['points'] == 9


def test_event_comparison_joins_both_teams_and_calculates_deltas():
    snap = SimpleNamespace(
        rows=[
            {'name': 'Baltimore Ravens', 'rank': 2, 'rating': 91.5, 'points': 8},
            {'name': 'Buffalo Bills', 'rank': 5, 'rating': 88, 'points': 6},
        ],
        status='ready', checked_at=datetime.now(UTC), source_as_of='2026-09-16',
    )
    query = EventComparisonsQuery(events=[{
        'market_id': '123', 'event_slug': 'nfl-bal-buf-2026-09-16',
        'event_title': 'Baltimore Ravens vs. Buffalo Bills',
    }])
    comparison = event_comparisons(query, {'espn-nfl': snap})['comparisons']['123']
    assert comparison['code'] == 'nfl'
    assert comparison['tags'] == ['nfl']
    assert comparison['match_status'] == 'matched'
    assert comparison['ranking'] == {'team_a': 2, 'team_b': 5, 'delta': -3}
    assert comparison['rating'] == {'team_a': 91.5, 'team_b': 88, 'delta': 3.5}
    assert comparison['points'] == {'team_a': 8, 'team_b': 6, 'delta': 2}


def test_event_comparison_loads_only_relevant_connected_sources():
    query = EventComparisonsQuery(events=[
        {'market_id': '1', 'event_slug': 'epl-bre-che-2026-09-18', 'event_title': 'Brentford FC vs. Chelsea FC'},
        {'market_id': '2', 'event_slug': 'egy1-gem-zas-2026-09-16', 'event_title': 'Ghazl El Mahalla SC vs. Zamalek SC'},
    ])
    source_ids = _comparison_source_ids(query)
    assert 'football-data-E0' in source_ids
    assert 'espn-soccer-egy1' in source_ids
    assert 'espn-soccer-pol' in source_ids


def test_event_comparison_never_invents_values_for_unmatched_teams():
    query = EventComparisonsQuery(events=[{
        'market_id': '456', 'event_slug': 'bel1-a-b-2026-09-16',
        'event_title': 'Unknown A vs Unknown B',
    }])
    comparison = event_comparisons(query, {})['comparisons']['456']
    assert comparison['tags'] == ['bel1']
    assert comparison['match_status'] == 'unmatched'
    assert comparison['ranking'] is None


def test_soccer_standings_parser_preserves_rank_points_and_derives_rating():
    data = {
        'season': {'year': 2026},
        'children': [{
            'name': 'League table',
            'standings': {
                'season': 2026,
                'seasonDisplayName': '2026/27',
                'entries': [
                    {
                        'team': {'id': str(index), 'displayName': f'Team {index}'},
                        'stats': [
                            {'name': 'rank', 'value': index}, {'name': 'gamesPlayed', 'value': 4},
                            {'name': 'wins', 'value': 3}, {'name': 'ties', 'value': 0},
                            {'name': 'losses', 'value': 1}, {'name': 'points', 'value': 9},
                        ],
                    }
                    for index in range(1, 11)
                ],
            },
        }],
    }
    rows, _, season = parse_json(data, 'espn-soccer')
    assert season == '2026/27'
    assert rows[0]['rank'] == 1
    assert rows[0]['points'] == 9
    assert rows[0]['rating'] == 75


def test_cup_event_uses_unique_same_domestic_source_and_derives_rating():
    snap = SimpleNamespace(
        rows=[
            {'name': 'Everton', 'rank': 6, 'points': 7, 'played': 4},
            {'name': 'Wolves', 'rank': 12, 'points': 4, 'played': 4},
        ],
        status='ready', checked_at=datetime.now(UTC), source_as_of='2026-09-16',
    )
    query = EventComparisonsQuery(events=[{
        'market_id': 'efl-1', 'event_slug': 'efl-eve-wol-2026-09-17',
        'event_title': 'Everton FC vs Wolverhampton Wanderers FC',
    }])
    comparison = event_comparisons(query, {'football-data-E0': snap})['comparisons']['efl-1']
    assert comparison['match_status'] == 'matched'
    assert comparison['ranking'] == {'team_a': 6, 'team_b': 12, 'delta': -6}
    assert comparison['points'] == {'team_a': 7, 'team_b': 4, 'delta': 3}
    assert comparison['rating'] == {'team_a': 58.33, 'team_b': 33.33, 'delta': 25.0}
