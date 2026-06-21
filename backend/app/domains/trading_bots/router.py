from __future__ import annotations

from fastapi import APIRouter, Depends

from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import User
from app.domains.trading_bots.schemas import (
    TradingBotsOverviewResponse,
    TradingBotsSummaryResponse,
)
from app.domains.trading_bots.service import (
    build_trading_bots_overview,
    build_trading_bots_summary,
)

router = APIRouter(prefix="/trading-bots", tags=["trading-bots"])


@router.get("/summary", response_model=TradingBotsSummaryResponse)
async def trading_bots_summary(current_user: User = Depends(get_current_user)):
    return await build_trading_bots_summary(current_user.id)


@router.get("/overview", response_model=TradingBotsOverviewResponse)
async def trading_bots_overview(current_user: User = Depends(get_current_user)):
    return await build_trading_bots_overview(current_user.id)
