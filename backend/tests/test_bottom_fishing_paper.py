from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from pydantic import ValidationError

from app.domains.bottom_fishing.engine import paper_cycle, roll
from app.domains.bottom_fishing.store import Settings
from app.domains.bottom_fishing.strategy import WEIGHTS, evaluate, exit_fill, quantity, support

ZONE = ZoneInfo("Asia/Kolkata")
T = datetime(2026,11,25,9,30,tzinfo=ZONE)


def pattern():
    bars = [dict(as_of=(T-timedelta(days=21-i)).isoformat(), low=104, high=108, close=106, volume=1000000)
            for i in range(20)]
    bars[1].update(high=125)
    bars[2].update(low=100)
    bars[5].update(high=120)
    bars[10].update(low=101)
    return dict(support(bars,.05), member=True, isin="INE000000001")


def candle(t,close,low=None):
    return dict(end=t.isoformat(),open=close,low=low or close,high=close,close=close)


def cycle(state,t,price,previous,*,settings=None,scan=None):
    frames = {"NSE:A":[candle(t-timedelta(minutes=5),previous),candle(t,price)],
              "NSE:NIFTYBEES":[candle(t,100)]}
    return paper_cycle(state,settings or Settings().model_dump(),t,{"NSE:A":pattern()} if scan else {},
                       frames,{"NSE:A":dict(roce=30,sales=30,profit=30,leverage=0)},100,scan,
                       {t.date().isoformat():t.isoformat()})


def test_source_isolation_and_morning_setup_survives_recovery():
    with pytest.raises(ValidationError):
        Settings(inputs=["swing"])
    s=cycle(roll({},T),T,101,102,scan={"covered":500})
    assert s["setups"]["NSE:A"]["discovery"]==101
    later=T.replace(hour=13,minute=15)
    s=cycle(s,later,105,104,scan={"covered":500})
    assert s["setups"]["NSE:A"]["discovered"]==T.isoformat()
    assert len(s["scans"])==2
    s=cycle(s,later+timedelta(minutes=5),99,105)
    assert s["rows"][0]["reason"]=="Support broken"


def test_risk_combines_pending_and_open_and_requires_fresh_crossing():
    assert quantity(100000,{"A":{"qty":100,"risk":10,"price":200}},
                    {"B":{"qty":20,"risk":10,"price":200}},200,8)==37
    setup=dict(pattern(),discovery=101)
    f=dict(roce=25,sales=25,profit=25,leverage=0)
    row=evaluate(setup,109,109,0,f,WEIGHTS)
    assert row["reason"]=="Waiting for fresh breakout"
    assert evaluate(setup,109,107,0,f,WEIGHTS)["reason"]=="Reward/risk below 2 after costs"


def test_empty_inputs_keep_existing_exit_and_gap_loss():
    s=roll({},T)
    s["positions"]["NSE:A"]=dict(qty=10,price=102,stop=99,target=115,entry=T.isoformat(),checked=T.isoformat())
    s=cycle(s,T+timedelta(minutes=5),95,102,settings=Settings(inputs=[]).model_dump())
    assert not s["rows"] and not s["positions"]
    assert s["closed"][0]["price"]==95 and s["realized"]< -70
    assert exit_fill(dict(stop=99,target=115),dict(low=98,high=116,open=102,close=114),False)==(99,"Stop")


def test_breakout_creates_only_one_paper_reservation_and_preserves_frozen_levels():
    s=roll({},T)
    setup=dict(pattern(),breakout=104.05,discovery=100,discovered=T.isoformat())
    s["setups"]["NSE:A"]=setup
    bar_time=T+timedelta(minutes=10)
    cycle(s,bar_time,104.1,103.5)
    assert s["rows"][0]["reason"]=="Paper limit pending"
    assert 0<s["pending"]["NSE:A"]["qty"]<=96
    cycle(s,bar_time,104.1,103.5)
    assert not s["pending"] and s["rows"][0]["reason"]=="Already held or attempted today"
    assert "score" not in evaluate(setup,104.1,103.5,0,None,WEIGHTS)


