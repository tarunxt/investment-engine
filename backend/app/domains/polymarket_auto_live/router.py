from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.exc import SQLAlchemyError

from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import User
from app.domains.polymarket.runtime_broker import get_bullpen_runtime_broker
from app.domains.polymarket_auto_live.schemas import (
    BullpenAutoLiveDecision,
    BullpenAutoLiveRun,
    BullpenAutoLiveRunOrdersResponse,
    BullpenAutoLiveRunOnceRequest,
    BullpenAutoLiveSettings,
    BullpenAutoLiveSettingsUpdate,
    BullpenAutoLiveState,
    BullpenAutoLiveSummary,
)
from app.domains.polymarket_auto_live.service import polymarket_auto_live_bot_manager
from app.domains.polymarket_auto_live.run_recovery import (
    run_contains_historical_auth_error,
)

router = APIRouter(prefix="/polymarket/auto-live", tags=["polymarket"])


async def _get_bot(current_user: User):
    return await polymarket_auto_live_bot_manager.get_bot(current_user.id)


def _http_error_detail(exc: Exception) -> str:
    message = str(exc).strip()
    if message and message.lower() != "none":
        return f"{exc.__class__.__name__}: {message}"
    return f"{exc.__class__.__name__}: {exc!r}"


def _database_not_ready_error(exc: SQLAlchemyError) -> HTTPException:
    return HTTPException(
        status_code=503,
        detail=(
            "Auto-Live database tables are not ready. Run Alembic migrations "
            "inside the backend container (`alembic upgrade head`) and retry. "
            f"{_http_error_detail(exc)}"
        ),
    )


async def _attach_latest_active_auth(
    summary: BullpenAutoLiveSummary,
) -> BullpenAutoLiveSummary:
    broker = get_bullpen_runtime_broker()
    historical_auth_error = any(
        run_contains_historical_auth_error(run)
        for run in [summary.latest_run, *summary.recent_runs]
    )
    try:
        active_auth = await broker.resolve_latest_active_auth_result(
            refresh_if_stale=historical_auth_error,
        )
    except Exception:
        # Unknown live auth state must not turn a historical command error into
        # a login banner. Only a persisted active doctor verdict can do that.
        active_auth = None
    return summary.model_copy(update={"runtime_auth": active_auth})


@router.get("/settings", response_model=BullpenAutoLiveSettings)
async def get_auto_live_settings(current_user: User = Depends(get_current_user)):
    bot = await _get_bot(current_user)
    try:
        return await bot.get_settings()
    except SQLAlchemyError as exc:
        raise _database_not_ready_error(exc) from exc


@router.put("/settings", response_model=BullpenAutoLiveSettings)
async def update_auto_live_settings(
    request: BullpenAutoLiveSettingsUpdate,
    current_user: User = Depends(get_current_user),
):
    bot = await _get_bot(current_user)
    try:
        return await bot.update_settings(request)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=_http_error_detail(exc)) from exc


@router.post("/settings/reset", response_model=BullpenAutoLiveSettings)
async def reset_auto_live_settings(current_user: User = Depends(get_current_user)):
    bot = await _get_bot(current_user)
    return await bot.reset_settings()


@router.get("/state", response_model=BullpenAutoLiveState)
async def get_auto_live_state(current_user: User = Depends(get_current_user)):
    bot = await _get_bot(current_user)
    try:
        return await bot.get_state()
    except SQLAlchemyError as exc:
        raise _database_not_ready_error(exc) from exc


@router.get("/summary", response_model=BullpenAutoLiveSummary)
async def get_auto_live_summary(current_user: User = Depends(get_current_user)):
    bot = await _get_bot(current_user)
    try:
        return await _attach_latest_active_auth(await bot.get_summary())
    except SQLAlchemyError as exc:
        raise _database_not_ready_error(exc) from exc


@router.get("/runs", response_model=list[BullpenAutoLiveRun])
async def list_auto_live_runs(current_user: User = Depends(get_current_user)):
    bot = await _get_bot(current_user)
    return await bot.list_runs()


