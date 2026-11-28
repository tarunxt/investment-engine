from datetime import datetime
from unittest.mock import AsyncMock, Mock

import pytest

from app.domains.bottom_fishing import cloud_score, market, store
from app.domains.bottom_fishing.engine import roll


@pytest.mark.asyncio
@pytest.mark.parametrize("carried", [False, True])
async def test_custom_selection_preserves_missing_candle_and_rejects_changed_issuer(monkeypatch, carried):
    stamp = datetime(2026, 11, 26, 15, 30, tzinfo=market.INDIA)
    key = "NSE:TEST"
    settings = store.Settings().model_dump()
    settings["score_inputs"] = dict(current=False, sources={key: ["custom"]},
                                    runs={"custom": [101]}, fingerprint="fixture")
    previous = roll({}, stamp)
    if carried:
        previous["setups"][key] = dict(isin="OLD", member=True, discovered=stamp.isoformat(), low=100)
    async def daily(client, cache, cutoff, rows, discovery):
        rows[0].update(universe=True, liquidity=True, touches=True, rebound=True, low=100, high=140)
        return {key: dict(isin="NEW")}, None, dict(universe=1, covered=1)
    monkeypatch.setattr(market, "daily", daily)
    monkeypatch.setattr(market, "candles", AsyncMock(return_value=[]))
    state = await cloud_score.finish_screen(None, None, None, {key: "NSE_EQ|NEW"}, settings,
                                            stamp, {}, dict(rows=[], complete=True), previous)
    assert key not in state["setups"]
    assert state["score_status"] == "partial"
    assert [(row["symbol"], row["reason"], row["sources"]) for row in state["rows"]] == [
        (key, "Missing current closed candle", ["custom"])]
    assert not state["pending"] and not state["positions"]


@pytest.mark.asyncio
@pytest.mark.parametrize("seconds,attempts", [(0, 2), (99, 2), (100, 1), (300, 1), (-5, 1)])
async def test_discovery_retry_is_bounded_and_pinned(monkeypatch, seconds, attempts):
    from datetime import timedelta
    from app.domains.bottom_fishing import worker

    stamp = datetime.now(market.INDIA) - timedelta(seconds=seconds)
    attempt = AsyncMock(side_effect=worker.DiscoveryReadTimeout("fixture", 17))
    monkeypatch.setattr(worker, "_run_once", attempt)
    with pytest.raises(worker.DiscoveryReadTimeout):
        await worker.run(None, 3, stamp)
    assert attempt.await_count == attempts
    assert all(call.args == (None, 3, stamp) for call in attempt.await_args_list)
    if attempts == 2:
        assert attempt.await_args_list[1].kwargs == {"expected_version": 17}


def test_failed_window_survives_later_ticks_and_clears_only_on_matching_scan():
    from datetime import timedelta
    from app.domains.bottom_fishing.worker import reconcile_discovery_coverage

    morning = datetime(2026, 11, 27, 9, 30, tzinfo=market.INDIA)
    afternoon = morning.replace(hour=13, minute=15)
    state = roll({}, morning)
    state["status"] = "failed"
    reconcile_discovery_coverage(state, morning, error="ReadTimeout during daily market inputs")
    assert state["status"] == "failed"

    state.update(status="completed", error=None)
    state["scans"].append({"at": afternoon.isoformat(), "covered": 495})
    reconcile_discovery_coverage(state, afternoon)
    assert state["status"] == "partial"
    assert list(state["discovery_failures"]) == [morning.isoformat()]
    assert state["positions"] == state["pending"] == {}
    assert "discovery_failures" not in roll(state, morning + timedelta(days=1))

    state.update(status="completed", error=None)
    state["scans"].append({"at": morning.isoformat(), "covered": 495})
    reconcile_discovery_coverage(state, morning)
    assert state["status"] == "completed"
    assert "discovery_failures" not in state


