"""Resolve live screen display columns independently of the five-minute scan."""
import asyncio
import json
import logging
import os
from datetime import datetime
from uuid import uuid4

import httpx

from app.domains.zerodha.upstox_quote_guard import QuoteGuard, RELEASE, redis_client
from . import columns, market, screen_ratios
from .issuer import issuer

log = logging.getLogger(__name__)
CANONICAL = {name.casefold(): name for name in columns.NAMES}
HISTORY = {"Volume", "CMP by 200 DMA", *(f"Volume {span} average" for span in ("1week", "1month", "1year")),
           *(f"DMA {n}{suffix}" for n in (50, 200) for suffix in ("", " previous day"))}


def keys(row, session, history_day):
    identity = f"{row['exchange']}:{row['symbol']}:{row.get('isin') or row.get('exchange_token') or ''}"
    base = f"bottom:display:v3:{identity}"
    return f"{base}:issuer:{session}", f"{base}:history:{history_day}", f"{base}:last-issuer"


async def overlay(cache, report, stamp):
    rows = report.get("rows", [])
    if not rows:
        return
    session = stamp[:10]
    day = report.get("history_day", stamp)
    lookup = [key for row in rows for key in keys(row, session, day)]
    records = await cache.mget(lookup)
    ratio_keys = [key + ":" + metric for key in lookup[::3] for metric in screen_ratios.METRICS]
    ratios = await cache.mget(ratio_keys)
    for i, row in enumerate(rows):
        financial, history, previous = [json.loads(raw) if raw else {} for raw in records[i*3:i*3+3]]
        fallback = previous if previous.get("session", "9999") <= session else {}
        observed = financial if financial.get("status") == "ready" else fallback
        values = row.setdefault("columns", {})
        for name, value in observed.get("values", {}).items():
            values.setdefault(name, value)
        values.update(history.get("values", {}))
        cmp_dma = columns.ratio(values.get("Current price"), values.get("DMA 200"))
        if cmp_dma is not None:
            values["CMP by 200 DMA"] = cmp_dma
        row["column_status"] = {name: (history if name in HISTORY else financial).get("status", "loading")
                                for name in report.get("column_names", columns.DEFAULT) if name not in values}
        pat_basis = None
        for offset, metric in enumerate(screen_ratios.METRICS):
            if metric in values or metric not in row["column_status"]:
                continue
            raw = ratios[2*i + offset]
            record = json.loads(raw) if raw else {}
            result = record.get("values", {}).get(metric)
            if result is not None and (metric != screen_ratios.PAT or not observed.get("quarter")
                                       or isinstance(record.get("quarter"), dict)
                                       or record.get("quarter") == observed["quarter"]):
                if metric == screen_ratios.PAT and isinstance(record.get("quarter"), dict):
                    pat_basis = record["quarter"]
                values[metric] = result
                row["column_status"].pop(metric)
            else:
                row["column_status"][metric] = record.get("status", "loading")
        row["issuer_observed_at"] = observed.get("observed_at")
        row["issuer_quarter"] = observed.get("quarter")
        if pat_basis:
            label = f"Prior-year PAT: {pat_basis['period']} ({pat_basis['basis']}, Screener)"
            row["issuer_quarter"] = " · ".join(filter(None, [row["issuer_quarter"], label]))


async def resolve(cache, key, fetch, *, session, last=None):
    if await cache.exists(key):
        return
    lease = key + ":lock"
    token = uuid4().hex
    if not await cache.set(lease, token, nx=True, ex=90):
        return
    try:
        if await cache.exists(key):
            return
        try:
            async with asyncio.timeout(45):
                values, quarter = await fetch()
            record = dict(values=values, quarter=quarter, session=session, status="ready",
                          observed_at=datetime.now(market.INDIA).isoformat())
        except (httpx.HTTPError, KeyError, ValueError, IndexError, TimeoutError):
            log.warning("Display lookup will retry for %s", key, exc_info=True)
            await cache.set(key, json.dumps({"status": "retry"}), ex=120)
            return
        payload = json.dumps(record, allow_nan=False)
        async with cache.pipeline(transaction=True) as pipe:
            pipe.set(key, payload, ex=3*86400)
            if last and values:
                pipe.set(last, payload, ex=30*86400)
            await pipe.execute()
    finally:
        await cache.eval(RELEASE, 1, lease, token)


async def fill(sessions, owner):
    from . import store
    async with sessions() as db:
        _, live = await store.latest(db, owner, store.LIVE, {})
    state = live.get("state", {})
    report = state.get("original_results", {})
    if not report.get("rows") or not state.get("market_as_of"):
        return
    stamp = datetime.fromisoformat(state["market_as_of"])
    session = stamp.date().isoformat()
    gate = asyncio.Semaphore(3)
    async with redis_client() as cache, httpx.AsyncClient(timeout=8, follow_redirects=False) as client:
        guard = QuoteGuard(cache, os.getenv("UPSTOX_LTP_OWNER_USER_ID") or owner, "bottom-cloud", [])
        from .review import candle_cutoff
        try:
            _, calendar = candle_cutoff(stamp, await market.calendar(client, cache, stamp))
        except (httpx.HTTPError, ValueError, KeyError, TimeoutError):
            log.warning("Display history calendar unavailable", exc_info=True)
            calendar = {}

        async def project(row):
            async with gate:
                finance_key, price_key, last = keys(row, session, report.get("history_day", stamp.isoformat()))
                async def financials():
                    symbol = row["exchange_token"] if row["exchange"] == "BSE" else row["symbol"]
                    fields, _ = await issuer(client, cache, f"{row['exchange']}:{symbol}")
                    values = {CANONICAL[k.casefold()]: v for k, v in fields.get("display", {}).items()
                              if k.casefold() in CANONICAL and k != "Current price"}
                    return values, fields.get("quarter")

                async def prices():
                    if not calendar:
                        raise ValueError("Session calendar unavailable")
                    instrument = f"{row['exchange']}_EQ|{row['isin']}"
                    values = await columns.price_facts(client, cache, guard, instrument, stamp, calendar,
                                                       row.get("session_volume"))
                    if not values:
                        raise ValueError("Price history unavailable")
                    return values, None

                async def named_ratio(metric):
                    async def fetch():
                        symbol = row["exchange_token"] if row["exchange"] == "BSE" else row["symbol"]
                        fields, _ = await issuer(client, cache, f"{row['exchange']}:{symbol}")
                        direct = fields.get("display", {}).get(metric)
                        if direct is not None:
                            return {metric: direct}, fields.get("quarter")
                        return await screen_ratios.lookup(client, cache, fields, metric, session)
                    await resolve(cache, finance_key + ":" + metric, fetch, session=session)

                await asyncio.gather(resolve(cache, finance_key, financials, session=session, last=last),
                                     resolve(cache, price_key, prices, session=session))
                for metric in screen_ratios.METRICS:
                    await named_ratio(metric)

        await asyncio.gather(*(project(row) for row in report["rows"]))


async def serve(sessions):
    from .worker import owners
    while True:
        try:
            if os.getenv("UPSTOX_ANALYTICS_TOKEN"):
                for owner in await owners(sessions):
                    await fill(sessions, owner)
        except Exception:
            log.exception("BFS display refresh interrupted")
        await asyncio.sleep(20)
