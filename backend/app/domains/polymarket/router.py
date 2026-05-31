from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import User
from app.domains.polymarket.schemas import (
    PolymarketBotState,
    PolymarketDiscoveryDebugReport,
    PolymarketDiscoveryDebugRequest,
)
from app.domains.polymarket.service import polymarket_bot_manager

router = APIRouter(prefix="/polymarket", tags=["polymarket"])


async def _get_bot(current_user: User) -> object:
    return await polymarket_bot_manager.get_bot(current_user.id)


@router.get("/state", response_model=PolymarketBotState)
async def get_polymarket_state(current_user: User = Depends(get_current_user)):
    bot = await _get_bot(current_user)
    return await bot.get_state()


@router.post("/start", response_model=PolymarketBotState)
async def start_polymarket_bot(current_user: User = Depends(get_current_user)):
    bot = await _get_bot(current_user)
    try:
        await bot.start()
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return await bot.get_state()


@router.post("/stop", response_model=PolymarketBotState)
async def stop_polymarket_bot(current_user: User = Depends(get_current_user)):
    bot = await _get_bot(current_user)
    await bot.stop()
    return await bot.get_state()


@router.post("/pause", response_model=PolymarketBotState)
async def pause_polymarket_bot(current_user: User = Depends(get_current_user)):
    bot = await _get_bot(current_user)
    await bot.pause()
    return await bot.get_state()


@router.post("/resume", response_model=PolymarketBotState)
async def resume_polymarket_bot(current_user: User = Depends(get_current_user)):
    bot = await _get_bot(current_user)
    await bot.resume()
    return await bot.get_state()


@router.post("/live/unlock", response_model=PolymarketBotState)
async def unlock_polymarket_live(current_user: User = Depends(get_current_user)):
    bot = await _get_bot(current_user)
    try:
        await bot.unlock_live()
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return await bot.get_state()


@router.post("/live/lock", response_model=PolymarketBotState)
async def lock_polymarket_live(current_user: User = Depends(get_current_user)):
    bot = await _get_bot(current_user)
    await bot.lock_live()
    return await bot.get_state()


@router.post("/live/doctor", response_model=PolymarketBotState)
async def refresh_polymarket_doctor(current_user: User = Depends(get_current_user)):
    bot = await _get_bot(current_user)
    await bot.refresh_doctor()
    return await bot.get_state()


@router.post("/live/balance/refresh", response_model=PolymarketBotState)
async def refresh_polymarket_balance(current_user: User = Depends(get_current_user)):
    bot = await _get_bot(current_user)
    await bot.refresh_balance()
    return await bot.get_state()


@router.post("/live/emergency-stop", response_model=PolymarketBotState)
async def emergency_stop_polymarket_live(current_user: User = Depends(get_current_user)):
    bot = await _get_bot(current_user)
    await bot.emergency_stop()
    return await bot.get_state()


@router.post("/live/reset-emergency-stop", response_model=PolymarketBotState)
async def reset_polymarket_live_emergency_stop(current_user: User = Depends(get_current_user)):
    bot = await _get_bot(current_user)
    await bot.reset_emergency_stop()
    return await bot.get_state()


@router.post("/live/trades/{trade_id}/confirm", response_model=PolymarketBotState)
async def confirm_polymarket_trade(trade_id: str, current_user: User = Depends(get_current_user)):
    bot = await _get_bot(current_user)
    try:
        await bot.confirm_live_trade(trade_id)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return await bot.get_state()


@router.post("/live/trades/{trade_id}/reject", response_model=PolymarketBotState)
async def reject_polymarket_trade(trade_id: str, current_user: User = Depends(get_current_user)):
    bot = await _get_bot(current_user)
    try:
        await bot.reject_live_trade(trade_id)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return await bot.get_state()


@router.post("/live/trades/reject-all", response_model=PolymarketBotState)
async def reject_all_polymarket_trades(current_user: User = Depends(get_current_user)):
    bot = await _get_bot(current_user)
    await bot.reject_all_pending_live_trades()
    return await bot.get_state()


@router.post("/live/discovery/debug", response_model=PolymarketDiscoveryDebugReport)
async def debug_polymarket_discovery(
    request: PolymarketDiscoveryDebugRequest,
    current_user: User = Depends(get_current_user),
):
    bot = await _get_bot(current_user)
    try:
        return await bot.debug_discovery(request.target)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
