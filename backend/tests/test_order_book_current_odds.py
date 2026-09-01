from app.domains.polymarket_auto_live.console_profile import (
    _read_yes_no_prices as read_console_prices,
)
from app.domains.polymarket_auto_live.scanner import (
    _read_yes_no_prices as read_scanner_prices,
)


def gamma_market() -> dict[str, object]:
    return {
        "outcomes": '["Yes", "No"]',
        "outcomePrices": '["0.125", "0.875"]',
        "bestBid": "0.01",
        "bestAsk": "0.44",
    }


def test_scanner_uses_executable_order_book_buy_prices() -> None:
    row = gamma_market()

    assert read_scanner_prices(["Yes", "No"], row) == (44.0, 99.0)


def test_console_uses_executable_order_book_buy_prices() -> None:
    row = gamma_market()

    assert read_console_prices(row, ["Yes", "No"]) == (44.0, 99.0)


def test_console_prefers_side_specific_bullpen_asks() -> None:
    row = {
        "outcomes": [
            {"name": "Yes", "bestAsk": "0.44"},
            {"name": "No", "bestAsk": "0.99"},
        ],
        "outcomePrices": '["0.125", "0.875"]',
    }

    assert read_console_prices(row, ["Yes", "No"]) == (44.0, 99.0)


def test_order_book_price_falls_back_to_indicative_odds() -> None:
    row = {
        "outcomes": '["Yes", "No"]',
        "outcomePrices": '["0.125", "0.875"]',
    }

    assert read_scanner_prices(["Yes", "No"], row) == (12.5, 87.5)
    assert read_console_prices(row, ["Yes", "No"]) == (12.5, 87.5)
