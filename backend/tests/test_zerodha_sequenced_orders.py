from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.domains.zerodha import router as zerodha_router
from app.domains.zerodha.schemas import (
    ZerodhaProtectedMarketOrderRequest,
    ZerodhaSequencedProtectedMarketRequest,
)


class FakeRepo:
    def __init__(self, db):
        pass

    async def get_plaintext_token(self, user_id):
        return "token"


class FakeAudit:
    def __init__(self, db):
        self.events = []

    async def log(self, *args, **kwargs):
        self.events.append((args, kwargs))


class FakeDb:
    async def commit(self):
        pass


class FakeRequest:
    headers = {}
    client = SimpleNamespace(host="127.0.0.1")


class FakeSvc:
    direct_market_orders_enabled = True

    def __init__(self, *, sell_status="COMPLETE", margin=10_000, quote=100):
        self.sell_status = sell_status
        self.margin = margin
        self.quote = quote
        self.placed = []
        self.order_counter = 0

    async def place_order(self, token, order_data, *, variety="regular"):
        self.order_counter += 1
        order_id = f"order-{self.order_counter}"
        self.placed.append(order_data)
        return {"order_id": order_id}

    async def get_orders(self, token):
        return [
            {
                "order_id": "order-1",
                "status": self.sell_status,
                "filled_quantity": 10 if self.sell_status == "COMPLETE" else 0,
                "average_price": 100,
            }
        ]

    async def get_margins(self, token):
        return {"equity": {"available": {"live_balance": self.margin}}}

    async def get_quotes(self, token, instruments):
        return {instruments[0]: {"last_price": self.quote}}


def req(*orders, **kwargs):
    return ZerodhaSequencedProtectedMarketRequest(orders=list(orders), **kwargs)


def order(symbol, side, quantity=10):
    return ZerodhaProtectedMarketOrderRequest(
        tradingsymbol=symbol,
        exchange="NSE",
        transaction_type=side,
        quantity=quantity,
        market_protection="-1",
    )


@pytest.fixture(autouse=True)
def patch_repos(monkeypatch):
    monkeypatch.setattr(zerodha_router, "ZerodhaCredentialRepository", FakeRepo)
    monkeypatch.setattr(zerodha_router, "ZerodhaAuditRepository", FakeAudit)


@pytest.mark.anyio
async def test_sequenced_sell_complete_places_affordable_buys(monkeypatch):
    svc = FakeSvc(margin=1_000, quote=100)
    monkeypatch.setattr(zerodha_router, "_svc", svc)

    response = await zerodha_router.place_protected_market_orders_sequenced(
        FakeRequest(), req(order("SELLME", "SELL"), order("BUYME", "BUY", 5), safety_buffer_amount=50), FakeDb(), SimpleNamespace(id=1)
    )

    assert response.sell_phase_complete is True
    assert response.placed_count == 2
    assert [placed["transaction_type"] for placed in svc.placed] == ["SELL", "BUY"]


@pytest.mark.anyio
async def test_sequenced_sell_rejected_skips_unaffordable_buys(monkeypatch):
    svc = FakeSvc(sell_status="REJECTED", margin=0, quote=100)
    monkeypatch.setattr(zerodha_router, "_svc", svc)

    response = await zerodha_router.place_protected_market_orders_sequenced(
        FakeRequest(), req(order("SELLME", "SELL"), order("BUYME", "BUY", 5)), FakeDb(), SimpleNamespace(id=1)
    )

    assert response.skipped_count == 1
    assert [placed["transaction_type"] for placed in svc.placed] == ["SELL"]


@pytest.mark.anyio
async def test_sequenced_partial_margin_clamps_buy_quantity(monkeypatch):
    svc = FakeSvc(margin=350, quote=100)
    monkeypatch.setattr(zerodha_router, "_svc", svc)

    response = await zerodha_router.place_protected_market_orders_sequenced(
        FakeRequest(), req(order("SELLME", "SELL"), order("BUYME", "BUY", 5), safety_buffer_amount=50), FakeDb(), SimpleNamespace(id=1)
    )

    assert response.buy_results[0].quantity == 3
    assert response.skipped_count == 1


@pytest.mark.anyio
async def test_sequenced_direct_market_disabled_returns_503(monkeypatch):
    svc = FakeSvc()
    svc.direct_market_orders_enabled = False
    monkeypatch.setattr(zerodha_router, "_svc", svc)

    with pytest.raises(HTTPException) as exc:
        await zerodha_router.place_protected_market_orders_sequenced(
            FakeRequest(), req(order("SELLME", "SELL")), FakeDb(), SimpleNamespace(id=1)
        )
    assert exc.value.status_code == 503
