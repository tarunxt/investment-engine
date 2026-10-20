from __future__ import annotations

from dataclasses import asdict, dataclass
import hashlib
import json
import math
import secrets
import time

import redis.asyncio as aioredis
from app.core.config import settings
from app.domains.auth.session_revocation import authentication_time

WEBSOCKET_TICKET_TTL_SECONDS = 30
_TICKET_PREFIX = 'auth:ws-ticket:'
_CONSUME_TICKET_SCRIPT = """
local value = redis.call('GET', KEYS[1])
if value then redis.call('DEL', KEYS[1]) end
return value
"""


@dataclass(frozen=True)
class StreamAccess:
    user_id: int
    auth_time: float
    expires_at: float


def _ticket_key(ticket: str) -> str:
    return _TICKET_PREFIX + hashlib.sha256(ticket.encode('utf-8')).hexdigest()


async def issue_websocket_ticket(user_id: int, claims: dict) -> str:
    authenticated = authentication_time(claims)
    expiry = claims.get('exp')
    if (claims.get('sub') != str(user_id) or claims.get('type') == 'refresh'
            or authenticated is None or isinstance(expiry, bool)
            or not isinstance(expiry, (float, int)) or not math.isfinite(expiry) or expiry <= time.time()):
        raise ValueError('Current access claims required')
    ticket = secrets.token_urlsafe(32)
    redis = aioredis.from_url(settings.redis_url, decode_responses=True)
    try:
        await redis.set(_ticket_key(ticket), json.dumps(asdict(
            StreamAccess(user_id, authenticated, float(expiry)))), ex=WEBSOCKET_TICKET_TTL_SECONDS)
    finally:
        await redis.aclose()
    return ticket


async def consume_stream_ticket(ticket: str) -> StreamAccess | None:
    redis = aioredis.from_url(settings.redis_url, decode_responses=True)
    try:
        value = await redis.eval(_CONSUME_TICKET_SCRIPT, 1, _ticket_key(ticket))
    finally:
        await redis.aclose()
    try:
        payload = json.loads(value) if value else None
        access = StreamAccess(**payload) if isinstance(payload, dict) else None
        if (access is None or type(access.user_id) is not int or access.user_id < 1
                or authentication_time({'auth_time': access.auth_time}) is None
                or isinstance(access.expires_at, bool) or not isinstance(access.expires_at, (float, int))
                or not math.isfinite(access.expires_at)
                or access.expires_at <= time.time()):
            return None
        return access
    except (TypeError, ValueError):
        return None


async def consume_websocket_ticket(ticket: str) -> int | None:
    """Compatibility helper; HTTP access JWTs are never stream credentials."""
    access = await consume_stream_ticket(ticket)
    return access.user_id if access else None
