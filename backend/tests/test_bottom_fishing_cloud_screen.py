from datetime import datetime
from unittest.mock import AsyncMock

import pytest

from app.domains.bottom_fishing import cloud_screen, store


def test_cloud_universe_is_independent_of_index_and_deduplicates():
    ordinary = {"isin":"INE179A01014","series":"EQ"}
    assert cloud_screen.listings({"BSE:A":ordinary, "NSE:A":ordinary,
                                 "BSE:ONLY":{"isin":"INE121A01024","series":"A"},
                                 "NSE:BOND":{"isin":"INE179A07020","series":"EQ"}}) == ["NSE:A","BSE:ONLY"]


@pytest.mark.asyncio
async def test_cloud_scans_query_before_discovery_and_removes_old_matches(monkeypatch):
    stamp = datetime(2026,11,26,14,45,tzinfo=cloud_screen.INDIA)
    master = {"NSE:FIRST":{"isin":"INE179A01014","series":"EQ","name":"First"},
              "NSE:SECOND":{"isin":"INE121A01024","series":"EQ","name":"Second"}}
    monkeypatch.setattr(cloud_screen, "technical_instruments", AsyncMock(return_value=master))
    quotes = {"NSE_EQ|INE179A01014":{"price":120}, "NSE_EQ|INE121A01024":{"price":80}}
    monkeypatch.setattr(cloud_screen,"quotes",AsyncMock(return_value=quotes))
    async def daily(client,cache,stamp,rows,discovery=None):
        for row in rows:
            row.update(universe=False,low=90,high=200,liquidity=True,touches=True,rebound=True)
        return {}, None, {"universe": 2, "covered": 2}
    monkeypatch.setattr(cloud_screen.market,"daily",daily)
    monkeypatch.setattr(cloud_screen.market,"candles",AsyncMock(return_value=[]))
    async def scan():
        return await cloud_screen.scan(None,AsyncMock(),1,store.Settings(screen_query="Current price > 100").model_dump(),stamp,{"2026-11-25":""})
    first = await scan()
    assert [r["symbol"] for r in first["original_results"]["rows"]] == ["FIRST"]
    assert first["score_status"] == "completed" and first["at"] == stamp.isoformat() and first["rows"] == []
    quotes["NSE_EQ|INE179A01014"]["price"] = 99
    quotes["NSE_EQ|INE121A01024"]["price"] = 101
    assert [r["symbol"] for r in (await scan())["original_results"]["rows"]] == ["SECOND"]


@pytest.mark.asyncio
@pytest.mark.parametrize("missing_facts", [False, True])
async def test_score_consumes_verified_screen_candles_and_keeps_missing_evidence(monkeypatch, missing_facts):
    from app.domains.bottom_fishing import cloud_score, market

    stamp = datetime(2026,11,26,14,45,tzinfo=cloud_screen.INDIA)
    settings = store.Settings(screen_query="Current price > 100").model_dump()
    report = dict(complete=False, unknown=1, rows=[dict(exchange="NSE", symbol="A"), dict(exchange="BSE", symbol="X")])
    level = dict(low=100, high=125, width=25, stop=97.5, target=122.5, breakout=109,
                 previous=105, tick=.05, member=True, bounce=.9, turnover=20_000_000)
    async def daily(client, cache, cutoff, rows, discovery=None):
        rows[0].update(universe=True, liquidity=True, touches=True, rebound=True, low=100, high=125)
        return {"NSE:A":level}, 100, {"universe":2,"covered":1}

    candles = AsyncMock(return_value=[{"end":stamp.isoformat(), "close":102}])
    monkeypatch.setattr(market, "daily", daily)
    monkeypatch.setattr(market, "candles", candles)
    monkeypatch.setattr(market, "facts", AsyncMock(return_value=None if missing_facts else
                                                  dict(roce=25, sales=25, profit=25, leverage=.2)))
    state = await cloud_score.finish_screen(None,None,None,{"NSE:A":"stock",market.BENCH:"benchmark"},
                                            settings,stamp,{},report,{})
    assert state["original_results"] is report and report["rows"][0]["proximity"] is True
    assert state["screen_status"] == "partial" and state["scored_at"]
    assert [r["symbol"] for r in state["rows"]] == ["NSE:A"]
    assert [call.args[1] for call in candles.await_args_list] == ["benchmark","stock"]
    row = state["rows"][0]
    if missing_facts:
        assert state["score_status"] == "partial" and row["reason"].startswith("Missing ")
        assert set(row["points"]) == {"bounce", "proximity", "strength", "recovery"}
        assert "ROCE" in row["reason"]
        assert "score" not in row
    else:
        assert state["score_status"] == "completed" and len(row["points"]) == 8
    assert not state["pending"]


