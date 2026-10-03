import pytest

from app.domains.indmoney_us.service import IndMoneyUsPortfolioService
from app.domains.indmoney_us.snapshot_validation import validate_holdings_snapshot
from app.shared.exceptions import ValidationException
from test_indmoney_us_parser import RAW_SNAPSHOT


def test_explore_page_cannot_become_a_portfolio_snapshot():
    parsed = IndMoneyUsPortfolioService().parse_snapshot(
        "My US Stocks\nUS Stocks / Explore\nTop Gainers\nNvidia\nNVDA\n$233.95\n"
    )
    with pytest.raises(ValidationException, match="My US Stocks") as error:
        validate_holdings_snapshot(parsed)
    assert error.value.status_code == 422


def test_real_fractional_holdings_are_accepted_without_rewriting():
    parsed = IndMoneyUsPortfolioService().parse_snapshot(RAW_SNAPSHOT)
    validate_holdings_snapshot(parsed)
    assert parsed["holdings"][0]["quantity"] == 1.418367913


@pytest.mark.parametrize("holdings,reported", [
    ([], None),
    ([{"symbol": "ABC", "quantity": None}], 1),
    ([{"symbol": "ABC", "quantity": -1}], 1),
    ([{"symbol": "ABC", "quantity": True}], 1),
    ([{"symbol": "ABC", "quantity": float("nan")}], 1),
    ([{"symbol": "ABC", "quantity": 0.5}], 2),
    ([{"symbol": "ABC", "quantity": 0.5}, {"symbol": "abc", "quantity": 1}], 2),
])
def test_incomplete_holdings_fail_closed(holdings, reported):
    with pytest.raises(ValidationException):
        validate_holdings_snapshot({"holdings": holdings, "reported_holdings_count": reported})
