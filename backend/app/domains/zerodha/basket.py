from __future__ import annotations

from app.domains.zerodha.order_validation import (
    ZerodhaPriceGuardInput,
    guard_zerodha_limit_price,
)
from app.domains.zerodha.schemas import (
    ZerodhaPrepareBasketOrderRequest,
    ZerodhaPreparedBasketOrder,
)


def prepare_basket_order_from_request(
    order: ZerodhaPrepareBasketOrderRequest,
) -> ZerodhaPreparedBasketOrder:
    """Prepare a Publisher basket row without live quote permissions.

    Some Kite apps can use Publisher baskets but do not have quote API access
    enabled. In that case, opening the basket should still work with the
    already displayed recommendation price instead of failing before Kite opens.
    The user still reviews and confirms the final price inside Kite.
    """
    guard = guard_zerodha_limit_price(
        ZerodhaPriceGuardInput(
            side=order.transaction_type,
            requested_price=order.price,
            last_price=None,
            lower_circuit_limit=None,
            upper_circuit_limit=None,
            tick_size=None,
        )
    )
    reasons = list(guard.reasons)
    reasons.append("live_quote_unavailable_using_requested_price")
    return ZerodhaPreparedBasketOrder(
        tradingsymbol=order.tradingsymbol.upper(),
        exchange=order.exchange.upper(),
        transaction_type=order.transaction_type,
        quantity=order.quantity,
        requested_price=order.price,
        price=guard.price,
        last_price=order.price,
        tick_size=guard.tick_size,
        lower_circuit_limit=None,
        upper_circuit_limit=None,
        adjusted=True,
        reasons=reasons,
    )


def is_kite_quote_permission_error_message(message: str) -> bool:
    normalized = message.lower()
    return "insufficient permission" in normalized or "permission" in normalized