def test_closed_market_cutoff_and_proposal_preserve_paper_account():
    from copy import deepcopy
    from app.domains.bottom_fishing.review import candle_cutoff
    from app.domains.bottom_fishing.engine import size_entries

    assert candle_cutoff(T.replace(hour=21), [])[0] == T.replace(hour=15, minute=30)
    assert candle_cutoff(T.replace(minute=43), [])[0] == T.replace(minute=40)
    # Nov 24 is an exchange holiday, including before the open on Nov 25.
    assert candle_cutoff(T.replace(hour=7), [])[0] == T.replace(day=23, hour=15, minute=30)
    state = roll({}, T)
    state["pending"] = {"NSE:OLD":dict(price=100, qty=2, risk=5)}
    state["rows"] = [dict(symbol="NSE:A", reason="Qualified", price=104, risk=5)]
    before = deepcopy(state)
    size_entries(state, Settings().model_dump(), T.replace(hour=15,minute=30), preview=True)
    assert state["rows"][0]["reason"] == "Proposed buy" and state["rows"][0]["qty"] > 0
    for key in ("positions", "pending", "seen", "realized", "closed"):
        assert state[key] == before[key]


@pytest.mark.asyncio
async def test_legacy_queue_runs_all_four_stages_once_and_freezes_review(monkeypatch):
    import asyncio
    from contextlib import asynccontextmanager
    from types import SimpleNamespace
    from fastapi import HTTPException
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
    from app.domains.auth.models import User, ActivityLog
    from app.domains.bottom_fishing import review, store
    import app.models  # register relationships

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as conn:
        for table in [User.__table__, ActivityLog.__table__]:
            await conn.run_sync(table.create)
    owner = SimpleNamespace(id=5,username="owner")
    wake = asyncio.Event()
    http_request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(bottom_review_wake=wake)))
    async with sessions() as db:
        db.add(User(id=owner.id, username=owner.username, email="user@example.test", password_hash="test"))
        # Upgrade the actual previous request format, with no run id in its JSON.
        request = store.append(db,owner.id,store.MANUAL,dict(status="queued",requested_at=T.isoformat()))
        await db.commit()
        request_id = request.id

    @asynccontextmanager
    async def cache():
        yield object()

    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return T.replace(hour=20)
    stages_seen=[]
    async def calendar(*args): return []
    async def prepared(_client,_cache,stamp, discovery=None):
        assert stamp.hour==15 and stamp.minute==30
        return {"NSE:A":pattern()},100,dict(covered=500,universe=500)
    async def evidence(_client,_cache,guard,stamp,levels,state,coverage):
        coverage.update(patterns=1,current_candles=1)
        return {"NSE:A":[candle(stamp-timedelta(minutes=5),101),candle(stamp,102)],
                "NSE:NIFTYBEES":[candle(stamp,100)]},{"NSE:A":dict(roce=25,sales=25,profit=25,leverage=0)}
    def traced(func,name):
        async def wrapped(*args,**kwargs):
            stages_seen.append(name)
            return await func(*args,**kwargs)
        return wrapped
    monkeypatch.setattr(review.httpx,"AsyncClient",lambda **kwargs: cache())
    monkeypatch.setattr(review,"datetime",Clock)
    monkeypatch.setattr(review,"configured_for",lambda *args:True)
    monkeypatch.setattr("app.domains.zerodha.upstox_quotes.configured_for",lambda *args:True)
    monkeypatch.setattr(review,"redis_client",cache)
    monkeypatch.setattr(review.market,"calendar",calendar)
    async def kite(user_id):
        assert user_id == owner.id
        return {"captured_at": T.isoformat(), "holdings_count": 7, "holdings": []}
    monkeypatch.setattr(review,"sync_kite_portfolio",traced(kite,"kite"))
    monkeypatch.setattr(review,"prepared_market",traced(prepared,"sync"))
    monkeypatch.setattr(review,"collect_evidence",traced(evidence,"screen"))
    def trace_sync(func,name):
        def wrapped(*args,**kwargs):
            stages_seen.append(name)
            return func(*args,**kwargs)
        return wrapped
    monkeypatch.setattr(review,"paper_cycle",trace_sync(review.paper_cycle,"score"))
    monkeypatch.setattr(review,"size_entries",trace_sync(review.size_entries,"actionables"))
    async with sessions() as db:
        assert (await store.request_run(http_request,db,owner))["id"] == request_id
    assert wake.is_set()
    for _ in range(2):
        await review.drain_reviews(sessions)
    assert stages_seen == ["kite","sync","screen","score","actionables"]
    async with sessions() as db:
        data = await store.snapshot(db,owner.id)
        assert data["manual"]["status"] == "completed"
        assert data["review"]["state"]["kite_sync"]["holdings_count"] == 7
        assert data["state"] == {} and data["review"]["state"]["rows"][0]["score"] is not None
        assert data["review"]["state"]["pending"] == {} and not data["review"]["state"]["positions"]
        history = await store.history(None,db,owner)
        assert len(history["items"]) == 1
        key = history["items"][0]["id"]
        assert (await store.history_record(key,db,owner))["request_id"] == request_id
        with pytest.raises(HTTPException) as denied:
            await store.history_record(key,db,SimpleNamespace(id=6))
        assert denied.value.status_code == 404
        with pytest.raises(HTTPException) as conflict:
            await store.request_run(http_request,db,owner,store.RunInputs(version=9))
        assert conflict.value.status_code == 409
        again = await store.request_run(http_request,db,owner,store.RunInputs(version=0))
        assert again["id"] != request_id
        assert (await store.request_run(http_request,db,owner))["id"] == again["id"]
        assert (await db.scalars(select(ActivityLog).where(ActivityLog.action==store.CYCLE))).all() == []
        edited = await store.change(store.Change(version=0,screen_query="Current price > 10000"),db,owner)
        with pytest.raises(HTTPException) as active_conflict:
            await store.request_run(http_request,db,owner,store.RunInputs(version=edited["version"]))
        assert active_conflict.value.status_code == 409
    await review.drain_reviews(sessions)
    async with sessions() as db:
        view = await store.snapshot(db,owner.id)
        assert view["review"]["settings"]["screen_query"] == ""
        assert view["settings"]["screen_query"] == "Current price > 10000"
    await engine.dispose()

