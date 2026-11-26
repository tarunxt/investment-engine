import asyncio
from contextlib import asynccontextmanager
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.domains.scorecards import screener_library as library, screener_runs as runs
from test_auto_rebalance_audit_durability import audit_db, anyio_backend

OWNER = SimpleNamespace(id=7, username="owner")
OTHER = SimpleNamespace(id=8, username="other")
DEFINITION = dict(name="Value candidates", summary="Test positive prices.", query="Current price > 0")


@pytest.mark.anyio
async def test_two_boards_share_definitions_but_keep_assignments_and_owners_separate(audit_db):
    async with audit_db.sessions() as db:
        initial = await library.library(db, OWNER)
        assert initial["assigned"] == {"og": ["swing"], "bfs": ["bottom"]}
        created = await library.add(library.AddScreener(strategy="bfs", version=0, definition=DEFINITION), db, OWNER)
        key = created["assigned"]["bfs"][-1]
        assert created["assigned"]["og"] == ["swing"]
        assert created["screeners"][-1]["query"] == DEFINITION["query"]
        with pytest.raises(HTTPException, match="changed"):
            await library.add(library.AddScreener(strategy="og", version=0, existing=key), db, OWNER)
        assigned = await library.add(library.AddScreener(strategy="og", version=created["version"], existing=key), db, OWNER)
        assert assigned["assigned"]["og"] == ["swing", key]
        assert (await library.library(db, OWNER)) == assigned
        assert (await library.library(db, OTHER)) == initial
        with pytest.raises(HTTPException, match="unavailable"):
            await library.add(library.AddScreener(strategy="og", version=0, existing=key), db, OTHER)
        with pytest.raises(HTTPException, match="already exists"):
            await library.add(library.AddScreener(strategy="og", version=assigned["version"], definition=DEFINITION), db, OWNER)
    with pytest.raises(ValidationError, match="Unsupported"):
        library.Definition(**{**DEFINITION, "query": "unknown > 0"})


@pytest.mark.anyio
async def test_scan_queue_deduplicates_claims_and_reports_partial_matches_only_to_owner(audit_db, monkeypatch):
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(screener_wake=asyncio.Event())))
    monkeypatch.setattr(runs, "configured_for", lambda *args: True)
    async with audit_db.sessions() as db:
        board = await library.add(library.AddScreener(strategy="og", version=0, definition=DEFINITION), db, OWNER)
        key = board["assigned"]["og"][-1]
        assert await runs.request_run(key, request, db, OWNER) == {"status": "queued"}
        assert await runs.request_run(key, request, db, OWNER) == {"status": "queued"}
        with pytest.raises(HTTPException, match="unavailable"):
            await runs.request_run(key, request, db, OTHER)
    job = await runs.claim(audit_db.sessions)
    assert job and await runs.claim(audit_db.sessions) is None
    @asynccontextmanager
    async def cache():
        yield object()
    monkeypatch.setattr(runs, "redis_client", cache)
    monkeypatch.setattr(runs.httpx, "AsyncClient", lambda **kwargs: cache())
    monkeypatch.setattr(runs.market, "calendar", AsyncMock(return_value={}))
    stamp = datetime.fromisoformat("2026-11-26T15:30:00+05:30")
    monkeypatch.setattr(runs, "candle_cutoff", lambda *_: (stamp, {}))
    scanned = AsyncMock(return_value=(dict(rows=[dict(exchange="NSE",symbol="TEST",name="Test")], total=1,
                                         unknown=3, universe_size=10, complete=False), {}, None))
    monkeypatch.setattr(runs, "query_matches", scanned)
    await runs.execute(audit_db.sessions, *job)
    assert scanned.await_args.args[3] == {"screen_query": DEFINITION["query"], "latest_results": False}
    async with audit_db.sessions() as db:
        assert (await runs.result(key, db, OWNER))["report"]["total"] == 1
        assert (await runs.result(key, db, OWNER))["status"] == "partial"
        assert await runs.result(key, db, OTHER) is None
        assert await runs.claim(audit_db.sessions) is None
