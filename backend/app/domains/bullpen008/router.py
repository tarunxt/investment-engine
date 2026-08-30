from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings as app_settings
from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import User
from app.domains.bullpen008.constants import (
    CELERY_QUEUE,
    PENDING_MARKER_TTL_SECONDS,
    REDIS_PREFIX,
)
from app.domains.bullpen008.schemas import (
    Bullpen008Bootstrap,
    Bullpen008HistoryPage,
    Bullpen008Run,
    Bullpen008RunRequest,
    Bullpen008Settings,
    Bullpen008SettingsUpdate,
    Bullpen008StageOutput,
    Bullpen008State,
)
from app.domains.bullpen008.service import (
    create_run_record,
    get_bootstrap,
    get_history,
    get_run,
    get_stage,
    get_settings,
    run_from_record,
    set_scheduler_running,
    update_settings,
)
from app.domains.bullpen008.tasks import execute_bullpen008_shadow_run
from app.infrastructure.database.session import get_async_db

router = APIRouter(prefix="/polymarket/bullpen008", tags=["bullpen008"])


def _pending_key(user_id: int) -> str:
    return f"{REDIS_PREFIX}:pending:user:{user_id}"


@router.get("/bootstrap", response_model=Bullpen008Bootstrap)
async def bullpen008_bootstrap(
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_async_db),
) -> Bullpen008Bootstrap:
    return await get_bootstrap(session, user_id=current_user.id)


@router.get("/settings", response_model=Bullpen008Settings)
async def bullpen008_settings(
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_async_db),
) -> Bullpen008Settings:
    return await get_settings(session, user_id=current_user.id)


@router.put("/settings", response_model=Bullpen008Settings)
async def save_bullpen008_settings(
    update: Bullpen008SettingsUpdate,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_async_db),
) -> Bullpen008Settings:
    try:
        return await update_settings(
            session,
            user_id=current_user.id,
            update=update,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/scheduler/start", response_model=Bullpen008State)
async def start_bullpen008_scheduler(
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_async_db),
) -> Bullpen008State:
    return await set_scheduler_running(session, user_id=current_user.id, running=True)


@router.post("/scheduler/stop", response_model=Bullpen008State)
async def stop_bullpen008_scheduler(
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_async_db),
) -> Bullpen008State:
    return await set_scheduler_running(session, user_id=current_user.id, running=False)


@router.post("/run-once", response_model=Bullpen008Run, status_code=202)
async def run_bullpen008_once(
    request: Bullpen008RunRequest | None = None,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_async_db),
) -> Bullpen008Run:
    import redis.asyncio as aioredis

    redis_client = aioredis.from_url(app_settings.redis_url, decode_responses=True)
    pending_key = _pending_key(current_user.id)
    acquired = await redis_client.set(
        pending_key,
        "manual",
        nx=True,
        ex=PENDING_MARKER_TTL_SECONDS,
    )
    if not acquired:
        await redis_client.close()
        raise HTTPException(
            status_code=409,
            detail="A Bullpen 008 shadow run is already queued or running.",
        )
    try:
        record = await create_run_record(
            session,
            user_id=current_user.id,
            triggered_by="manual",
            idempotency_key=request.idempotency_key if request else None,
        )
        async_result = execute_bullpen008_shadow_run.apply_async(
            args=[record.id],
            queue=CELERY_QUEUE,
            task_id=f"bullpen008:{record.id}",
            headers={
                "workflow_profile": "bullpen008",
                "shadow_mode": True,
                "orders_permitted": False,
            },
        )
        record.task_metadata = {
            **dict(record.task_metadata),
            "celery_task_id": async_result.id,
            "dispatch_status": "published",
        }
        await session.commit()
        loaded = await get_run(session, user_id=current_user.id, run_id=record.id)
        assert loaded is not None
        return run_from_record(loaded)
    except Exception:
        await redis_client.delete(pending_key)
        raise
    finally:
        await redis_client.close()


@router.get("/runs", response_model=Bullpen008HistoryPage)
async def bullpen008_runs(
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_async_db),
) -> Bullpen008HistoryPage:
    return await get_history(
        session,
        user_id=current_user.id,
        limit=limit,
        offset=offset,
    )


@router.get("/runs/{run_id}", response_model=Bullpen008Run)
async def bullpen008_run_detail(
    run_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_async_db),
) -> Bullpen008Run:
    record = await get_run(session, user_id=current_user.id, run_id=run_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Bullpen 008 run not found.")
    return run_from_record(record, include_stage_payloads=False)


@router.get(
    "/runs/{run_id}/stages/{stage_number}",
    response_model=Bullpen008StageOutput,
)
async def bullpen008_stage_detail(
    run_id: str,
    stage_number: int,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_async_db),
) -> Bullpen008StageOutput:
    if stage_number not in {1, 2, 3, 4}:
        raise HTTPException(status_code=404, detail="Bullpen 008 stage not found.")
    stage = await get_stage(
        session,
        user_id=current_user.id,
        run_id=run_id,
        stage_number=stage_number,
    )
    if stage is None:
        raise HTTPException(status_code=404, detail="Bullpen 008 stage not found.")
    return stage


@router.post("/orders", status_code=403)
async def bullpen008_orders_disabled(
    _current_user: User = Depends(get_current_user),
) -> None:
    raise HTTPException(
        status_code=403,
        detail="Bullpen 008 order creation is disabled in Phase 1 shadow mode.",
    )
