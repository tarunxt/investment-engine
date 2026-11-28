"""Public daily NSE evidence, completed Upstox candles, observed consolidated financials."""
import asyncio
import csv
import io
import json
import math
import os

import httpx
from datetime import datetime, timedelta
from urllib.parse import quote

from app.domains.scorecards.research import INDIA, download
from app.domains.scorecards.technical_sources import archive_url, extract_archive, session_calendar, nse_actions, action_ledger, HOLIDAYS
from app.domains.zerodha.upstox_quotes import technical_instruments
from .issuer import facts, financials  # preserve published market-data entry points
from .discovery import DEFAULTS, Discovery, daily_pattern

INDEX = "https://archives.nseindia.com/content/indices/ind_nifty500list.csv"
INDEX_FALLBACK = "https://www.niftyindices.com/IndexConstituent/ind_nifty500list.csv"
BENCH = "NSE:NIFTYBEES"


async def archive_download(client, primary, alternate):
    try:
        return await download(client, primary)
    except httpx.HTTPError:
        return await download(client, alternate)


def issuer_action_key(isin, start, end):
    return f"bottom:issuer-actions:{isin}:{start}:{end}"


async def cached_issuer_actions(cache, isins, start, end):
    """Read only ledgers verified for the exact issuer and adjustment interval."""
    result = {}
    unique = sorted(set(isins))
    for offset in range(0, len(unique), 256):
        batch = unique[offset:offset + 256]
        raw = await cache.mget([issuer_action_key(isin, start, end) for isin in batch])
        for isin, payload in zip(batch, raw, strict=True):
            if payload is None:
                continue
            try:
                events = json.loads(payload)
            except (TypeError, ValueError):
                continue
            if isinstance(events, list) and all(
                isinstance(event, dict) and isinstance(event.get("date"), str)
                and start < event["date"] <= end
                and "multiplier" in event and (event["multiplier"] is None or
                     (type(event["multiplier"]) in (int, float) and math.isfinite(event["multiplier"])
                      and event["multiplier"] > 0))
                for event in events
            ):
                result[isin] = events
    return result


async def issuer_actions(client, cache, isins, start, end):
    gate = asyncio.Semaphore(4)
    async def ledger(isin):
        key = issuer_action_key(isin, start, end)
        try:
            cached = await cache.get(key)
            if cached is not None:
                return isin, json.loads(cached)
            async with gate:
                response = await client.get(f"https://api.upstox.com/v2/fundamentals/{isin}/corporate-actions",
                                            headers={"Authorization":"Bearer "+os.environ["UPSTOX_ANALYTICS_TOKEN"]})
            response.raise_for_status()
            body = response.json()
            if body.get("status") != "success" or not isinstance(body.get("data"), list):
                return isin, None
            events = action_ledger(body["data"], start, end)
            await cache.set(key, json.dumps(events), ex=3600)
            return isin, events
        except (httpx.HTTPError, ValueError, KeyError, TypeError):
            return isin, None
    return dict(await asyncio.gather(*(ledger(isin) for isin in set(isins))))


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


