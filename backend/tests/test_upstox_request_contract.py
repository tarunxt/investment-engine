"""Offline wire-contract and diagnostic redaction checks; dummy token only."""
import asyncio
import json

import httpx
import pytest

from app.domains.zerodha import upstox_quotes as upstox
from scripts.diagnose_upstox_quote import diagnose, sanitized_result

KEY = "NSE_EQ|INE848E01016"
TOKEN = "offline-dummy-token"
URL = "https://api.upstox.com/v2/market-quote/quotes?instrument_key=NSE_EQ%7CINE848E01016"


def test_request_matches_documented_method_encoding_and_headers():
    with httpx.Client() as client:
        request = upstox.build_quote_request(client, [KEY], TOKEN)
        assert request.method == "GET"
        assert str(request.url) == URL
        assert request.content == b""
        assert request.headers["Authorization"] == "Bearer " + TOKEN
        assert request.headers["Accept"] == "application/json"
        assert request.headers["Content-Type"] == "application/json"
        assert request.headers["User-Agent"] == client.headers["User-Agent"]
        assert "api-version" not in request.headers
        assert TOKEN not in str(request.url)
        multiple = upstox.build_quote_request(client, [KEY, "BSE_EQ|INE848E01016", KEY], TOKEN)
        assert multiple.url.params["instrument_key"] == "BSE_EQ|INE848E01016," + KEY
        assert "%257C" not in str(multiple.url)


def test_production_and_diagnostic_send_identical_requests_once(monkeypatch):
    monkeypatch.setenv("UPSTOX_LTP_OWNER_USER_ID", "2")
    monkeypatch.setenv("UPSTOX_ANALYTICS_TOKEN", TOKEN)
    async def master(client): return {"NSE:NHPC": KEY}
    monkeypatch.setattr(upstox, "load_instruments", master)
    seen = []
    def handler(request):
        seen.append(request)
        return httpx.Response(403, json={"message": "Provider access denied"})
    real_client = httpx.AsyncClient
    monkeypatch.setattr(upstox.httpx, "AsyncClient", lambda **kwargs: real_client(transport=httpx.MockTransport(handler), **kwargs))
    # Wire contract is independent of Redis admission; distributed admission is
    # exercised end-to-end in test_upstox_quote_guard.py with mocked transport.
    class Guard:
        async def admit(self): return True
        async def count(self, field): pass
        async def backoff(self, value): pass
    assert asyncio.run(upstox._fetch_quotes(["NSE:NHPC"], Guard())) == []
    async def smoke():
        async with real_client(transport=httpx.MockTransport(handler), timeout=6, follow_redirects=False) as client:
            return await diagnose(client, KEY, TOKEN)
    result = asyncio.run(smoke())
    assert result["http_status"] == 403
    assert len(seen) == 2
    assert seen[0].method == seen[1].method
    assert seen[0].url == seen[1].url
    assert seen[0].headers == seen[1].headers
    assert seen[0].content == seen[1].content


@pytest.mark.parametrize("status,body,kind", [
    (403, {"message": "The site owner has blocked access based on your browser's signature."}, "json_object"),
    (401, {"errors": [{"errorCode": "UDAPI100050", "message": "Invalid token"}]}, "json_object"),
    (403, b"<html>Forbidden</html>", "html"),
    (200, {"data": {"NHPC": {"instrument_token": KEY, "last_price": 12.5}}}, "json_object"),
])
def test_diagnostic_safely_classifies_one_mocked_response(status, body, kind):
    calls = []
    def handler(request):
        calls.append(request)
        content = body if isinstance(body, bytes) else json.dumps(body).encode()
        return httpx.Response(status, content=content, headers={"Content-Type": "text/html" if isinstance(body, bytes) else "application/json", "x-request-id": "offline-request-1"})
    async def smoke():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=False) as client:
            return await diagnose(client, KEY, TOKEN)
    result = asyncio.run(smoke())
    assert len(calls) == 1
    assert result["http_status"] == status
    assert result["response_kind"] == kind
    assert result["request_id"] == "offline-request-1"
    assert TOKEN not in json.dumps(result)
    if status == 200: assert "positive finite" in result["error_message"]


def test_diagnostic_never_exposes_tokens_raw_body_or_transport_exception():
    secret = "dummy.header.signature"
    body = {"errors": [{"errorCode": "UDAPI100050", "message": "Bearer " + secret + " " + secret}], "private": secret}
    result = sanitized_result(403, {"content-type": "application/json", "x-request-id": secret}, json.dumps(body).encode(), secret, KEY)
    assert result["error_code"] == "UDAPI100050"
    assert secret not in json.dumps(result)
    assert "private" not in result
    assert result["request_id"] is None
    calls = []
    def handler(request):
        calls.append(request)
        raise httpx.ReadTimeout(secret)
    async def smoke():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await diagnose(client, KEY, secret)
    result = asyncio.run(smoke())
    assert len(calls) == 1
    assert result["error_code"] == "ReadTimeout"
    assert secret not in json.dumps(result)


def test_diagnostic_does_not_follow_redirects_or_dump_oversized_body():
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(302, headers={"Location": "https://example.invalid/"}, content=b"x" * 20000)
    async def smoke():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=False) as client:
            return await diagnose(client, KEY, TOKEN)
    result = asyncio.run(smoke())
    assert len(calls) == 1
    assert result["http_status"] == 302
    assert result["response_kind"] == "non_json"
    assert len(json.dumps(result)) < 600
