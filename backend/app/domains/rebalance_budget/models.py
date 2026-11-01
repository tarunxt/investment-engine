from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Integer, Numeric, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.infrastructure.database.base import Base


def utcnow():
    return datetime.now(timezone.utc)


class RebalanceSpendScope(Base):
    __tablename__ = "rebalance_spend_scopes"
    __table_args__ = (
        UniqueConstraint("user_id", "portfolio", name="uq_rebalance_spend_owner_market"),
        CheckConstraint("portfolio IN ('india', 'indmoney_us')", name="ck_rebalance_spend_market"),
        CheckConstraint("cap_inr = 20 AND settled_inr >= 0 AND reserved_inr >= 0", name="ck_rebalance_spend_amounts"),
    )
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    portfolio: Mapped[str] = mapped_column(String(32), nullable=False)
    cap_inr: Mapped[Decimal] = mapped_column(Numeric(24, 8), nullable=False, default=Decimal("20"))
    settled_inr: Mapped[Decimal] = mapped_column(Numeric(24, 8), nullable=False, default=Decimal(0))
    reserved_inr: Mapped[Decimal] = mapped_column(Numeric(24, 8), nullable=False, default=Decimal(0))
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="open")
    policy_version: Mapped[str] = mapped_column(String(64), nullable=False, default="rebalance-inr-cap-v1")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)


class RebalanceSpendBinding(Base):
    __tablename__ = "rebalance_spend_bindings"
    __table_args__ = (
        UniqueConstraint("user_id", "portfolio", "sequence", name="uq_rebalance_spend_workflow"),
        CheckConstraint("sequence > 0", name="ck_rebalance_spend_sequence"),
    )
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    scope_id: Mapped[int] = mapped_column(ForeignKey("rebalance_spend_scopes.id", ondelete="RESTRICT"), nullable=False)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    portfolio: Mapped[str] = mapped_column(String(32), nullable=False)
    sequence: Mapped[int] = mapped_column(Integer, nullable=False)


class RebalanceSpendAttempt(Base):
    __tablename__ = "rebalance_spend_attempts"
    __table_args__ = (
        UniqueConstraint("scope_id", "attempt_key", name="uq_rebalance_spend_attempt"),
        CheckConstraint("upper_inr > 0 AND (actual_inr IS NULL OR actual_inr >= 0)", name="ck_rebalance_attempt_amounts"),
    )
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    scope_id: Mapped[int] = mapped_column(ForeignKey("rebalance_spend_scopes.id", ondelete="RESTRICT"), nullable=False, index=True)
    job_id: Mapped[int] = mapped_column(ForeignKey("jobs.id", ondelete="RESTRICT"), nullable=False)
    attempt_key: Mapped[str] = mapped_column(String(128), nullable=False)
    provider: Mapped[str] = mapped_column(String(64), nullable=False)
    model: Mapped[str | None] = mapped_column(String(128))
    upper_inr: Mapped[Decimal] = mapped_column(Numeric(24, 8), nullable=False)
    actual_inr: Mapped[Decimal | None] = mapped_column(Numeric(24, 8))
    tariff_version: Mapped[str] = mapped_column(String(128), nullable=False)
    fx_version: Mapped[str] = mapped_column(String(128), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="reserved")
    receipt: Mapped[str | None] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
