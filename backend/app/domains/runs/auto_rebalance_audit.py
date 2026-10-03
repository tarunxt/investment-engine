"""Validate audit references and LLM outcomes against persisted execution."""
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domains.jobs.models import Job
from app.domains.runs.models import Run, RunJob
from app.domains.runs.run_identity import analysis_run_identity

LLM_STAGES = ("threats", "swing", "rebalance", "technical")


def _status(record):
    return getattr(record.status, "value", str(record.status)).lower()


async def validate_execution(
    db: AsyncSession, *, user_id: int, portfolio: str, sequence: int,
    stage: str, run_id: int | None, job_id: int | None,
    expected_status: str | None = None, verify_pair: bool = True,
) -> None:
    records = {}
    for kind, model, record_id in (("run", Run, run_id), ("job", Job, job_id)):
        if record_id is None:
            continue
        record = (await db.execute(select(model).where(
            model.id == record_id, model.user_id == user_id,
        ))).scalar_one_or_none()
        if record is None:
            raise HTTPException(404, detail=f"Referenced {kind} not found")
        if record.auto_rebalance_portfolio != portfolio or record.auto_rebalance_sequence != sequence:
            raise HTTPException(422, detail=f"Referenced {kind} belongs to another auto-rebalance")
        if analysis_run_identity(record).stage != stage:
            raise HTTPException(422, detail=f"Referenced {kind} belongs to another auto-rebalance stage")
        records[kind] = record
    if verify_pair and run_id is not None and job_id is not None:
        link = (await db.execute(select(RunJob.id).where(
            RunJob.run_id == run_id, RunJob.job_id == job_id,
        ).limit(1))).scalar_one_or_none()
        if link is None:
            raise HTTPException(422, detail="Referenced job does not belong to the referenced run")
    if expected_status is None:
        return
    aggregate = records.get("run") or records.get("job")
    child_statuses = {"completed", "partial", "failed"} if expected_status == "partial" else {"completed"}
    if (
        aggregate is None or _status(aggregate) != expected_status
        or ("run" in records and "job" in records and _status(records["job"]) not in child_statuses)
    ):
        raise HTTPException(
            409,
            detail=f"Auto-rebalance {stage} completion is not verified by matching persisted execution evidence",
        )
