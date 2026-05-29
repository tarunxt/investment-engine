import redis.asyncio as aioredis
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.domains.ai_providers.factory import ProviderFactory
from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import User
from app.domains.jobs.models import Job
from app.domains.runs.models import RunJob
from app.domains.runs.repository import PostgresRunRepository
from app.domains.runs.schemas import RunCreate, RunResponse
from app.domains.runs.use_cases.create_run import (
    CreateRunCommand,
    CreateRunUseCase,
    RunModelTarget,
)
from app.infrastructure.database.session import get_async_db
from app.infrastructure.locks.redis_lock import RedisLock
from app.shared.exceptions import AppException
from app.shared.pagination import PagedQuery
from app.shared.types import JobStatus, UserId

router = APIRouter(prefix="/runs", tags=["runs"])


def _get_redis() -> aioredis.Redis:
    return aioredis.from_url(settings.redis_url, decode_responses=True)


@router.post("", response_model=RunResponse)
async def create_run(
    body: RunCreate,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    for t in body.targets:
        if not ProviderFactory.supports(t.provider):
            raise HTTPException(400, detail=f"Unsupported provider: '{t.provider}'")
        if not ProviderFactory.is_configured(t.provider):
            raise HTTPException(
                400,
                detail=f"Provider '{t.provider}' is not configured. Set the API key in your environment.",
            )
        is_compatible, reason = ProviderFactory.model_compatibility(t.provider, t.model)
        if not is_compatible:
            raise HTTPException(
                400,
                detail=(
                    f"Model '{t.model}' for provider '{t.provider}' is currently incompatible. "
                    f"{reason or ''}".strip()
                ),
            )

    redis = _get_redis()
    uc = CreateRunUseCase(session=db, lock=RedisLock(redis))
    try:
        run = await uc.execute(
            CreateRunCommand(
                prompt=body.prompt,
                targets=[RunModelTarget(provider=t.provider, model=t.model) for t in body.targets],
                user_id=UserId(current_user.id),
                prompt_id=body.prompt_id,
                scheduled_at=body.scheduled_at,
                auto_export_enabled=body.auto_export_enabled,
                export_spreadsheet_url=body.export_spreadsheet_url,
                export_sheet_name=body.export_sheet_name,
                export_investment_amount=body.export_investment_amount,
                export_title=body.export_title,
                allow_parallel=body.allow_parallel,
            )
        )
    except AppException as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message)

    return run


@router.get("")
async def list_runs(
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    repo = PostgresRunRepository(db)
    result = await repo.list(PagedQuery(page=page, limit=limit))
    return {
        **result.to_dict(),
        "items": [RunResponse.model_validate(run) for run in result.items],
    }


@router.get("/{run_id}", response_model=RunResponse)
async def get_run(
    run_id: int,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    repo = PostgresRunRepository(db)
    run = await repo.get(run_id)
    if not run:
        raise HTTPException(404, detail="Run not found")
    return run


@router.post("/{run_id}/cancel", response_model=RunResponse)
async def cancel_run(
    run_id: int,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    repo = PostgresRunRepository(db)
    run = await repo.get(run_id)
    if not run:
        raise HTTPException(404, detail="Run not found")
    if run.user_id != current_user.id:
        raise HTTPException(403, detail="Not allowed")

    if run.status in {JobStatus.COMPLETED, JobStatus.FAILED}:
        return run

    run.status = JobStatus.FAILED
    run.export_status = "failed"
    run.export_error = "Cancelled by user"

    run_job_rows = await db.execute(
        select(RunJob).where(RunJob.run_id == run_id)
    )
    run_jobs = run_job_rows.scalars().all()
    if run_jobs:
        job_ids = [rj.job_id for rj in run_jobs]
        jobs_rows = await db.execute(select(Job).where(Job.id.in_(job_ids)))
        jobs = jobs_rows.scalars().all()
        for job in jobs:
            if job.status in {JobStatus.SCHEDULED, JobStatus.PENDING, JobStatus.PROCESSING}:
                job.status = JobStatus.FAILED
                job.error_message = "Cancelled by user"
                if run.auto_export_enabled:
                    job.export_status = "failed"
                    job.export_error = "Cancelled by user"

    await db.commit()
    run = await repo.get(run_id)
    if not run:
        raise HTTPException(404, detail="Run not found")
    return run
