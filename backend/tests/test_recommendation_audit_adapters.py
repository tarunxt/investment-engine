# Synthetic security, holdings, scores, prices and times; no user portfolio data.
from contextlib import contextmanager
import json
import pytest
from app.domains.recommendation_audit.adapters import get_bytes, kite_read, rbi_read


class Response:
    def __init__(self,text,status=200): self.text=text;self.status_code=status
    def __enter__(self): return self
    def __exit__(self,*args): pass
    def raise_for_status(self):
        if self.status_code>=400: raise ValueError("HTTP error")
    def iter_content(self,size):
        raw=self.text.encode()
        for i in range(0,len(raw),size): yield raw[i:i+size]


@pytest.mark.parametrize("url",["http://api.kite.trade/quote","https://evil.example/quote","https://api.kite.trade/orders","https://api.kite.trade/quote#fragment","https://user:pass@api.kite.trade/quote","https://www.rbi.org.in/scripts/BS_PressReleaseDisplay.aspx?prid=1&redirect=evil"])
def test_transport_allowlist_blocks_unrequested_targets(url):
    def never(*args,**kwargs): raise AssertionError("Network called")
    with pytest.raises(ValueError,match="allowlist"): get_bytes(url,transport=never)


def test_transport_blocks_redirects_and_large_responses():
    with pytest.raises(ValueError,match="Redirects"): get_bytes("https://api.kite.trade/quote",transport=lambda *a,**k:Response("",302))
    with pytest.raises(ValueError,match="byte limit"): get_bytes("https://api.kite.trade/quote",transport=lambda *a,**k:Response("x"*262145))


def test_kite_uses_only_two_bounded_gets_and_preserves_unknown_availability():
    calls=[]
    def transport(url,**kwargs):
        calls.append((url,kwargs));assert kwargs["timeout"]==(3,10) and kwargs["allow_redirects"] is False
        if url.endswith("/quote"): return Response(json.dumps({"data":{"NSE:FIXTUREEQ":{"instrument_token":123,"last_price":100}}}))
        return Response(json.dumps({"data":{"candles":[["2024-01-31T00:00:00+0530",100,105,95,100,12345],["2024-02-01T00:00:00+0530",100,105,80,80,12345]]}}))
    source=kite_read({"market":"india","exchange":"NSE","symbol":"FIXTUREEQ","decision_at":"2024-02-01T04:00:00+00:00"},api_key="fixture",access_token="fixture",transport=transport)
    assert len(calls)==2 and all("orders" not in c[0] for c in calls)
    assert source["candles"][0]["complete"] is True and source["candles"][1]["complete"] is False
    assert all(c["available_at"] is None for c in source["candles"])


def test_rbi_does_not_turn_html_into_stock_exit_proof():
    source=rbi_read("https://www.rbi.org.in/scripts/BS_PressReleaseDisplay.aspx?prid=63742",transport=lambda *a,**k:Response("Growth resilient; repo increased by 25 bps"))
    assert source["available_at"] is None
    assert "verdict" not in source and "content_hash" in source
