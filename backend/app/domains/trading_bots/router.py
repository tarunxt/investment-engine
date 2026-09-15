from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends

from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import User
from app.domains.trading_bots.schemas import (
    TradingBotsOverviewResponse,
    TradingBotsSummaryResponse,
    UniversalScanAutoRunStatus,
    UniversalScanScheduleUpdate,
)
from app.domains.trading_bots.service import (
    build_trading_bots_overview,
    build_trading_bots_summary,
)
from app.domains.trading_bots.tasks import queue_universal_scan
from app.domains.trading_bots.universal_scan import status_for_user, update_schedule
from app.infrastructure.database.sync_session import SyncSessionLocal

router = APIRouter(prefix="/trading-bots", tags=["trading-bots"])


@router.get("/summary", response_model=TradingBotsSummaryResponse)
async def trading_bots_summary(current_user: User = Depends(get_current_user)):
    return await build_trading_bots_summary(current_user.id)


@router.get("/overview", response_model=TradingBotsOverviewResponse)
async def trading_bots_overview(current_user: User = Depends(get_current_user)):
    return await build_trading_bots_overview(current_user.id)


def _universal_status(user_id: int) -> dict[str, object]:
    with SyncSessionLocal() as session:
        return status_for_user(session, user_id)


def _update_universal_schedule(
    user_id: int,
    *,
    enabled: bool | None = None,
    start_at: str | None = None,
    refresh_minutes: int | None = None,
) -> dict[str, object]:
    with SyncSessionLocal() as session:
        result = update_schedule(
            session,
            user_id,
            enabled=enabled,
            start_at=start_at,
            refresh_minutes=refresh_minutes,
        )
        session.commit()
        return result


@router.get("/universal-scan/auto-run", response_model=UniversalScanAutoRunStatus)
async def universal_scan_auto_run_status(current_user: User = Depends(get_current_user)):
    return await asyncio.to_thread(_universal_status, current_user.id)


@router.post("/universal-scan/auto-run/settings", response_model=UniversalScanAutoRunStatus)
async def update_universal_scan_auto_run(
    request: UniversalScanScheduleUpdate,
    current_user: User = Depends(get_current_user),
):
    return await asyncio.to_thread(
        _update_universal_schedule,
        current_user.id,
        start_at=request.start_at,
        refresh_minutes=request.refresh_minutes,
    )


@router.post("/universal-scan/auto-run/enable", response_model=UniversalScanAutoRunStatus)
async def enable_universal_scan_auto_run(current_user: User = Depends(get_current_user)):
    return await asyncio.to_thread(_update_universal_schedule, current_user.id, enabled=True)


@router.post("/universal-scan/auto-run/disable", response_model=UniversalScanAutoRunStatus)
async def disable_universal_scan_auto_run(current_user: User = Depends(get_current_user)):
    return await asyncio.to_thread(_update_universal_schedule, current_user.id, enabled=False)


@router.post("/universal-scan/auto-run/run-now", response_model=UniversalScanAutoRunStatus)
async def run_universal_scan_now(current_user: User = Depends(get_current_user)):
    await asyncio.to_thread(queue_universal_scan, current_user.id, triggered_by="manual")
    return await asyncio.to_thread(_universal_status, current_user.id)
