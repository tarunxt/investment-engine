from __future__ import annotations

import logging
from datetime import datetime, timezone

from sqlalchemy import JSON, DateTime, ForeignKey, Integer, String, select
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from app.infrastructure.database.base import Base

logger = logging.getLogger(__name__)


class ZerodhaAuditLog(Base):
    __tablename__ = "zerodha_audit_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    action: Mapped[str] = mapped_column(String(64), nullable=False)
    ip_address: Mapped[str | None] = mapped_column(String(45), nullable=True)
    details: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=lambda: datetime.now(tz=timezone.utc)
    )


class ZerodhaAuditRepository:
    def __init__(self, db: AsyncSession) -> None:
        self._db = db

    async def log(
        self,
        user_id: int,
        action: str,
        ip_address: str | None = None,
        details: dict | None = None,
    ) -> None:
        try:
            entry = ZerodhaAuditLog(
                user_id=user_id,
                action=action,
                ip_address=ip_address,
                details=details,
            )
            self._db.add(entry)
            await self._db.flush()
        except Exception:
            logger.exception("Zerodha audit log failed — action=%s user_id=%s", action, user_id)

    async def get_by_user(self, user_id: int, limit: int = 100) -> list[ZerodhaAuditLog]:
        result = await self._db.execute(
            select(ZerodhaAuditLog)
            .where(ZerodhaAuditLog.user_id == user_id)
            .order_by(ZerodhaAuditLog.created_at.desc())
            .limit(limit)
        )
        return list(result.scalars().all())


class SyncZerodhaAuditRepository:
    def __init__(self, db: Session) -> None:
        self._db = db

    def log(
        self,
        user_id: int,
        action: str,
        ip_address: str | None = None,
        details: dict | None = None,
    ) -> None:
        try:
            entry = ZerodhaAuditLog(
                user_id=user_id,
                action=action,
                ip_address=ip_address,
                details=details,
            )
            self._db.add(entry)
            self._db.flush()
        except Exception:
            logger.exception("Zerodha audit log failed — action=%s user_id=%s", action, user_id)
