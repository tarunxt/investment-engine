"""Continuously evaluate saved BFS queries without a browser or a strategy run."""
import ast
import asyncio
import json
import logging
import math
import os
from datetime import datetime, timedelta
from uuid import uuid4

import httpx
from sqlalchemy import select

from app.domains.auth.models import User
from app.domains.zerodha.upstox_quote_guard import QuoteGuard, RELEASE, redis_client
from app.domains.zerodha.upstox_quotes import build_quote_request, configured_for, technical_instruments
from . import market, store
from .cloud_score import finish_screen
from .issuer import issuer
from .query import compile_query, evaluate
from .query_evidence import daily_closes, macd
from .review import candle_cutoff
from .worker import INDIA, owners

log = logging.getLogger(__name__)
LIVE = store.LIVE


def listings(master):
    """Represent each ordinary company equity once, preferring the NSE listing."""
    result = {}
    for key in sorted(master, key=lambda k:(not k.startswith("NSE:"), k)):
        item = master[key]
        isin = item["isin"]
        if not isin.startswith("INE") or isin[7:9] != "01":
            continue
        if key.startswith("NSE:") and item["series"] != "EQ":
            continue
        if key.startswith(("NSE:", "BSE:")):
            result.setdefault(isin, key)
    return list(result.values())


async def quotes(client, guard, keys, stamp):
    result = {}
    for start in range(0, len(keys), 200):
        batch = keys[start:start+200]
        if not await guard.admit():
            break
        response = await client.send(build_quote_request(client, batch, os.environ["UPSTOX_ANALYTICS_TOKEN"]))
        if response.status_code == 429:
            await guard.backoff(response.headers.get("Retry-After"))
            break
        response.raise_for_status()
        for q in response.json()["data"].values():
            token = q.get("instrument_token")
            if token not in batch or not q.get("last_trade_time"):
                continue
            traded = datetime.fromtimestamp(float(q["last_trade_time"])/1000, INDIA)
            price = q.get("last_price")
            if traded.date()!=stamp.date() or not isinstance(price,(int,float)) or not math.isfinite(price) or price<=0:
                continue
            values = {"price":price}
            previous = (q.get("ohlc") or {}).get("close")
            if previous and previous>0:
                values["day_return"] = 100*(price/previous-1)
            result[token] = values
    return result


async def scan(client, cache, owner, settings, stamp, calendar, previous=None):
    async with asyncio.timeout(235):
        report, instruments, guard = await query_matches(client, cache, owner, settings, stamp, calendar)
    return await finish_screen(client, cache, guard, instruments, settings, stamp, calendar, report, previous or {})