@router.get("/runs/{run_id}/orders", response_model=BullpenAutoLiveRunOrdersResponse)
async def get_auto_live_run_orders(
    run_id: str,
    current_user: User = Depends(get_current_user),
):
    bot = await _get_bot(current_user)
    try:
        return await bot.get_run_orders(run_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=_http_error_detail(exc)) from exc


@router.post("/runs/{run_id}/reconcile", response_model=BullpenAutoLiveRunOrdersResponse)
async def reconcile_auto_live_run_order_states(
    run_id: str,
    current_user: User = Depends(get_current_user),
):
    bot = await _get_bot(current_user)
    try:
        return await bot.reconcile_run_orders(run_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=_http_error_detail(exc)) from exc


@router.post(
    "/runs/{run_id}/retry-exits-and-continue-buys",
    response_model=BullpenAutoLiveRunOrdersResponse,
)
async def retry_failed_exits_and_continue_buys(
    run_id: str,
    current_user: User = Depends(get_current_user),
):
    bot = await _get_bot(current_user)
    try:
        return await bot.retry_failed_exits_and_continue_buys(run_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=_http_error_detail(exc)) from exc


@router.get("/decisions", response_model=list[BullpenAutoLiveDecision])
async def list_auto_live_decisions(current_user: User = Depends(get_current_user)):
    bot = await _get_bot(current_user)
    return await bot.list_decisions()


@router.post("/orders/{intent_id}/retry", response_model=BullpenAutoLiveRunOrdersResponse)
async def retry_auto_live_order(
    intent_id: str,
    remote_absence_verified: bool = False,
    current_user: User = Depends(get_current_user),
):
    bot = await _get_bot(current_user)
    try:
        return await bot.retry_order_intent(
            intent_id,
            remote_absence_verified=remote_absence_verified,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=_http_error_detail(exc)) from exc


@router.post("/orders/{intent_id}/cancel", response_model=BullpenAutoLiveRunOrdersResponse)
async def cancel_auto_live_order(
    intent_id: str,
    current_user: User = Depends(get_current_user),
):
    bot = await _get_bot(current_user)
    try:
        return await bot.cancel_order_intent(intent_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=_http_error_detail(exc)) from exc


@router.post("/run-once", response_model=BullpenAutoLiveRun)
async def run_auto_live_once(
    request: BullpenAutoLiveRunOnceRequest | None = None,
    current_user: User = Depends(get_current_user),
):
    bot = await _get_bot(current_user)
    try:
        return await bot.run_once(triggered_by="manual", request=request)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=_http_error_detail(exc)) from exc


@router.post("/start", response_model=BullpenAutoLiveState)
async def start_auto_live(current_user: User = Depends(get_current_user)):
    bot = await _get_bot(current_user)
    return await bot.start()


@router.post("/stop", response_model=BullpenAutoLiveState)
async def stop_auto_live(current_user: User = Depends(get_current_user)):
    bot = await _get_bot(current_user)
    return await bot.stop()


@router.post("/pause", response_model=BullpenAutoLiveState)
async def pause_auto_live(current_user: User = Depends(get_current_user)):
    bot = await _get_bot(current_user)
    return await bot.pause()


@router.post("/resume", response_model=BullpenAutoLiveState)
async def resume_auto_live(current_user: User = Depends(get_current_user)):
    bot = await _get_bot(current_user)
    return await bot.resume()


@router.post("/emergency-stop", response_model=BullpenAutoLiveState)
async def emergency_stop_auto_live(current_user: User = Depends(get_current_user)):
    bot = await _get_bot(current_user)
    return await bot.emergency_stop()


@router.post("/clear-emergency-stop", response_model=BullpenAutoLiveState)
async def clear_auto_live_emergency_stop(
    current_user: User = Depends(get_current_user),
):
    bot = await _get_bot(current_user)
    return await bot.clear_emergency_stop()
