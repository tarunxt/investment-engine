import redis.asyncio as aioredis
from redis.exceptions import WatchError
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from datetime import datetime, timezone
import re

from app.core.config import settings
from app.domains.ai_providers.factory import ProviderFactory
from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import User
from app.domains.jobs.models import Job
from app.domains.runs.models import (
    AutoRebalanceWorkflow,
    AutoRebalanceWorkflowStage,
    Run,
    RunJob,
)
from app.domains.runs.repository import PostgresRunRepository
from app.domains.runs.schemas import (
    AutoRebalanceCompletionEmailRequest,
    AutoRebalanceHistoryDetailResponse,
    AutoRebalanceHistoryItemResponse,
    AutoRebalanceHistoryListResponse,
    AutoRebalanceJobDetailResponse,
    AutoRebalanceRunReservationRequest,
    AutoRebalanceRunReservationResponse,
    AutoRebalanceRunDetailResponse,
    AutoRebalanceStageKey,
    AutoRebalanceStageResponse,
    AutoRebalanceStageUpdateRequest,
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
from app.infrastructure.messaging.task_registry import revoke_registered_job_task
from app.shared.exceptions import AppException
from app.shared.pagination import PagedQuery
from app.shared.types import JobStatus, UserId

router = APIRouter(prefix="/runs", tags=["runs"])
RUN_PROMPT_PREVIEW_CHARS = 280
AUTO_REBALANCE_LABEL_PREFIXES = {
    "india": "India Run",
    "indmoney_us": "IndMoney US Run",
}
AUTO_REBALANCE_STAGE_ORDER: tuple[AutoRebalanceStageKey, ...] = (
    "sync", "threats", "swing", "rebalance", "technical", "actionables",
)
AUTO_REBALANCE_ACTIVE_STATUSES = {"queued", "pending", "processing", "running"}
AUTO_REBALANCE_TERMINAL_STATUSES = {
    "completed",
    "partial",
    "failed",
    "skipped",
    "paused",
    "cancelled",
    "interrupted",
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
    workflow_max = (await db.execute(
        select(func.max(AutoRebalanceWorkflow.sequence)).where(
            AutoRebalanceWorkflow.portfolio == portfolio,
        )
    )).scalar_one_or_none() or 0
    return max(int(run_max), int(job_max), int(workflow_max))


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


def _base_auto_rebalance_label(label: str | None, portfolio: str, sequence: int) -> str:
    fallback = _format_auto_rebalance_label(portfolio, sequence)
    return re.sub(
        r"\s+\((?:threats(?:\s*(?:&|and)\s*guardrails)?|swing|rebalance|technical)\s+scan\)\s*$",
        "",
        (label or fallback).strip(),
        flags=re.IGNORECASE,
    ) or fallback


def _infer_auto_rebalance_stage(label: str | None, prompt: str | None) -> AutoRebalanceStageKey:
    text = f"{label or ''}\n{prompt or ''}".lower()
    if "[zerodha_threats]" in text or "[indmoney_us_threats]" in text or "threat" in (label or "").lower():
        return "threats"
    if "technical scan" in text or "## technical scan input bundle" in text:
        return "technical"
    if "rebalance scan" in text or "[rebalance_flow:" in text:
        return "rebalance"
    return "swing"


def _status_value(value: object) -> str:
    return getattr(value, "value", str(value or "queued")).lower()


def _is_terminal_auto_rebalance_status(status: str) -> bool:
    return status.lower() in AUTO_REBALANCE_TERMINAL_STATUSES


def _latest_timestamp(values: list[datetime | None]) -> datetime | None:
    timestamps = [value for value in values if value is not None]
    return max(timestamps, key=_timestamp_sort_key) if timestamps else None


def _earliest_timestamp(values: list[datetime | None]) -> datetime | None:
    timestamps = [value for value in values if value is not None]
    return min(timestamps, key=_timestamp_sort_key) if timestamps else None


def _timestamp_sort_key(value: datetime) -> float:
    """Compare legacy naive timestamps and new UTC-aware audit timestamps safely."""
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.timestamp()


def _serialize_auto_rebalance_job(job: Job) -> AutoRebalanceJobDetailResponse:
    return AutoRebalanceJobDetailResponse(
        id=job.id,
        provider=job.provider,
        model=job.model,
        status=_status_value(job.status),
        prompt=job.prompt,
        response=job.response,
        error_message=job.error_message,
        tokens_in=job.tokens_in,
        tokens_out=job.tokens_out,
        estimated_cost=job.estimated_cost,
        web_search_used=job.web_search_used,
        web_search_queries=job.web_search_queries,
        web_sources=job.web_sources,
        runtime_metadata_json=job.runtime_metadata_json,
        created_at=job.created_at,
        updated_at=job.updated_at,
    )


def _derive_stage_status(jobs: list[Job]) -> str:
    statuses = [_status_value(job.status) for job in jobs]
    if not statuses:
        return "queued"
    if any(status in AUTO_REBALANCE_ACTIVE_STATUSES for status in statuses):
        return "processing"
    succeeded = sum(status in {"completed", "partial"} for status in statuses)
    failed = sum(status == "failed" for status in statuses)
    if succeeded and failed:
        return "partial"
    if succeeded:
        return "completed"
    if failed:
        return "failed"
    return statuses[0]


def _stage_response(
    stage: AutoRebalanceStageKey,
    *,
    event: AutoRebalanceWorkflowStage | None,
    runs: list[Run],
    standalone_jobs: list[Job],
) -> AutoRebalanceStageResponse:
    jobs = [
        job
        for run in runs
        for link in run.run_jobs
        if (job := link.job) is not None
    ] + standalone_jobs
    failed_jobs = [job for job in jobs if _status_value(job.status) == "failed"]
    event_status = event.status.lower() if event else None
    status = event_status or _derive_stage_status(jobs)
    if event_status in AUTO_REBALANCE_ACTIVE_STATUSES and jobs:
        # A stale browser can leave an event at processing after its worker has
        # finished. The durable child job is authoritative in that case.
        derived_status = _derive_stage_status(jobs)
        if _is_terminal_auto_rebalance_status(derived_status):
            status = derived_status
    return AutoRebalanceStageResponse(
        stage=stage,
        status=status,
        run_id=event.run_id if event and event.run_id else (runs[-1].id if runs else None),
        job_id=event.job_id if event and event.job_id else (standalone_jobs[-1].id if standalone_jobs else None),
        summary=dict(event.summary_json or {}) if event else {},
        error_message=(
            event.error_message
            if event and event.error_message
            else (failed_jobs[-1].error_message if failed_jobs else None)
        ),
        started_at=(
            event.started_at
            if event and event.started_at
            else _earliest_timestamp([*(run.created_at for run in runs), *(job.created_at for job in standalone_jobs)])
        ),
        completed_at=(
            event.completed_at
            if event and event.completed_at
            else _latest_timestamp(
                [
                    *(run.updated_at for run in runs if _is_terminal_auto_rebalance_status(_status_value(run.status))),
                    *(job.updated_at for job in standalone_jobs if _is_terminal_auto_rebalance_status(_status_value(job.status))),
                ]
            )
        ),
        provider_count=len(jobs),
        completed_provider_count=sum(
            _status_value(job.status) in {"completed", "partial"} for job in jobs
        ),
        failed_provider_count=len(failed_jobs),
        estimated_cost=round(sum(job.estimated_cost or 0 for job in jobs), 8),
    )


async def _build_auto_rebalance_history(
    db: AsyncSession,
    *,
    user_id: int,
    portfolio: str,
) -> list[tuple[AutoRebalanceHistoryItemResponse, list[Run], list[Job]]]:
    workflows = list(
        (await db.execute(
            select(AutoRebalanceWorkflow)
            .where(
                AutoRebalanceWorkflow.user_id == user_id,
                AutoRebalanceWorkflow.portfolio == portfolio,
            )
            .options(selectinload(AutoRebalanceWorkflow.stages))
        )).scalars().all()
    )
    runs = list(
        (await db.execute(
            select(Run)
            .where(
                Run.user_id == user_id,
                Run.auto_rebalance_portfolio == portfolio,
                Run.auto_rebalance_sequence.is_not(None),
            )
            .options(selectinload(Run.run_jobs).selectinload(RunJob.job))
        )).scalars().all()
    )
    jobs = list(
        (await db.execute(
            select(Job).where(
                Job.user_id == user_id,
                Job.auto_rebalance_portfolio == portfolio,
                Job.auto_rebalance_sequence.is_not(None),
            )
        )).scalars().all()
    )

    grouped: dict[int, dict] = {}
    for workflow in workflows:
        grouped[workflow.sequence] = {
            "workflow": workflow,
            "runs": [],
            "jobs": [],
        }
    for run in runs:
        if run.auto_rebalance_sequence is None:
            continue
        grouped.setdefault(run.auto_rebalance_sequence, {"workflow": None, "runs": [], "jobs": []})["runs"].append(run)
    run_job_ids = {link.job_id for run in runs for link in run.run_jobs}
    for job in jobs:
        if job.auto_rebalance_sequence is None or job.id in run_job_ids:
            continue
        grouped.setdefault(job.auto_rebalance_sequence, {"workflow": None, "runs": [], "jobs": []})["jobs"].append(job)

    result: list[tuple[AutoRebalanceHistoryItemResponse, list[Run], list[Job]]] = []
    for sequence, group in grouped.items():
        workflow: AutoRebalanceWorkflow | None = group["workflow"]
        group_runs: list[Run] = group["runs"]
        group_jobs: list[Job] = group["jobs"]
        label_source = workflow.label if workflow else next(
            (run.auto_rebalance_label for run in group_runs if run.auto_rebalance_label),
            next((job.auto_rebalance_label for job in group_jobs if job.auto_rebalance_label), None),
        )
        label = _base_auto_rebalance_label(label_source, portfolio, sequence)
        events = {event.stage: event for event in (workflow.stages if workflow else [])}
        runs_by_stage: dict[AutoRebalanceStageKey, list[Run]] = {}
        jobs_by_stage: dict[AutoRebalanceStageKey, list[Job]] = {}
        for run in group_runs:
            stage = _infer_auto_rebalance_stage(run.auto_rebalance_label, run.prompt)
            runs_by_stage.setdefault(stage, []).append(run)
        for job in group_jobs:
            stage = _infer_auto_rebalance_stage(job.auto_rebalance_label, job.prompt)
            jobs_by_stage.setdefault(stage, []).append(job)
        stage_responses = [
            _stage_response(
                stage,
                event=events.get(stage),
                runs=runs_by_stage.get(stage, []),
                standalone_jobs=jobs_by_stage.get(stage, []),
            )
            for stage in AUTO_REBALANCE_STAGE_ORDER
            if stage in events or stage in runs_by_stage or stage in jobs_by_stage
        ]
        active = [stage for stage in stage_responses if stage.status in AUTO_REBALANCE_ACTIVE_STATUSES]
        failed = [stage for stage in stage_responses if stage.status == "failed"]
        if failed:
            derived_status = "failed"
        elif active:
            derived_status = "processing"
        elif stage_responses:
            derived_status = "completed"
        else:
            derived_status = "queued"
        current_stage = (
            active[-1].stage if active else (stage_responses[-1].stage if stage_responses else None)
        )
        all_jobs = [
            *(job for run in group_runs for link in run.run_jobs if (job := link.job) is not None),
            *group_jobs,
        ]
        created_at = _earliest_timestamp([
            workflow.created_at if workflow else None,
            *(run.created_at for run in group_runs),
            *(job.created_at for job in group_jobs),
        ]) or datetime.now(timezone.utc)
        updated_at = _latest_timestamp([
            workflow.updated_at if workflow else None,
            *(run.updated_at for run in group_runs),
            *(job.updated_at for job in group_jobs),
        ]) or created_at
        error_message = (
            failed[-1].error_message if failed else (workflow.error_message if workflow else None)
        )
        result.append((
            AutoRebalanceHistoryItemResponse(
                portfolio=portfolio,
                sequence=sequence,
                label=label,
                status=derived_status if not workflow or workflow.status in AUTO_REBALANCE_ACTIVE_STATUSES else workflow.status,
                current_stage=current_stage or (workflow.current_stage if workflow else None),
                error_message=error_message,
                created_at=created_at,
                updated_at=updated_at,
                completed_at=(
                    workflow.completed_at if workflow and workflow.completed_at else _latest_timestamp([stage.completed_at for stage in stage_responses])
                ),
                total_estimated_cost=round(sum(job.estimated_cost or 0 for job in all_jobs), 8),
                stages=stage_responses,
            ),
            group_runs,
            group_jobs,
        ))
    return sorted(result, key=lambda entry: (entry[0].sequence, entry[0].updated_at), reverse=True)


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
    workflow = AutoRebalanceWorkflow(
        user_id=current_user.id,
        portfolio=body.portfolio,
        sequence=sequence,
        label=_format_auto_rebalance_label(body.portfolio, sequence),
        status="queued",
        current_stage="sync",
    )
    db.add(workflow)
    await db.commit()
    return AutoRebalanceRunReservationResponse(
        portfolio=body.portfolio,
        sequence=sequence,
        label=workflow.label,
    )


@router.get("/auto-rebalance-history", response_model=AutoRebalanceHistoryListResponse)
async def list_auto_rebalance_history(
    portfolio: str = Query(..., pattern="^(india|indmoney_us)$"),
    limit: int = Query(default=100, ge=1, le=250),
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    history = await _build_auto_rebalance_history(
        db,
        user_id=current_user.id,
        portfolio=portfolio,
    )
    return AutoRebalanceHistoryListResponse(
        items=[item for item, _, _ in history[:limit]],
        total=len(history),
    )


@router.get(
    "/auto-rebalance-history/{portfolio}/{sequence}",
    response_model=AutoRebalanceHistoryDetailResponse,
)
async def get_auto_rebalance_history_detail(
    portfolio: str,
    sequence: int,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    if portfolio not in AUTO_REBALANCE_LABEL_PREFIXES:
        raise HTTPException(404, detail="Auto-rebalance portfolio not found")
    history = await _build_auto_rebalance_history(
        db,
        user_id=current_user.id,
        portfolio=portfolio,
    )
    match = next((entry for entry in history if entry[0].sequence == sequence), None)
    if not match:
        raise HTTPException(404, detail="Auto-rebalance run not found")
    item, runs, standalone_jobs = match
    detailed_runs = [
        AutoRebalanceRunDetailResponse(
            id=run.id,
            status=_status_value(run.status),
            prompt=run.prompt,
            created_at=run.created_at,
            updated_at=run.updated_at,
            jobs=[
                _serialize_auto_rebalance_job(link.job)
                for link in run.run_jobs
                if link.job is not None
            ],
        )
        for run in sorted(runs, key=lambda value: value.id)
    ]
    return AutoRebalanceHistoryDetailResponse(
        **item.model_dump(),
        runs=detailed_runs,
        standalone_jobs=[
            _serialize_auto_rebalance_job(job)
            for job in sorted(standalone_jobs, key=lambda value: value.id)
        ],
    )


@router.patch(
    "/auto-rebalance-history/{portfolio}/{sequence}/stages/{stage}",
    response_model=AutoRebalanceStageResponse,
)
async def update_auto_rebalance_stage(
    portfolio: str,
    sequence: int,
    stage: AutoRebalanceStageKey,
    body: AutoRebalanceStageUpdateRequest,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    if portfolio not in AUTO_REBALANCE_LABEL_PREFIXES:
        raise HTTPException(404, detail="Auto-rebalance portfolio not found")
    # Lock the parent row. The dashboard may send a "started" audit update and
    # an ID-linking update almost at the same time; serializing them prevents a
    # duplicate stage row and makes updates idempotent across browser retries.
    workflow = (await db.execute(
        select(AutoRebalanceWorkflow)
        .where(
            AutoRebalanceWorkflow.user_id == current_user.id,
            AutoRebalanceWorkflow.portfolio == portfolio,
            AutoRebalanceWorkflow.sequence == sequence,
        )
        .with_for_update()
        .options(selectinload(AutoRebalanceWorkflow.stages))
    )).scalar_one_or_none()
    if not workflow:
        raise HTTPException(404, detail="Auto-rebalance run not found")
    if body.run_id is not None:
        run = (await db.execute(
            select(Run).where(Run.id == body.run_id, Run.user_id == current_user.id)
        )).scalar_one_or_none()
        if not run:
            raise HTTPException(404, detail="Referenced run not found")
        if (
            run.auto_rebalance_portfolio != portfolio
            or run.auto_rebalance_sequence != sequence
        ):
            raise HTTPException(422, detail="Referenced run belongs to another auto-rebalance")
    if body.job_id is not None:
        job = (await db.execute(
            select(Job).where(Job.id == body.job_id, Job.user_id == current_user.id)
        )).scalar_one_or_none()
        if not job:
            raise HTTPException(404, detail="Referenced job not found")
        if (
            job.auto_rebalance_portfolio != portfolio
            or job.auto_rebalance_sequence != sequence
        ):
            raise HTTPException(422, detail="Referenced job belongs to another auto-rebalance")

    stage_record = next((item for item in workflow.stages if item.stage == stage), None)
    if not stage_record:
        stage_record = AutoRebalanceWorkflowStage(workflow_id=workflow.id, stage=stage)
        db.add(stage_record)
    existing_status = stage_record.status.lower()
    requested_status = body.status
    # Audit writes are deliberately asynchronous in the client. Once a stage
    # has a terminal outcome, an in-flight older update must not regress it to
    # a different outcome. We still accept IDs and non-empty summary fields
    # from that delayed write.
    status = (
        existing_status
        if existing_status in AUTO_REBALANCE_TERMINAL_STATUSES
        else requested_status
    )
    stage_record.status = status
    stage_record.run_id = body.run_id or stage_record.run_id
    stage_record.job_id = body.job_id or stage_record.job_id
    stage_record.summary_json = body.summary or stage_record.summary_json
    if body.error_message is not None:
        stage_record.error_message = body.error_message
    stage_record.started_at = body.started_at or stage_record.started_at or datetime.now(timezone.utc)
    if body.completed_at is not None:
        stage_record.completed_at = body.completed_at
    elif status in AUTO_REBALANCE_TERMINAL_STATUSES:
        stage_record.completed_at = datetime.now(timezone.utc)

    workflow.current_stage = stage
    if status == "failed":
        workflow.status = "failed"
        workflow.error_message = stage_record.error_message or f"{stage} stage failed"
        workflow.completed_at = stage_record.completed_at
    elif status in {"paused", "cancelled", "interrupted"}:
        workflow.status = status
        workflow.error_message = stage_record.error_message or f"{stage} stage {status}"
        workflow.completed_at = stage_record.completed_at
    elif stage == "actionables" and status in {"completed", "partial", "skipped"}:
        workflow.status = "completed" if status != "partial" else "partial"
        workflow.error_message = None
        workflow.completed_at = stage_record.completed_at
    else:
        workflow.status = "processing" if status != "skipped" else workflow.status
        if status != "failed":
            workflow.error_message = None
    await db.commit()

    history = await _build_auto_rebalance_history(
        db,
        user_id=current_user.id,
        portfolio=portfolio,
    )
    item = next((entry[0] for entry in history if entry[0].sequence == sequence), None)
    if not item:
        raise HTTPException(500, detail="Auto-rebalance stage could not be reloaded")
    response = next((stage_item for stage_item in item.stages if stage_item.stage == stage), None)
    if not response:
        raise HTTPException(500, detail="Auto-rebalance stage could not be serialized")
    return response


@router.post("/auto-rebalance-completion-email")
async def queue_auto_rebalance_completion_email(
    body: AutoRebalanceCompletionEmailRequest,
    current_user: User = Depends(get_current_user),
):
    dedupe_key = f"auto_rebalance_success_email_sent:{current_user.id}:{body.portfolio}:{body.sequence}"
    redis = _get_redis()
    try:
        queued = await redis.set(dedupe_key, "1", nx=True, ex=60 * 60 * 24 * 30)
    finally:
        await redis.aclose()
    if not queued:
        return {"status": "already_queued"}

    from app.domains.runs.tasks import send_auto_rebalance_success_email_task

    send_auto_rebalance_success_email_task.delay(  # type: ignore
        current_user.id,
        body.portfolio,
        body.label,
        body.completed_at.isoformat(),
        body.total_cost_inr,
        body.total_llm_time,
        body.stages_completed,
    )
    return {"status": "queued"}


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
    result = await repo.list(
        PagedQuery(page=page, limit=limit),
        user_id=current_user.id,
        summary=summary,
    )
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
    run = await repo.get(run_id, user_id=current_user.id)
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
    run = await repo.get(run_id, user_id=current_user.id)
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
    jobs: list[Job] = []
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

    from app.domains.jobs.tasks import _publish_job_update, _publish_run_update

    for job in jobs:
        if job.status == JobStatus.FAILED and (job.error_message or "").lower().find("cancelled") >= 0:
            _publish_job_update(job)
            await revoke_registered_job_task(job.id)

    run = await repo.get(run_id, user_id=current_user.id)
    if not run:
        raise HTTPException(404, detail="Run not found")
    _publish_run_update(
        run.id,
        run.user_id,
        run.status,
        run.current_stage,
        run.export_status,
        run.export_error,
        run.exported_at.isoformat() if run.exported_at else None,
        run.exported_sheet_url,
    )
    return run
