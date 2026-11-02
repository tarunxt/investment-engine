"""Owner-scoped IEX display estimates. No account, asset, paper or trading API calls.

Configured listing records must come from a separately verified security master.
No generic US alias, guessed listing, currency, or share class is inferred here.
"""
import asyncio
import hashlib
import json
import logging
import math
import os
import re
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import httpx

logger = logging.getLogger(__name__)
URL = "https://data.alpaca.markets/v2/stocks/trades/latest"
MIC = {"NASDAQ": "XNAS", "NYSE": "XNYS", "NYSEARCA": "ARCX", "NYSEAMERICAN": "XASE"}
MAX_AGE_SECONDS = 120


def validate_instruments(instruments):
    if not 1 <= len(instruments) <= 50 or any(not isinstance(key, str) or not re.fullmatch(r"(?:NASDAQ|NYSE|NYSEARCA|NYSEAMERICAN):[A-Z0-9.-]{1,24}", key) for key in instruments):
        raise ValueError("Choose 1 to 50 exact supported US listings; generic US is not a listing")
    return sorted(set(instruments))


def verified_listings(raw):
    """Validate operator-verified mapping; never query a trading assets endpoint."""
    if not isinstance(raw, list) or len(raw) > 1000:
        return {}
    candidates = {}
    vendor_symbols = {}
    for row in raw:
        if not isinstance(row, dict):
            continue
        instrument, vendor = row.get("instrument"), row.get("vendor_symbol")
        if not isinstance(instrument, str) or not isinstance(vendor, str):
            continue
        try:
            validate_instruments([instrument])
        except ValueError:
            continue
        venue, symbol = instrument.split(":")
        if (row.get("listing_mic") != MIC[venue] or row.get("currency") != "USD"
                or row.get("verified") is not True
                or not isinstance(row.get("share_class"), str) or not row["share_class"].strip()
                or not isinstance(row.get("security_id"), str) or not row["security_id"].strip()
                or not re.fullmatch(r"[A-Z0-9.-]{1,24}", vendor)
                or row.get("symbol") != symbol):
            continue
        candidates.setdefault(instrument, []).append(row)
        vendor_symbols.setdefault(vendor, set()).add(instrument)
    return {key: rows[0] for key, rows in candidates.items() if len(rows) == 1 and len(vendor_symbols[rows[0]["vendor_symbol"]]) == 1}


def read_verified_listings(user_id):
    """Nonsecret owner-bound metadata only. No key access or provider request."""
    if str(user_id) != os.getenv("ALPACA_LTP_OWNER_USER_ID", ""):
        return {"listings": [], "reason": "Verified US listing metadata is not configured for this owner"}
    try:
        rows = list(verified_listings(json.loads(os.getenv("ALPACA_LTP_LISTINGS_JSON", "[]"))).values())
    except (ValueError, TypeError):
        rows = []
    allowed = {"instrument", "symbol", "listing_mic", "share_class", "security_id", "vendor_symbol", "currency", "verified"}
    return {"listings": [{key: row[key] for key in allowed} for row in rows], "reason": None if rows else "Verified US listing MIC, symbol and share-class metadata unavailable"}


def configured_for(user_id):
    # This is an application restraint. Paper keys may still permit paper trades.
    return (os.getenv("ALPACA_LTP_ENABLED") == "true"
            and str(user_id) == os.getenv("ALPACA_LTP_OWNER_USER_ID", "")
            and bool(os.getenv("ALPACA_DATA_KEY_ID"))
            and bool(os.getenv("ALPACA_DATA_SECRET_KEY")))


def build_request(client, symbols, key_id, secret):
    # Fixed host/method/path/feed: keys can never reach a trading endpoint here.
    return client.build_request("GET", URL, params={"symbols": ",".join(sorted(set(symbols))), "feed": "iex", "currency": "USD"}, headers={"APCA-API-KEY-ID": key_id, "APCA-API-SECRET-KEY": secret, "Accept": "application/json"})


