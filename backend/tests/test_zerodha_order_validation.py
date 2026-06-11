from decimal import Decimal

from app.domains.zerodha.order_validation import (
    ZerodhaPriceGuardInput,
    guard_zerodha_limit_price,
)
from app.domains.zerodha.basket import (
    is_kite_quote_permission_error_message,
    prepare_basket_order_from_request,
)
from app.domains.zerodha.schemas import ZerodhaPrepareBasketOrderRequest


def test_guard_rounds_sell_price_to_tick_multiple():
    result = guard_zerodha_limit_price(
        ZerodhaPriceGuardInput(side="SELL", requested_price=143.78, last_price=143.70)
    )

    assert result.price == 142.95
    assert Decimal(str(result.price)) % Decimal("0.05") == 0
    assert result.adjusted is True


def test_guard_clamps_buy_price_to_upper_circuit_and_tick():
    result = guard_zerodha_limit_price(
        ZerodhaPriceGuardInput(
            side="BUY",
            requested_price=438,
            last_price=232.60,
            lower_circuit_limit=209.35,
            upper_circuit_limit=257.25,
        )
    )

    assert result.price <= 257.25
    assert Decimal(str(result.price)) % Decimal("0.05") == 0
    assert result.price == 233.80
    assert result.adjusted is True
    assert "using_ltp_derived_marketable_limit" in result.reasons


def test_guard_uses_requested_price_when_ltp_missing():
    result = guard_zerodha_limit_price(
        ZerodhaPriceGuardInput(side="SELL", requested_price=355.71, last_price=None)
    )

    assert result.price == 355.70
    assert result.adjusted is True


def test_prepare_basket_fallback_uses_requested_price_when_quotes_forbidden():
    order = ZerodhaPrepareBasketOrderRequest(
        tradingsymbol="infy",
        exchange="nse",
        transaction_type="BUY",
        quantity=3,
        price=143.78,
    )

    prepared = prepare_basket_order_from_request(order)

    assert prepared.tradingsymbol == "INFY"
    assert prepared.exchange == "NSE"
    assert prepared.price == 143.80
    assert prepared.last_price == 143.78
    assert prepared.adjusted is True
    assert "live_quote_unavailable_using_requested_price" in prepared.reasons


def test_kite_quote_permission_error_detection_matches_reported_message():
    assert is_kite_quote_permission_error_message(
        "Insufficient permission for that call."
    )
