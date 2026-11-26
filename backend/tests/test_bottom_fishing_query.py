from datetime import datetime
from zoneinfo import ZoneInfo

import pytest
from lxml import html

from app.domains.bottom_fishing.issuer import issuer_fields
from app.domains.bottom_fishing.query import compile_query, evaluate
from app.domains.bottom_fishing.query_evidence import apply_screen, macd


def test_query_preserves_screener_precedence_and_missing_values():
    query = compile_query("Current price <= Low price + 0.20 * (High price - Low price)\nAND Return over 1day > -2 OR MACD > MACD Previous Day")
    values = dict(price=22, low_52w=20, high_52w=30, day_return=-1)
    assert evaluate(query, values) is True
    assert evaluate(query, dict(values, price=23)) is None
    assert evaluate(query, dict(values, price=23, macd=-1, previous_macd=-0.5)) is False
    assert evaluate(compile_query("Market Capitalization / Debt to equity > 1"), dict(cap=10, leverage=0)) is None
    for invalid in ("", "No such ratio < 3", "1 < 2 < 3", "Current price > (", "_price > 0", "Latest ratio() > 0"):
        with pytest.raises(ValueError):
            compile_query(invalid)


def test_published_issuer_fields_and_macd():
    root = html.fromstring('<ul id="top-ratios"><li><span class="name">High / Low</span><span class="number">40</span>/<span class="number">20</span></li></ul>')
    assert issuer_fields(root) == {"high_52w": 40, "low_52w": 20}
    values = macd([10]*60, 11)
    assert values["macd"] == pytest.approx(2/13-2/27)
    assert values["previous_macd"] == 0
    assert macd([10]*8, 11) == {}


@pytest.mark.asyncio
async def test_saved_query_filters_candidates_before_scoring_and_preserves_holdings():
    stamp = datetime(2026, 11, 25, 15, 30, tzinfo=ZoneInfo("Asia/Kolkata"))
    setup = dict(member=True, low=100, width=40, previous=100)
    levels = {symbol: setup for symbol in ("A","B","C")}
    series = {symbol: [dict(end=stamp.isoformat(), close=price)] for symbol,price in [("A",101),("B",104)]}
    state = {"setups": {}, "positions": {"B": {"qty": 1}}}
    coverage = {}
    async def screened(text):
        return await apply_screen(None,None,None,{"screen_query":text},stamp,{},levels,series,state,coverage)
    assert set(await screened("Current price < 103")) == {"A"}
    assert coverage == {"query_passed":1,"query_excluded":1,"query_missing":1}
    state["setups"]["A"] = setup.copy()
    assert set(await screened("Current price > 103")) == {"B"}
    assert state["setups"] == {}
    assert state["positions"] == {"B":{"qty":1}}


@pytest.mark.asyncio
async def test_original_results_preserve_every_company_and_check_pagination():
    import httpx
    from datetime import datetime, timezone
    from app.domains.bottom_fishing.screener_results import original_results

    def respond(request):
        assert request.url.params["latest"] == "on"
        assert request.url.params["query"] == "Market Capitalization > 300"
        symbol = "ABC" if "page" not in request.url.params else "DEF"
        return httpx.Response(200, text=f'<body>2 results found<table><tr><td><a href="/company/{symbol}/">{symbol}</a></td></tr></table></body>')

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        report = await original_results(client, {"screen_query":"Market Capitalization > 300","latest_results":True}, datetime.now(timezone.utc))
    assert report["complete"] and [r["symbol"] for r in report["rows"]] == ["ABC","DEF"]
