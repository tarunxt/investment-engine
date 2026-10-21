from __future__ import annotations

from datetime import date, datetime, timezone

from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from app.domains.zerodha.crypto import decrypt_token, encrypt_token
from app.domains.zerodha.models import ZerodhaCredential, ZerodhaPortfolioSnapshot
from app.shared.portfolio_summary import build_persisted_portfolio_summary


class ZerodhaCredentialRepository:
    def __init__(self, db: AsyncSession) -> None:
        self._db = db

    async def get_by_user(self, user_id: int) -> ZerodhaCredential | None:
        from app.domains.connections.service import ConnectionStore
        from app.domains.connections.crypto import ConnectionFault
        store=ConnectionStore(self._db)
        try:
            token=await store.resolve_token(user_id)
            return await store.current(user_id) if token else None
        except ConnectionFault:return None

    async def get_plaintext_token(self, user_id: int):
        # Compatibility name, now returns one authenticated key/secret/token
        # bundle rather than a string that could be mixed with global app keys.
        from app.domains.connections.service import ConnectionStore
        from app.domains.connections.crypto import ConnectionFault
        try:return await ConnectionStore(self._db).resolve_token(user_id)
        except ConnectionFault:return None

    async def upsert(
        self,
        user_id: int,
        access_token: str,
        login_time: datetime,
        expires_at: datetime,
    ) -> ZerodhaCredential:
        # Unbound legacy writes cannot establish an authenticated app/account
        # binding. Stage10 authorization must call install_session explicitly.
        from app.domains.connections.crypto import ConnectionFault
        raise ConnectionFault('CONNECTION_BOUND_SESSION_REQUIRED')

    async def delete_by_user(self, user_id: int) -> None:
        from app.domains.connections.service import ConnectionStore
        await ConnectionStore(self._db).disable(user_id)


class SyncZerodhaCredentialRepository:
    def __init__(self, db: Session) -> None:
        self._db = db

    def get_by_user(self, user_id: int):
        from app.domains.connections.service import SyncConnectionStore
        from app.domains.connections.crypto import ConnectionFault
        from app.domains.connections.models import IntegrationConnection
        try:
            token=SyncConnectionStore(self._db).resolve_token(user_id)
            return self._db.execute(select(IntegrationConnection).where(IntegrationConnection.owner_id==user_id,IntegrationConnection.id==token.connection_id)).scalar_one_or_none() if token else None
        except ConnectionFault:return None

    def get_plaintext_token(self, user_id: int):
        from app.domains.connections.service import SyncConnectionStore
        from app.domains.connections.crypto import ConnectionFault
        try:return SyncConnectionStore(self._db).resolve_token(user_id)
        except ConnectionFault:return None

    def list_active_user_ids(self, now: datetime) -> list[int]:
        from app.domains.connections.models import IntegrationConnection
        return list(self._db.execute(select(IntegrationConnection.owner_id).where(IntegrationConnection.is_current.is_(True),IntegrationConnection.status=='active',IntegrationConnection.token_expires_at>now)).scalars().all())


class ZerodhaPortfolioSnapshotRepository:
    def __init__(self, db: AsyncSession) -> None:
        self._db = db

    async def get_latest_by_user(self, user_id: int) -> ZerodhaPortfolioSnapshot | None:
        result = await self._db.execute(
            select(ZerodhaPortfolioSnapshot)
            .where(ZerodhaPortfolioSnapshot.user_id == user_id)
            .order_by(
                ZerodhaPortfolioSnapshot.snapshot_date.desc(),
                ZerodhaPortfolioSnapshot.captured_at.desc(),
            )
            .limit(1)
        )
        return result.scalar_one_or_none()

    async def get_by_user_and_date(
        self,
        user_id: int,
        snapshot_date: date,
    ) -> ZerodhaPortfolioSnapshot | None:
        result = await self._db.execute(
            select(ZerodhaPortfolioSnapshot).where(
                ZerodhaPortfolioSnapshot.user_id == user_id,
                ZerodhaPortfolioSnapshot.snapshot_date == snapshot_date,
            )
        )
        return result.scalar_one_or_none()

    async def list_by_user(
        self,
        user_id: int,
        *,
        limit: int = 30,
    ) -> list[ZerodhaPortfolioSnapshot]:
        result = await self._db.execute(
            select(ZerodhaPortfolioSnapshot)
            .where(ZerodhaPortfolioSnapshot.user_id == user_id)
            .order_by(
                ZerodhaPortfolioSnapshot.snapshot_date.desc(),
                ZerodhaPortfolioSnapshot.captured_at.desc(),
            )
            .limit(limit)
        )
        return list(result.scalars().all())


class SyncZerodhaPortfolioSnapshotRepository:
    def __init__(self, db: Session) -> None:
        self._db = db

    def get_by_user_and_date(
        self,
        user_id: int,
        snapshot_date: date,
    ) -> ZerodhaPortfolioSnapshot | None:
        return self._db.execute(
            select(ZerodhaPortfolioSnapshot).where(
                ZerodhaPortfolioSnapshot.user_id == user_id,
                ZerodhaPortfolioSnapshot.snapshot_date == snapshot_date,
            )
        ).scalar_one_or_none()

    def upsert_snapshot(
        self,
        user_id: int,
        snapshot_data: dict,
    ) -> ZerodhaPortfolioSnapshot:
        snapshot_date = snapshot_data["snapshot_date"]
        snapshot = self.get_by_user_and_date(user_id, snapshot_date)
        if snapshot is None:
            snapshot = ZerodhaPortfolioSnapshot(
                user_id=user_id,
                snapshot_date=snapshot_date,
            )
            self._db.add(snapshot)

        self._apply_snapshot(snapshot, snapshot_data)

        try:
            self._db.flush()
        except IntegrityError:
            self._db.rollback()
            snapshot = self.get_by_user_and_date(user_id, snapshot_date)
            if snapshot is None:
                raise
            self._apply_snapshot(snapshot, snapshot_data)
            self._db.flush()

        return snapshot

    @staticmethod
    def _apply_snapshot(snapshot: ZerodhaPortfolioSnapshot, snapshot_data: dict) -> None:
        top_holdings, invested_value = build_persisted_portfolio_summary(
            snapshot_data["holdings"],
            total_value=snapshot_data["holdings_market_value"],
        )
        # This legacy acquisition path has no verified IntegrationConnection binding.
        # Invalidate an earlier receipt on every overwrite; do not accept caller provenance.
        snapshot.acquisition_json = None
        snapshot.captured_at = snapshot_data["captured_at"]
        snapshot.source = snapshot_data["source"]
        snapshot.holdings_count = snapshot_data["holdings_count"]
        snapshot.net_positions_count = snapshot_data["net_positions_count"]
        snapshot.day_positions_count = snapshot_data["day_positions_count"]
        snapshot.holdings_market_value = snapshot_data["holdings_market_value"]
        snapshot.holdings_pnl = snapshot_data["holdings_pnl"]
        snapshot.holdings_day_change_value = snapshot_data["holdings_day_change_value"]
        snapshot.available_margin = snapshot_data.get("available_margin", 0.0)
        snapshot.positions_pnl = snapshot_data["positions_pnl"]
        snapshot.positions_m2m = snapshot_data["positions_m2m"]
        snapshot.holdings_invested_value = invested_value
        snapshot.dashboard_top_holdings = top_holdings
        snapshot.holdings = snapshot_data["holdings"]
        snapshot.net_positions = snapshot_data["net_positions"]
        snapshot.day_positions = snapshot_data["day_positions"]
