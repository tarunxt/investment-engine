from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Query
import redis.asyncio as aioredis
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import User
from app.domains.indmoney_us.repository import IndMoneyUsPortfolioSnapshotRepository
from app.domains.indmoney_us.threats import (
    THREAT_ANALYSIS_MODEL,
    THREAT_ANALYSIS_PROVIDER,
    THREAT_JOB_MARKER,
    build_indmoney_us_threat_prompt,
    extract_indmoney_us_threat_prompt_metadata,
    is_indmoney_us_threat_job,
    parse_indmoney_us_threat_report,
)
from app.domains.indmoney_us.threats_schemas import (
    IndMoneyUsThreatAnalysisResponse,
    IndMoneyUsThreatHistoryResponse,
    IndMoneyUsThreatLatestResponse,
    IndMoneyUsThreatRunResponse,
)
from app.domains.jobs.models import Job
from app.domains.jobs.repository import PostgresJobRepository
from app.domains.jobs.use_cases.create_job import CreateJobCommand, CreateJobUseCase
from app.domains.portfolio_events.urgent_actionables import (
    HoldingContext,
    build_holding_context_index,
    build_urgent_action_history_entries,
    merge_urgent_actionables_history,
    resolve_portfolio_percentage,
)
from app.domains.portfolio_events.schemas import (
    PortfolioAnalysisHistoryItemResponse,
    PortfolioEventRunRequest,
)
from app.domains.portfolio_events.target_resolution import resolve_portfolio_analysis_target
from app.infrastructure.database.session import get_async_db
from app.infrastructure.locks.redis_lock import RedisLock
from app.infrastructure.messaging.event_bus import event_bus
from app.infrastructure.messaging.idempotency import IdempotencyStore
from app.shared.types import JobId, UserId
from app.shared.types import JobStatus

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/indmoney-us/threats", tags=["indmoney-us"])


def _get_redis() -> aioredis.Redis:
    return aioredis.from_url(settings.redis_url, decode_responses=True)


