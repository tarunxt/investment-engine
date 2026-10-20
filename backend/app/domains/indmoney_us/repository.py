from __future__ import annotations

from sqlalchemy import select,and_
from sqlalchemy.orm import aliased
from sqlalchemy.ext.asyncio import AsyncSession

from app.domains.indmoney_us.models import IndMoneyUsPortfolioSnapshot


def accepted_snapshot_predicate():
    correction=aliased(IndMoneyUsPortfolioSnapshot)
    superseded=select(correction.id).where(correction.user_id==IndMoneyUsPortfolioSnapshot.user_id,correction.acceptance_state=='accepted',correction.supersedes_id==IndMoneyUsPortfolioSnapshot.id).exists()
    return and_(IndMoneyUsPortfolioSnapshot.acceptance_state=='accepted',~superseded)


class IndMoneyUsPortfolioSnapshotRepository:
    def __init__(self, db: AsyncSession) -> None:
        self._db = db

    async def create_snapshot(self, snapshot_data: dict) -> IndMoneyUsPortfolioSnapshot:
        snapshot = IndMoneyUsPortfolioSnapshot(**snapshot_data)
        self._db.add(snapshot)
        await self._db.flush()
        return snapshot

    async def get_latest_by_user(self, user_id: int) -> IndMoneyUsPortfolioSnapshot | None:
        result = await self._db.execute(
            select(IndMoneyUsPortfolioSnapshot)
            .where(IndMoneyUsPortfolioSnapshot.user_id == user_id,accepted_snapshot_predicate())
            .order_by(
                IndMoneyUsPortfolioSnapshot.captured_at.desc(),
                IndMoneyUsPortfolioSnapshot.id.desc(),
            )
            .limit(1)
        )
        return result.scalar_one_or_none()

    async def get_by_user_and_id(
        self,
        user_id: int,
        snapshot_id: int,
    ) -> IndMoneyUsPortfolioSnapshot | None:
        result = await self._db.execute(
            select(IndMoneyUsPortfolioSnapshot).where(
                IndMoneyUsPortfolioSnapshot.user_id == user_id,
                IndMoneyUsPortfolioSnapshot.id == snapshot_id,
            )
        )
        return result.scalar_one_or_none()

    async def list_by_user(
        self,
        user_id: int,
        *,
        limit: int = 30,
    ) -> list[IndMoneyUsPortfolioSnapshot]:
        result = await self._db.execute(
            select(IndMoneyUsPortfolioSnapshot)
            .where(IndMoneyUsPortfolioSnapshot.user_id == user_id)
            .order_by(
                IndMoneyUsPortfolioSnapshot.captured_at.desc(),
                IndMoneyUsPortfolioSnapshot.id.desc(),
            )
            .limit(limit)
        )
        return list(result.scalars().all())
