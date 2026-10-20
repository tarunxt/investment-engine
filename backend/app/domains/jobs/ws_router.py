from __future__ import annotations

import logging

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from app.infrastructure.database.session import AsyncSessionLocal
from app.domains.jobs.repository import PostgresJobRepository
from app.shared.types import JobId
from app.shared.ws_relay import relay_channel, authenticate_websocket, stream_is_current
from app.shared.ws_channels import job_channel

logger = logging.getLogger(__name__)

router = APIRouter(tags=["websocket"])


@router.websocket("/ws/jobs")
async def ws_job_list(websocket: WebSocket, token: str | None = Query(None)):
    """Stream real-time status updates for all jobs of the authenticated user."""
    access = await authenticate_websocket(websocket, token)
    if access is None:
        return
    user_id = access.user_id

    await websocket.accept()
    logger.info("WS /ws/jobs connected user_id=%s", user_id)
    try:
        await relay_channel(websocket, f"user_job_updates:{user_id}",
                            authorize=lambda message: stream_is_current(access, message=message), expires_at=access.expires_at)
    except WebSocketDisconnect:
        logger.info("WS /ws/jobs disconnected user_id=%s", user_id)
    except Exception:
        logger.error("WS /ws/jobs error user_id=%s", user_id)
    finally:
        logger.info("WS /ws/jobs closed user_id=%s", user_id)


@router.websocket("/ws/jobs/{job_id}")
async def ws_job_detail(websocket: WebSocket, job_id: JobId, token: str | None = Query(None)):
    """Stream real-time status updates for a specific job."""
    access = await authenticate_websocket(websocket, token)
    if access is None:
        return
    user_id = access.user_id

    async with AsyncSessionLocal() as db:
        job = await PostgresJobRepository(db).get(job_id, user_id=user_id)
        if job is None:
            await websocket.close(code=4004, reason="Job not found")
            return
    await websocket.accept()
    logger.info("WS /ws/jobs/%d connected user_id=%s", job_id, user_id)

    # Send current state immediately so clients that connect after a fast-completing
    # job still receive the final status (Redis pub/sub drops events with no subscriber).
    try:
        async with AsyncSessionLocal() as db:
            job = await PostgresJobRepository(db).get(job_id, user_id=user_id)
            if job and job.user_id == user_id and await stream_is_current(access, job_id=job_id):
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
                        "web_search_used": job.web_search_used,
                        "web_search_queries": job.web_search_queries,
                        "web_sources": job.web_sources,
                        "runtime_metadata_json": job.runtime_metadata_json,
                        "updated_at": job.updated_at.isoformat() if job.updated_at else None,
                    }
                )
    except Exception:
        logger.warning("Failed to send initial state for job %d", job_id)

    try:
        await relay_channel(websocket, job_channel(user_id, job_id),
                            authorize=lambda message: stream_is_current(access, job_id=job_id, message=message), expires_at=access.expires_at)
    except WebSocketDisconnect:
        logger.info("WS /ws/jobs/%d disconnected user_id=%s", job_id, user_id)
    except Exception:
        logger.error("WS /ws/jobs/%d error user_id=%s", job_id, user_id)
    finally:
        logger.info("WS /ws/jobs/%d closed user_id=%s", job_id, user_id)
