from __future__ import annotations

import logging

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import User
from app.domains.indmoney_us.repository import IndMoneyUsPortfolioSnapshotRepository
from app.domains.indmoney_us.schemas import (
    IndMoneyUsPortfolioOverviewResponse,
    IndMoneyUsPortfolioSnapshotCreateRequest,
    IndMoneyUsPortfolioSnapshotDetailResponse,
    IndMoneyUsPortfolioSnapshotSummaryResponse,
)
from app.domains.indmoney_us.service import IndMoneyUsPortfolioService
from app.infrastructure.database.session import get_async_db
from app.shared.exceptions import NotFoundException

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/indmoney-us", tags=["indmoney-us"])
service = IndMoneyUsPortfolioService()


@router.get("/portfolio", response_model=IndMoneyUsPortfolioOverviewResponse)
async def get_portfolio_overview(
    limit: int = 30,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    repo = IndMoneyUsPortfolioSnapshotRepository(db)
    snapshots = await repo.list_by_user(current_user.id, limit=min(max(limit, 1), 120))
    latest = (
        IndMoneyUsPortfolioSnapshotDetailResponse(**service.serialize_detail(snapshots[0]))
        if snapshots
        else None
    )
    history = [
        IndMoneyUsPortfolioSnapshotSummaryResponse(**service.serialize_summary(snapshot))
        for snapshot in snapshots
    ]
    return IndMoneyUsPortfolioOverviewResponse(latest=latest, history=history)


@router.post("/portfolio", response_model=IndMoneyUsPortfolioSnapshotDetailResponse)
async def create_portfolio_snapshot(
    request: IndMoneyUsPortfolioSnapshotCreateRequest,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    repo = IndMoneyUsPortfolioSnapshotRepository(db)
    snapshot_data = service.parse_snapshot(
        request.raw_text,
        captured_at=request.captured_at,
    )
    snapshot = await repo.create_snapshot(
        {
            **snapshot_data,
            "user_id": current_user.id,
        }
    )
    await db.commit()
    logger.info(
        "Saved INDmoney US snapshot %s for user %s with status %s",
        snapshot.id,
        current_user.id,
        snapshot.parse_status,
    )
    return IndMoneyUsPortfolioSnapshotDetailResponse(**service.serialize_detail(snapshot))


@router.get("/portfolio/{snapshot_id}", response_model=IndMoneyUsPortfolioSnapshotDetailResponse)
async def get_portfolio_snapshot(
    snapshot_id: int,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    repo = IndMoneyUsPortfolioSnapshotRepository(db)
    snapshot = await repo.get_by_user_and_id(current_user.id, snapshot_id)
    if not snapshot:
        raise NotFoundException("INDmoney US portfolio snapshot not found")
    return IndMoneyUsPortfolioSnapshotDetailResponse(**service.serialize_detail(snapshot))
