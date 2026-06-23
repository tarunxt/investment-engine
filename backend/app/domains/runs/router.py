import redis.asyncio as aioredis
from redis.exceptions import WatchError
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.domains.ai_providers.factory import ProviderFactory
from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import User
from app.domains.jobs.models import Job
from app.domains.runs.models import Run, RunJob
from app.domains.runs.repository import PostgresRunRepository
from app.domains.runs.schemas import (
    AutoRebalanceRunReservationRequest,
    AutoRebalanceRunReservationResponse,
    RunCreate,
    RunListItem,
    RunResponse,
)
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
RUN_PROMPT_PREVIEW_CHARS = 280
AUTO_REBALANCE_LABEL_PREFIXES = {
    "india": "India Run",
    "indmoney_us": "IndMoney US Run",
}



def _get_redis() -> aioredis.Redis:
    return aioredis.from_url(settings.redis_url, decode_responses=True)


def _format_auto_rebalance_label(portfolio: str, sequence: int) -> str:
    return f"{AUTO_REBALANCE_LABEL_PREFIXES[portfolio]} #{sequence}"


async def _get_max_auto_rebalance_sequence(db: AsyncSession, portfolio: str) -> int:
    run_max = (await db.execute(
        select(func.max(Run.auto_rebalance_sequence)).where(
            Run.auto_rebalance_portfolio == portfolio,
        )
    )).scalar_one_or_none() or 0
    job_max = (await db.execute(
        select(func.max(Job.auto_rebalance_sequence)).where(
            Job.auto_rebalance_portfolio == portfolio,
        )
    )).scalar_one_or_none() or 0
    return max(int(run_max), int(job_max))


def _coerce_auto_rebalance_sequence(value: object) -> int:
    try:
        sequence = int(value)
    except (TypeError, ValueError):
        return 0
    return sequence if sequence > 0 else 0


def _next_auto_rebalance_sequence(current_sequence: object, persisted_max_sequence: int) -> int:
    return max(
        _coerce_auto_rebalance_sequence(current_sequence),
        _coerce_auto_rebalance_sequence(persisted_max_sequence),
    ) + 1


async def _reserve_auto_rebalance_sequence(db: AsyncSession, redis: aioredis.Redis, portfolio: str) -> int:
    key = f"auto_rebalance_run_sequence:{portfolio}"
    persisted_max_sequence = await _get_max_auto_rebalance_sequence(db, portfolio)

    while True:
        async with redis.pipeline(transaction=True) as pipe:
            try:
                await pipe.watch(key)
                current_sequence = await pipe.get(key)
                next_sequence = _next_auto_rebalance_sequence(
                    current_sequence,
                    persisted_max_sequence,
                )
                pipe.multi()
                pipe.set(key, next_sequence)
                await pipe.execute()
                return next_sequence
            except WatchError:
                continue


def _preview_prompt(prompt: str) -> str:
    normalized = " ".join(prompt.split())
    if len(normalized) <= RUN_PROMPT_PREVIEW_CHARS:
        return normalized
    return f"{normalized[:RUN_PROMPT_PREVIEW_CHARS].rstrip()}..."


def _provider_uses_model_side_search(provider_name: str) -> bool:
    access = ProviderFactory.get_provider_internet_access(provider_name)
    return access.get("mode") != "none"


def _serialize_run_list_item(run) -> RunListItem:
    return RunListItem(
        id=run.id,
        prompt_preview=_preview_prompt(run.prompt),
        prompt_id=run.prompt_id,
        status=run.status,
        current_stage=run.current_stage,
        run_jobs=run.run_jobs,
        auto_export_enabled=run.auto_export_enabled,
        export_status=run.export_status,
        export_error=run.export_error,
        exported_at=run.exported_at,
        exported_sheet_url=run.exported_sheet_url,
        auto_rebalance_portfolio=run.auto_rebalance_portfolio,
        auto_rebalance_sequence=run.auto_rebalance_sequence,
        auto_rebalance_label=run.auto_rebalance_label,
        created_at=run.created_at,
        updated_at=run.updated_at,
    )


@router.post("/auto-rebalance-label", response_model=AutoRebalanceRunReservationResponse)
async def reserve_auto_rebalance_label(
    body: AutoRebalanceRunReservationRequest,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    redis = _get_redis()
    try:
        sequence = await _reserve_auto_rebalance_sequence(db, redis, body.portfolio)
    finally:
        await redis.aclose()
    return AutoRebalanceRunReservationResponse(
        portfolio=body.portfolio,
        sequence=sequence,
        label=_format_auto_rebalance_label(body.portfolio, sequence),
    )


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
        if (
            body.polymarket_event_context is not None
            and body.polymarket_event_context.evidence_options.require_fresh_internet_evidence
            and not body.polymarket_event_context.evidence_options.allow_evidence_grounded_non_web_models
            and not _provider_uses_model_side_search(t.provider)
        ):
            raise HTTPException(
                400,
                detail=(
                    f"Model '{t.model}' for provider '{t.provider}' has no model-side search. "
                    "Enable 'Allow evidence-grounded non-web models' or choose a searchable model."
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
                polymarket_event_context=(
                    body.polymarket_event_context.model_dump(mode="json")
                    if body.polymarket_event_context is not None
                    else None
                ),
                prompt_id=body.prompt_id,
                scheduled_at=body.scheduled_at,
                auto_export_enabled=body.auto_export_enabled,
                export_spreadsheet_url=body.export_spreadsheet_url,
                export_sheet_name=body.export_sheet_name,
                export_investment_amount=body.export_investment_amount,
                export_title=body.export_title,
                allow_parallel=body.allow_parallel,
                auto_rebalance_portfolio=body.auto_rebalance_portfolio,
                auto_rebalance_sequence=body.auto_rebalance_sequence,
                auto_rebalance_label=body.auto_rebalance_label,
            )
        )
    except AppException as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message)

    return run


@router.get("")
async def list_runs(
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    summary: bool = Query(False),
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    repo = PostgresRunRepository(db)
    result = await repo.list(PagedQuery(page=page, limit=limit), summary=summary)
    items = (
        [_serialize_run_list_item(run) for run in result.items]
        if summary
        else [RunResponse.model_validate(run) for run in result.items]
    )
    return {
        **result.to_dict(),
        "items": items,
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
