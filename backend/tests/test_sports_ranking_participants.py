from datetime import UTC, datetime
from types import SimpleNamespace

from app.domains.sports_rankings.catalogue import CATALOGUE, augment_catalogue, augment_competition
from app.domains.sports_rankings.polymarket_participants import SportsParticipantCollector
from app.domains.sports_rankings.schemas import EventComparisonsQuery, RankingQuery
from app.domains.sports_rankings.service import event_comparisons, ranking_rows, resolve


def sports_market(*, code, title, question, sports_market_type="moneyline"):
    return SimpleNamespace(
        theme="Sports",
        event_slug=f"{code}-aaa-bbb-2026-09-18",
        question=question,
        raw={
            "sportsMarketType": sports_market_type,
            "feeType": "sports_fees_v2",
            "_export_event": {
                "slug": f"{code}-aaa-bbb-2026-09-18",
                "title": title,
                "category": "Sports",
                "tags": [{"label": "Soccer"}],
            },
        },
    )


def snapshot(rows):
    return SimpleNamespace(
        rows=rows,
        status="ready",
        checked_at=datetime.now(UTC),
        source_as_of="2026-09-16",
    )


def test_universal_scan_collects_every_team_by_competition_code():
    collector = SportsParticipantCollector()
    collector.add(sports_market(
        code="lal",
        title="Real Racing Club vs. FC Barcelona",
        question="Will Real Racing Club win on 2026-09-18?",
    ))
    collector.add(sports_market(
        code="uel",
        title="Nottingham Forest FC vs. Real Betis Balompié",
        question="Will Nottingham Forest FC win on 2026-09-18?",
    ))
    payload = collector.payload(export_id="scan-1")

    assert payload["codes"]["lal"]["participants"] == ["FC Barcelona", "Real Racing Club"]
    assert payload["codes"]["uel"]["participants"] == [
        "Nottingham Forest FC", "Real Betis Balompié"
    ]
    assert payload["codes"]["uel"]["sport_id"] == "soccer"


def test_current_scan_adds_previously_unlisted_tournament_code():
    current = augment_catalogue(CATALOGUE, {
        "ucl": {
            "sport_id": "soccer",
            "participants": ["FC Barcelona", "Paris Saint-Germain FC"],
            "events": [{
                "slug": "ucl-bar-psg-2026-09-18",
                "title": "FC Barcelona vs. Paris Saint-Germain FC",
            }],
        }
    })
    competition = next(item for item in current if item["code"] == "ucl")

    assert competition["id"] == "polymarket-ucl"
    assert competition["sport_id"] == "soccer"
    assert [participant["name"] for participant in competition["participants"]] == [
        "FC Barcelona", "Paris Saint-Germain FC"
    ]


def test_college_football_tag_is_not_misclassified_as_soccer():
    market = sports_market(
        code="ncaaf",
        title="Ohio State Buckeyes vs. Michigan Wolverines",
        question="Will Ohio State Buckeyes win on 2026-09-18?",
    )
    market.raw["_export_event"]["tags"] = [{"label": "College Football"}]
    collector = SportsParticipantCollector()
    collector.add(market)

    assert collector.payload()["codes"]["ncaaf"]["sport_id"] == "american-football"


def test_real_racing_club_is_imported_and_maps_to_santander():
    competition = next(item for item in CATALOGUE if item["id"] == "lal")
    augmented = augment_competition(competition, {
        "lal": {
            "participants": ["Real Racing Club"],
            "events": [{
                "slug": "lal-rac-bar-2026-09-18",
                "title": "Real Racing Club vs. FC Barcelona",
            }],
        }
    })
    snap = snapshot([
        {"name": "Santander", "rank": 10, "points": 7, "played": 5},
        {"name": "Barcelona", "rank": 1, "points": 15, "played": 5},
    ])
    rows = ranking_rows(augmented, snap)
    santander = next(row for row in rows if row["name"] == "Santander")

    assert santander["imported_names"] == ["Real Racing Club"]
    result = resolve(
        RankingQuery(code="lal", name="Real Racing Club"),
        {"football-data-SP1": snap},
        [augmented],
    )
    assert result["match_status"] == "matched"
    assert result["candidates"][0]["name"] == "Santander"


def test_real_racing_event_comparison_uses_santander_metrics():
    competition = next(item for item in CATALOGUE if item["id"] == "lal")
    snap = snapshot([
        {"name": "Santander", "rank": 10, "points": 7, "played": 5},
        {"name": "Barcelona", "rank": 1, "points": 15, "played": 5},
    ])
    query = EventComparisonsQuery(events=[{
        "market_id": "lal-1",
        "event_slug": "lal-rac-bar-2026-09-18",
        "event_title": "Real Racing Club vs. FC Barcelona",
    }])
    comparison = event_comparisons(
        query,
        {"football-data-SP1": snap},
        [competition],
    )["comparisons"]["lal-1"]

    assert comparison["match_status"] == "matched"
    assert comparison["team_a"] == "Santander"
    assert comparison["ranking"] == {"team_a": 10, "team_b": 1, "delta": 9}
    assert comparison["points"] == {"team_a": 7, "team_b": 15, "delta": -8}


def test_scope_guard_never_maps_mens_team_to_women_or_academy():
    competition = {
        "id": "scope-test", "code": "scope", "name": "Scope", "source_id": "scope-source",
        "sport_id": "soccer", "participants": [], "events": [],
    }
    snap = snapshot([
        {"name": "Manchester City WFC", "rank": 1},
        {"name": "Manchester City Academy", "rank": 2},
    ])

    assert resolve(RankingQuery(code="scope", name="Manchester City FC"), {"scope-source": snap}, [competition])["candidates"] == []
