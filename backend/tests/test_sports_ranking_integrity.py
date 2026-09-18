import json
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.domains.sports_rankings.capture import annotate_candidates
from app.domains.sports_rankings.catalogue import CATALOGUE
from app.domains.sports_rankings.comparisons import _edition_current
from app.domains.sports_rankings.feeds import FEEDS
from app.domains.sports_rankings.football_tables import parse_fotmob
from app.domains.sports_rankings.polymarket_participants import clean_participant_name
from app.domains.sports_rankings.schemas import EventComparisonsQuery
from app.domains.sports_rankings.service import event_comparisons, ranking_rows

FIXTURE = json.loads((Path(__file__).parent / "fixtures/sports_rankings_2026_09_18.json").read_text())


def snapshots():
    return {source: SimpleNamespace(**{**deepcopy(data), "season": str(datetime.now(UTC).year)},
            checked_at=datetime.now(UTC), successful_at=datetime.now(UTC), status="ready", content_hash="fixture")
            for source, data in FIXTURE["snapshots"].items()}


def compare(code, title, snaps=None):
    return event_comparisons(EventComparisonsQuery(events=[dict(market_id="test", event_slug=f"{code}-test", event_title=title)]),
                             snapshots() if snaps is None else snaps)["comparisons"]["test"]


def test_all_97_audited_rows_have_both_ranks_without_cross_scope_deltas():
    result = event_comparisons(EventComparisonsQuery(events=FIXTURE["events"]), snapshots())
    assert result["coverage"]["total"] == 97
    assert len(result["coverage"]["tags"]) == 27
    assert result["coverage"]["statuses"] == {"VALID": 82, "NOT_COMPARABLE": 15}
    assert result["coverage"]["tags"]["uel"]["statuses"] == {"VALID": 23}
    for row in result["comparisons"].values():
        assert row["ranking"]["team_a"] is not None and row["ranking"]["team_b"] is not None
        if not row["comparable"]:
            assert all(row[metric]["delta"] is None for metric in ("ranking", "rating", "points"))
        for side in ("a", "b"):
            assert row["team_details"][side]["selected"]["snapshot_hash"] == "fixture"


def test_cup_fallback_cannot_select_chilean_everton():
    result = compare("efl", "Everton FC vs. Wolverhampton Wanderers FC")
    assert result["team_details"]["a"]["selected"]["source_id"] == "espn-soccer-epl"
    assert result["status_code"] == "NOT_COMPARABLE"


def test_provider_id_survives_name_change_and_rejects_replacement_identity():
    snaps = snapshots()
    row = next(r for r in snaps["espn-soccer-uel"].rows if r["name"] == "Real Sociedad")
    row.update(name="New provider display name", provider_aliases=[])
    result = compare("uel", "Real Sociedad de Fútbol vs. AFC Bournemouth", snaps)
    assert result["status_code"] == "VALID"
    assert result["team_a"] == "New provider display name"
    row["provider_id"] = "unrelated"
    assert compare("uel", "Real Sociedad de Fútbol vs. AFC Bournemouth", snaps)["status_code"] == "TEAM_UNMAPPED"


def test_duplicate_sources_are_selected_deterministically():
    snaps = snapshots()
    rows = deepcopy(snaps["espn-soccer-sea"].rows)
    snaps["football-data-I1"] = SimpleNamespace(rows=rows, status="ready", checked_at=datetime.now(UTC), season=str(datetime.now(UTC).year))
    result = compare("sea", "Sassuolo vs. Torino", snaps)
    assert result["status_code"] == "VALID"
    assert result["team_details"]["a"]["selected"]["source_id"] == "espn-soccer-sea"


def test_stale_and_failed_values_are_never_a_current_comparison():
    snaps = snapshots()
    snaps["fotmob-grc"].checked_at -= timedelta(hours=2)
    result = compare("grc", "AEK vs. MGS Panserraïkós", snaps)
    assert result["status_code"] == "STALE" and result["ranking"]["delta"] is None
    snaps["fotmob-grc"].checked_at = datetime.now(UTC)
    snaps["fotmob-grc"].status = "failed"
    assert compare("grc", "AEK vs. MGS Panserraïkós", snaps)["status_code"] == "FEED_FAILED"
    assert not _edition_current(SimpleNamespace(season="2020/2021"))


def test_exact_identity_does_not_merge_similar_clubs():
    rows = ranking_rows({"code": "grc", "participants": [{"name": "Panathinaikós AO", "aliases": []}]},
                        SimpleNamespace(rows=[{"name": "Panaitolikos", "rank": 1}]))
    assert rows[-1]["rank"] is None
    rows = ranking_rows({"code": "elc", "participants": [{"name": "Birmingham City FC", "aliases": []}]},
                        SimpleNamespace(rows=[{"name": "Bristol City", "rank": 1}]))
    assert rows[-1]["rank"] is None


@pytest.mark.parametrize("name", ["Real Racing Club - Exact Score", "Spain - Total Corners", "Norwich - First Team to Score"])
def test_market_descriptions_are_not_team_identities(name):
    assert clean_participant_name(name) is None


def test_frozen_capture_is_not_recomputed_on_resume():
    rows = [{"market_id": "1", "sports_event_slug": "nwsl-test", "sports_event_title": "Bay FC vs. Denver Summit FC"}]
    annotate_candidates(rows, snapshots())
    frozen = deepcopy(rows[0]["sports_ranking_at_scan"])
    annotate_candidates(rows, {})
    assert rows[0]["sports_ranking_at_scan"] == frozen
    assert frozen["view"] == "at_scan" and frozen["ranking"]["team_a"] is not None


def test_fotmob_validates_scope_and_preserves_official_deductions_and_groups():
    page = {"details": {"id": 10369, "country": "INT", "gender": "female", "selectedSeason": "2026", "latestSeason": "2026"},
            "table": [{"data": {"leagueId": 10369, "tables": [{"leagueName": "Group A", "table": {"all": [
                {"id": 1, "name": "Example U20", "idx": 1, "played": 1, "wins": 0, "draws": 0, "losses": 1, "pts": -3}
            ]}}]}}]}
    def body():
        return '<script id="__NEXT_DATA__">' + json.dumps({"props": {"pageProps": page}}) + '</script>'
    feed = {**FEEDS["fotmob-u20wwc"], "minimum": 1}
    rows, _, _ = parse_fotmob(body(), feed)
    assert rows[0]["points"] == -3 and rows[0]["group"] == "Group A"
    page["details"]["gender"] = "male"
    with pytest.raises(ValueError, match="gender mismatch"):
        parse_fotmob(body(), feed)


def test_audit_flags_capture_errors_and_cross_scope_delta_without_rewriting_evidence():
    from app.domains.bullpen_run_audit.validators import build_deterministic_findings
    evidence = [{"market_id": "1", "ranking": {"comparable": False, "ranking": {"delta": 3}}},
                {"market_id": "2", "capture_error": "DatabaseUnavailable"}]
    frozen = deepcopy(evidence)
    findings = build_deterministic_findings({"stage_1": {"sports_ranking_evidence": evidence}})
    assert any(f["code"] == "SPORTS_RANKING_EVIDENCE_INVALID" for f in findings)
    assert evidence == frozen
