from fastapi import APIRouter, Depends, Header, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.domains.jobs.repository import PostgresJobRepository
from app.domains.jobs.schemas import JobCreate, JobResponse
from app.domains.jobs.use_cases.create_job import CreateJobCommand, CreateJobUseCase
from app.domains.ai_providers.factory import ProviderFactory
from app.infrastructure.database.session import get_async_db
from app.infrastructure.locks.redis_lock import RedisLock
from app.infrastructure.messaging.event_bus import event_bus
from app.infrastructure.messaging.idempotency import IdempotencyStore
from app.infrastructure.messaging.task_registry import revoke_registered_job_task
from app.shared.exceptions import AppException
from app.shared.pagination import PagedQuery
from app.shared.types import JobId, JobStatus, UserId

import redis.asyncio as aioredis
from app.core.config import settings
from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import User

router = APIRouter(prefix="/jobs", tags=["jobs"])


def _get_redis() -> aioredis.Redis:
    return aioredis.from_url(settings.redis_url, decode_responses=True)


@router.post("", response_model=JobResponse)
async def create_job(
    body: JobCreate,
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user)
):
    if not ProviderFactory.supports(body.provider):
        raise HTTPException(400, detail=f"Unsupported provider: '{body.provider}'")
    if not ProviderFactory.is_configured(body.provider):
        raise HTTPException(
            400,
            detail=f"Provider '{body.provider}' is not configured. Set the API key in your environment.",
        )

    redis = _get_redis()
    uc = CreateJobUseCase(
        session=db,
        event_bus=event_bus,
        lock=RedisLock(redis),
        idempotency=IdempotencyStore(redis),
    )
    try:
        result = await uc.execute(
            CreateJobCommand(
                prompt=body.prompt,
                provider=body.provider,
                model=body.model,
                scheduled_at=body.scheduled_at,
                idempotency_key=idempotency_key,
                user_id=UserId(current_user.id),
            )
        )
    except AppException as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message)

    # Re-fetch to return full JobResponse (use case only returns minimal result)
    repo = PostgresJobRepository(db)
    job = await repo.get(result.job_id)
    return job


@router.get("")
async def list_jobs(
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    status: str | None = Query(None),
    q: str | None = Query(None),
    db: AsyncSession = Depends(get_async_db),
):
    repo = PostgresJobRepository(db)
    status_filter: JobStatus | None = None
    if status and status != "all":
        try:
            status_filter = JobStatus(status)
        except ValueError:
            raise HTTPException(400, detail=f"Invalid status: '{status}'")

    result = await repo.list(
        PagedQuery(page=page, limit=limit),
        status=status_filter,
        search=q or None,
    )
    return result.to_dict()


@router.get("/{job_id}", response_model=JobResponse)
async def get_job(
    job_id: int,
    db: AsyncSession = Depends(get_async_db),
):
    repo = PostgresJobRepository(db)
    job = await repo.get(JobId(job_id))
    if not job:
        raise HTTPException(404, detail="Job not found")
    return job


@router.post("/{job_id}/cancel", response_model=JobResponse)
async def cancel_job(
    job_id: int,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    repo = PostgresJobRepository(db)
    job = await repo.get(JobId(job_id))
    if not job:
        raise HTTPException(404, detail="Job not found")
    if job.user_id != current_user.id:
        raise HTTPException(403, detail="Not allowed")

    if job.status not in JobStatus.active():
        return job

    job.status = JobStatus.FAILED
    job.error_message = "Cancelled by user"
    if (job.export_status or "").lower() in {"", "pending", "queued", "processing"}:
        job.export_status = "failed"
        job.export_error = "Cancelled by user"

    await db.commit()

    job = await repo.get(JobId(job_id))
    if not job:
        raise HTTPException(404, detail="Job not found")

    await revoke_registered_job_task(job_id)

    from app.domains.jobs.tasks import _publish_job_update

    _publish_job_update(job)
    return job
