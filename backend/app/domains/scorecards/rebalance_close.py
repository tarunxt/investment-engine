"""Recover exact listing/session candles without advancing the decision's market date."""
import asyncio
from datetime import datetime, timezone
from collections import defaultdict
import os
from urllib.parse import urlencode

from app.domains.zerodha.upstox_quote_guard import QuoteGuard
from app.domains.zerodha.upstox_quotes import configured_for
from .research import INDIA, bar, download
from .technical_sources import ERRORS, archive_url, extract_archive

QUOTE_URL = "https://api.upstox.com/v3/market-quote/ohlc"


async def recover_closes(client, cache, manifest, username, history, master, *, refresh):
    if not refresh:
        return
    cutoff = datetime.fromisoformat(manifest["as_of"])
    missing = defaultdict(dict)
    dates = {}
    for stock in manifest["stocks"]:
        key = stock["listing"]
        venue = stock["exchange"]
        calendar = history["calendars"].get(venue, {})
        if not calendar:
            continue
        day = max(calendar)
        close = calendar[day]
        isin = master.get(key, {}).get("isin")
        rows = history["listings"].setdefault(key, [])
        if isin and datetime.fromisoformat(close) <= cutoff and not any(
            row.get("kind") == "daily_bar" and row["as_of"][:10] == day for row in rows
        ):
            missing[venue][key] = isin
            dates[venue] = (day, close)

    def retain(key, item):
        item["received_at"] = datetime.now(timezone.utc).isoformat()
        history["listings"][key].append(item)

    async def exchange(venue, wanted):
        day, close = dates[venue]
        url = archive_url(venue, day)
        try:
            data = await download(client, url, limit=6_000_000)
            rows = await asyncio.to_thread(extract_archive, data, venue, day, close, wanted, url)
            for key, candidates in rows.items():
                if len(candidates) == 1 and candidates[0].get("isin") == wanted[key]:
                    retain(key, dict(candidates[0], recovered_close=True))
                    del wanted[key]
        except ERRORS:
            return

    # A later official publication may be used only in a separate recovery output.
    await asyncio.gather(*(exchange(venue, wanted) for venue, wanted in missing.items()))

    instruments = {venue + "_EQ|" + isin: key for venue, wanted in missing.items() for key, isin in wanted.items()}
    if not instruments or cache is None or not configured_for(manifest["owner_id"], username):
        return
    owner = os.getenv("UPSTOX_LTP_OWNER_USER_ID") or manifest["owner_id"]
    guard = QuoteGuard(cache, owner, "rebalance-close", instruments)
    keys = sorted(instruments)
    for start in range(0, len(keys), 100):
        batch = keys[start:start + 100]
        try:
            if not await guard.admit():
                return
            response = await client.get(QUOTE_URL, params={"instrument_key": ",".join(batch), "interval": "1d"},
                                        headers={"Authorization": "Bearer " + os.environ["UPSTOX_ANALYTICS_TOKEN"]})
            if response.status_code == 429:
                await guard.backoff(response.headers.get("Retry-After"))
                return
            response.raise_for_status()
            for quote in response.json()["data"].values():
                instrument = quote.get("instrument_token")
                if instrument not in batch:
                    continue
                key = instruments[instrument]
                day, close = dates[key[:3]]
                for field in ("live_ohlc", "prev_ohlc"):
                    candle = quote.get(field) or {}
                    ts = candle.get("ts")
                    if type(ts) not in (int, float):
                        continue
                    session = datetime.fromtimestamp(ts / 1000, INDIA).date()
                    if session.isoformat() != day:
                        continue
                    url = QUOTE_URL + "?" + urlencode({"instrument_key": instrument, "interval": "1d"})
                    item = bar(session, INDIA, [candle.get(k) for k in ("open","high","low","close","volume")], url, cutoff)
                    if item and datetime.now(timezone.utc) >= datetime.fromisoformat(close):
                        retain(key, dict(item, as_of=close, basis="unverified-provider", recovered_close=True))
                        break
        except (*ERRORS, AttributeError, OverflowError):
            continue