async def query_matches(client, cache, owner, settings, stamp, calendar):
    root = compile_query(settings["screen_query"])
    fields = {n.id[1:] for n in ast.walk(root) if isinstance(n,ast.Name)}
    master = await technical_instruments(client)
    stocks = listings(master)
    if not stocks:
        raise ValueError("No verified equity listings available")
    instruments = {k:k[:3]+"_EQ|"+master[k]["isin"] for k in stocks}
    guard = QuoteGuard(cache, os.getenv("UPSTOX_LTP_OWNER_USER_ID") or owner, "bottom-cloud", [])
    prices = await quotes(client,guard,list(instruments.values()),stamp)
    report = dict(at=datetime.now(INDIA).isoformat(), source="Cred-X cloud", rows=[], universe_size=len(stocks),
                  unknown=0, complete=False)
    last_session = max(d for d in calendar if d<stamp.date().isoformat())
    quarter = (stamp.replace(month=(stamp.month-1)//3*3+1,day=1)-timedelta(days=1)).strftime("%b %Y")
    facts_needed = settings.get("latest_results") or fields-{"price","day_return","macd","previous_macd"}
    facts_keys = ["bottom:cloud:issuer:"+master[k]["isin"] for k in stocks]
    cached = await cache.mget(facts_keys) if facts_needed else [None]*len(stocks)
    # Cold data is filled in bounded batches; unresolved companies are counted.
    # Cache failures briefly so one missing issuer cannot starve later listings.
    warm = [(k,key,i) for i,(k,key,raw) in enumerate(zip(stocks,facts_keys,cached))
            if facts_needed and raw is None and evaluate(root,prices.get(instruments[k],{})) is not False][:40]
    gate = asyncio.Semaphore(3)
    async def warm_issuer(k,key,i):
        async with gate:
            try:
                issuer_key = k if k.startswith("NSE:") else "BSE:"+master[k]["exchange_token"]
                fields,_ = await issuer(client,cache,issuer_key)
            except (httpx.HTTPError, ValueError, KeyError, IndexError):
                fields = {}
            cached[i] = json.dumps(fields)
            await cache.set(key,cached[i],ex=86400 if fields else 1800)
    try:
        async with asyncio.timeout(80):
            await asyncio.gather(*(warm_issuer(*item) for item in warm))
    except TimeoutError:
        pass
    history_requests = 0
    for k, cache_key, raw in zip(stocks,facts_keys,cached):
        values = dict(prices.get(instruments[k],{}))
        matched = evaluate(root, values)
        if matched is not False and facts_needed:
            published = json.loads(raw) if raw else {}
            values.update(published)
            matched = evaluate(root,values)
        if matched is None and "price" in values and fields & {"macd","previous_macd"} and (not facts_needed or published):
            unavailable_key = f"bottom:cloud:history-missing:{instruments[k]}:{last_session}"
            if await cache.exists(unavailable_key):
                report["unknown"] += 1
                continue
            cached_history = await cache.exists(f"bottom:query-closes:v1:{instruments[k]}:{last_session}")
            if not cached_history and history_requests>=30:
                report["unknown"] += 1
                continue
            history_requests += int(not cached_history)
            try:
                history = await daily_closes(client,cache,guard,instruments[k],stamp,last_session)
                values.update(macd(history, values["price"]))
                if not history:
                    await cache.set(unavailable_key,"1",ex=900)
            except (httpx.HTTPError, KeyError, ValueError):
                await cache.set(unavailable_key,"1",ex=900)
            matched = evaluate(root,values)
        if settings.get("latest_results") and matched is not False and values.get("quarter")!=quarter:
            matched = False if values.get("quarter") else None
        if matched is None:
            report["unknown"] += 1
        if matched is True:
            report["rows"].append(dict(symbol=k.split(":",1)[1], exchange=k[:3], name=master[k]["name"] or k,
                                       **({"universe":False} if k.startswith("BSE:") else {})))
    report["total"] = len(report["rows"])
    report["complete"] = not report["unknown"]
    benchmark = master.get(market.BENCH)
    if benchmark:
        instruments[market.BENCH] = "NSE_EQ|" + benchmark["isin"]
    return report, instruments, guard


async def refresh(sessions,owner):
    from .store import CONFIG, latest
    async with sessions() as db:
        username = await db.scalar(select(User.username).where(User.id==owner))
        if not configured_for(owner,username):
            return
        version,settings = await latest(db,owner,CONFIG,{})
        previous_id, previous = await latest(db,owner,LIVE,{})
        if not settings.get("screen_query","").strip():
            return
    now = datetime.now(INDIA)
    async with redis_client() as cache, httpx.AsyncClient(timeout=8,follow_redirects=False) as client:
        stamp, calendar = candle_cutoff(now,await market.calendar(client,cache,now))
        slot = f"bottom:cloud:scored:{owner}:{version}:{stamp.isoformat()}"
        lease = f"bottom:cloud:lock:{owner}"
        token = uuid4().hex
        saved = previous.get("state", {})
        if (previous.get("version") == version and saved.get("market_as_of") == stamp.isoformat()
                and saved.get("score_status") and saved.get("status") == "completed"):
            return
        if await cache.exists(slot) or not await cache.set(lease,token,nx=True,ex=390):
            return
        state = dict(screen_query=dict(text=settings["screen_query"],latest_results=settings.get("latest_results",False)),
                     market_as_of=stamp.isoformat())
        try:
            try:
                state = await scan(client, cache, owner, store.Settings.model_validate(settings).model_dump(),
                                   stamp, calendar, previous.get("state") if previous.get("version") == version else None)
            except Exception as exc:
                log.exception("Cloud BFS scan failed")
                state.update(status="failed",error=f"Cloud refresh failed ({type(exc).__name__}).")
            async with sessions() as db:
                await store.lock(db,owner)
                current,_ = await latest(db,owner,CONFIG,{})
                if current != version:
                    return
                latest_id, _ = await latest(db,owner,LIVE,{})
                if latest_id != previous_id:
                    return
                output = dict(mode="Cloud screen",version=version,settings=settings,state=state,
                              finished_at=datetime.now(INDIA).isoformat())
                store.append(db,owner,LIVE,output)
                await db.commit()
            await cache.set(slot,"1",ex=3*86400 if state["status"]=="completed" else 300)
        finally:
            await cache.eval(RELEASE,1,lease,token)


async def serve(sessions):
    while True:
        try:
            if os.getenv("UPSTOX_ANALYTICS_TOKEN"):
                for owner in await owners(sessions):
                    await refresh(sessions,owner)
        except Exception:
            log.exception("Cloud BFS refresh unavailable")
        await asyncio.sleep(20)