@pytest.mark.asyncio
async def test_scheduled_recovery_reloads_saved_state_and_records_each_window_once(monkeypatch):
    from contextlib import asynccontextmanager
    import httpx
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    import app.models
    from app.domains.auth.models import ActivityLog, User
    from app.domains.bottom_fishing import worker

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    stamp = datetime(2026, 11, 27, 9, 30, tzinfo=market.INDIA)
    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return stamp
    @asynccontextmanager
    async def cache():
        yield AsyncMock()
    monkeypatch.setattr(worker, "datetime", Clock)
    monkeypatch.setattr(worker, "redis_client", cache)
    monkeypatch.setattr(worker.httpx, "AsyncClient", lambda **kwargs: cache())
    monkeypatch.setattr(worker, "configured_for", lambda *args: True)
    monkeypatch.setattr(worker.market, "calendar", AsyncMock(return_value=[]))
    monkeypatch.setattr(worker.score_inputs, "plan", AsyncMock(return_value=None))
    async def daily(*args):
        return {}, 100, {"universe": 1, "covered": 1, "patterns": 0, "current_candles": 0}
    monkeypatch.setattr(worker, "prepared_market", daily)
    reads = 0
    async def evidence(client, cache, guard, cutoff, levels, state, coverage):
        nonlocal reads
        reads += 1
        if reads == 1:
            state["setups"]["fixture mutation"] = {}
            raise httpx.ReadTimeout("synthetic instrument-source timeout")
        assert not state["setups"]
        return {}, {}
    monkeypatch.setattr(worker, "collect_evidence", evidence)
    try:
        async with engine.begin() as conn:
            for table in (User.__table__, ActivityLog.__table__):
                await conn.run_sync(table.create)
        async with sessions() as db:
            db.add(User(id=1, username="fixture", email="worker@example.test", password_hash="unused"))
            await db.commit()
        morning = stamp.isoformat()
        for hour, minute in [(9, 30), (9, 30), (13, 15), (15, 30)]:
            stamp = stamp.replace(hour=hour, minute=minute)
            await worker.run(sessions, 1, stamp)
        async with sessions() as db:
            records = (await db.scalars(select(ActivityLog).where(ActivityLog.action==store.CYCLE)
                                       .order_by(ActivityLog.id))).all()
            _, last = await store.latest(db, 1, store.CYCLE, {})
            assert len(records) == 4
            first = records[0].details
            assert morning in first and "ReadTimeout during instrument" in first
        assert [s["at"] for s in last["scans"]] == [morning, stamp.replace(hour=13, minute=15).isoformat()]
        assert last["status"] == "completed" and not last["pending"] and not last["positions"]
        stamp = stamp.replace(day=30, hour=9, minute=30)
        decide = Mock(side_effect=httpx.ReadTimeout("decision fixture"))
        monkeypatch.setattr(worker, "paper_cycle", decide)
        with pytest.raises(httpx.ReadTimeout):
            await worker.run(sessions, 1, stamp)
        decide.assert_called_once()
    finally:
        await engine.dispose()


def test_missing_dispatch_and_incomplete_issuer_coverage_remain_visible_through_close():
    from app.domains.bottom_fishing.worker import reconcile_discovery_coverage
    from app.domains.bottom_fishing.engine import size_entries
    morning = datetime(2026, 11, 27, 9, 30, tzinfo=market.INDIA)
    close = morning.replace(hour=15, minute=30)
    state = roll({}, morning)
    state.update(status="completed")
    reconcile_discovery_coverage(state, close)
    assert set(state["discovery_failures"]) == {morning.isoformat(), morning.replace(hour=13, minute=15).isoformat()}
    state["scans"] = [{"at": morning.isoformat(), "issuer_coverage_incomplete": True}]
    state["rows"] = [{"symbol":"NSE:TEST","reason":"Qualified"}]
    size_entries(state, store.Settings().model_dump(), morning)
    assert state["rows"][0]["reason"] == "Awaiting complete corporate-action coverage"
    assert not state["pending"] and not state["seen"]
    state["scans"].append({"at": morning.replace(hour=13, minute=15).isoformat()})
    state["status"] = "completed"
    reconcile_discovery_coverage(state, close)
    assert state["status"] == "partial" and not state.get("discovery_failures")


@pytest.mark.asyncio
async def test_bulk_timeout_uses_only_exact_cached_adjustments_and_does_not_freeze_partial_market(monkeypatch):
    import httpx
    import json
    from datetime import timedelta
    from app.domains.bottom_fishing import worker
    stamp = datetime(2026,11,27,9,30,tzinfo=market.INDIA)
    sessions = {str(stamp.date()-timedelta(days=i)): "fixture" for i in range(5,0,-1)}
    first = next(iter(sessions))
    members = {"NSE:TEST":"ISIN-A","NSE:OTHER":"ISIN-B"}
    master = {k:dict(isin=v,series="EQ",tick=.05) for k,v in members.items()}
    kv = {f"bottom:universe:v1:{stamp.date()}":json.dumps(members)}
    for day in sessions:
        kv["bottom:archive:v1:"+day] = json.dumps({k:dict(as_of=day,high=10,low=8,close=9,
                                                          volume=2000000,isin=v) for k,v in members.items()})
    kv[market.issuer_action_key("ISIN-A",first,str(stamp.date()))] = "[]"
    kv[market.issuer_action_key("ISIN-B",first,"2026-11-26")] = "[]"
    cache=AsyncMock()
    cache.get.side_effect=kv.get
    cache.mget.side_effect=lambda keys:[kv.get(k) for k in keys]
    monkeypatch.setattr(market, "calendar", AsyncMock(return_value=[]))
    monkeypatch.setattr(market, "session_calendar", lambda *args: sessions)
    monkeypatch.setattr(market, "technical_instruments", AsyncMock(return_value=master))
    monkeypatch.setattr(market, "download", AsyncMock(side_effect=httpx.ReadTimeout("bulk fixture")))
    live=AsyncMock(side_effect=AssertionError("No issuer provider fanout"))
    monkeypatch.setattr(market, "issuer_actions", live)
    rules=dict(lookback=5,touch_gap=2)
    _, _, coverage=await worker.prepared_market(None,cache,stamp,rules)
    assert coverage["covered"] == coverage["verified_issuer_ledgers"] == 1
    assert coverage["requested_issuer_ledgers"] == 2 and coverage["issuer_coverage_incomplete"]
    cache.set.assert_not_awaited()
    kv.pop(market.issuer_action_key("ISIN-A",first,str(stamp.date())))
    with pytest.raises(httpx.ReadTimeout):
        await worker.prepared_market(None,cache,stamp,rules)
    live.assert_not_awaited()
