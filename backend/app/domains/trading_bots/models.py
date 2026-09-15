from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import JSON, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.infrastructure.database.base import Base, TimestampMixin

if TYPE_CHECKING:
    from app.domains.auth.models import User


class UniversalScanSettingsRecord(Base, TimestampMixin):
    __tablename__ = "universal_scan_settings"

    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )
    payload: Mapped[dict[str, object]] = mapped_column(JSON, default=dict, nullable=False)

    user: Mapped[User] = relationship()


class UniversalScanStateRecord(Base, TimestampMixin):
    __tablename__ = "universal_scan_states"

    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    )
    payload: Mapped[dict[str, object]] = mapped_column(JSON, default=dict, nullable=False)

    user: Mapped[User] = relationship()
