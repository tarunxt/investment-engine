import asyncio
import json
import logging
import os
from datetime import datetime, time, timedelta

import httpx
from sqlalchemy import select
from app.domains.auth.models import User, ActivityLog
from app.domains.scorecards.technical_sources import session_calendar
from app.domains.zerodha.upstox_quote_guard import QuoteGuard, redis_client
from app.domains.zerodha.upstox_quotes import configured_for, load_instruments, build_quote_request
from . import market, store
from . import score_inputs
from .engine import close_position, paper_cycle, roll

log = logging.getLogger(__name__)
INDIA = market.INDIA


async def save(sessions, owner, version, previous, state):
    async with sessions() as db:
        await store.lock(db,owner)
        current,_ = await store.latest(db,owner,store.CYCLE,{})
        settings,_ = await store.latest(db,owner,store.CONFIG,{})
        if (current,settings)!=(previous,version):
            return None
        row = store.append(db,owner,store.CYCLE,state)
        await db.flush()
        saved_id = row.id
        await db.commit()
        return saved_id


async def paper_fills(client, guard, state):
    pending = state["pending"]
    keys = {f'NSE_EQ|{p["isin"]}':k for k,p in pending.items()}
    seen_quotes = set()
    while pending and any((datetime.now(INDIA)-datetime.fromisoformat(p["created"])).total_seconds()<30 for p in pending.values()):
        if not await guard.admit():
            break
        request = build_quote_request(client,keys,os.environ["UPSTOX_ANALYTICS_TOKEN"])
        response = await client.send(request)
        if response.status_code==429:
            await guard.backoff(response.headers.get("Retry-After"))
            break
        response.raise_for_status()
        now = datetime.now(INDIA)
        for q in response.json()["data"].values():
            k = keys.get(q.get("instrument_token"))
            p = pending.get(k)
            if not p or not q.get("timestamp"):
                continue
            observed = datetime.fromisoformat(q["timestamp"])
            opened = datetime.fromisoformat(p["created"])
            if observed.tzinfo is None or not opened<=observed<=now<opened+timedelta(seconds=30):
                continue
            offer = (q.get("depth",{}).get("sell") or [{}])[0]
            price,available = offer.get("price",0),offer.get("quantity",0)
            identity = (k,q["timestamp"],price,available)
            if identity in seen_quotes or not 0<price<=p["price"] or available<=0:
                continue
            seen_quotes.add(identity)
            qty = min(p["qty"],int(available))
            held = state["positions"].setdefault(k,dict(p,qty=0,entry=now.isoformat(), checked=now.isoformat()))
            held["price"] = (held["price"]*held["qty"]+price*qty)/(held["qty"]+qty)
            held["qty"] += qty
            p["qty"] -= qty
            if not p["qty"]:
                del pending[k]
        if pending:
            await asyncio.sleep(2)
    for row in state["rows"]:
        if row["reason"]=="Paper limit pending":
            held = state["positions"].get(row["symbol"])
            row.update(reason=("Paper filled" if held and held["qty"]==row["qty"] else
                               "Partial paper fill; remainder expired" if held else "Paper limit expired"),
                       filled=held["qty"] if held else 0)
    state["pending"] = {}


async def prepared_market(client, cache, stamp):
    cache_key = "bottom:prepared:v1:"+stamp.date().isoformat()
    prepared = await cache.get(cache_key)
    if prepared:
        levels,benchmark,coverage = json.loads(prepared)
    else:
        levels,benchmark,coverage = await market.daily(client,cache,stamp)
        await cache.set(cache_key,json.dumps([levels,benchmark,coverage]),ex=86400)
    return levels, benchmark, coverage


async def collect_evidence(client, cache, guard, stamp, levels, state, coverage):
    keys = set(levels)|set(state["setups"])|set(state["positions"])|{market.BENCH}
    master = await load_instruments(client)
    gate = asyncio.Semaphore(4)
    async def evidence(k):
        async with gate:
            try:
                bars = await market.candles(client,master[k],stamp,guard)
            except (httpx.HTTPError,KeyError,ValueError):
                bars = []
            facts = None
            s = levels.get(k)
            eligible = k in state["setups"] or (s and bars and s["low"]<=bars[-1]["close"]<=s["low"]+.15*s["width"])
            if eligible:
                try:
                    facts = await market.facts(client,cache,k)
                except (httpx.HTTPError, KeyError, ValueError, IndexError):
                    pass
            return k,bars,facts
    results = await asyncio.gather(*(evidence(k) for k in sorted(keys)))
    series = {k:b for k,b,_ in results}
    fundamentals = {k:f for k,_,f in results}
    if coverage is not None:
        coverage["patterns"] = len(levels)
        coverage["current_candles"] = sum(bool(series[k]) and series[k][-1]["end"]==stamp.isoformat() for k in levels)
    return series, fundamentals


