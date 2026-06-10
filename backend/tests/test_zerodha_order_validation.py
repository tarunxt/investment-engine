from decimal import Decimal

from app.domains.zerodha.order_validation import (
    ZerodhaPriceGuardInput,
    guard_zerodha_limit_price,
)


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
