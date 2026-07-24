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
from app.domains.zerodha.models import ZerodhaPortfolioSnapshot
from app.domains.zerodha.repository import ZerodhaPortfolioSnapshotRepository
from app.domains.zerodha.threats import (
    THREAT_ANALYSIS_MODEL,
    THREAT_ANALYSIS_PROVIDER,
    THREAT_JOB_MARKER,
    build_zerodha_threat_prompt,
    extract_threat_prompt_metadata,
    is_zerodha_threat_job,
    parse_zerodha_threat_report,
)
from app.domains.zerodha.threats_schemas import (
    ZerodhaThreatAnalysisResponse,
    ZerodhaThreatHistoryResponse,
    ZerodhaThreatLatestResponse,
    ZerodhaThreatRunResponse,
)
from app.infrastructure.database.session import get_async_db
from app.infrastructure.locks.redis_lock import RedisLock
from app.infrastructure.messaging.event_bus import event_bus
from app.infrastructure.messaging.idempotency import IdempotencyStore
from app.shared.types import JobId, UserId
from app.shared.types import JobStatus

logger = logging.getLogger(__name__)

THREAT_HISTORY_AUGMENTATION_LIMIT = 50

router = APIRouter(prefix="/zerodha/threats", tags=["zerodha"])


def _get_redis() -> aioredis.Redis:
    return aioredis.from_url(settings.redis_url, decode_responses=True)


@router.get("/latest", response_model=ZerodhaThreatLatestResponse)
async def get_latest_threat_analysis(
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    job = await _get_latest_threat_job(db, current_user.id)
    if not job:
        return ZerodhaThreatLatestResponse(analysis=None)
    return ZerodhaThreatLatestResponse(analysis=await _serialize_threat_job(db, job))


@router.get("/history", response_model=ZerodhaThreatHistoryResponse)
async def get_threat_history(
    limit: int = Query(default=100, ge=1, le=500),
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    jobs = await _get_threat_jobs(db, current_user.id, limit)
    return ZerodhaThreatHistoryResponse(history=[_serialize_threat_history_item(job) for job in jobs])


@router.get("/{job_id}", response_model=ZerodhaThreatAnalysisResponse)
async def get_threat_analysis(
    job_id: int,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    repo = PostgresJobRepository(db)
    job = await repo.get(JobId(job_id))
    if not job or job.user_id != current_user.id or not is_zerodha_threat_job(job):
        raise HTTPException(404, detail="Threat analysis job not found")
    return await _serialize_threat_job(db, job)


@router.post("/run", response_model=ZerodhaThreatRunResponse)
async def run_threat_analysis(
    body: PortfolioEventRunRequest | None = None,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    provider, model = await _resolve_threat_target(body, db)

    snapshot_repo = ZerodhaPortfolioSnapshotRepository(db)
    latest_snapshot = await snapshot_repo.get_latest_by_user(current_user.id)
    if not latest_snapshot:
        raise HTTPException(
            400,
            detail="No Zerodha portfolio snapshot found. Sync your portfolio first.",
        )

    prompt = build_zerodha_threat_prompt(latest_snapshot)
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
        raise HTTPException(500, detail="Threat analysis job could not be loaded after creation")

    logger.info(
        "Queued Zerodha threats analysis job %s for user %s on snapshot %s",
        job.id,
        current_user.id,
        latest_snapshot.snapshot_date,
    )
    return ZerodhaThreatRunResponse(
        job_id=job.id,
        status=job.status,
        provider=job.provider,
        model=job.model,
        snapshot_date=latest_snapshot.snapshot_date,
        captured_at=latest_snapshot.captured_at,
        created_at=job.created_at,
    )


async def _resolve_threat_target(
    body: PortfolioEventRunRequest | None,
    db: AsyncSession,
) -> tuple[str, str]:
    return await resolve_portfolio_analysis_target(
        body,
        db=db,
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
        .order_by(Job.id.desc())
        .limit(THREAT_HISTORY_AUGMENTATION_LIMIT)
    )
    jobs = list(result.scalars().all())
    jobs.reverse()
    return jobs


async def _serialize_threat_job(
    db: AsyncSession,
    job: Job,
) -> ZerodhaThreatAnalysisResponse:
    metadata = extract_threat_prompt_metadata(job.prompt or "")
    parsed = parse_zerodha_threat_report(job.response)
    parsed = await _augment_report_with_urgent_history(db, job, parsed)
    return ZerodhaThreatAnalysisResponse(
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

    history_items = []
    snapshot_dates = set()
    for history_job in history_jobs:
        history_report = parse_zerodha_threat_report(history_job.response)
        if not history_report:
            continue

        prompt_metadata = extract_threat_prompt_metadata(history_job.prompt or "")
        history_items.append((history_job, history_report, prompt_metadata))
        if prompt_metadata.snapshot_date:
            snapshot_dates.add(prompt_metadata.snapshot_date)

    snapshots_by_date = {}
    if snapshot_dates:
        snapshot_result = await db.execute(
            select(ZerodhaPortfolioSnapshot).where(
                ZerodhaPortfolioSnapshot.user_id == job.user_id,
                ZerodhaPortfolioSnapshot.snapshot_date.in_(tuple(snapshot_dates)),
            )
        )
        snapshots_by_date = {
            snapshot.snapshot_date: snapshot
            for snapshot in snapshot_result.scalars().all()
        }

    holding_context_by_snapshot_date = {
        snapshot_date: _build_holding_context_index(snapshot)
        for snapshot_date, snapshot in snapshots_by_date.items()
    }
    history_entries = []
    for history_job, history_report, prompt_metadata in history_items:
        holding_context_index = (
            holding_context_by_snapshot_date.get(prompt_metadata.snapshot_date, {})
            if prompt_metadata.snapshot_date
            else {}
        )
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
        currency_code="INR",
        portfolio_percentage_label="Percentage of India Portfolio",
    )


def _build_holding_context_index(snapshot) -> dict[str, HoldingContext]:
    if snapshot is None:
        return {}

    total_invested_value = sum(
        amount
        for holding in snapshot.holdings or []
        if (amount := _optional_float(holding.get("invested_value"))) is not None
    )
    total_market_value = snapshot.holdings_market_value or 0.0
    contexts = []
    for holding in snapshot.holdings or []:
        invested_value = _optional_float(holding.get("invested_value"))
        market_value = _optional_float(holding.get("market_value"))
        contexts.append(
            HoldingContext(
                exchange=str(holding.get("exchange") or ""),
                stock_symbol=str(holding.get("tradingsymbol") or ""),
                stock_name=str(holding.get("tradingsymbol") or ""),
                amount_invested=invested_value,
                portfolio_percentage=resolve_portfolio_percentage(
                    amount_invested=invested_value,
                    total_amount_invested=total_invested_value,
                    position_value=market_value,
                    total_position_value=total_market_value,
                ),
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
    metadata = extract_threat_prompt_metadata(job.prompt or "")
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
        auto_rebalance_portfolio=job.auto_rebalance_portfolio,
        auto_rebalance_sequence=job.auto_rebalance_sequence,
        auto_rebalance_label=job.auto_rebalance_label,
    )
