from datetime import UTC, datetime
import pytest

from app.domains.sports_rankings.catalogue import CATALOGUE, SOURCE_IDS
from app.domains.sports_rankings.master import SPORTS, SPORT_BY_ID, CODE_REGISTRY
from app.domains.sports_rankings.classification import MatchCandidate, classify
from app.domains.sports_rankings.public_providers import parse_json, parse_html, validate


def test_all_requested_sports_are_represented_without_invented_codes():
    assert len(SPORTS) == len(SPORT_BY_ID) == 123
    assert {c['sport_id'] for c in CATALOGUE} == set(SPORT_BY_ID)
    for c in CATALOGUE:
        assert c['scope'] and c['reference_url'].startswith('https://')
        assert c['source_id'] is None or c['source_id'] in SOURCE_IDS
        if c['entry_kind'] == 'master_sport' and c['code']:
            assert c['code'] in CODE_REGISTRY
    assert SPORT_BY_ID['golf-match-play']
    assert SPORT_BY_ID['field-archery-teams']
    assert SPORT_BY_ID['pubg-h2h']
    assert SPORT_BY_ID['professional-wrestling']


def candidate(**changes):
    return MatchCandidate(**dict(dict(sport_id='soccer', participants=['Arsenal', 'Chelsea'], question='Arsenal vs Chelsea on 2026-09-14', market_type='moneyline', scope='match', period='full_match'), **changes))


def test_two_participants_not_two_outcomes():
    assert classify(candidate())['eligible']
    assert not classify(candidate(participants=['Yes', 'No']))['eligible']
    assert not classify(candidate(participants=['Arsenal', 'Arsenal']))['eligible']
    assert not classify(candidate(participants=['A', 'B', 'C']))['eligible']
    assert not classify(candidate(period=None))['eligible']
    assert not classify(candidate(scope='tournament'))['eligible']


@pytest.mark.parametrize('question', ['First half winner', 'Set 2 winner', 'Map 1 winner', 'First innings winner', 'Total goals over 2.5', 'Will Arsenal win 2-1?', 'Correct score', 'Handicap -1.5', 'Tournament winner'])
def test_excluded_market_questions(question):
    assert not classify(candidate(question=question))['eligible']


@pytest.mark.parametrize('sport', ['pubg-h2h', 'formula-1', 'horse-racing', 'golf-match-play', 'cycling', 'swimming', 'shooting-match-play'])
def test_multi_participant_sports_require_explicit_h2h(sport):
    assert not classify(candidate(sport_id=sport))['eligible']
    assert classify(candidate(sport_id=sport, explicit_head_to_head=True))['eligible']
    assert not classify(candidate(sport_id=sport, explicit_head_to_head=True, has_total=True))['eligible']


def test_espn_orders_only_within_groups_and_does_not_invent_preseason_rank():
    children=[]
    for group in ['East', 'West']:
        entries=[]
        for i in range(5):
            entries.append(dict(team=dict(id=f'{group}-{i}',displayName=f'{group} {i}'),stats=[dict(name='wins',value=0),dict(name='losses',value=0),dict(name='winPercent',value=0)]))
        children.append(dict(name=group,standings=dict(seasonDisplayName='2026-27',entries=entries)))
    rows, date, season = parse_json(dict(season=2027,children=children), 'espn')
    assert len(rows)==10 and all(r['rank'] is None for r in rows)
    assert date is None and season=='2026-27'


def test_conflicting_publisher_rows_are_rejected():
    rows=[dict(name=f'Team {i}',group='Men',rank=i+1,points=50-i) for i in range(10)]
    assert len(validate(rows+rows))==10
    with pytest.raises(ValueError,match='Conflicting'):
        validate(rows+[dict(rows[0],rank=8)])


def test_fide_rating_is_not_ranking_points_and_date_is_publication_month():
    body='<h2>Top 100 Players September 2026</h2><table class="top_recors_table">'+''.join(f'<tr><td>{i}</td><td>Player {i}</td><td>IND</td><td>{2800-i}</td></tr>' for i in range(1,11))+'</table>'
    rows,date,_=parse_html(body,'fide')
    assert date=='2026-09-01'
    assert rows[0]['rating']==2799 and rows[0]['points'] is None


def test_mens_hockey_feed_is_not_labelled_as_womens_rankings():
    from app.domains.sports_rankings.feeds import FEEDS
    assert "men's list" in FEEDS['fih-outdoor']['name']
    assert 'not inferred' in FEEDS['fih-outdoor']['note']
