import os
from datetime import datetime, timezone

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://test:test@localhost:5432/testdb",
)
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

from app.domains.indmoney_us.price_service import IndMoneyUsCurrentPriceService


QUOTE_HTML = """
<script class="ds:2">
AF_initDataCallback({key: 'ds:2', hash: '6', data:[[[["/m/07zllzd",["NVDA","NASDAQ"],"NVIDIA Corp",0,"USD",[211.14,-3.1100006,-1.4515755,2,2,2],null,214.25,"#5b9001","US","/m/09rh_",[1780101000],"America/New_York",-14400,"/m/07zllzd",null,[212.49,1.3500061,0.6393891,2,2,2],[1780084801],[1780099198],[[1,[2026,5,29,9,30,null,null,[-14400]],[2026,5,29,16,null,null,null,[-14400]]]],null,"NVDA:NASDAQ",0,null,null,null,0]]]], sideChannel: {}});
</script>
"""


def test_parse_quote_page_extracts_current_price_fields():
    service = IndMoneyUsCurrentPriceService()

    parsed = service.parse_quote_page(
        QUOTE_HTML,
        exchange="NASDAQ",
        symbol="NVDA",
        now=datetime(2026, 5, 29, 19, 0, tzinfo=timezone.utc),
    )

    assert parsed["exchange"] == "NASDAQ"
    assert parsed["symbol"] == "NVDA"
    assert parsed["company_name"] == "NVIDIA Corp"
    assert parsed["currency"] == "USD"
    assert parsed["current_price"] == 211.14
    assert parsed["previous_close"] == 214.25
    assert parsed["change_value"] == -3.1100006
    assert parsed["change_percent"] == -1.4515755


def test_parse_quote_page_marks_market_open_only_inside_session_window():
    service = IndMoneyUsCurrentPriceService()

    open_session = service.parse_quote_page(
        QUOTE_HTML,
        exchange="NASDAQ",
        symbol="NVDA",
        now=datetime(2026, 5, 29, 17, 0, tzinfo=timezone.utc),
    )
    closed_session = service.parse_quote_page(
        QUOTE_HTML,
        exchange="NASDAQ",
        symbol="NVDA",
        now=datetime(2026, 5, 31, 17, 0, tzinfo=timezone.utc),
    )

    assert open_session["market_open"] is True
    assert open_session["session_open_at"] == datetime(2026, 5, 29, 13, 30, tzinfo=timezone.utc)
    assert open_session["session_close_at"] == datetime(2026, 5, 29, 20, 0, tzinfo=timezone.utc)
    assert closed_session["market_open"] is False
    assert closed_session["session_close_at"] == datetime(2026, 5, 29, 20, 0, tzinfo=timezone.utc)