async def daily(client, cache, stamp, comparison=None, discovery=None):
    """Cache each session archive across users, only read ordinary NSE shares with matching ISIN."""
    rules = Discovery.model_validate(discovery or {})
    master = await technical_instruments(client)
    day = stamp.date().isoformat()
    async def constituents(size):
        cache_key = f"bottom:universe:v1:{day}" if size==500 else f"bottom:index:{size}:{day}"
        raw = await cache.get(cache_key)
        if raw:
            return json.loads(raw)
        data = await archive_download(client,INDEX.replace("500",str(size)),INDEX_FALLBACK.replace("500",str(size)))
        rows = csv.DictReader(io.StringIO(data.decode("utf-8-sig")))
        found = {"NSE:"+r["Symbol"]:r["ISIN Code"].strip() for r in rows if r["Series"]=="EQ"}
        if len(found) < size*.9:
            raise ValueError(f"Nifty {size} constituent feed is incomplete")
        await cache.set(cache_key,json.dumps(found),ex=86400)
        return found

    members = await constituents(500)
    universes = {500:members}
    for size in rules.indices():
        if size!=500:
            try:
                universes[size]=await constituents(size)
            except (httpx.HTTPError, ValueError, KeyError):
                universes[size]=None
    def membership(key):
        listing = master.get(key,{})
        flags={f"nifty_{size}_member":(None if stocks is None else int(key in stocks and stocks[key]==listing.get("isin")))
               for size,stocks in universes.items()}
        return rules.check("universe", **flags, nse_equity=int(listing.get("series")=="EQ"),
                           isin_match=int(key in master and (key not in members or listing["isin"]==members[key])))
    keys = {k:v for k,v in members.items() if master.get(k,{}).get("isin")==v}
    if comparison is None and (rules.minimum < 5 or rules.formulas["universe"] != DEFAULTS["universe"]):
        keys.update({k:v["isin"] for k,v in master.items() if k.startswith("NSE:") and v["series"]=="EQ"
                     and v.get("isin") and (k not in members or v["isin"] == members[k])})
    keys.update({k:master[k]["isin"] for k in [BENCH] if k in master and k.startswith("NSE:")})
    rows = {"NSE:"+r["symbol"]:r for r in (comparison or [])}
    for k, row in rows.items():
        row["universe"] = membership(k)
        row["identity_matches"] = k in master and (k not in members or master[k]["isin"] == members[k])
        if k in master and (k not in members or master[k]["isin"] == members[k]):
            keys[k] = master[k]["isin"]
    holidays = await calendar(client, cache, stamp)
    sessions = session_calendar(stamp.replace(hour=0, minute=0), "NSE", holidays, rules.lookback)
    if len(sessions) != rules.lookback:
        raise ValueError("Incomplete exchange calendar")
    gate = asyncio.Semaphore(4)
    async def session(day, close):
        key = "bottom:archive:v1:" + day
        payload = await cache.get(key)
        url = archive_url("NSE", day)
        if payload is None:
            async with gate:
                data = await archive_download(client, url.replace("nsearchives.", "archives."), url)
            all_keys = {k:v["isin"] for k,v in master.items() if k.startswith("NSE:")}
            records = await asyncio.to_thread(extract_archive, data, "NSE", day, close, all_keys, url)
            values = {k:{f:r[0][f] for f in ("as_of","close","high","low","volume","isin")} for k,r in records.items() if len(r)==1}
            await cache.set(key, json.dumps(values), ex=86400*35)
            return values
        return json.loads(payload)
    days = await asyncio.gather(*(session(d,c) for d,c in sessions.items()))
    start = datetime.fromisoformat(next(iter(sessions)))
    actions_key = f"bottom:actions:{start.date()}:{day}"
    raw = await cache.get(actions_key)
    action_coverage = {}
    try:
        if raw is None:
            url = ("https://www.nseindia.com/api/corporates-corporateActions?index=equities"
               f"&from_date={start:%d-%m-%Y}&to_date={stamp:%d-%m-%Y}")
            raw = (await download(client, url)).decode()
            nse_actions(json.loads(raw), keys.values())
            await cache.set(actions_key, raw, ex=6*3600)
        actions = nse_actions(json.loads(raw), keys.values())
    except (httpx.HTTPError, ValueError):
        if rows:
            wanted = [keys[k] for k in rows if k in keys]
            actions = await issuer_actions(client, cache, wanted, start.date().isoformat(), day)
        else:
            wanted = set(keys.values())
            actions = await cached_issuer_actions(cache, wanted, start.date().isoformat(), day)
            if not actions:
                raise
            action_coverage = dict(corporate_action_source="cached_issuer_ledgers",
                                   verified_issuer_ledgers=len(actions), requested_issuer_ledgers=len(wanted),
                                   issuer_coverage_incomplete=len(actions) < len(wanted))
    levels = {}
    covered = 0
    for k,isin in keys.items():
        bars = [d[k].copy() for d in days if k in d and d[k]["isin"]==isin]
        events = actions.get(isin)
        if events is None or len(bars)!=rules.lookback or any(not a["multiplier"] for a in events):
            continue
        for b in bars:
            factor = math.prod(a["multiplier"] for a in events if b["as_of"][:10]<a["date"]<=day)
            for f in ("high","low","close"):
                b[f] /= factor
            b["volume"] = b["volume"]*factor if b["volume"] is not None else None
        covered += int(k in members)
        member = membership(k)
        flags, pattern = daily_pattern(bars, master[k]["tick"], isin, member, rules)
        if k in rows:
            rows[k].update(flags)
        if pattern and (k in members or k in rows or comparison is None and k != BENCH):
            levels[k] = pattern
    benchmark = days[-1].get(BENCH)
    mismatches = [k for k, isin in members.items() if k in master and master[k].get("isin") != isin]
    return levels, benchmark and benchmark["close"], dict(universe=len(members), covered=covered,
                                                        identity_mismatches=mismatches, **action_coverage)


async def previous_session_close(client, cache, guard, instrument, session):
    key = f"bottom:benchmark-close:{instrument}:{session}"
    cached = await cache.get(key)
    if cached is not None:
        return float(cached)
    if not await guard.admit():
        return None
    url = f"https://api.upstox.com/v3/historical-candle/{quote(instrument, safe='')}/days/1/{session}/{session}"
    response = await client.get(url, headers={"Authorization":"Bearer "+os.environ["UPSTOX_ANALYTICS_TOKEN"]})
    if response.status_code == 429:
        await guard.backoff(response.headers.get("Retry-After"))
    response.raise_for_status()
    candles = response.json()["data"]["candles"]
    if len(candles) != 1 or len(candles[0]) < 5:
        return None
    candle = candles[0]
    end = datetime.fromisoformat(candle[0])
    close = candle[4]
    if (end.tzinfo is None or end.astimezone(INDIA).date().isoformat() != session
            or type(close) not in (float, int) or not math.isfinite(close) or close <= 0):
        return None
    await cache.set(key, str(close), ex=3*86400)
    return close


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
