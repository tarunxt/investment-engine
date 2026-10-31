"""Owner-scoped, read-only Upstox quotes. Shared short-lived display cache; never execution prices."""
import asyncio
import gzip
import io
import json
import logging
import math
import os
import re
import time
from datetime import datetime, timezone

import httpx

logger = logging.getLogger(__name__)
_master = ({}, 0.0)
MASTER_TTL = 6 * 60 * 60
RECENT_TRADE_AGE = 120



def build_quote_request(client, instrument_keys, token):
    """Shared production/diagnostic wire contract; no retries or identity overrides."""
    return client.build_request(
        "GET", "https://api.upstox.com/v2/market-quote/quotes",
        params={"instrument_key": ",".join(sorted(set(instrument_keys)))},
        headers={"Authorization": "Bearer " + token, "Accept": "application/json",
                 "Content-Type": "application/json"},
    )


def configured_for(user_id):
    # No global credential may become an implicit shared market-data account.
    return (str(user_id) == os.getenv("UPSTOX_LTP_OWNER_USER_ID", "")
            and bool(os.getenv("UPSTOX_ANALYTICS_TOKEN", "")))


def instrument_map(rows):
    candidates = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        segment, symbol, key = (row.get(k) for k in ("segment", "trading_symbol", "instrument_key"))
        if segment not in {"NSE_EQ", "BSE_EQ"} or not isinstance(symbol, str):
            continue
        if not isinstance(key, str) or not re.fullmatch(segment + r"\|[A-Z0-9]{12}", key):
            continue
        instrument = segment[:3] + ":" + symbol
        candidates.setdefault(instrument, set()).add(key)
    # Ambiguous listings fail closed, never guess by name or cross exchange.
    return {symbol: next(iter(keys)) for symbol, keys in candidates.items() if len(keys) == 1}


async def load_instruments(client):
    global _master
    if time.monotonic() - _master[1] < MASTER_TTL and _master[0]:
        return _master[0]
    compressed = bytearray()
    async with client.stream("GET", "https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz") as response:
        response.raise_for_status()
        async for chunk in response.aiter_bytes():
            compressed.extend(chunk)
            if len(compressed) > 30_000_000:
                raise ValueError("Compressed instrument master exceeds size bound")
    def decode():
        # Bound decompression and keep JSON/decompression off the event loop.
        with gzip.GzipFile(fileobj=io.BytesIO(compressed)) as stream:
            raw = stream.read(120_000_001)
        if len(raw) > 120_000_000:
            raise ValueError("Instrument master exceeds size bound")
        rows = json.loads(raw)
        if not isinstance(rows, list):
            raise ValueError("Invalid instrument master")
        return instrument_map(rows)
    mapping = await asyncio.to_thread(decode)
    _master = (mapping, time.monotonic())
    return mapping


def normalize_quotes(data, requested, now):
    if not isinstance(data, dict):
        return []
    by_key = {}
    for row in data.values():
        if isinstance(row, dict) and isinstance(row.get("instrument_token"), str):
            by_key.setdefault(row.get("instrument_token"), []).append(row)
    quotes = []
    for instrument, key in requested.items():
        rows = by_key.get(key, [])
        if len(rows) != 1:
            continue
        row = rows[0]
        price = row.get("last_price")
        if isinstance(price, bool) or not isinstance(price, (int, float)) or not math.isfinite(price) or price <= 0:
            continue
        if isinstance(row.get("last_trade_time"), bool):
            continue
        try:
            traded = datetime.fromtimestamp(float(row["last_trade_time"]) / 1000, timezone.utc)
        except (KeyError, TypeError, ValueError, OverflowError, OSError):
            continue
        age = (now - traded).total_seconds()
        # LTP remains useful after close and for illiquid stocks. Its trade age
        # must never be hidden behind the freshness of this HTTP request.
        if traded.timestamp() <= 0 or age < 0:
            continue
        freshness = "recent last trade" if age <= RECENT_TRADE_AGE else "older last trade; market may be closed or instrument illiquid"
        quotes.append({"instrument": instrument, "price": price, "as_of": traded.isoformat(),
                       "source": ("Upstox /market-quote/quotes last_price · exact venue · exchange last trade time · "
                                  f"{freshness} · trade age {int(age)}s · retrieved {now.isoformat()} · display only; not an execution quote")})
    return quotes


async def read_upstox_quotes(user_id, instruments):
    if not instruments or not configured_for(user_id):
        return []
    from .upstox_quote_guard import guarded_quotes
    return await guarded_quotes(user_id, instruments, lambda guard: _fetch_quotes(instruments, guard))


async def _fetch_quotes(instruments, guard):
    try:
        # Budget already reserved, including failures and timeout uncertainty.
        async with asyncio.timeout(15):
            async with httpx.AsyncClient(timeout=6, follow_redirects=False) as client:
                mapping = await load_instruments(client)
                requested = {key: mapping[key] for key in instruments if key in mapping}
                if not requested:
                    await guard.count("unmapped")
                    return []
                request = build_quote_request(client, requested.values(), os.environ["UPSTOX_ANALYTICS_TOKEN"])
                response = await client.send(request)
                if response.status_code == 429:
                    await guard.backoff(response.headers.get("Retry-After"))
                    logger.warning("Upstox quote rate limited; shared cooldown applied")
                    return []
                response.raise_for_status()
                payload = response.json()
                if not isinstance(payload, dict) or payload.get("status") != "success":
                    await guard.count("invalid_response")
                    logger.warning("Upstox read-only quote fallback returned invalid status")
                    return []
                rows = normalize_quotes(payload.get("data"), requested, datetime.now(timezone.utc))
                await guard.count("success" if rows else "empty_response")
                return rows
    except (httpx.HTTPError, TimeoutError, ValueError, OSError, EOFError):
        await guard.count("provider_failure")
        logger.warning("Upstox read-only quote fallback unavailable")
        return []
