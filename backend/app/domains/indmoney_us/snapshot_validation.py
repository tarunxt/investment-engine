"""Reject incomplete imports before they replace the portfolio or fund scans."""
from collections.abc import Mapping
from math import isfinite

from app.shared.exceptions import ValidationException


def validate_holdings_snapshot(snapshot: Mapping) -> None:
    holdings = snapshot.get("holdings") or []
    instruction = (
        "Open INDmoney > My US Stocks and copy the complete Current Holdings "
        "section, including quantities. The Explore page is not a portfolio snapshot."
    )
    if not holdings or snapshot.get("parse_status") == "unparsed":
        raise ValidationException(f"No INDmoney holdings could be parsed. {instruction}")
    reported = snapshot.get("reported_holdings_count")
    if reported is not None and reported != len(holdings):
        raise ValidationException(f"The INDmoney holdings snapshot is incomplete. {instruction}")
    symbols = set()
    for holding in holdings:
        symbol = str(holding.get("symbol") or "").strip().upper()
        quantity = holding.get("quantity")
        if (not symbol or symbol in symbols or isinstance(quantity, bool)
                or not isinstance(quantity, (int, float))
                or not isfinite(quantity) or quantity < 0):
            raise ValidationException(f"INDmoney holdings have missing quantities or ambiguous symbols. {instruction}")
        symbols.add(symbol)
