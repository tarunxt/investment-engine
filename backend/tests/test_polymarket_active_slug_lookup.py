from __future__ import annotations

import asyncio

from app.domains.polymarket_auto_live.console_profile import (
    _authoritative_market_open_state,
)
from app.domains.polymarket_auto_live.scanner import (
    POLYMARKET_GAMMA_MARKETS_URL,
    _fetch_market_by_slug_with_client,
)


class _FakeResponse:
    def __init__(self, payload: object) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> object:
        return self._payload


class _FakeClient:
    def __init__(self, payload: object) -> None:
        self.payload = payload
        self.calls: list[tuple[str, dict[str, str]]] = []

    async def get(self, url: str, *, params: dict[str, str]) -> _FakeResponse:
        self.calls.append((url, params))
        return _FakeResponse(self.payload)


def test_exact_slug_lookup_is_authoritative_for_current_active_positions() -> None:
    slug = "iran-full-airspace-closure-by-august-15-2099"
    client = _FakeClient(
        [
            {
                "id": "market-1",
                "conditionId": "0x" + ("1" * 64),
                "question": "Iran full airspace closure by August 15, 2099?",
                "slug": slug,
                "outcomes": ["Yes", "No"],
                "outcomePrices": ["0.005", "0.995"],
                "endDate": "2099-08-15T23:59:59Z",
                # Deliberately omit active/closed/archived. The exact active
                # query itself is the authoritative open-state proof.
            }
        ]
    )

    market = asyncio.run(_fetch_market_by_slug_with_client(client, slug))

    assert client.calls == [
        (
            POLYMARKET_GAMMA_MARKETS_URL,
            {
                "slug": slug,
                "active": "true",
                "archived": "false",
                "closed": "false",
            },
        )
    ]
    assert market is not None
    assert market.raw is not None
    assert market.raw["active"] is True
    assert market.raw["closed"] is False
    assert market.raw["archived"] is False
    assert _authoritative_market_open_state(market) is True
