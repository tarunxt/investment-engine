from __future__ import annotations

import asyncio
import json
import logging

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect
import redis.asyncio as aioredis

from app.core.config import settings
from app.core.security import JWTUtils
from app.infrastructure.database.session import AsyncSessionLocal
from app.domains.jobs.repository import PostgresJobRepository
from app.shared.types import JobId

logger = logging.getLogger(__name__)

router = APIRouter(tags=["websocket"])

_PING_INTERVAL = 25  # seconds — below typical 30 s idle timeout


def _user_id_from_token(token: str) -> int | None:
    payload = JWTUtils.verify_token(token)
    if not payload:
        return None
    try:
        return int(payload["sub"])
    except (KeyError, ValueError, TypeError):
        return None


async def _relay_channel(websocket: WebSocket, channel: str) -> None:
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
                logger.debug(
                    "Received Redis pub/sub message on channel %s: %s", channel, msg
                )
                if msg["type"] != "message":
                    continue
                try:
                    # Validate JSON before sending
                    data = json.loads(msg["data"])
                    await websocket.send_json(data)
                except json.JSONDecodeError:
                    # Fallback: send raw text if not valid JSON
                    await websocket.send_text(msg["data"])
                except Exception as e:
                    logger.warning("Failed to send WS message: %s", e)
                    break

        async def _ws_drain() -> None:
            """Detect client disconnect by reading any frame type."""
            try:
                while True:
                    msg = await websocket.receive()
                    if msg["type"] == "websocket.disconnect":
                        break
            except WebSocketDisconnect:
                pass

        async def _keepalive() -> None:
            """Send periodic ping to prevent idle timeout."""
            try:
                while True:
                    await asyncio.sleep(_PING_INTERVAL)
                    # Only send if still connected
                    if websocket.client_state.name == "CONNECTED":
                        await websocket.send_json({"type": "ping"})
            except Exception:
                # Expected when websocket closes
                pass

        redis_task = asyncio.create_task(_redis_to_ws(), name="redis_to_ws")
        drain_task = asyncio.create_task(_ws_drain(), name="ws_drain")
        ping_task = asyncio.create_task(_keepalive(), name="keepalive")

        done, pending = await asyncio.wait(
            [redis_task, drain_task],
            return_when=asyncio.FIRST_COMPLETED,
        )

        # Cancel all tasks cleanly
        for t in (redis_task, drain_task, ping_task):
            if not t.done():
                t.cancel()
                try:
                    await t
                except asyncio.CancelledError:
                    pass

    finally:
        # Always cleanup Redis resources
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


@router.websocket("/ws/jobs")
async def ws_job_list(websocket: WebSocket, token: str = Query(...)):
    """Stream real-time status updates for all jobs of the authenticated user."""
    user_id = _user_id_from_token(token)
    if user_id is None:
        await websocket.close(code=4001, reason="Unauthorized")
        return

    await websocket.accept()
    logger.info("WS /ws/jobs connected user_id=%s", user_id)
    try:
        await _relay_channel(websocket, f"user_job_updates:{user_id}")
    except WebSocketDisconnect:
        logger.info("WS /ws/jobs disconnected user_id=%s", user_id)
    except Exception as e:
        logger.error("WS /ws/jobs error user_id=%s: %s", user_id, e)
    finally:
        logger.info("WS /ws/jobs closed user_id=%s", user_id)


@router.websocket("/ws/jobs/{job_id}")
async def ws_job_detail(websocket: WebSocket, job_id: JobId, token: str = Query(...)):
    """Stream real-time status updates for a specific job."""
    user_id = _user_id_from_token(token)
    if user_id is None:
        await websocket.close(code=4001, reason="Unauthorized")
        return

    await websocket.accept()
    logger.info("WS /ws/jobs/%d connected user_id=%s", job_id, user_id)

    # Send current state immediately so clients that connect after a fast-completing
    # job still receive the final status (Redis pub/sub drops events with no subscriber).
    try:
        async with AsyncSessionLocal() as db:
            job = await PostgresJobRepository(db).get(job_id)
            if job and job.user_id == user_id:
                status_val = (
                    job.status.value
                    if hasattr(job.status, "value")
                    else str(job.status)
                )
                await websocket.send_json(
                    {
                        "type": "job.updated",
                        "job_id": job.id,
                        "status": status_val,
                        "response": job.response,
                        "error_message": job.error_message,
                        "tokens_in": job.tokens_in,
                        "tokens_out": job.tokens_out,
                        "estimated_cost": job.estimated_cost,
                    }
                )
    except Exception:
        logger.warning("Failed to send initial state for job %d", job_id, exc_info=True)

    try:
        await _relay_channel(websocket, f"job_updates:{job_id}")
    except WebSocketDisconnect:
        logger.info("WS /ws/jobs/%d disconnected user_id=%s", job_id, user_id)
    except Exception as e:
        logger.error("WS /ws/jobs/%d error user_id=%s: %s", job_id, user_id, e)
    finally:
        logger.info("WS /ws/jobs/%d closed user_id=%s", job_id, user_id)