def normalize_quotes(payload, mapping, received_at):
    trades = payload.get("trades") if isinstance(payload, dict) else None
    if not isinstance(trades, dict) or set(trades) - {row["vendor_symbol"] for row in mapping.values()}:
        return []
    result = []
    for instrument, listing in mapping.items():
        trade = trades.get(listing["vendor_symbol"])
        if not isinstance(trade, dict):
            continue
        price = trade.get("p")
        if isinstance(price, bool) or not isinstance(price, (int, float)) or not math.isfinite(price) or price <= 0:
            continue
        stamp = trade.get("t")
        try:
            if not isinstance(stamp, str):
                continue
            traded = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
            if traded.tzinfo is None:
                continue
            traded = traded.astimezone(timezone.utc)
        except (ValueError, OverflowError):
            continue
        age = (received_at - traded).total_seconds()
        # IEX execution venue is distinct from the security's primary listing MIC.
        if age < 0 or traded.timestamp() <= 0 or trade.get("x") != "V":
            continue
        local = traded.astimezone(ZoneInfo("America/New_York"))
        minute = local.hour * 60 + local.minute
        session = "regular_hours_time_window_unverified_calendar" if local.weekday() < 5 and 570 <= minute < 960 else "outside_regular_hours_time_window"
        stale = age > MAX_AGE_SECONDS
        result.append({"instrument": instrument, "security_id": listing["security_id"], "symbol": listing["symbol"], "listing_mic": listing["listing_mic"], "share_class": listing["share_class"], "vendor_symbol": listing["vendor_symbol"], "currency": "USD", "provider": "Alpaca", "feed": "iex", "coverage": "IEX only; not consolidated US market LTP", "price": price, "as_of": traded.isoformat(), "received_at": received_at.isoformat(), "session": session, "stale": stale, "delay_reason": "older IEX last trade" if stale else None, "eligible_for_readiness": False, "source": "US vendor Alpaca · IEX only · not consolidated US LTP · source last-trade time · display estimate"})
    return result


async def read_alpaca_quotes(user_id, instruments):
    keys = validate_instruments(instruments)
    missing = lambda reason: {"quotes": [], "missing": [{"instrument": key, "reason": reason} for key in keys], "provider": "Alpaca", "feed": "iex"}
    if not configured_for(user_id):
        return missing("Alpaca IEX display data is not configured for this owner")
    try:
        mapping = verified_listings(json.loads(os.getenv("ALPACA_LTP_LISTINGS_JSON", "[]")))
    except (ValueError, TypeError):
        return missing("Verified listing mapping unavailable")
    requested = {key: mapping[key] for key in keys if key in mapping}
    if not requested:
        return missing("Verified listing MIC, share class, symbol and USD mapping required")
    # Reuse the existing shared Redis guard's conservative sliding budget,
    # short cache, coalescing and 429 cooldown, with isolated Alpaca keys.
    from app.domains.zerodha.upstox_quote_guard import QuoteGuard, redis_client
    generation = hashlib.sha256((os.environ["ALPACA_DATA_KEY_ID"] + os.environ["ALPACA_DATA_SECRET_KEY"] + json.dumps(requested, sort_keys=True)).encode()).hexdigest()
    async def fetch(guard):
        try:
            async with asyncio.timeout(15):
                if not await guard.admit():
                    return []
                async with httpx.AsyncClient(timeout=6, follow_redirects=False) as client:
                    response = await client.send(build_request(client, [row["vendor_symbol"] for row in requested.values()], os.environ["ALPACA_DATA_KEY_ID"], os.environ["ALPACA_DATA_SECRET_KEY"]))
                if response.status_code == 429:
                    await guard.backoff(response.headers.get("Retry-After"))
                    return []
                response.raise_for_status()
                return normalize_quotes(response.json(), requested, datetime.now(timezone.utc))
        except (httpx.HTTPError, TimeoutError, ValueError):
            logger.warning("Alpaca IEX display read unavailable")
            return []
    try:
        async with redis_client() as redis:
            guard = QuoteGuard(redis, user_id, generation, keys)
            for attr in ("base", "cache", "lock", "stats", "cooldown"):
                setattr(guard, attr, getattr(guard, attr).replace("upstox:full-quotes:v1:", "alpaca:iex-display:v1:", 1))
            quotes = await guard.run(fetch)
    except Exception:
        logger.warning("Alpaca display coordination unavailable; provider read suppressed")
        return missing("Shared quote coordination unavailable")
    # Recompute age after cache reads. Preserve the original source/receipt times.
    now = datetime.now(timezone.utc)
    for quote in quotes:
        quote["stale"] = (now - datetime.fromisoformat(quote["as_of"])).total_seconds() > MAX_AGE_SECONDS
        quote["delay_reason"] = "older IEX last trade" if quote["stale"] else None
        quote["eligible_for_readiness"] = quote["eligible_for_readiness"] and not quote["stale"]
    found = {quote["instrument"] for quote in quotes}
    return {"quotes": quotes, "missing": [{"instrument": key, "reason": "Verified listing mapping required" if key not in requested else "IEX trade unavailable, invalid, quota limited or provider rejected"} for key in keys if key not in found], "provider": "Alpaca", "feed": "iex"}
