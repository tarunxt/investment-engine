from __future__ import annotations

import asyncio
import json
import logging
import math
import time

from fastapi import WebSocket, WebSocketDisconnect
import redis.asyncio as aioredis
from sqlalchemy import select

from app.core.config import settings
from app.core.security import JWTUtils
from app.domains.auth.dependencies import get_or_create_dev_user, is_auth_disabled
from app.domains.auth.models import User
from app.domains.auth.session_lifecycle import SessionLifecycle, subject
from app.domains.auth.session_store import SqlSessionFamilies
from app.domains.auth.websocket_tickets import consume_websocket_ticket
from app.infrastructure.database.session import AsyncSessionLocal

logger = logging.getLogger(__name__)

_PING_INTERVAL = 25  # seconds — below typical 30 s idle timeout


def user_id_from_token(token: str) -> int | None:
    """Parse an access-token identity only; not a session authorization check."""
    payload = JWTUtils.verify_access_token(token)
    if not payload:
        return None
    try:
        return int(payload["sub"])
    except (KeyError, ValueError, TypeError):
        return None


class SessionIdentity(int):
    def __new__(cls, uid, claims):
        obj = super().__new__(cls, uid)
        obj.claims = claims
        return obj


async def session_identity_active(identity):
    if identity is None:
        return False
    if identity.claims is None:
        return is_auth_disabled()
    try:
        expiry = identity.claims["exp"]
        if not isinstance(expiry, (int, float)) or not math.isfinite(expiry) or expiry <= time.time():
            return False
        async with asyncio.timeout(3):
            async with AsyncSessionLocal() as db:
                await SessionLifecycle(SqlSessionFamilies(db)).require_active(identity.claims)
        return True
    except Exception:
        # No private exception/token values in logs and no unavailable-store
        # fallback. WebSocket callers close and require fresh authentication.
        return False


async def user_id_from_ws_token(token: str | None) -> int | None:
    if is_auth_disabled() and (not token or token == "dev"):
        async with AsyncSessionLocal() as db:
            user = await get_or_create_dev_user(db)
            return SessionIdentity(user.id, None)
    if not token:
        return None
    payload = JWTUtils.verify_access_token(token)
    if payload is None:
        try:
            payload = await consume_websocket_ticket(token)
        except Exception:
            return None
    if payload is None:
        return None
    try:
        identity = SessionIdentity(subject(payload), payload)
        return identity if await session_identity_active(identity) else None
    except Exception:
        return None


async def relay_channel(websocket: WebSocket, channel: str, *, auth_identity: SessionIdentity) -> None:
    """Subscribe to a Redis pub/sub channel and relay messages to the WebSocket.

    Three concurrent tasks race:
    - redis_task: reads from pub/sub, writes to WS
    - drain_task: reads from WS to detect client disconnect (any frame type)
    - ping_task: sends periodic ping to keep connection alive

    Returns when either redis_task or drain_task completes.
    """
    redis: aioredis.Redis | None = None
    pubsub = None
    tasks = []

    try:
        redis = aioredis.from_url(settings.redis_url, decode_responses=True)
        pubsub = redis.pubsub()
        await pubsub.subscribe(channel)

        async def _redis_to_ws() -> None:
            async for msg in pubsub.listen():
                if msg["type"] != "message":
                    continue
                if not await session_identity_active(auth_identity):
                    await websocket.close(code=4001, reason="Session expired or revoked")
                    return
                try:
                    data = json.loads(msg["data"])
                    await websocket.send_json(data)
                except json.JSONDecodeError:
                    await websocket.send_text(msg["data"])
                except Exception as e:
                    logger.warning("Failed to send WS message: %s", e)
                    break

        async def _ws_drain() -> None:
            try:
                while True:
                    msg = await websocket.receive()
                    if msg["type"] == "websocket.disconnect":
                        break
            except WebSocketDisconnect:
                pass

        async def _keepalive() -> None:
            try:
                while True:
                    await asyncio.sleep(_PING_INTERVAL)
                    if websocket.client_state.name == "CONNECTED":
                        await websocket.send_json({"type": "ping"})
            except Exception:
                pass

        async def _session_watch():
            while True:
                if not await session_identity_active(auth_identity):
                    await websocket.close(code=4001, reason="Session expired or revoked")
                    return
                await asyncio.sleep(5)

        watch_task = asyncio.create_task(_session_watch(), name="session_watch")
        redis_task = asyncio.create_task(_redis_to_ws(), name="redis_to_ws")
        drain_task = asyncio.create_task(_ws_drain(), name="ws_drain")
        ping_task = asyncio.create_task(_keepalive(), name="keepalive")

        tasks = [redis_task, drain_task, ping_task, watch_task]
        await asyncio.wait([redis_task, drain_task, watch_task], return_when=asyncio.FIRST_COMPLETED)

    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        if pubsub is not None:
            try:
                await pubsub.unsubscribe(channel)
                await pubsub.aclose()
            except Exception:
                pass
        if redis is not None:
            try:
                await redis.aclose()
            except Exception:
                pass
