from __future__ import annotations

import asyncio
import json
import logging

from fastapi import WebSocket, WebSocketDisconnect
import redis.asyncio as aioredis
from sqlalchemy import select

from app.core.config import settings
from app.core.security import JWTUtils
from app.domains.auth.dependencies import get_or_create_dev_user, is_auth_disabled
from app.domains.auth.models import User
from app.infrastructure.database.session import AsyncSessionLocal

logger = logging.getLogger(__name__)

_PING_INTERVAL = 25  # seconds — below typical 30 s idle timeout


def user_id_from_token(token: str) -> int | None:
    payload = JWTUtils.verify_token(token)
    if not payload:
        return None
    try:
        return int(payload["sub"])
    except (KeyError, ValueError, TypeError):
        return None


async def user_id_from_ws_token(token: str | None) -> int | None:
    if is_auth_disabled() and (not token or token == "dev"):
        async with AsyncSessionLocal() as db:
            user = await get_or_create_dev_user(db)
            return user.id

    if not token:
        return None

    user_id = user_id_from_token(token)
    if user_id is None:
        return None

    async with AsyncSessionLocal() as db:
        result = await db.execute(select(User.id).where(User.id == user_id, User.is_active.is_(True)))
        return result.scalar_one_or_none()


async def relay_channel(websocket: WebSocket, channel: str) -> None:
    """Subscribe to a Redis pub/sub channel and relay messages to the WebSocket.

    Three concurrent tasks race:
    - redis_task: reads from pub/sub, writes to WS
    - drain_task: reads from WS to detect client disconnect (any frame type)
    - ping_task: sends periodic ping to keep connection alive

    Returns when either redis_task or drain_task completes.
    """
    redis: aioredis.Redis | None = None
    pubsub = None

    try:
        redis = aioredis.from_url(settings.redis_url, decode_responses=True)
        pubsub = redis.pubsub()
        await pubsub.subscribe(channel)

        async def _redis_to_ws() -> None:
            async for msg in pubsub.listen():
                if msg["type"] != "message":
                    continue
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

        redis_task = asyncio.create_task(_redis_to_ws(), name="redis_to_ws")
        drain_task = asyncio.create_task(_ws_drain(), name="ws_drain")
        ping_task = asyncio.create_task(_keepalive(), name="keepalive")

        await asyncio.wait([redis_task, drain_task], return_when=asyncio.FIRST_COMPLETED)

        for t in (redis_task, drain_task, ping_task):
            if not t.done():
                t.cancel()
                try:
                    await t
                except asyncio.CancelledError:
                    pass

    finally:
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
