from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import User
from app.domains.polymarket_auto_live.schemas import (
    BullpenAutoLiveDecision,
    BullpenAutoLiveRun,
    BullpenAutoLiveSettings,
    BullpenAutoLiveSettingsUpdate,
    BullpenAutoLiveState,
    BullpenAutoLiveSummary,
)
from app.domains.polymarket_auto_live.service import polymarket_auto_live_bot_manager

router = APIRouter(prefix="/polymarket/auto-live", tags=["polymarket"])


async def _get_bot(current_user: User):
    return await polymarket_auto_live_bot_manager.get_bot(current_user.id)


def _http_error_detail(exc: Exception) -> str:
    message = str(exc).strip()
    if message and message.lower() != "none":
        return f"{exc.__class__.__name__}: {message}"
    return f"{exc.__class__.__name__}: {exc!r}"


@router.get("/settings", response_model=BullpenAutoLiveSettings)
async def get_auto_live_settings(current_user: User = Depends(get_current_user)):
    bot = await _get_bot(current_user)
    return await bot.get_settings()


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
    return await bot.get_state()


@router.get("/summary", response_model=BullpenAutoLiveSummary)
async def get_auto_live_summary(current_user: User = Depends(get_current_user)):
    bot = await _get_bot(current_user)
    return await bot.get_summary()


@router.get("/runs", response_model=list[BullpenAutoLiveRun])
async def list_auto_live_runs(current_user: User = Depends(get_current_user)):
    bot = await _get_bot(current_user)
    return await bot.list_runs()


@router.get("/decisions", response_model=list[BullpenAutoLiveDecision])
async def list_auto_live_decisions(current_user: User = Depends(get_current_user)):
    bot = await _get_bot(current_user)
    return await bot.list_decisions()


@router.post("/run-once", response_model=BullpenAutoLiveRun)
async def run_auto_live_once(current_user: User = Depends(get_current_user)):
    bot = await _get_bot(current_user)
    try:
        return await bot.run_once(triggered_by="manual")
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
