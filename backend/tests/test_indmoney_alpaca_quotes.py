"""No credentials, network or account operations; only fake market-data transport."""
import asyncio
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from app.domains.indmoney_us import alpaca_quotes as quotes

NOW = datetime(2026, 11, 2, 15, tzinfo=timezone.utc)
LISTING = {"instrument": "NASDAQ:ABC", "symbol": "ABC", "listing_mic": "XNAS", "share_class": "common", "security_id": "fixture:ABC:common:XNAS", "vendor_symbol": "ABC", "currency": "USD", "verified": True}


def test_request_is_fixed_read_only_iex_usd_no_trading_endpoints():
    with httpx.Client() as client:
        request = quotes.build_request(client, ["ABC", "ABC"], "dummy-id", "dummy-secret")
    assert request.method == "GET"
    assert str(request.url).startswith("https://data.alpaca.markets/v2/stocks/trades/latest?")
    assert dict(request.url.params) == {"symbols": "ABC", "feed": "iex", "currency": "USD"}
    assert request.headers["APCA-API-KEY-ID"] == "dummy-id"


def test_verified_mapping_requires_mic_usd_class_and_unique_vendor_symbol():
    assert quotes.verified_listings([LISTING]) == {"NASDAQ:ABC": LISTING}
    for patch in ({"verified": False}, {"listing_mic": "XNYS"}, {"currency": "INR"}, {"share_class": ""}, {"security_id": ""}, {"instrument": "US:ABC"}):
        assert quotes.verified_listings([{**LISTING, **patch}]) == {}
    assert quotes.verified_listings([LISTING, LISTING]) == {}
    other = {**LISTING, "instrument": "NYSE:ABC", "listing_mic": "XNYS"}
    assert quotes.verified_listings([LISTING, other]) == {}


def normalize(trade):
    return quotes.normalize_quotes({"trades": {"ABC": trade}}, {"NASDAQ:ABC": LISTING}, NOW)


def test_trade_timestamp_receipt_iex_execution_and_primary_listing_are_distinct():
    row = normalize({"p": 123.5, "t": (NOW - timedelta(seconds=2)).isoformat(), "x": "V"})[0]
    assert row["price"] == 123.5
    assert row["feed"] == "iex" and row["currency"] == "USD"
    assert row["listing_mic"] == "XNAS"
    assert row["as_of"] != row["received_at"]
    assert row["coverage"] == "IEX only; not consolidated US market LTP"
    assert row["stale"] is False
    assert row["eligible_for_readiness"] is False  # no verified holiday/calendar gate
    stale = normalize({"p": 123.5, "t": (NOW - timedelta(days=1)).isoformat(), "x": "V"})[0]
    assert stale["stale"] is True and stale["delay_reason"]
    assert stale["eligible_for_readiness"] is False


@pytest.mark.parametrize("patch", [{"p": 0}, {"p": -1}, {"p": True}, {"p": float("inf")}, {"p": float("nan")}, {"t": None}, {"t": "2026-11-02T15:00:00"}, {"t": "2026-11-02T15:00:01Z"}, {"x": "Q"}])
def test_invalid_or_undated_or_other_feed_trades_stay_unavailable(patch):
    assert normalize({"p": 1, "t": NOW.isoformat(), "x": "V", **patch}) == []


def test_missing_or_extra_vendor_symbol_rejects_scope():
    assert quotes.normalize_quotes({"trades": {}}, {"NASDAQ:ABC": LISTING}, NOW) == []
    assert quotes.normalize_quotes({"trades": {"OTHER": {"p": 1, "t": NOW.isoformat(), "x": "V"}}}, {"NASDAQ:ABC": LISTING}, NOW) == []


def test_unconfigured_or_other_owner_never_reaches_transport(monkeypatch):
    monkeypatch.delenv("ALPACA_LTP_ENABLED", raising=False)
    result = asyncio.run(quotes.read_alpaca_quotes(999, ["NASDAQ:ABC"]))
    assert result["quotes"] == [] and "not configured" in result["missing"][0]["reason"]
    monkeypatch.setenv("ALPACA_LTP_ENABLED", "true")
    monkeypatch.setenv("ALPACA_LTP_OWNER_USER_ID", "123")
    monkeypatch.setenv("ALPACA_DATA_KEY_ID", "dummy")
    monkeypatch.setenv("ALPACA_DATA_SECRET_KEY", "dummy")
    assert quotes.configured_for(999) is False
    assert quotes.configured_for(123) is True


def test_instrument_validation_is_bounded_and_does_not_guess_us_venue():
    for instruments in ([], ["US:ABC"], ["NASDAQ:ABC"] * 51, ["NASDAQ:../orders"]):
        with pytest.raises(ValueError):
            quotes.validate_instruments(instruments)

@pytest.mark.parametrize("status", [200, 401, 403, 429])
def test_mock_transport_is_data_only_and_rate_errors_fail_closed(monkeypatch, status):
    import json
    from app.domains.zerodha import upstox_quote_guard as guard_module
    monkeypatch.setenv("ALPACA_LTP_ENABLED", "true")
    monkeypatch.setenv("ALPACA_LTP_OWNER_USER_ID", "123")
    monkeypatch.setenv("ALPACA_DATA_KEY_ID", "dummy-id")
    monkeypatch.setenv("ALPACA_DATA_SECRET_KEY", "dummy-secret")
    monkeypatch.setenv("ALPACA_LTP_LISTINGS_JSON", json.dumps([LISTING]))
    seen, cooldown = [], []
    class Context:
        async def __aenter__(self): return self
        async def __aexit__(self, *_): pass
    class Guard:
        def __init__(self, *_):
            for field in ("base", "cache", "lock", "stats", "cooldown"):
                setattr(self, field, "upstox:full-quotes:v1:fixture:" + field)
        async def run(self, fetch): return await fetch(self)
        async def admit(self): return True
        async def backoff(self, value): cooldown.append(value)
    monkeypatch.setattr(guard_module, "redis_client", Context)
    monkeypatch.setattr(guard_module, "QuoteGuard", Guard)
    def transport(request):
        seen.append(request)
        return httpx.Response(status, headers={"Retry-After": "61"}, json={"trades": {"ABC": {"p": 123.5, "t": NOW.isoformat(), "x": "V"}}})
    real_client = httpx.AsyncClient
    monkeypatch.setattr(quotes.httpx, "AsyncClient", lambda **kwargs: real_client(transport=httpx.MockTransport(transport), **kwargs))
    result = asyncio.run(quotes.read_alpaca_quotes(123, ["NASDAQ:ABC"]))
    assert len(seen) == 1 and seen[0].method == "GET"
    assert seen[0].url.host == "data.alpaca.markets"
    assert seen[0].url.params["feed"] == "iex"
    assert bool(result["quotes"]) is (status == 200)
    assert cooldown == (["61"] if status == 429 else [])
    assert "dummy-secret" not in json.dumps(result)
