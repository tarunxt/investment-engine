from __future__ import annotations

import logging

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from app.shared.types import JobId
from app.domains.runs.repository import PostgresRunRepository
from app.infrastructure.database.session import AsyncSessionLocal
from app.shared.ws_relay import relay_channel, authenticate_websocket, stream_is_current
from app.shared.ws_channels import run_channel

logger = logging.getLogger(__name__)

router = APIRouter(tags=["websocket"])


@router.websocket("/ws/runs")
async def ws_run_list(websocket: WebSocket, token: str | None = Query(None)):
    """Stream real-time run status updates for the authenticated user."""
    access = await authenticate_websocket(websocket, token)
    if access is None:
        return
    user_id = access.user_id

    await websocket.accept()
    logger.info("WS /ws/runs connected user_id=%s", user_id)
    try:
        await relay_channel(websocket, f"user_run_updates:{user_id}",
                            authorize=lambda message: stream_is_current(access, message=message), expires_at=access.expires_at)
    except WebSocketDisconnect:
        logger.info("WS /ws/runs disconnected user_id=%s", user_id)
    except Exception:
        logger.error("WS /ws/runs error user_id=%s", user_id)
    finally:
        logger.info("WS /ws/runs closed user_id=%s", user_id)


@router.websocket("/ws/runs/{run_id}")
async def ws_run_detail(websocket: WebSocket, run_id: JobId, token: str | None = Query(None)):
    """Stream per-job updates and run status changes for a specific run."""
    access = await authenticate_websocket(websocket, token)
    if access is None:
        return
    user_id = access.user_id

    async with AsyncSessionLocal() as db:
        run = await PostgresRunRepository(db).get(run_id, user_id=user_id)
        if run is None:
            await websocket.close(code=4004, reason="Run not found")
            return
    await websocket.accept()
    logger.info("WS /ws/runs/%d connected user_id=%s", run_id, user_id)
    try:
        await relay_channel(websocket, run_channel(user_id, run_id),
                            authorize=lambda message: stream_is_current(access, run_id=run_id, message=message), expires_at=access.expires_at)
    except WebSocketDisconnect:
        logger.info("WS /ws/runs/%d disconnected user_id=%s", run_id, user_id)
    except Exception:
        logger.error("WS /ws/runs/%d error user_id=%s", run_id, user_id)
    finally:
        logger.info("WS /ws/runs/%d closed user_id=%s", run_id, user_id)