@pytest.mark.asyncio
async def test_manual_review_spaces_concurrent_candles_and_honors_shared_denials(monkeypatch):
    import asyncio
    from app.domains.bottom_fishing.review import ManualReviewQuoteGuard
    from app.domains.zerodha.upstox_quote_guard import QuoteGuard

    observed = []
    async def shared_admission(self):
        observed.append(asyncio.get_running_loop().time())
        return len(observed) != 2

    monkeypatch.setattr(QuoteGuard, "admit", shared_admission)
    monkeypatch.setattr(ManualReviewQuoteGuard, "interval", 0.01)
    guard = ManualReviewQuoteGuard(None, 1, "bottom-review", [])
    allowed = await asyncio.gather(*(guard.admit() for _ in range(5)))
    assert allowed == [True, False, True, True, True]
    assert all(later - earlier >= 0.009 for earlier, later in zip(observed, observed[1:]))


@pytest.mark.asyncio
async def test_scheduled_candle_and_exit_tick_use_local_service_once(monkeypatch):
    from contextlib import asynccontextmanager
    from unittest.mock import AsyncMock
    from app.domains.bottom_fishing import tasks

    cache = AsyncMock()
    cache.set.side_effect = [True, False, False, True]
    cache.exists.return_value = True

    @asynccontextmanager
    async def redis():
        yield cache

    advance = AsyncMock()
    monkeypatch.setattr(tasks, "redis_client", redis)
    monkeypatch.setattr(tasks, "advance", advance)
    sessions = object()
    await tasks.scheduled_owner(sessions, 42, T, T)
    await tasks.scheduled_owner(sessions, 42, T, T)
    await tasks.scheduled_owner(sessions, 42, T, T + timedelta(seconds=25))
    assert [item.args for item in advance.await_args_list] == [
        (sessions, 42, T.isoformat(), False),
        (sessions, 42, T.isoformat(), True),
    ]


@pytest.mark.asyncio
async def test_old_kite_review_restores_only_its_owners_exact_capture():
    from datetime import timedelta
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.domains.auth.models import User
    from app.domains.bottom_fishing.store import restore_kite_details
    from app.domains.zerodha.models import ZerodhaPortfolioSnapshot

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        for table in (User.__table__, ZerodhaPortfolioSnapshot.__table__):
            await conn.run_sync(table.create)
    async with async_sessionmaker(engine)() as db:
        db.add(ZerodhaPortfolioSnapshot(user_id=5, captured_at=T, snapshot_date=T.date(),
                                       holdings=[{"tradingsymbol":"TEST"}]))
        await db.commit()
        for owner, stamp, matches in [(5,T,True),(6,T,False),(5,T+timedelta(seconds=1),False)]:
            kite = {"captured_at":stamp.isoformat()}
            await restore_kite_details(db,owner,{"state":{"kite_sync":kite}})
            assert ("holdings" in kite) is matches
            if matches:
                assert kite["holdings"] == [{"tradingsymbol":"TEST"}]
    await engine.dispose()
