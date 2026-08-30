from __future__ import annotations

import asyncio
import os
from uuid import uuid4

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
    Bullpen008ExecutionControlRequest,
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
    recover_interrupted_previous_build_run,
    run_from_record,
    set_emergency_stop,
    set_execution_control,
    set_scheduler_paused,
    set_scheduler_running,
    update_settings,
)
from app.domains.bullpen008.tasks import execute_bullpen008_run
from app.domains.bullpen_run_audit.provenance import resolve_backend_commit_sha
from app.infrastructure.database.session import get_async_db

router = APIRouter(prefix="/polymarket/bullpen008", tags=["bullpen008"])

# The public same-origin proxy has a deliberately small mutation budget.  A
# broker reconnect can consume several seconds even though the publish later
# succeeds, so only wait briefly for the acknowledgement.  The run is already
# durable and the stable Celery task id plus run lock make the ambiguous path
# idempotent.
PUBLISH_ACK_TIMEOUT_SECONDS = 0.25


def _pending_key(user_id: int) -> str:
    return f"{REDIS_PREFIX}:pending:user:{user_id}"


async def _recover_interrupted_008_build(
    session: AsyncSession,
    *,
    user_id: int,
) -> str | None:
    import redis.asyncio as aioredis

    current_build = resolve_backend_commit_sha()
    interrupted_run_id = await recover_interrupted_previous_build_run(
        session,
        user_id=user_id,
        current_build=current_build,
    )
    if interrupted_run_id is None:
        return None
    redis_client = aioredis.from_url(app_settings.redis_url, decode_responses=True)
    try:
        await redis_client.delete(f"{REDIS_PREFIX}:run:{interrupted_run_id}:lock")
        await redis_client.delete(_pending_key(user_id))
    finally:
        await redis_client.close()
    return interrupted_run_id


@router.get("/bootstrap", response_model=Bullpen008Bootstrap)
async def bullpen008_bootstrap(
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_async_db),
) -> Bullpen008Bootstrap:
    await _recover_interrupted_008_build(session, user_id=current_user.id)
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


@router.post("/scheduler/pause", response_model=Bullpen008State)
async def pause_bullpen008_scheduler(
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_async_db),
) -> Bullpen008State:
    return await set_scheduler_paused(session, user_id=current_user.id, paused=True)


@router.post("/scheduler/resume", response_model=Bullpen008State)
async def resume_bullpen008_scheduler(
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_async_db),
) -> Bullpen008State:
    return await set_scheduler_paused(session, user_id=current_user.id, paused=False)


@router.post("/emergency-stop", response_model=Bullpen008State)
async def activate_bullpen008_emergency_stop(
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_async_db),
) -> Bullpen008State:
    return await set_emergency_stop(session, user_id=current_user.id, active=True)


@router.post("/emergency-stop/clear", response_model=Bullpen008State)
async def clear_bullpen008_emergency_stop(
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_async_db),
) -> Bullpen008State:
    return await set_emergency_stop(session, user_id=current_user.id, active=False)


@router.post("/execution-control", response_model=Bullpen008Settings)
async def update_bullpen008_execution_control(
    request: Bullpen008ExecutionControlRequest,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_async_db),
) -> Bullpen008Settings:
    if request.mode == "live":
        if request.confirmation != "ARM BULLPEN 008 LIVE":
            raise HTTPException(status_code=400, detail="Exact Bullpen 008 live confirmation is required.")
        if os.getenv("BULLPEN008_LIVE_EXECUTION_ENABLED", "").strip().lower() not in {"1", "true", "yes"}:
            raise HTTPException(status_code=403, detail="Bullpen 008 live execution is disabled by the production environment.")
    elif request.confirmation != "RETURN BULLPEN 008 TO SHADOW":
        raise HTTPException(status_code=400, detail="Exact Bullpen 008 shadow confirmation is required.")
    return await set_execution_control(
        session,
        user_id=current_user.id,
        live=request.mode == "live",
    )


