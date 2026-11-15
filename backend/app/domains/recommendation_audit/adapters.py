"""Bounded read-only transports. No LLM, orders, token refresh, or hidden retry."""
from datetime import datetime, timedelta, timezone
import json
import re
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo
import requests
from .deterministic import digest

MAX_BYTES = 262_144


def get_bytes(url, *, headers=None, params=None, transport=None):
    from .fundamentals import official_filing_url
    parsed = urlsplit(url)
    allowed = (parsed.scheme == "https" and not parsed.username and not parsed.password and not parsed.fragment and parsed.port in {None, 443} and (
        parsed.hostname == "api.kite.trade" and (parsed.path == "/quote" or re.fullmatch(r"/instruments/historical/[1-9][0-9]{0,12}/day", parsed.path)) or
        parsed.hostname == "www.rbi.org.in" and parsed.path == "/scripts/BS_PressReleaseDisplay.aspx" and re.fullmatch(r"prid=[1-9][0-9]{0,8}", parsed.query) or official_filing_url(url)))
    if not allowed: raise ValueError("Source URL is outside the read-only allowlist")
    send = transport or requests.get
    with send(url, headers=headers or {}, params=params, timeout=(3, 10), allow_redirects=False, stream=True) as response:
        response.raise_for_status()
        if not 200 <= response.status_code < 300: raise ValueError("Redirects and non-success responses are blocked")
        chunks, size = [], 0
        for chunk in response.iter_content(8192):
            size += len(chunk)
            if size > MAX_BYTES: raise ValueError("Source response exceeds byte limit")
            chunks.append(chunk)
    raw = b"".join(chunks)
    return raw.decode("utf-8"), datetime.now(timezone.utc)


def kite_read(decision, *, api_key, access_token, transport=None):
    if decision.get("market") != "india" or decision.get("exchange") not in {"NSE", "BSE"}: raise ValueError("Kite only supports captured Indian exchange identities")
    symbol = decision["symbol"]
    if not re.fullmatch(r"[A-Z0-9&_.-]{1,64}", symbol): raise ValueError("Invalid instrument symbol")
    identity = f"{decision['exchange']}:{symbol}"
    headers = {"X-Kite-Version": "3", "Authorization": f"token {api_key}:{access_token}"}
    quote_text, observed = get_bytes("https://api.kite.trade/quote", headers=headers, params={"i": identity}, transport=transport)
    quote = json.loads(quote_text).get("data", {}).get(identity)
    if not isinstance(quote, dict) or type(quote.get("instrument_token")) is not int or quote["instrument_token"] <= 0: raise ValueError("Quote did not resolve the exact captured exchange:symbol")
    token = quote["instrument_token"]
    end = datetime.fromisoformat(decision["decision_at"]).astimezone(ZoneInfo("Asia/Kolkata"))
    start = end - timedelta(days=14)
    url = f"https://api.kite.trade/instruments/historical/{token}/day"
    candle_text, observed = get_bytes(url, headers=headers, params={"from": start.strftime("%Y-%m-%d %H:%M:%S"), "to": end.strftime("%Y-%m-%d %H:%M:%S"), "continuous": 0, "oi": 0}, transport=transport)
    rows = json.loads(candle_text).get("data", {}).get("candles", [])
    if not isinstance(rows, list) or len(rows) > 32: raise ValueError("Unexpected historical candle shape or coverage")
    candles = []
    for row in rows:
        if not isinstance(row, list) or len(row) < 6: raise ValueError("Malformed candle")
        opened = datetime.fromisoformat(row[0]).astimezone(ZoneInfo("Asia/Kolkata"))
        completed = opened.replace(hour=15, minute=30, second=0, microsecond=0)
        # Timestamp identifies the session; API supplies no original publication timestamp.
        candles.append({"opened_at": opened.isoformat(), "completed_at": completed.isoformat(), "available_at": None, "close": row[4], "complete": completed <= end})
    return {"source_id": "kite-historical-day-v1", "source_url": url, "content_hash": digest(candle_text), "observed_at": observed.isoformat(), "identity": identity, "instrument_token": token, "isin_verified": False, "quote": quote, "candles": candles,
        "limitations": ["Instrument token resolved now; historical token/security continuity is not independently certified", "Historical API does not report original publication time; ex-ante availability remains unknown", "Quote is contextual and cannot prove a completed daily-close trigger"]}


def rbi_read(url, *, transport=None):
    text, observed = get_bytes(url, transport=transport)
    # Preserve evidence. No semantic rate decision is inferred from arbitrary HTML numbers.
    return {"source_id": "rbi-press-release-v1", "source_url": url, "content_hash": digest(text), "observed_at": observed.isoformat(), "available_at": None,
        "content": text, "limitations": ["Original intraday publication time not supplied by this transport", "Official macro context does not establish a stock-specific exit"]}
