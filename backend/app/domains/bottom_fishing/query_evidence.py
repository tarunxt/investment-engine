"""Read-only market and issuer evidence for the editable Stage 2 query."""
import json
import math
import os
from datetime import datetime, timedelta
from urllib.parse import quote

import ast
import asyncio

import httpx
from app.domains.scorecards.research import INDIA
from app.domains.zerodha.upstox_quotes import load_instruments
from .issuer import issuer
from .discovery import at_close
from .query import compile_query, evaluate


def macd(closes, current):
    # Daily EMA(12) minus EMA(26) for the previous close and the current candle.
    if len(closes)<60 or not all(math.isfinite(p) and p>0 for p in [*closes,current]):
        return {}
    fast = slow = closes[0]
    for price in closes[1:]:
        fast += 2/13*(price-fast)
        slow += 2/27*(price-slow)
    return {"previous_macd":fast-slow, "macd":fast+2/13*(current-fast)-slow-2/27*(current-slow)}


async def daily_closes(client,cache,guard,instrument,stamp,last_session):
    key = f"bottom:query-closes:v1:{instrument}:{last_session}"
    cached = await cache.get(key)
    if cached:
        return json.loads(cached)
    if not await guard.admit():
        return []
    first = (stamp.date()-timedelta(days=370)).isoformat()
    url = f"https://api.upstox.com/v3/historical-candle/{quote(instrument,safe='')}/days/1/{last_session}/{first}"
    response = await client.get(url,headers={"Authorization":"Bearer "+os.environ["UPSTOX_ANALYTICS_TOKEN"]})
    if response.status_code==429:
        await guard.backoff(response.headers.get("Retry-After"))
    response.raise_for_status()
    prices, volumes = {}, {}
    for t, _, _, _, close, *rest in response.json()["data"]["candles"]:
        day = datetime.fromisoformat(t).astimezone(INDIA).date().isoformat()
        if first<=day<=last_session:
            if day in prices or not math.isfinite(close) or close<=0:
                raise ValueError("Invalid historical close")
            prices[day] = close
            if rest and isinstance(rest[0],(int,float)) and math.isfinite(rest[0]) and rest[0]>=0:
                volumes[day]=rest[0]
    if last_session not in prices or len(prices)<60:
        return []
    if volumes:
        history={d:[prices[d],volumes.get(d)] for d in prices}
        await cache.set(f"bottom:display:daily:{instrument}:{last_session}",json.dumps(history),ex=172800)
    closes = [prices[d] for d in sorted(prices)]
    await cache.set(key,json.dumps(closes),ex=86400)
    return closes


async def apply_screen(client,cache,guard,settings,stamp,calendar,levels,series,state,coverage):
    """Filter new and carried setups in the confirmed technical universe. Never alter owned positions."""
    text = settings.get("screen_query","").strip()
    latest = settings.get("latest_results",False)
    spec = {"text":text,"latest_results":latest}
    if state.get("screen_query",{"text":"","latest_results":False})!=spec:
        state["setups"] = {}
    config = settings.get("discovery")
    if state.get("discovery") != config and config is not None:
        from .discovery import Discovery
        if state.get("discovery") is not None or config != Discovery().model_dump():
            state["setups"] = {}
    state["discovery"] = config
    state["screen_query"] = spec
    if not text or coverage is None:
        return levels
    root = compile_query(text)
    fields = {n.id[1:] for n in ast.walk(root) if isinstance(n,ast.Name)}
    need_macd = bool(fields & {"macd","previous_macd"})
    master = await load_instruments(client) if need_macd else {}
    previous = max((d for d in calendar if d<stamp.date().isoformat()),default=None)
    quarter_start = stamp.replace(month=(stamp.month-1)//3*3+1,day=1)
    quarter = (quarter_start-timedelta(days=1)).strftime("%b %Y")
    gate = asyncio.Semaphore(4)

    async def check(k):
        bars = series.get(k) or []
        setup = state["setups"].get(k) or levels[k]
        if not setup.get("discovery_flags") and not setup.get("member"):
            return k,"outside"
        if not bars or bars[-1]["end"]!=stamp.isoformat():
            return k,"missing"
        close = bars[-1]["close"]
        if k not in state["setups"] and not at_close(setup, close):
            return k,"outside"
        values = {"price":close,"day_return":100*(close/setup["previous"]-1)}
        async with gate:
            if latest or fields-{"price","day_return","macd","previous_macd"}:
                try:
                    published,_ = await issuer(client,cache,k)
                    values.update(published)
                except (httpx.HTTPError,ValueError,KeyError,IndexError):
                    pass
            result = evaluate(root,values)
            if result is None and need_macd and previous and k in master:
                try:
                    closes = await daily_closes(client,cache,guard,master[k],stamp,previous)
                    values.update(macd(closes,close))
                    result = evaluate(root,values)
                except (httpx.HTTPError,ValueError,KeyError,IndexError):
                    pass
            if latest and values.get("quarter")!=quarter and result is not False:
                result = False if values.get("quarter") else None
        return k, "passed" if result is True else "excluded" if result is False else "missing"

    checked = await asyncio.gather(*(check(k) for k in sorted(set(levels)|set(state["setups"]))))
    results = dict(checked)
    for k in list(state["setups"]):
        if results[k]!="passed":
            del state["setups"][k]
    coverage.update(query_passed=sum(r=="passed" for r in results.values()),
                    query_excluded=sum(r=="excluded" for r in results.values()),
                    query_missing=sum(r=="missing" for r in results.values()))
    return {k:v for k,v in levels.items() if results[k]=="passed"}
