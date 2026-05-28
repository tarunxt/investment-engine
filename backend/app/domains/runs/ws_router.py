from __future__ import annotations

import logging

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from app.shared.types import JobId
from app.shared.ws_relay import relay_channel, user_id_from_ws_token

logger = logging.getLogger(__name__)

router = APIRouter(tags=["websocket"])


@router.websocket("/ws/runs")
async def ws_run_list(websocket: WebSocket, token: str | None = Query(None)):
    """Stream real-time run status updates for the authenticated user."""
    user_id = await user_id_from_ws_token(token)
    if user_id is None:
        await websocket.close(code=4001, reason="Unauthorized")
        return

    await websocket.accept()
    logger.info("WS /ws/runs connected user_id=%s", user_id)
    try:
        await relay_channel(websocket, f"user_run_updates:{user_id}")
    except WebSocketDisconnect:
        logger.info("WS /ws/runs disconnected user_id=%s", user_id)
    except Exception as e:
        logger.error("WS /ws/runs error user_id=%s: %s", user_id, e)
    finally:
        logger.info("WS /ws/runs closed user_id=%s", user_id)


@router.websocket("/ws/runs/{run_id}")
async def ws_run_detail(websocket: WebSocket, run_id: JobId, token: str | None = Query(None)):
    """Stream per-job updates and run status changes for a specific run."""
    user_id = await user_id_from_ws_token(token)
    if user_id is None:
        await websocket.close(code=4001, reason="Unauthorized")
        return

    await websocket.accept()
    logger.info("WS /ws/runs/%d connected user_id=%s", run_id, user_id)
    try:
        await relay_channel(websocket, f"run_updates:{run_id}")
    except WebSocketDisconnect:
        logger.info("WS /ws/runs/%d disconnected user_id=%s", run_id, user_id)
    except Exception as e:
        logger.error("WS /ws/runs/%d error user_id=%s: %s", run_id, user_id, e)
    finally:
        logger.info("WS /ws/runs/%d closed user_id=%s", run_id, user_id)
