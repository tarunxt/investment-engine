from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import User
from app.domains.bullpen_trade_analysis.schemas import (
    BullpenTradeAnalysisDetailResponse,
    BullpenTradeAnalysisListResponse,
)
from app.domains.bullpen_trade_analysis.service import BullpenTradeAnalysisService
from app.infrastructure.database.session import get_async_db

router = APIRouter(prefix="/bullpen-ai/trade-analysis", tags=["bullpen-ai"])


def _parse_optional_date(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid date value '{value}'. Use ISO-8601 format.",
        ) from exc
    return parsed.astimezone(UTC) if parsed.tzinfo else parsed.replace(tzinfo=UTC)


@router.get("", response_model=BullpenTradeAnalysisListResponse)
async def list_bullpen_trade_analysis(
    status: str | None = Query(default=None),
    pnl_outcome: str | None = Query(default=None),
    final_tag: str | None = Query(default=None),
    from_date: str | None = Query(default=None),
    to_date: str | None = Query(default=None),
    strategy_version: str | None = Query(default=None),
    category: str | None = Query(default=None),
    topic: str | None = Query(default=None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_async_db),
):
    service = BullpenTradeAnalysisService(db)
    return await service.list_trades(
        user_id=current_user.id,
        status=status,
        pnl_outcome=pnl_outcome,
        final_tag=final_tag,
        from_date=_parse_optional_date(from_date),
        to_date=_parse_optional_date(to_date),
        strategy_version=strategy_version,
        category=category,
        topic=topic,
    )


@router.get("/{trade_id}", response_model=BullpenTradeAnalysisDetailResponse)
async def get_bullpen_trade_analysis_detail(
    trade_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_async_db),
):
    service = BullpenTradeAnalysisService(db)
    detail = await service.get_trade_detail(user_id=current_user.id, trade_id=trade_id)
    if detail is None:
        raise HTTPException(status_code=404, detail="Trade analysis record not found")
    return detail


@router.post("/{trade_id}/post-trade-analysis", response_model=BullpenTradeAnalysisDetailResponse)
async def recompute_bullpen_trade_analysis(
    trade_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_async_db),
):
    service = BullpenTradeAnalysisService(db)
    detail = await service.recompute_post_trade_analysis(
        user_id=current_user.id,
        trade_id=trade_id,
    )
    if detail is None:
        raise HTTPException(status_code=404, detail="Trade analysis record not found")
    return detail
