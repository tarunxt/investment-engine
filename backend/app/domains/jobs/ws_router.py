from __future__ import annotations

import logging

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from app.infrastructure.database.session import AsyncSessionLocal
from app.domains.jobs.repository import PostgresJobRepository
from app.shared.types import JobId
from app.shared.ws_relay import relay_channel, user_id_from_token

logger = logging.getLogger(__name__)

router = APIRouter(tags=["websocket"])


@router.websocket("/ws/jobs")
async def ws_job_list(websocket: WebSocket, token: str = Query(...)):
    """Stream real-time status updates for all jobs of the authenticated user."""
    user_id = user_id_from_token(token)
    if user_id is None:
        await websocket.close(code=4001, reason="Unauthorized")
        return

    await websocket.accept()
    logger.info("WS /ws/jobs connected user_id=%s", user_id)
    try:
        await relay_channel(websocket, f"user_job_updates:{user_id}")
    except WebSocketDisconnect:
        logger.info("WS /ws/jobs disconnected user_id=%s", user_id)
    except Exception as e:
        logger.error("WS /ws/jobs error user_id=%s: %s", user_id, e)
    finally:
        logger.info("WS /ws/jobs closed user_id=%s", user_id)


@router.websocket("/ws/jobs/{job_id}")
async def ws_job_detail(websocket: WebSocket, job_id: JobId, token: str = Query(...)):
    """Stream real-time status updates for a specific job."""
    user_id = user_id_from_token(token)
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
                    job.status.value if hasattr(job.status, "value") else str(job.status)
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
        await relay_channel(websocket, f"job_updates:{job_id}")
    except WebSocketDisconnect:
        logger.info("WS /ws/jobs/%d disconnected user_id=%s", job_id, user_id)
    except Exception as e:
        logger.error("WS /ws/jobs/%d error user_id=%s: %s", job_id, user_id, e)
    finally:
        logger.info("WS /ws/jobs/%d closed user_id=%s", job_id, user_id)