async def run(sessions, owner, stamp):
    async with sessions() as db:
        await store.lock(db,owner)
        username = await db.scalar(select(User.username).where(User.id==owner))
        if username is None:
            return
        view = await store.snapshot(db,owner,include_review=False)
        prior,_ = await store.latest(db,owner,store.CYCLE,{})
        settings = view["settings"]
        settings["score_inputs"] = await score_inputs.plan(db, owner, settings)
    state = roll(view["state"],stamp)
    if state.get("at","")>stamp.isoformat() or (state.get("at")==stamp.isoformat() and not state["pending"]):
        return
    try:
        if not configured_for(owner,username):
            raise ValueError("Market data unavailable for this account")
        async with redis_client() as cache, httpx.AsyncClient(timeout=9, follow_redirects=False,
                headers={"User-Agent":"Cred-X market research (https://cred-x.in)"}) as client:
            guard = QuoteGuard(cache,os.getenv("UPSTOX_LTP_OWNER_USER_ID") or owner,"bottom-paper",[])
            holidays = await market.calendar(client,cache,stamp)
            calendar = session_calendar(stamp.replace(hour=23,minute=59),"NSE",holidays,60)
            if stamp.date().isoformat() not in calendar:
                return
            if state.get("at")!=stamp.isoformat():
                screen = stamp.time() in (time(9,30),time(13,15))
                if screen or stamp.time()==time(9,20):
                    levels,benchmark,coverage = await prepared_market(client,cache,stamp)
                    state["sync"] = dict(at=stamp.isoformat(), **coverage)
                    state["benchmark_close"] = benchmark
                    if not screen:
                        levels,coverage = {},None
                else:
                    levels,coverage = {},None
                series, fundamentals = await collect_evidence(client, cache, guard, stamp, levels, state, coverage)
                levels, native = await score_inputs.filter_paper(client,cache,guard,settings,stamp,calendar,levels,series,state,coverage)
                paper_cycle(state,score_inputs.scoring_settings(settings),stamp,levels,series,fundamentals,state.get("benchmark_close"),coverage,calendar)
                score_inputs.record_inputs(state,settings,native)
                if coverage:
                    state["screen_symbols"] = sorted(k for k in native if k in state["setups"])
                missing = [r for r in state["rows"] if r["reason"].startswith("Missing ")]
                if missing or (coverage and (coverage.get("query_missing",0) or coverage["covered"]<coverage["universe"] or coverage["current_candles"]<coverage["patterns"])):
                    state["status"] = "partial"
                if datetime.now(INDIA)>=stamp+timedelta(minutes=5):
                    for r in state["rows"]:
                        if r["reason"]=="Paper limit pending":
                            r["reason"]="Signal expired"
                    state["pending"]={}
                prior = await save(sessions,owner,view["version"],prior,state)
                if prior is None:
                    return
            if state["positions"] or state["pending"]:
                await cache.set(f"bottom:monitor:{owner}","1",ex=4*86400)
            if state["pending"]:
                await paper_fills(client,guard,state)
                await save(sessions,owner,view["version"],prior,state)
    except Exception as exc:
        log.exception("Bottom Fishing cycle failed for account %s",owner)
        state.update(status="failed",error=type(exc).__name__+" during market-data collection",attempt=stamp.isoformat())
        await save(sessions,owner,view["version"],prior,state)
        raise


async def owners(sessions):
    async with sessions() as db:
        users = set(await db.scalars(select(ActivityLog.user_id).where(ActivityLog.action == store.CONFIG).distinct()))
        primary = os.getenv("UPSTOX_LTP_OWNER_USER_ID","")
        if primary.isdigit():
            users.add(int(primary))
        return users


async def monitor(sessions, owner):
    """Manage only simulated exits between score cycles, using fresh exchange trades."""
    async with sessions() as db:
        await store.lock(db,owner)
        user = await db.get(User,owner)
        if not user or not configured_for(owner,user.username):
            return
        version,_ = await store.latest(db,owner,store.CONFIG,{})
        prior,state = await store.latest(db,owner,store.CYCLE,{})
    async with redis_client() as cache:
        positions = state.get("positions",{})
        if not positions:
            await cache.delete(f"bottom:monitor:{owner}")
            return
        keys = {"NSE_EQ|"+p["isin"]:k for k,p in positions.items()}
        guard = QuoteGuard(cache,os.getenv("UPSTOX_LTP_OWNER_USER_ID") or owner,"bottom-paper",keys)
        if not await guard.admit():
            return
        async with httpx.AsyncClient(timeout=6,follow_redirects=False) as client:
            response = await client.send(build_quote_request(client,keys,os.environ["UPSTOX_ANALYTICS_TOKEN"]))
        if response.status_code==429:
            await guard.backoff(response.headers.get("Retry-After"))
            return
        response.raise_for_status()
        changed = False
        now = datetime.now(INDIA)
        for q in response.json()["data"].values():
            k = keys.get(q.get("instrument_token"))
            p = positions.get(k)
            if not p or not q.get("last_trade_time"):
                continue
            when = datetime.fromtimestamp(float(q["last_trade_time"])/1000,INDIA)
            if not 0<=(now-when).total_seconds()<=30 or when<=datetime.fromisoformat(p["checked"]):
                continue
            price = float(q["last_price"])
            if 0<price<=p["stop"] or price>=p["target"]:
                stop = price<=p["stop"]
                close_position(state,k,price if stop else p["target"],"Stop" if stop else "Target",when.isoformat())
                changed = True
        if changed:
            await save(sessions,owner,version,prior,state)
