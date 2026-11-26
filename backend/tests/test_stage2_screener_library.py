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


@pytest.mark.anyio
async def test_card_specific_runs_are_owned_frozen_and_used_by_the_scorecard(audit_db, monkeypatch):
    from datetime import datetime, timezone
    from app.domains.bottom_fishing import store, score_inputs
    from app.domains.scorecards import screener_inputs as inputs, screener_manifest, router, storage
    from app.domains.zerodha.models import ZerodhaPortfolioSnapshot
    from app.domains.auth.models import ActivityLog
    import json

    stamp = datetime(2026, 11, 26, 10, tzinfo=timezone.utc)
    async with audit_db.engine.begin() as conn:
        await conn.run_sync(ZerodhaPortfolioSnapshot.__table__.create)
    async with audit_db.sessions() as db:
        board = await library.add(library.AddScreener(strategy="og", version=0, definition=DEFINITION), db, OWNER)
        key = board["assigned"]["og"][-1]
        await library.add(library.AddScreener(strategy="bfs", version=board["version"], existing=key), db, OWNER)
        ids = []
        for index in range(6):
            report = dict(rows=[dict(symbol=f"TEST{index}",name="Test",exchange="NSE")],total=1)
            record = ActivityLog(user_id=7, resource_type=key, action=runs.FINISHED, details=json.dumps(dict(status="completed",report=report)))
            db.add(record)
            await db.flush()
            ids.append(record.id)
        state = (await inputs.inputs("og","technical",db,OWNER))["groups"][-1]
        assert [r["id"] for r in state["runs"]] == list(reversed(ids[1:]))
        assert state["automatic"] and state["selected"] == [ids[-1]]
        change = inputs.Selection(version=0,selected={key:ids[1:3], "swing":[]})
        await inputs.save_inputs("og","technical",change,db,OWNER)
        with pytest.raises(HTTPException,match="changed"):
            await inputs.save_inputs("og","technical",change,db,OWNER)
        with pytest.raises(HTTPException,match="available"):
            await inputs.save_inputs("og","technical",inputs.Selection(version=0, selected={key:[ids[-1]]}),db,OTHER)
        await inputs.save_inputs("bfs","bottom",inputs.Selection(version=0,selected={key:[ids[1]],"bottom":[]}),db,OWNER)
        bfs = await score_inputs.plan(db,7,store.Settings().model_dump())
        assert not bfs["current"] and bfs["sources"] == {"NSE:TEST1":[key]}
        assert score_inputs.apply_candidates({"score_inputs":bfs},{"NSE:NATIVE"},{"NSE:TEST1":1,"NSE:NATIVE":2}) == {"NSE:TEST1":1}
        snap = ZerodhaPortfolioSnapshot(user_id=7,captured_at=stamp,snapshot_date=stamp.date(),holdings_count=1,
            holdings=[dict(exchange="NSE",tradingsymbol="HELD",quantity=2,last_price=100)])
        db.add(snap)
        await db.commit()
        publication = router.Publication(sequence=42, request_key="test", captured_at=stamp,
            use_screeners=True, snapshot_id=snap.id, swing_job_ids=[])
        wf = await router.workflow(db,7,"india",42)
        manifest = await screener_manifest.publish_with_screeners(db,7,wf,publication)
        doc = await storage.append(db,wf.id,"revision","test-freeze",dict(manifest=manifest,digest="test"))
        await db.commit()
        def listings(view): return [row["listing"] for row in view["stocks"]]
        assert listings((await router.detail("india",doc.id,db,OWNER,card="technical"))["manifest"]) == ["NSE:HELD","NSE:TEST1","NSE:TEST2"]
        for card in ("rebalance","pairwise","threats"):
            assert listings((await storage.lookup(db,7,"india","revision",doc.id,card=card)).manifest) == ["NSE:HELD","NSE:TEST5"]
        prior = (await inputs.inputs("og","technical",db,OWNER))["version"]
        await inputs.save_inputs("og","technical",inputs.Selection(version=prior,selected={key:[]}),db,OWNER)
        assert listings((await storage.lookup(db,7,"india","revision",doc.id,card="technical")).manifest) == ["NSE:HELD","NSE:TEST1","NSE:TEST2"]
        newer = await screener_manifest.refresh(db,OWNER,doc.id)
        assert newer != doc.id and listings((await storage.lookup(db,7,"india","revision",newer,card="technical")).manifest) == ["NSE:HELD"]
