from __future__ import annotations

import asyncio

from app.domains.polymarket_auto_live.console_profile import (
    _authoritative_market_open_state,
)
from app.domains.polymarket_auto_live.scanner import (
    POLYMARKET_GAMMA_MARKETS_URL,
    _fetch_market_by_exact_identity_with_client,
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


class _SequencedFakeClient:
    def __init__(self, payloads: list[object]) -> None:
        self.payloads = payloads
        self.calls: list[tuple[str, dict[str, str]]] = []

    async def get(self, url: str, *, params: dict[str, str]) -> _FakeResponse:
        self.calls.append((url, params))
        index = len(self.calls) - 1
        return _FakeResponse(self.payloads[index])


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


def test_exact_condition_id_lookup_uses_gamma_condition_ids_and_proves_open() -> None:
    condition_id = "0x" + ("2" * 64)
    client = _SequencedFakeClient(
        [
            [
                {
                    "id": "812345",
                    "conditionId": condition_id,
                    "question": "US announces end of Iranian blockade by August 15, 2099?",
                    "slug": "us-announces-end-of-iranian-blockade-by-august-15-2099",
                    "outcomes": ["Yes", "No"],
                    "outcomePrices": ["0.984", "0.016"],
                    "endDate": "2099-08-15T23:59:59Z",
                    # Compact Gamma rows may omit lifecycle booleans. The
                    # active-only condition_ids query is the open proof.
                }
            ]
        ]
    )

    market = asyncio.run(
        _fetch_market_by_exact_identity_with_client(
            client,
            market_id="wallet-event-slug-does-not-match-child-market",
            condition_id=condition_id,
        )
    )

    assert client.calls == [
        (
            POLYMARKET_GAMMA_MARKETS_URL,
            {
                "condition_ids": condition_id,
                "active": "true",
                "archived": "false",
                "closed": "false",
            },
        )
    ]
    assert market is not None
    assert market.raw is not None
    assert market.raw["conditionId"] == condition_id
    assert market.raw["active"] is True
    assert market.raw["closed"] is False
    assert _authoritative_market_open_state(market) is True


def test_exact_condition_id_lookup_falls_back_to_closed_market_state() -> None:
    condition_id = "0x" + ("3" * 64)
    closed_row = {
        "id": "812346",
        "conditionId": condition_id,
        "question": "Closed wallet market?",
        "slug": "closed-wallet-market",
        "outcomes": ["Yes", "No"],
        "outcomePrices": ["1", "0"],
        "endDate": "2025-08-15T23:59:59Z",
        "active": False,
        "closed": True,
        "archived": False,
    }
    client = _SequencedFakeClient([[], [closed_row]])

    market = asyncio.run(
        _fetch_market_by_exact_identity_with_client(
            client,
            market_id=None,
            condition_id=condition_id,
        )
    )

    assert client.calls == [
        (
            POLYMARKET_GAMMA_MARKETS_URL,
            {
                "condition_ids": condition_id,
                "active": "true",
                "archived": "false",
                "closed": "false",
            },
        ),
        (
            POLYMARKET_GAMMA_MARKETS_URL,
            {"condition_ids": condition_id},
        ),
    ]
    assert market is not None
    assert _authoritative_market_open_state(market) is False
