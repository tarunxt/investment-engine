from __future__ import annotations

import pytest

from app.domains.auth import websocket_tickets


class _FakeRedis:
    def __init__(self) -> None:
        self.values: dict[str, str] = {}
        self.expirations: dict[str, int] = {}

    async def set(self, key: str, value: str, *, ex: int) -> None:
        self.values[key] = value
        self.expirations[key] = ex

    async def eval(self, _script: str, _key_count: int, key: str) -> str | None:
        return self.values.pop(key, None)

    async def aclose(self) -> None:
        return None


@pytest.mark.anyio
async def test_websocket_ticket_is_hashed_short_lived_and_one_time(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_redis = _FakeRedis()
    monkeypatch.setattr(
        websocket_tickets.aioredis,
        "from_url",
        lambda *_args, **_kwargs: fake_redis,
    )

    ticket = await websocket_tickets.issue_websocket_ticket(42)

    assert ticket
    assert all(ticket not in key for key in fake_redis.values)
    assert list(fake_redis.values.values()) == ["42"]
    assert list(fake_redis.expirations.values()) == [
        websocket_tickets.WEBSOCKET_TICKET_TTL_SECONDS
    ]
    assert await websocket_tickets.consume_websocket_ticket(ticket) == 42
    assert await websocket_tickets.consume_websocket_ticket(ticket) is None
