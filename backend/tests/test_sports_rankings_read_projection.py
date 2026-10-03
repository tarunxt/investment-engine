from datetime import UTC, datetime, timedelta
import json
from types import SimpleNamespace

from fastapi import Response
import pytest
from sqlalchemy import MetaData, create_engine, null, select
from sqlalchemy.dialects import postgresql, sqlite
from sqlalchemy.orm import Session

import app.models  # noqa: F401 - register mapped relationship targets
from app.domains.sports_rankings import providers, public_providers, router, tasks
from app.domains.sports_rankings.catalogue import augment_catalogue
from app.domains.sports_rankings.models import SportsRankingSnapshot
from app.domains.sports_rankings.read_projection import snapshot_summaries_query
from app.domains.sports_rankings.service import ranking_rows, summary


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def forbid_external_work(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("Passive rankings reads must not call providers or tasks")

    monkeypatch.setattr(providers, "fetch_source", forbidden)
    monkeypatch.setattr(public_providers, "fetch_public", forbidden)
    for task in (tasks.refresh_source, tasks.dispatch_refresh,
                 tasks.rebuild_polymarket_participant_indexes, tasks.reconcile_cricket):
        monkeypatch.setattr(task, "apply_async", forbidden)
        monkeypatch.setattr(task, "delay", forbidden)
        monkeypatch.setattr(task, "run", forbidden)


def test_catalogue_query_projects_only_metadata_and_count_on_both_dialects():
    statement = snapshot_summaries_query()
    assert set(statement.selected_columns.keys()) == {
        "source_id", "status", "source_url", "source_as_of", "season",
        "checked_at", "successful_at", "error", "rows_type", "ranked_count",
    }
    for dialect in (postgresql.dialect(), sqlite.dialect()):
        query = str(statement.compile(dialect=dialect, compile_kwargs={"literal_binds": True}))
        type_function = "json_typeof" if dialect.name == "postgresql" else "json_type"
        assert f"CASE WHEN ({type_function}(sports_ranking_snapshots.rows) = 'array')" in query
        assert "THEN json_array_length(sports_ranking_snapshots.rows) ELSE 0 END AS ranked_count" in query
        assert query.count("sports_ranking_snapshots.rows") == 3
        assert "content_hash" not in query
        assert "LIMIT" not in query


class LocalAsyncSession:
    """Awaitable adapter over an isolated in-memory SQLite fixture."""

    def __init__(self, session):
        self.session = session
        self.statements = []
        self.gets = []

    async def execute(self, statement):
        self.statements.append(statement)
        return self.session.execute(statement)

    async def get(self, model, identity):
        self.gets.append(identity)
        return self.session.get(model, identity)


@pytest.mark.anyio
@pytest.mark.parametrize("view", ["full", "summary"])
async def test_catalogue_nulls_and_non_array_payloads_cannot_fail_array_count(
    monkeypatch, forbid_external_work, view,
):
    def forbidden_decode(value):
        raise AssertionError("Projection must not transfer or decode ranking JSON")

    engine = create_engine("sqlite://", json_deserializer=forbidden_decode)
    table = SportsRankingSnapshot.__table__.to_metadata(MetaData())
    # A nullable local copy verifies defensive SQL NULL behavior without any
    # production model/schema change. JSON null needs no nullable SQL column.
    table.c.rows.nullable = True
    table.create(engine)
    cases = {
        "sql-null": (null(), 0), "json-null": (None, 0), "empty": ([], 0),
        "array": ([{"name": "A"}, {"name": "B"}], 2),
        "object": ({"name": "Not a ranking array"}, 0),
        "string": ("Not ranking rows", 0), "number": (7, 0), "boolean": (True, 0),
    }
    now = datetime.now(UTC)
    with engine.begin() as connection:
        for source_id, (value, _) in cases.items():
            connection.execute(table.insert().values(
                source_id=source_id, rows=value, status="ready", checked_at=now,
                error="Existing source error" if source_id == "object" else None,
                source_as_of="2026-10-02",
            ))
    monkeypatch.setattr(router, "CATALOGUE", [
        {"id": source_id, "code": source_id, "source_id": source_id,
         "name": source_id, "participants": [], "events": []}
        for source_id in cases
    ])
    monkeypatch.setattr(router, "load_participant_index", lambda user_id: {})
    with Session(engine) as session:
        result = await router.catalogue(Response(), LocalAsyncSession(session), SimpleNamespace(id=17), view=view)
    assert {row["source_id"]: row["ranked_count"] for row in result["competitions"]} == {
        source_id: count for source_id, (_, count) in cases.items()
    }
    for row in result["competitions"]:
        assert "rows_type" not in row
        assert row["source_as_of"] == "2026-10-02"
        if row["source_id"] in {"empty", "array"}:
            assert row["status"] == "ready" and row["error"] is None
        else:
            assert row["status"] == "unavailable"
            assert "Stored ranking payload is not a JSON array" in row["error"]
    invalid_object = next(row for row in result["competitions"] if row["source_id"] == "object")
    assert invalid_object["error"].startswith("Existing source error; ")
    with Session(engine) as session:
        stored = session.execute(select(table.c.source_id, table.c.status, table.c.error)).all()
    assert all(row.status == "ready" for row in stored)
    assert next(row.error for row in stored if row.source_id == "object") == "Existing source error"
    engine.dispose()


@pytest.mark.anyio
async def test_catalogue_matches_full_summaries_without_decoding_rows_and_detail_is_complete(
    monkeypatch, forbid_external_work,
):
    decoded = []

    def decode(value):
        decoded.append(len(value))
        return json.loads(value)

    engine = create_engine("sqlite://", json_deserializer=decode)
    SportsRankingSnapshot.__table__.create(engine)
    now = datetime.now(UTC)
    saved = [
        SportsRankingSnapshot(
            source_id="football-data-E0", status="ready",
            rows=[{"name": f"Team {i}", "rank": i + 1, "points": 9000 - i,
                   "evidence": "fixture-only" * 50} for i in range(3000)],
            source_url="https://example.test/table", source_as_of="2026-10-02",
            season="2026/27", checked_at=now, successful_at=now,
        ),
        SportsRankingSnapshot(source_id="valve-global", status="failed", rows=[],
                             error="Source unavailable", checked_at=now),
        SportsRankingSnapshot(source_id="old-source", status="ready", rows=[{"name": "Old", "rank": 1}],
                             checked_at=now - timedelta(hours=2)),
    ]
    seed = [
        {"id": key, "code": key, "source_id": source, "name": key,
         "participants": [{"name": "Team 0", "aliases": []}], "events": []}
        for key, source in [
            ("ranked", "football-data-E0"), ("shared", "football-data-E0"),
            ("failed", "valve-global"), ("stale", "old-source"),
            ("pending", "missing-source"), ("unavailable", None),
        ]
    ]
    index = {"ranked": {"participants": ["New participant"], "events": [
        {"slug": "ranked-new-team", "title": "New participant vs Team 0"},
    ]}, "newcode": {"sport_id": "soccer", "participants": ["New code team"], "events": []}}
    owners = []
    monkeypatch.setattr(router, "CATALOGUE", seed)
    monkeypatch.setattr(router, "load_participant_index", lambda user_id: owners.append(user_id) or index)
    augmented = augment_catalogue(seed, index)
    with Session(engine, expire_on_commit=False) as session:
        session.add_all(saved)
        session.commit()
        session.expunge_all()
        full = {row.source_id: row for row in session.scalars(select(SportsRankingSnapshot))}
        expected = [summary(item, full.get(item["source_id"])) for item in augmented]
        expected_detail = {**expected[0], "rows": ranking_rows(augmented[0], full["football-data-E0"])}
        session.expunge_all()
        decoded.clear()
        db = LocalAsyncSession(session)
        response = Response()
        result = await router.catalogue(response, db, SimpleNamespace(id=17))
        assert result["competitions"] == expected
        assert result["schema_version"] == 3
        assert result["automatic_analysis_enabled"] is False
        assert response.headers["Cache-Control"] == "private, no-store"
        assert owners == [17]
        assert len(db.statements) == 1 and not db.gets
        assert not decoded
        assert [row["status"] for row in result["competitions"][:6]] == [
            "ready", "ready", "failed", "stale", "pending", "unavailable",
        ]
        detail_response = Response()
        detail = await router.competition("ranked", detail_response, db, SimpleNamespace(id=17))
        assert detail == expected_detail
        assert len(detail["rows"]) == 3001
        assert detail["ranked_count"] == 3000
        assert db.gets == ["football-data-E0"] and len(decoded) == 1
        assert owners == [17, 17]
        assert detail_response.headers["Cache-Control"] == "private, no-store"
    engine.dispose()
