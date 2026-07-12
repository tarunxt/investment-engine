from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.infrastructure.database.base import Base, TimestampMixin

if TYPE_CHECKING:
    from app.domains.auth.models import User


class PolymarketRedeemAttemptRecord(Base, TimestampMixin):
    __tablename__ = "polymarket_redeem_attempts"
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "condition_id",
            name="uq_polymarket_redeem_attempt_user_condition",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    condition_id: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    market_id: Mapped[str | None] = mapped_column(String(500), nullable=True, index=True)
    market_title: Mapped[str | None] = mapped_column(Text, nullable=True)
    source: Mapped[str] = mapped_column(String(64), nullable=False, default="unknown")
    status: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    execution_response: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_seen_shares: Mapped[float | None] = mapped_column(nullable=True)
    last_seen_claimable_value_usd: Mapped[float | None] = mapped_column(nullable=True)
    last_reconciled_at: Mapped[DateTime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    last_submitted_at: Mapped[DateTime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    confirmed_at: Mapped[DateTime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )

    user: Mapped[User] = relationship()