@router.post("/run-once", response_model=Bullpen008Run, status_code=202)
async def run_bullpen008_once(
    request: Bullpen008RunRequest | None = None,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_async_db),
) -> Bullpen008Run:
    import redis.asyncio as aioredis

    redis_client = aioredis.from_url(app_settings.redis_url, decode_responses=True)
    pending_key = _pending_key(current_user.id)
    await _recover_interrupted_008_build(session, user_id=current_user.id)
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
        publish = asyncio.create_task(
            asyncio.to_thread(
                execute_bullpen008_run.apply_async,
                args=[record.id],
                queue=CELERY_QUEUE,
                task_id=f"bullpen008:{record.id}",
                headers={
                    "workflow_profile": "bullpen008",
                    "shadow_mode": record.shadow_mode,
                    "orders_permitted": record.execution_enabled,
                },
                retry=False,
            )
        )
        try:
            async_result = await asyncio.wait_for(
                asyncio.shield(publish), timeout=PUBLISH_ACK_TIMEOUT_SECONDS
            )
            dispatch_status = "published"
            celery_task_id = async_result.id
        except TimeoutError:
            # The broker result is ambiguous, but the stable task ID and the
            # worker's isolated run lock make any later duplicate delivery a
            # no-op. Return the persisted run promptly so the UI never invents
            # a second run after a proxy timeout.
            dispatch_status = "publish-timeout-ambiguous"
            celery_task_id = f"bullpen008:{record.id}"
            publish.add_done_callback(
                lambda task: task.exception() if not task.cancelled() else None
            )
        record.task_metadata = {
            **dict(record.task_metadata),
            "celery_task_id": celery_task_id,
            "dispatch_status": dispatch_status,
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


@router.post("/runs/{run_id}/retry", response_model=Bullpen008Run, status_code=202)
async def retry_bullpen008_run(
    run_id: str,
    request: Bullpen008RunRequest | None = None,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_async_db),
) -> Bullpen008Run:
    import redis.asyncio as aioredis

    frozen = await get_run(session, user_id=current_user.id, run_id=run_id)
    if frozen is None:
        raise HTTPException(status_code=404, detail="Bullpen 008 run not found.")
    redis_client = aioredis.from_url(app_settings.redis_url, decode_responses=True)
    pending_key = _pending_key(current_user.id)
    acquired = await redis_client.set(
        pending_key, "retry", nx=True, ex=PENDING_MARKER_TTL_SECONDS
    )
    if not acquired:
        await redis_client.close()
        raise HTTPException(status_code=409, detail="A Bullpen 008 run is already queued or running.")
    try:
        record = await create_run_record(
            session,
            user_id=current_user.id,
            triggered_by="retry",
            idempotency_key=(request.idempotency_key if request and request.idempotency_key else f"bullpen008:retry:{run_id}:{uuid4()}"),
        )
        record.run_metadata = {
            **dict(record.run_metadata),
            "retry_of_run_id": run_id,
            "retry_version": int(frozen.run_metadata.get("retry_version", 0)) + 1,
            "frozen_source_run_unchanged": True,
        }
        publish = asyncio.create_task(
            asyncio.to_thread(
                execute_bullpen008_run.apply_async,
                args=[record.id],
                queue=CELERY_QUEUE,
                task_id=f"bullpen008:{record.id}",
                headers={"workflow_profile": "bullpen008", "retry_of_run_id": run_id},
                retry=False,
            )
        )
        try:
            async_result = await asyncio.wait_for(
                asyncio.shield(publish), timeout=PUBLISH_ACK_TIMEOUT_SECONDS
            )
            dispatch_status = "published"
            celery_task_id = async_result.id
        except TimeoutError:
            dispatch_status = "publish-timeout-ambiguous"
            celery_task_id = f"bullpen008:{record.id}"
            publish.add_done_callback(
                lambda task: task.exception() if not task.cancelled() else None
            )
        record.task_metadata = {
            **dict(record.task_metadata),
            "celery_task_id": celery_task_id,
            "dispatch_status": dispatch_status,
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
    if stage_number not in {1, 2, 3, 4, 5, 6}:
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
        detail="Direct Bullpen 008 order creation is forbidden. Stage 6 may execute only immutable certified Stage 5 actions after explicit live arming.",
    )
