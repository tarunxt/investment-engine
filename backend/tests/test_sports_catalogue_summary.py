from copy import deepcopy
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.encoders import jsonable_encoder
from fastapi.testclient import TestClient
import pytest

from app.domains.auth import dependencies as auth_dependencies
from app.domains.auth.dependencies import get_current_user
from app.domains.sports_rankings import providers, public_providers, router, tasks
from app.domains.sports_rankings.catalogue import CATALOGUE, augment_catalogue
from app.domains.sports_rankings.master import SPORTS
from app.domains.sports_rankings.service import ranking_rows, summary
from app.infrastructure.database.session import get_async_db


def without_events(payload):
    return {
        **payload,
        "competitions": [
            {key: value for key, value in competition.items() if key != "events"}
            for competition in payload["competitions"]
        ],
    }


@pytest.fixture
def passive_catalogue(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("Catalogue/detail reads must not fetch providers or queue work")

    monkeypatch.setattr(providers, "fetch_source", forbidden)
    monkeypatch.setattr(public_providers, "fetch_public", forbidden)
    for task in (tasks.refresh_source, tasks.dispatch_refresh,
                 tasks.rebuild_polymarket_participant_indexes, tasks.reconcile_cricket):
        for method in ("run", "delay", "apply_async"):
            monkeypatch.setattr(task, method, forbidden)

    now = datetime.now(UTC)
    snapshots = {
        source_id: SimpleNamespace(
            source_id=source_id, status=status, rows=rows, rows_type="array",
            ranked_count=len(rows), source_url="https://example.test/rankings",
            source_as_of="2026-10-03", season="2026", checked_at=checked_at,
            successful_at=now - timedelta(minutes=30), error=error,
        )
        for source_id, status, rows, checked_at, error in [
            ("valve-global", "ready", [{"name": "Spirit", "rank": 1, "points": 2000}], now, None),
            ("football-data-E0", "failed", [], now, "Retained source error"),
            ("espn-nfl", "ready", [{"name": "Fixture NFL", "rank": 2}], now - timedelta(hours=2), None),
        ]
    }
    registry = {
        "cs2": {
            "sport_id": "counter-strike",
            "participants": ["Spirit", "New CS2 team", "New CS2 TEAM", "draw"],
            "events": [{"slug": "cs2-fixture", "title": "Spirit vs New CS2 team"}] * 2,
        },
        "epl": {
            "participants": ["Manchester City FC", "New EPL team"],
            "events": [{"slug": "epl-fixture", "title": "Manchester City FC vs New EPL team"}],
        },
        "newfixtureleague": {
            "sport_id": "soccer", "participants": ["New fixture participant"],
            "events": [{"slug": "newfixtureleague-fixture", "title": "A vs B"}],
        },
        "unknownfixturesport": {
            "sport_id": "unrecognized-fixture-sport", "participants": ["Not guessed"],
            "events": [],
        },
    }
    calls = {"owners": [], "statements": [], "details": []}

    class FixtureDB:
        async def execute(self, statement):
            calls["statements"].append(statement)
            return SimpleNamespace(all=lambda: list(snapshots.values()))

        async def get(self, model, source_id):
            calls["details"].append(source_id)
            return snapshots.get(source_id)

    def load_index(user_id):
        calls["owners"].append(user_id)
        return registry

    monkeypatch.setattr(router, "load_participant_index", load_index)
    app = FastAPI()
    app.include_router(router.router)
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id=17)
    app.dependency_overrides[get_async_db] = FixtureDB
    with TestClient(app) as client:
        yield client, registry, snapshots, calls


def test_summary_is_opt_in_and_exactly_preserves_all_non_event_fields(passive_catalogue):
    client, registry, snapshots, calls = passive_catalogue
    catalogue_before, registry_before = deepcopy(CATALOGUE), deepcopy(registry)
    expected = jsonable_encoder({
        "schema_version": 3, "sports": SPORTS, "refresh_seconds": 900,
        "automatic_analysis_enabled": False,
        "competitions": [summary(item, snapshots.get(item["source_id"]))
                         for item in augment_catalogue(CATALOGUE, registry)],
    })
    full = client.get("/api/sports-rankings")
    explicit_full = client.get("/api/sports-rankings?view=full")
    compact = client.get("/api/sports-rankings?view=summary")
    assert full.status_code == explicit_full.status_code == compact.status_code == 200
    assert full.json() == explicit_full.json() == expected
    assert compact.json() == without_events(expected)
    assert len(compact.json()["competitions"]) == len(CATALOGUE) + 1
    assert all(response.headers["cache-control"] == "private, no-store"
               for response in (full, explicit_full, compact))
    assert calls["owners"] == [17, 17, 17]
    assert not calls["details"]
    assert CATALOGUE == catalogue_before and registry == registry_before


