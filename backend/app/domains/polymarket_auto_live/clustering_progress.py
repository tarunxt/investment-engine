"""Per-scan external clustering telemetry; never advances published metadata."""
from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field
from sqlalchemy import JSON, cast, func, select

from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import ActivityLog, User
from app.domains.polymarket_auto_live.models import PolymarketAutoLiveRunRecord
from app.infrastructure.database.session import AsyncSessionLocal

router = APIRouter()
RESOURCE = "bullpen_clustering_progress"
ACTIVE = {"collecting", "researching", "validating", "deploying", "verifying"}


class ClusteringProgressRequest(BaseModel):
    attempt_id: UUID
    sequence: int = Field(ge=0)
    status: Literal["collecting", "researching", "validating", "deploying", "verifying", "completed", "blocked", "failed"]
    detail: str = Field(min_length=1, max_length=1200)


def progress_view(payload, now=None):
    if not payload:
        return {"status": "not_reported", "detail": "No job start or progress has been reported for this scan. Email delivery alone does not prove the external job started.", "stale": False}
    result = dict(payload)
    updated = datetime.fromisoformat(payload["updated_at"])
    result["stale"] = payload["status"] in ACTIVE and ((now or datetime.now(UTC)) - updated).total_seconds() > 600
    return result


async def owned_run(session, user_id, run_id, lock=False):
    query = select(PolymarketAutoLiveRunRecord.id).where(
        PolymarketAutoLiveRunRecord.id == str(run_id),
        PolymarketAutoLiveRunRecord.user_id == user_id,
    )
    if lock:
        query = query.with_for_update()
    if (await session.execute(query)).scalar_one_or_none() is None:
        raise HTTPException(404, "Scan not found")


async def latest_log(session, user_id, run_id, resource):
    return (await session.execute(select(ActivityLog).where(
        ActivityLog.user_id == user_id,
        ActivityLog.resource_type == resource,
        cast(ActivityLog.details, JSON)["run_id"].as_string() == str(run_id),
    ).order_by(ActivityLog.id.desc()).limit(1))).scalar_one_or_none()


@router.get("/clustering/{run_id}/progress")
async def get_clustering_progress(run_id: UUID, response: Response, current_user: User = Depends(get_current_user)):
    response.headers["Cache-Control"] = "private, no-store"
    async with AsyncSessionLocal() as session:
        await owned_run(session, current_user.id, run_id)
        row = await latest_log(session, current_user.id, run_id, RESOURCE)
        # Completion events include other stages; select scan specifically.
        delivery = (await session.execute(select(ActivityLog).where(
            ActivityLog.user_id == current_user.id,
            ActivityLog.resource_type == "completion_notification",
            cast(ActivityLog.details, JSON)["run_id"].as_string() == str(run_id),
            cast(ActivityLog.details, JSON)["stage"].as_string() == "scan",
        ).order_by(ActivityLog.id.desc()).limit(1))).scalar_one_or_none()
        email = json.loads(delivery.details) if delivery else {}
        return {"run_id": str(run_id), "checked_at": datetime.now(UTC).isoformat(),
                "job": progress_view(json.loads(row.details) if row else None),
                "email": {"status": email.get("delivery_status") or (delivery.action if delivery else "not_recorded"),
                          "error": email.get("error"), "delivery_id": email.get("delivery_id")}}


@router.post("/clustering/{run_id}/progress")
async def record_clustering_progress(run_id: UUID, request: ClusteringProgressRequest, current_user: User = Depends(get_current_user)):
    async with AsyncSessionLocal() as session:
        # Never lock the busy scan row: scan/LLM persistence may hold it while
        # this independent external job needs to report a blocker. A short,
        # nonblocking transaction lock serialises only clustering reporters.
        await owned_run(session, current_user.id, run_id)
        acquired = (await session.execute(select(func.pg_try_advisory_xact_lock(
            func.hashtextextended(f"clustering:{current_user.id}:{run_id}", 0)
        )))).scalar_one()
        if not acquired:
            raise HTTPException(409, "A progress report is being saved; retry the same attempt and sequence")
        row = await latest_log(session, current_user.id, run_id, RESOURCE)
        previous = json.loads(row.details) if row else None
        if previous:
            same_attempt = previous["attempt_id"] == str(request.attempt_id)
            if same_attempt and request.sequence <= previous["sequence"]:
                return progress_view(previous)
            if same_attempt and previous["status"] in {"completed", "blocked", "failed"}:
                raise HTTPException(409, "Start a new attempt after a terminal report")
            if not same_attempt and (request.sequence != 0 or request.status not in {"collecting", "blocked"}):
                raise HTTPException(409, "A new attempt must start at sequence zero")
            if not same_attempt and previous["status"] in ACTIVE and not progress_view(previous)["stale"]:
                raise HTTPException(409, "Another attempt is reporting progress for this scan")
        elif request.sequence != 0:
            raise HTTPException(409, "The first report must have sequence zero")
        payload = {**request.model_dump(mode="json"), "run_id": str(run_id), "updated_at": datetime.now(UTC).isoformat()}
        session.add(ActivityLog(user_id=current_user.id, action="clustering.progress", resource_type=RESOURCE, details=json.dumps(payload)))
        await session.commit()
        return progress_view(payload)
