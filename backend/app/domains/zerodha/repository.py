from __future__ import annotations

from datetime import date, datetime, timezone
from hashlib import sha256

from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from app.core.config import settings
from app.domains.zerodha.crypto import decrypt_token, encrypt_token
from app.domains.zerodha.models import ZerodhaCredential, ZerodhaPortfolioSnapshot
from app.shared.portfolio_summary import build_persisted_portfolio_summary


def _app_binding(user_id: int) -> str:
    app = settings.zerodha_personal_apps.get(user_id)
    identity = f"personal:{app.api_key}:{app.client_id}" if app else f"default:{settings.zerodha_api_key}"
    return sha256(identity.encode()).hexdigest()


def _matches_app(cred: ZerodhaCredential | None, user_id: int) -> bool:
    if cred is None:
        return False
    if cred.app_binding is None:
        # Sessions written before owner-specific apps could only use the default app.
        return user_id not in settings.zerodha_personal_apps
    return cred.app_binding == _app_binding(user_id)


class ZerodhaCredentialRepository:
    def __init__(self, db: AsyncSession) -> None:
        self._db = db

    async def get_by_user(self, user_id: int) -> ZerodhaCredential | None:
        result = await self._db.execute(
            select(ZerodhaCredential).where(ZerodhaCredential.user_id == user_id)
        )
        cred = result.scalar_one_or_none()
        return cred if _matches_app(cred, user_id) else None

    async def get_plaintext_token(self, user_id: int) -> str | None:
        """Return the decrypted access token and stamp last_used_at."""
        cred = await self.get_by_user(user_id)
        if not cred:
            return None
        cred.last_used_at = datetime.now(tz=timezone.utc)
        await self._db.flush()
        return decrypt_token(cred.access_token)

    async def upsert(
        self,
        user_id: int,
        access_token: str,
        login_time: datetime,
        expires_at: datetime,
    ) -> ZerodhaCredential:
        # PostgreSQL upsert also covers two first-time callbacks arriving together.
        values = dict(
            user_id=user_id,
            access_token=encrypt_token(access_token),
            app_binding=_app_binding(user_id),
            login_time=login_time,
            expires_at=expires_at,
        )
        insert_stmt = insert(ZerodhaCredential).values(**values)
        updates = {k: getattr(insert_stmt.excluded, k) for k in values if k != "user_id"}
        updates["updated_at"] = func.now()
        stmt = insert_stmt.on_conflict_do_update(
            index_elements=[ZerodhaCredential.user_id],
            set_=updates,
        ).returning(ZerodhaCredential)
        return (await self._db.scalars(stmt, execution_options={"populate_existing": True})).one()

    async def delete_by_user(self, user_id: int) -> None:
        await self._db.execute(
            delete(ZerodhaCredential).where(ZerodhaCredential.user_id == user_id)
        )


class SyncZerodhaCredentialRepository:
    def __init__(self, db: Session) -> None:
        self._db = db

    def get_by_user(self, user_id: int) -> ZerodhaCredential | None:
        cred = self._db.execute(
            select(ZerodhaCredential).where(ZerodhaCredential.user_id == user_id)
        ).scalar_one_or_none()
        return cred if _matches_app(cred, user_id) else None

    def get_plaintext_token(self, user_id: int) -> str | None:
        cred = self.get_by_user(user_id)
        if not cred:
            return None
        cred.last_used_at = datetime.now(tz=timezone.utc)
        self._db.flush()
        return decrypt_token(cred.access_token)

    def list_active_user_ids(self, now: datetime) -> list[int]:
        rows = self._db.execute(
            select(ZerodhaCredential.user_id).where(ZerodhaCredential.expires_at > now)
        )
        return list(rows.scalars().all())


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
        snapshot.captured_at = snapshot_data["captured_at"]
        snapshot.source = snapshot_data["source"]
        snapshot.holdings_count = snapshot_data["holdings_count"]
        snapshot.net_positions_count = snapshot_data["net_positions_count"]
        snapshot.day_positions_count = snapshot_data["day_positions_count"]
        snapshot.holdings_market_value = snapshot_data["holdings_market_value"]
        snapshot.holdings_pnl = snapshot_data["holdings_pnl"]
        snapshot.holdings_day_change_value = snapshot_data["holdings_day_change_value"]
        snapshot.available_margin = snapshot_data["available_margin"]
        snapshot.positions_pnl = snapshot_data["positions_pnl"]
        snapshot.positions_m2m = snapshot_data["positions_m2m"]
        snapshot.holdings_invested_value = invested_value
        snapshot.dashboard_top_holdings = top_holdings
        snapshot.holdings = snapshot_data["holdings"]
        snapshot.net_positions = snapshot_data["net_positions"]
        snapshot.day_positions = snapshot_data["day_positions"]
