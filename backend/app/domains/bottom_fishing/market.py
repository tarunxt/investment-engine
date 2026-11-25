"""Public daily NSE evidence, completed Upstox candles, observed consolidated financials."""
import asyncio
import csv
import io
import json
import math
import os
from datetime import datetime, timedelta
from urllib.parse import quote

from app.domains.scorecards.research import INDIA, download
from app.domains.scorecards.technical_sources import archive_url, extract_archive, session_calendar, nse_actions, HOLIDAYS
from app.domains.zerodha.upstox_quotes import technical_instruments
from .issuer import facts, financials  # preserve published market-data entry points
from .strategy import support

INDEX = "https://www.niftyindices.com/IndexConstituent/ind_nifty500list.csv"
BENCH = "NSE:NIFTYBEES"


async def calendar(client, cache, stamp):
    key = "bottom:calendar:" + str(stamp.year)
    raw = await cache.get(key)
    if raw:
        return json.loads(raw)
    response = await client.get(HOLIDAYS)
    response.raise_for_status()
    events = response.json()["data"]
    await cache.set(key, json.dumps(events), ex=86400)
    return events


async def daily(client, cache, stamp):
    """Cache each session archive across users, only read ordinary NSE shares with matching ISIN."""
    master = await technical_instruments(client)
    day = stamp.date().isoformat()
    cache_key = "bottom:universe:v1:" + day
    raw = await cache.get(cache_key)
    if raw:
        members = json.loads(raw)
    else:
        rows = csv.DictReader(io.StringIO((await download(client, INDEX)).decode("utf-8-sig")))
        members = {"NSE:"+r["Symbol"]:r["ISIN Code"].strip() for r in rows if r["Series"] == "EQ"}
        if len(members) < 450:
            raise ValueError("Nifty 500 constituent feed is incomplete")
        await cache.set(cache_key, json.dumps(members), ex=86400)
    keys = {k:v for k,v in members.items() if master.get(k,{}).get("isin")==v}
    keys.update({k:master[k]["isin"] for k in [BENCH] if k in master and k.startswith("NSE:")})
    holidays = await calendar(client, cache, stamp)
    sessions = session_calendar(stamp.replace(hour=0, minute=0), "NSE", holidays, 20)
    if len(sessions) != 20:
        raise ValueError("Incomplete exchange calendar")
    gate = asyncio.Semaphore(4)
    async def session(day, close):
        key = "bottom:archive:v1:" + day
        payload = await cache.get(key)
        url = archive_url("NSE", day)
        if payload is None:
            async with gate:
                data = await download(client, url)
            all_keys = {k:v["isin"] for k,v in master.items() if k.startswith("NSE:")}
            records = await asyncio.to_thread(extract_archive, data, "NSE", day, close, all_keys, url)
            values = {k:{f:r[0][f] for f in ("as_of","close","high","low","volume","isin")} for k,r in records.items() if len(r)==1}
            await cache.set(key, json.dumps(values), ex=86400*35)
            return values
        return json.loads(payload)
    days = await asyncio.gather(*(session(d,c) for d,c in sessions.items()))
    start = datetime.fromisoformat(next(iter(sessions)))
    actions_key = "bottom:actions:" + day
    raw = await cache.get(actions_key)
    if raw is None:
        url = ("https://www.nseindia.in/api/corporates-corporateActions?index=equities"
               f"&from_date={start:%d-%m-%Y}&to_date={stamp:%d-%m-%Y}")
        raw = (await download(client, url)).decode()
        nse_actions(json.loads(raw), keys.values())
        await cache.set(actions_key, raw, ex=6*3600)
    actions = nse_actions(json.loads(raw), keys.values())
    levels = {}
    covered = 0
    for k,isin in keys.items():
        bars = [d[k].copy() for d in days if k in d and d[k]["isin"]==isin]
        events = actions[isin]
        if len(bars)!=20 or any(not a["multiplier"] for a in events):
            continue
        for b in bars:
            factor = math.prod(a["multiplier"] for a in events if b["as_of"][:10]<a["date"]<=day)
            for f in ("high","low","close"):
                b[f] /= factor
            b["volume"] = (b["volume"] or 0)*factor
        covered += int(k in members)
        pattern = support(bars,master[k]["tick"])
        if pattern:
            levels[k] = dict(pattern, isin=isin, member=k in members)
    benchmark = days[-1].get(BENCH)
    return levels, benchmark and benchmark["close"], dict(universe=len(members), covered=covered)


async def candles(client, key, stamp, guard):
    if not await guard.admit():
        return []
    base = "https://api.upstox.com/v3/historical-candle/"
    instrument = quote(key, safe="")
    day = stamp.date().isoformat()
    if stamp.date() == datetime.now(INDIA).date():
        url = f"{base}intraday/{instrument}/minutes/5"
    else:
        url = f"{base}{instrument}/minutes/5/{day}/{day}"
    response = await client.get(url, headers={"Authorization":"Bearer "+os.environ["UPSTOX_ANALYTICS_TOKEN"]})
    if response.status_code == 429:
        await guard.backoff(response.headers.get("Retry-After"))
    response.raise_for_status()
    bars = {}
    for t, op, hi, lo, cl, vol, *_ in response.json()["data"]["candles"]:
        end = datetime.fromisoformat(t).astimezone(INDIA)+timedelta(minutes=5)
        if end.date()==stamp.date() and end<=stamp and 0<lo<=min(op,cl)<=max(op,cl)<=hi and vol>0:
            bars[end.isoformat()] = dict(end=end.isoformat(), open=op, high=hi, low=lo, close=cl)
    return [bars[k] for k in sorted(bars)]
