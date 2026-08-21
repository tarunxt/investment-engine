from decimal import Decimal

from app.domains.zerodha.order_validation import (
    ZerodhaPriceGuardInput,
    guard_zerodha_limit_price,
)
from app.domains.zerodha.basket import (
    is_kite_quote_permission_error_message,
    prepare_basket_order_from_request,
)
from app.domains.zerodha.schemas import (
    ZerodhaPlaceOrderRequest,
    ZerodhaPrepareBasketOrderRequest,
    ZerodhaProtectedMarketOrderRequest,
)


def test_guard_matches_live_sell_price_to_tick_multiple():
    result = guard_zerodha_limit_price(
        ZerodhaPriceGuardInput(side="SELL", requested_price=143.78, last_price=143.70)
    )

    assert result.price == 143.70
    assert Decimal(str(result.price)) % Decimal("0.05") == 0
    assert result.adjusted is True


def test_guard_uses_live_buy_price_when_quote_is_available():
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
    assert result.price == 232.60
    assert result.adjusted is True
    assert "using_live_ltp_as_limit_price" in result.reasons


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


def test_prepare_basket_fallback_uses_client_last_price_when_quotes_forbidden():
    order = ZerodhaPrepareBasketOrderRequest(
        tradingsymbol="pfc",
        exchange="nse",
        transaction_type="BUY",
        quantity=18,
        price=580,
        last_price=429.40,
    )

    prepared = prepare_basket_order_from_request(order)

    assert prepared.price == 429.40
    assert prepared.last_price == 429.40
    assert prepared.adjusted is True
    assert "using_live_ltp_as_limit_price" in prepared.reasons
    assert "live_quote_unavailable_using_client_last_price" in prepared.reasons

def test_kite_quote_permission_error_detection_matches_reported_message():
    assert is_kite_quote_permission_error_message(
        "Insufficient permission for that call."
    )


def test_market_order_defaults_to_zerodha_auto_market_protection_and_omits_price():
    order = ZerodhaPlaceOrderRequest(
        tradingsymbol="PFC",
        exchange="NSE",
        transaction_type="BUY",
        order_type="MARKET",
        quantity=18,
        product="CNC",
        price=580,
    )

    assert order.market_protection == -1
    assert order.price == 0


def test_rejects_unprotected_market_order_value_over_api_limit():
    try:
        ZerodhaPlaceOrderRequest(
            tradingsymbol="PFC",
            exchange="NSE",
            transaction_type="BUY",
            order_type="MARKET",
            quantity=18,
            product="CNC",
            market_protection=101,
        )
    except ValueError as exc:
        assert "market_protection" in str(exc)
    else:
        raise AssertionError("market_protection above 100 should be rejected")


def test_market_intent_direct_order_payload_uses_market_protection_without_price():
    orders = [
        ZerodhaPlaceOrderRequest(
            tradingsymbol="PFC",
            exchange="NSE",
            transaction_type="BUY",
            order_type="MARKET",
            quantity=18,
            product="CNC",
            price=580,
        ),
        ZerodhaPlaceOrderRequest(
            tradingsymbol="HAL",
            exchange="NSE",
            transaction_type="BUY",
            order_type="MARKET",
            quantity=2,
            product="CNC",
            price=5450,
        ),
        ZerodhaPlaceOrderRequest(
            tradingsymbol="HINDALCO",
            exchange="NSE",
            transaction_type="BUY",
            order_type="MARKET",
            quantity=13,
            product="CNC",
            price=778,
        ),
    ]

    for order in orders:
        payload = order.model_dump(exclude={"price", "trigger_price"})
        assert payload["order_type"] == "MARKET"
        assert payload["market_protection"] == -1
        assert "price" not in payload
        assert "trigger_price" not in payload


def test_explicit_limit_order_keeps_validated_limit_price():
    order = ZerodhaPlaceOrderRequest(
        tradingsymbol="INFY",
        exchange="NSE",
        transaction_type="BUY",
        order_type="LIMIT",
        quantity=3,
        product="CNC",
        price=143.8,
    )

    assert order.order_type == "LIMIT"
    assert order.price == 143.8


def test_direct_protected_market_orders_use_string_market_protection_without_prices():
    for symbol, qty in [("PFC", 18), ("HAL", 2), ("HINDALCO", 13)]:
        order = ZerodhaProtectedMarketOrderRequest(
            tradingsymbol=symbol,
            exchange="NSE",
            transaction_type="BUY",
            quantity=qty,
            market_protection="-1",
        )
        payload = {
            "variety": "regular",
            "tradingsymbol": order.tradingsymbol.upper(),
            "exchange": order.exchange.upper(),
            "transaction_type": order.transaction_type.upper(),
            "quantity": str(order.quantity),
            "product": "CNC",
            "validity": "DAY",
            "order_type": "MARKET",
            "market_protection": order.market_protection,
        }
        assert payload["order_type"] == "MARKET"
        assert payload["market_protection"] == "-1"
        assert "price" not in payload
        assert "trigger_price" not in payload


def test_direct_protected_market_rejects_missing_zero_or_boolean_protection():
    for bad_value in ("0", 0, True, False):
        try:
            ZerodhaProtectedMarketOrderRequest(
                tradingsymbol="PFC",
                exchange="NSE",
                transaction_type="BUY",
                quantity=18,
                market_protection=bad_value,
            )
        except ValueError as exc:
            assert "market_protection" in str(exc)
        else:
            raise AssertionError(f"market_protection {bad_value!r} should be rejected")
