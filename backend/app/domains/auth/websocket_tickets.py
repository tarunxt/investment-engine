from __future__ import annotations

import hashlib
import secrets

import redis.asyncio as aioredis

from app.core.config import settings

WEBSOCKET_TICKET_TTL_SECONDS = 30
_TICKET_PREFIX = "auth:ws-ticket:"
_CONSUME_TICKET_SCRIPT = """
local value = redis.call('GET', KEYS[1])
if value then
  redis.call('DEL', KEYS[1])
end
return value
"""


def _ticket_key(ticket: str) -> str:
    digest = hashlib.sha256(ticket.encode("utf-8")).hexdigest()
    return f"{_TICKET_PREFIX}{digest}"


async def issue_websocket_ticket(user_id: int) -> str:
    ticket = secrets.token_urlsafe(32)
    redis = aioredis.from_url(settings.redis_url, decode_responses=True)
    try:
        await redis.set(
            _ticket_key(ticket),
            str(user_id),
            ex=WEBSOCKET_TICKET_TTL_SECONDS,
        )
    finally:
        await redis.aclose()
    return ticket


async def consume_websocket_ticket(ticket: str) -> int | None:
    redis = aioredis.from_url(settings.redis_url, decode_responses=True)
    try:
        value = await redis.eval(_CONSUME_TICKET_SCRIPT, 1, _ticket_key(ticket))
    finally:
        await redis.aclose()
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None
