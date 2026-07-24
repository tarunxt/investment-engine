from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Query
import redis.asyncio as aioredis
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import User
from app.domains.jobs.models import Job
from app.domains.jobs.repository import PostgresJobRepository
from app.domains.jobs.use_cases.create_job import CreateJobCommand, CreateJobUseCase
from app.domains.portfolio_events.common import ensure_event_table_covers_prompt_holdings
from app.domains.portfolio_events.schemas import (
    PortfolioAnalysisHistoryItemResponse,
    PortfolioEventRunRequest,
)
from app.domains.portfolio_events.target_resolution import resolve_portfolio_analysis_target
from app.domains.zerodha.events import (
    EVENT_ANALYSIS_MODEL,
    EVENT_ANALYSIS_PROVIDER,
    EVENT_JOB_MARKER,
    build_zerodha_events_prompt,
    extract_zerodha_events_prompt_metadata,
    is_zerodha_event_job,
    parse_zerodha_events_table,
)
from app.domains.zerodha.events_schemas import (
    ZerodhaEventsAnalysisResponse,
    ZerodhaEventsHistoryResponse,
    ZerodhaEventsLatestResponse,
    ZerodhaEventsRunResponse,
)
from app.domains.zerodha.repository import ZerodhaPortfolioSnapshotRepository
from app.infrastructure.database.session import get_async_db
from app.infrastructure.locks.redis_lock import RedisLock
from app.infrastructure.messaging.event_bus import event_bus
from app.infrastructure.messaging.idempotency import IdempotencyStore
from app.shared.types import JobId, UserId

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/zerodha/events", tags=["zerodha"])


def _get_redis() -> aioredis.Redis:
    return aioredis.from_url(settings.redis_url, decode_responses=True)


@router.get("/latest", response_model=ZerodhaEventsLatestResponse)
async def get_latest_events_analysis(
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    job = await _get_latest_events_job(db, current_user.id)
    if not job:
        return ZerodhaEventsLatestResponse(analysis=None)
    return ZerodhaEventsLatestResponse(analysis=_serialize_events_job(job))


@router.get("/history", response_model=ZerodhaEventsHistoryResponse)
async def get_events_history(
    limit: int = Query(default=100, ge=1, le=500),
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    jobs = await _get_events_jobs(db, current_user.id, limit)
    return ZerodhaEventsHistoryResponse(history=[_serialize_events_history_item(job) for job in jobs])


@router.get("/{job_id}", response_model=ZerodhaEventsAnalysisResponse)
async def get_events_analysis(
    job_id: int,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    repo = PostgresJobRepository(db)
    job = await repo.get(JobId(job_id))
    if not job or job.user_id != current_user.id or not is_zerodha_event_job(job):
        raise HTTPException(404, detail="Events analysis job not found")
    return _serialize_events_job(job)


@router.post("/run", response_model=ZerodhaEventsRunResponse)
async def run_events_analysis(
    body: PortfolioEventRunRequest | None = None,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    provider, model = await _resolve_events_target(body, db)

    snapshot_repo = ZerodhaPortfolioSnapshotRepository(db)
    latest_snapshot = await snapshot_repo.get_latest_by_user(current_user.id)
    if not latest_snapshot or latest_snapshot.holdings_count <= 0:
        raise HTTPException(
            400,
            detail="No Zerodha holdings snapshot found. Sync your portfolio first.",
        )

    prompt = build_zerodha_events_prompt(latest_snapshot)
    redis = _get_redis()
    try:
        use_case = CreateJobUseCase(
            session=db,
            event_bus=event_bus,
            lock=RedisLock(redis),
            idempotency=IdempotencyStore(redis),
        )
        result = await use_case.execute(
            CreateJobCommand(
                prompt=prompt,
                provider=provider,
                model=model,
                user_id=UserId(current_user.id),
      auto_rebalance_portfolio=body.auto_rebalance_portfolio if body else None,
      auto_rebalance_sequence=body.auto_rebalance_sequence if body else None,
      auto_rebalance_label=body.auto_rebalance_label if body else None,
  )
        )
    finally:
        await redis.aclose()

    job = await PostgresJobRepository(db).get(result.job_id)
    if not job:
        raise HTTPException(500, detail="Events analysis job could not be loaded after creation")

    logger.info(
        "Queued Zerodha events analysis job %s for user %s on snapshot %s",
        job.id,
        current_user.id,
        latest_snapshot.snapshot_date,
    )
    return ZerodhaEventsRunResponse(
        job_id=job.id,
        status=job.status,
        provider=job.provider,
        model=job.model,
        snapshot_date=latest_snapshot.snapshot_date,
        captured_at=latest_snapshot.captured_at,
        created_at=job.created_at,
    )


async def _resolve_events_target(
    body: PortfolioEventRunRequest | None,
    db: AsyncSession,
) -> tuple[str, str]:
    return await resolve_portfolio_analysis_target(
        body,
        db=db,
        default_provider=EVENT_ANALYSIS_PROVIDER,
        default_model=EVENT_ANALYSIS_MODEL,
        analysis_label="events",
    )


async def _get_latest_events_job(db: AsyncSession, user_id: int) -> Job | None:
    jobs = await _get_events_jobs(db, user_id, limit=1)
    return jobs[0] if jobs else None


async def _get_events_jobs(db: AsyncSession, user_id: int, limit: int) -> list[Job]:
    result = await db.execute(
        select(Job)
        .where(
            Job.user_id == user_id,
            Job.prompt.ilike(f"%{EVENT_JOB_MARKER}%"),
        )
        .order_by(Job.id.desc())
        .limit(limit)
    )
    return list(result.scalars().all())


def _serialize_events_job(job: Job) -> ZerodhaEventsAnalysisResponse:
    metadata = extract_zerodha_events_prompt_metadata(job.prompt or "")
    parsed = ensure_event_table_covers_prompt_holdings(
        job.prompt or "",
        parse_zerodha_events_table(job.response),
    )
    return ZerodhaEventsAnalysisResponse(
        job_id=job.id,
        status=job.status,
        provider=job.provider,
        model=job.model,
        snapshot_date=metadata.snapshot_date,
        captured_at=metadata.captured_at,
        created_at=job.created_at,
        updated_at=job.updated_at,
        tokens_in=job.tokens_in,
        tokens_out=job.tokens_out,
        estimated_cost=job.estimated_cost,
        error_message=job.error_message,
        table=parsed,
    )


def _serialize_events_history_item(job: Job) -> PortfolioAnalysisHistoryItemResponse:
    metadata = extract_zerodha_events_prompt_metadata(job.prompt or "")
    return PortfolioAnalysisHistoryItemResponse(
        job_id=job.id,
        status=job.status,
        provider=job.provider,
        model=job.model,
        snapshot_date=metadata.snapshot_date,
        captured_at=metadata.captured_at,
        created_at=job.created_at,
        updated_at=job.updated_at,
        estimated_cost=job.estimated_cost,
        error_message=job.error_message,
    )