@pytest.mark.asyncio
async def test_cloud_refresh_persists_pair_once_and_manual_reuses_only_exact_result(monkeypatch):
    from contextlib import asynccontextmanager
    from types import SimpleNamespace
    from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
    from app.domains.auth.models import User, ActivityLog
    from app.domains.bottom_fishing import review
    import app.models

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as conn:
        for table in (User.__table__, ActivityLog.__table__):
            await conn.run_sync(table.create)
    owner = SimpleNamespace(id=5, username="owner")
    settings = store.Settings(screen_query="Current price > 100").model_dump()
    stamp = datetime(2026,11,26,14,45,tzinfo=cloud_screen.INDIA)
    async with sessions() as db:
        db.add(User(id=5, username="owner", email="owner@example.test", password_hash="x"))
        config = store.append(db, 5, store.CONFIG, settings)
        await db.commit()
        version = config.id
    @asynccontextmanager
    async def cache():
        redis = AsyncMock()
        redis.exists.return_value = False
        yield redis
    monkeypatch.setattr(cloud_screen, "redis_client", cache)
    monkeypatch.setattr(cloud_screen.httpx, "AsyncClient", lambda **kwargs: cache())
    monkeypatch.setattr(cloud_screen, "configured_for", lambda *args: True)
    monkeypatch.setattr(cloud_screen.market, "calendar", AsyncMock(return_value={}))
    monkeypatch.setattr(cloud_screen, "candle_cutoff", lambda *args:(stamp, {}))
    monkeypatch.setattr(cloud_screen, "query_matches", AsyncMock(return_value=(
        dict(complete=True, unknown=0, rows=[], source="Cred-X cloud"), {}, None)))
    await cloud_screen.refresh(sessions, 5)
    await cloud_screen.refresh(sessions, 5)
    assert cloud_screen.query_matches.await_count == 1
    async with sessions() as db:
        snapshot = await store.snapshot(db,5)
        paired = snapshot["live"]["state"]
        history = await store.history(None,db,owner,True,True)
        assert len(history["items"]) == 1 and history["items"][0]["scored"] == 0
        assert (await store.history_record(history["items"][0]["id"],db,owner))["state"] == paired
        assert not snapshot["state"] and paired["at"] == stamp.isoformat()
        assert paired["screen_status"] == paired["score_status"] == "completed"
    scan = AsyncMock(return_value={"fresh":True})
    monkeypatch.setattr(cloud_screen, "scan", scan)
    args = (sessions, 5, version, settings, None, None)
    assert await review.review_cloud_score(*args,stamp,{}, {}) == paired
    scan.assert_not_awaited()
    assert await review.review_cloud_score(*args,stamp.replace(minute=50),{}, {}) == {"fresh":True}
    assert await review.review_cloud_score(sessions, 5, version+1, settings, None, None,stamp,{}, {}) == {"fresh":True}
    assert scan.await_count == 2
    # Once the final session candle has a saved automatic attempt, a partial
    # result must survive restarts without unbounded overnight provider calls.
    class AfterClose(datetime):
        @classmethod
        def now(cls, tz=None):
            return stamp.replace(hour=19, minute=0)
    monkeypatch.setattr(cloud_screen, "datetime", AfterClose)
    close = stamp.replace(hour=15, minute=30)
    monkeypatch.setattr(cloud_screen, "candle_cutoff", lambda *args: (close, {close.date().isoformat(): close.isoformat()}))
    scan.reset_mock()
    scan.return_value = dict(market_as_of=close.isoformat(), status="partial", score_status="partial")
    await cloud_screen.refresh(sessions, 5)
    await cloud_screen.refresh(sessions, 5)
    assert scan.await_count == 1
    async with sessions() as db:
        store.append(db, 5, cloud_screen.columns.PREF, ["Sales"])
        await db.commit()
    await cloud_screen.refresh(sessions, 5)
    assert scan.await_count == 2
    await engine.dispose()


@pytest.mark.asyncio
@pytest.mark.parametrize("returned_date,expected", [("2026-11-26", 295.33), ("2026-11-25", None)])
async def test_benchmark_fallback_accepts_only_the_previous_session(monkeypatch, returned_date, expected):
    from unittest.mock import AsyncMock
    import httpx
    from app.domains.bottom_fishing import market

    monkeypatch.setenv("UPSTOX_ANALYTICS_TOKEN", "test")
    def serve(request):
        assert request.url.path.endswith("/days/1/2026-11-26/2026-11-26")
        candle = [returned_date+"T00:00:00+05:30", 294, 296, 293, 295.33, 1050]
        return httpx.Response(200, json={"data":{"candles":[candle]}})
    cache, guard = AsyncMock(), AsyncMock()
    cache.get.return_value = None
    guard.admit.return_value = True
    async with httpx.AsyncClient(transport=httpx.MockTransport(serve)) as client:
        result = await market.previous_session_close(client, cache, guard, "NSE_EQ|INF204KB14I2", "2026-11-26")
    assert result == expected
    assert cache.set.await_count == int(expected is not None)


@pytest.mark.asyncio
async def test_verified_fundamentals_are_reused_without_a_new_fetch():
    import json
    from unittest.mock import AsyncMock
    from app.domains.bottom_fishing import issuer

    verified = {"quarter":"Sep 2026", "sales":9, "profit":0, "roce":12, "leverage":0}
    cache = AsyncMock()
    cache.get.return_value = json.dumps(verified)
    assert await issuer.facts(None, cache, "NSE:TEST") == verified
    cache.get.assert_awaited_once_with("bottom:verified-financials:v1:NSE:TEST")