@router.get("/latest", response_model=IndMoneyUsThreatLatestResponse)
async def get_latest_threat_analysis(
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    job = await _get_latest_threat_job(db, current_user.id)
    if not job:
        return IndMoneyUsThreatLatestResponse(analysis=None)
    return IndMoneyUsThreatLatestResponse(analysis=await _serialize_threat_job(db, job))


@router.get("/history", response_model=IndMoneyUsThreatHistoryResponse)
async def get_threat_history(
    limit: int = Query(default=100, ge=1, le=500),
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    jobs = await _get_threat_jobs(db, current_user.id, limit)
    return IndMoneyUsThreatHistoryResponse(history=[_serialize_threat_history_item(job) for job in jobs])


@router.get("/{job_id}", response_model=IndMoneyUsThreatAnalysisResponse)
async def get_threat_analysis(
    job_id: int,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    repo = PostgresJobRepository(db)
    job = await repo.get(JobId(job_id))
    if not job or job.user_id != current_user.id or not is_indmoney_us_threat_job(job):
        raise HTTPException(404, detail="Threat analysis job not found")
    return await _serialize_threat_job(db, job)


@router.post("/run", response_model=IndMoneyUsThreatRunResponse)
async def run_threat_analysis(
    body: PortfolioEventRunRequest | None = None,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    provider, model = _resolve_threat_target(body)

    snapshot_repo = IndMoneyUsPortfolioSnapshotRepository(db)
    latest_snapshot = await snapshot_repo.get_latest_by_user(current_user.id)
    if not latest_snapshot:
        raise HTTPException(
            400,
            detail="No INDmoney US portfolio snapshot found. Paste a snapshot first.",
        )

    prompt = build_indmoney_us_threat_prompt(latest_snapshot)
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
            )
        )
    finally:
        await redis.aclose()

    job = await PostgresJobRepository(db).get(result.job_id)
    if not job:
        raise HTTPException(500, detail="Threat analysis job could not be loaded after creation")

    logger.info(
        "Queued INDmoney US threats analysis job %s for user %s on snapshot %s",
        job.id,
        current_user.id,
        latest_snapshot.id,
    )
    return IndMoneyUsThreatRunResponse(
        job_id=job.id,
        status=job.status,
        provider=job.provider,
        model=job.model,
        snapshot_id=latest_snapshot.id,
        snapshot_date=latest_snapshot.snapshot_date,
        captured_at=latest_snapshot.captured_at,
        created_at=job.created_at,
    )


def _resolve_threat_target(body: PortfolioEventRunRequest | None) -> tuple[str, str]:
    return resolve_portfolio_analysis_target(
        body,
        default_provider=THREAT_ANALYSIS_PROVIDER,
        default_model=THREAT_ANALYSIS_MODEL,
        analysis_label="threats",
    )


async def _get_latest_threat_job(db: AsyncSession, user_id: int) -> Job | None:
    jobs = await _get_threat_jobs(db, user_id, limit=1)
    return jobs[0] if jobs else None


async def _get_threat_jobs(db: AsyncSession, user_id: int, limit: int) -> list[Job]:
    result = await db.execute(
        select(Job)
        .where(
            Job.user_id == user_id,
            Job.prompt.ilike(f"%{THREAT_JOB_MARKER}%"),
        )
        .order_by(Job.id.desc())
        .limit(limit)
    )
    return list(result.scalars().all())


async def _get_completed_threat_jobs_upto(
    db: AsyncSession,
    user_id: int,
    *,
    max_job_id: int,
) -> list[Job]:
    result = await db.execute(
        select(Job)
        .where(
            Job.user_id == user_id,
            Job.id <= max_job_id,
            Job.status == JobStatus.COMPLETED,
            Job.prompt.ilike(f"%{THREAT_JOB_MARKER}%"),
        )
        .order_by(Job.id.asc())
    )
    return list(result.scalars().all())


async def _serialize_threat_job(
    db: AsyncSession,
    job: Job,
) -> IndMoneyUsThreatAnalysisResponse:
    metadata = extract_indmoney_us_threat_prompt_metadata(job.prompt or "")
    parsed = parse_indmoney_us_threat_report(job.response)
    parsed = await _augment_report_with_urgent_history(db, job, parsed)
    return IndMoneyUsThreatAnalysisResponse(
        job_id=job.id,
        status=job.status,
        provider=job.provider,
        model=job.model,
        snapshot_id=metadata.snapshot_id,
        snapshot_date=metadata.snapshot_date,
        captured_at=metadata.captured_at,
        created_at=job.created_at,
        updated_at=job.updated_at,
        tokens_in=job.tokens_in,
        tokens_out=job.tokens_out,
        estimated_cost=job.estimated_cost,
        error_message=job.error_message,
        report=parsed,
    )


async def _augment_report_with_urgent_history(
    db: AsyncSession,
    job: Job,
    parsed: dict | None,
) -> dict | None:
    if not parsed or not job.user_id:
        return parsed

    history_jobs = await _get_completed_threat_jobs_upto(db, job.user_id, max_job_id=job.id)
    if not history_jobs:
        return parsed

    snapshot_repo = IndMoneyUsPortfolioSnapshotRepository(db)
    holding_context_cache: dict[int, dict[str, HoldingContext]] = {}
    history_entries = []

    for history_job in history_jobs:
        history_report = parse_indmoney_us_threat_report(history_job.response)
        if not history_report:
            continue

        prompt_metadata = extract_indmoney_us_threat_prompt_metadata(history_job.prompt or "")
        holding_context_index: dict[str, HoldingContext] = {}
        if prompt_metadata.snapshot_id is not None:
            cache_key = prompt_metadata.snapshot_id
            if cache_key not in holding_context_cache:
                snapshot = await snapshot_repo.get_by_user_and_id(job.user_id, cache_key)
                holding_context_cache[cache_key] = _build_holding_context_index(snapshot)
            holding_context_index = holding_context_cache[cache_key]

        history_entries.extend(
            build_urgent_action_history_entries(
                history_report,
                tagged_at=history_job.updated_at or history_job.created_at,
                holding_context_index=holding_context_index,
            )
        )

    return merge_urgent_actionables_history(
        parsed,
        entries=history_entries,
        currency_code="USD",
        portfolio_percentage_label="Percentage of US Portfolio",
    )


def _build_holding_context_index(snapshot) -> dict[str, HoldingContext]:
    if snapshot is None:
        return {}

    total_invested_value = sum(
        amount
        for holding in snapshot.holdings or []
        if (amount := _optional_float(holding.get("invested_value"))) is not None
    )
    total_current_value = snapshot.current_value or 0.0
    contexts = []
    for holding in snapshot.holdings or []:
        invested_value = _optional_float(holding.get("invested_value"))
        holding_current_value = _optional_float(holding.get("current_value"))
        stored_weight = _optional_float(holding.get("portfolio_weight_percent"))
        portfolio_percentage = resolve_portfolio_percentage(
            amount_invested=invested_value,
            total_amount_invested=total_invested_value,
            position_value=holding_current_value,
            total_position_value=total_current_value,
            preferred_percentage=stored_weight,
        )
        contexts.append(
            HoldingContext(
                exchange=str(holding.get("exchange") or ""),
                stock_symbol=str(holding.get("symbol") or ""),
                stock_name=str(holding.get("company_name") or holding.get("symbol") or ""),
                amount_invested=invested_value,
                portfolio_percentage=portfolio_percentage,
            )
        )
    return build_holding_context_index(contexts)


def _optional_float(value: object) -> float | None:
    if value in (None, ""):
        return None

    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _serialize_threat_history_item(job: Job) -> PortfolioAnalysisHistoryItemResponse:
    metadata = extract_indmoney_us_threat_prompt_metadata(job.prompt or "")
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