def test_compact_catalogue_does_not_change_selected_full_detail(passive_catalogue):
    client, registry, snapshots, calls = passive_catalogue
    current = augment_catalogue(CATALOGUE, registry)
    competition = next(item for item in current if item["code"] == "cs2")
    snapshot = snapshots[competition["source_id"]]
    expected = jsonable_encoder({
        **summary(competition, snapshot), "rows": ranking_rows(competition, snapshot),
    })
    before = client.get(f"/api/sports-rankings/competitions/{competition['id']}")
    compact = client.get("/api/sports-rankings?view=summary")
    after = client.get(f"/api/sports-rankings/competitions/{competition['id']}")
    assert before.status_code == compact.status_code == after.status_code == 200
    assert before.json() == after.json() == expected
    assert any(event["slug"] == "cs2-fixture" for event in after.json()["events"])
    assert any(row["name"] == "New CS2 team" and row["rank"] is None
               for row in after.json()["rows"])
    assert calls["details"] == [competition["source_id"], competition["source_id"]]
    assert client.get("/api/sports-rankings/competitions/missing-fixture").status_code == 404


def test_invalid_catalogue_view_is_rejected_before_reading(passive_catalogue):
    client, _, _, calls = passive_catalogue
    response = client.get("/api/sports-rankings?view=partial")
    assert response.status_code == 422
    assert calls["owners"] == calls["statements"] == calls["details"] == []


def test_summary_full_and_detail_retain_existing_authentication(passive_catalogue, monkeypatch):
    client, _, _, calls = passive_catalogue
    client.app.dependency_overrides.pop(get_current_user)
    monkeypatch.setattr(auth_dependencies, "is_auth_disabled", lambda: False)
    for path in ("", "?view=full", "?view=summary", "/competitions/epl"):
        response = client.get(f"/api/sports-rankings{path}")
        assert response.status_code == 401
        assert response.headers["www-authenticate"] == "Bearer"
    assert calls["owners"] == calls["statements"] == calls["details"] == []


def test_summary_and_detail_keep_dynamic_participants_scoped_to_current_owner(passive_catalogue, monkeypatch):
    client, _, _, _ = passive_catalogue
    owners = []

    def owned_index(user_id):
        owners.append(user_id)
        return {"ownedfixture": {
            "sport_id": "soccer", "participants": [f"Owner {user_id} participant"],
            "events": [{"slug": f"ownedfixture-{user_id}", "title": f"Owner {user_id} event"}],
        }}

    monkeypatch.setattr(router, "load_participant_index", owned_index)
    for owner in (17, 23, 17):
        client.app.dependency_overrides[get_current_user] = lambda owner=owner: SimpleNamespace(id=owner)
        compact = client.get("/api/sports-rankings?view=summary").json()
        card = next(item for item in compact["competitions"] if item["code"] == "ownedfixture")
        assert card["participants"] == [{"name": f"Owner {owner} participant", "aliases": []}]
        assert "events" not in card
        detail = client.get("/api/sports-rankings/competitions/polymarket-ownedfixture").json()
        assert detail["participants"] == card["participants"]
        assert detail["events"] == [{"slug": f"ownedfixture-{owner}", "title": f"Owner {owner} event"}]
        assert detail["rows"][0]["name"] == f"Owner {owner} participant"
    assert owners == [17, 17, 23, 23, 17, 17]


def test_summary_skips_seed_and_dynamic_event_iteration_but_keeps_all_participants():
    class UnreadableEvents(list):
        def __iter__(self):
            raise AssertionError("Summary must not iterate event payloads")

    seed = [{
        "id": "fixture", "code": "fixture", "source_id": None,
        "participants": [{"name": "Seed participant", "aliases": ["Seed alias"]}],
        "events": UnreadableEvents(), "custom_metadata": {"preserved": True},
    }]
    names = [f"Participant {index}" for index in range(2500)]
    registry = {
        "fixture": {"participants": names, "events": UnreadableEvents()},
        "newfixture": {"sport_id": "soccer", "participants": names, "events": UnreadableEvents()},
    }
    compact = augment_catalogue(seed, registry, include_events=False)
    assert len(compact) == 2
    assert all("events" not in item for item in compact)
    assert compact[0]["custom_metadata"] == seed[0]["custom_metadata"]
    assert compact[0]["participants"] == [seed[0]["participants"][0], *[
        {"name": name, "aliases": []} for name in names
    ]]
    assert compact[1]["participants"] == [{"name": name, "aliases": []} for name in names]


def test_summary_reduces_fanout_bytes_without_losing_any_card_or_participant(passive_catalogue):
    client, registry, _, _ = passive_catalogue
    registry["cs2"] = {
        "participants": [f"Synthetic team {index}" for index in range(300)],
        "events": [{"slug": f"cs2-synthetic-{index}", "title": f"Team {index} vs Other {index}"}
                   for index in range(2000)],
    }
    full = client.get("/api/sports-rankings")
    compact = client.get("/api/sports-rankings?view=summary")
    assert compact.json() == without_events(full.json())
    assert len(compact.content) < len(full.content) / 4
    full_cs2 = [card for card in full.json()["competitions"] if card["code"] == "cs2"]
    compact_cs2 = [card for card in compact.json()["competitions"] if card["code"] == "cs2"]
    assert len(compact_cs2) == len(full_cs2) == 12
    assert all(any(participant["name"] == "Synthetic team 299" for participant in card["participants"])
               for card in compact_cs2)
