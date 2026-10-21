"""Durable execution evidence. No registration or real transport is installed."""
from datetime import datetime
from sqlalchemy import String, Integer, Boolean, DateTime, JSON, ForeignKey, UniqueConstraint, CheckConstraint
from sqlalchemy.orm import Mapped, mapped_column
from app.infrastructure.database.base import Base


class ExecutionFence(Base):
    __tablename__ = 'order_execution_fences'
    # Canonical keys: platform, owner:<id>, connection:<id>, account:<owner>:<account>.
    key: Mapped[str] = mapped_column(String(180), primary_key=True)
    stopped: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)


class ExecutionRun(Base):
    __tablename__ = 'order_execution_runs'
    intent_id: Mapped[str] = mapped_column(ForeignKey('confirmed_order_intents.id'), primary_key=True)
    outbox_id: Mapped[str] = mapped_column(String(36), nullable=False, unique=True)
    binding_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    approval_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    limits_json: Mapped[dict] = mapped_column(JSON, nullable=False)


class ExecutionAttempt(Base):
    __tablename__ = 'order_execution_attempts'
    __table_args__ = (
        UniqueConstraint('leg_id', name='uq_execution_attempt_leg'),
        CheckConstraint('polls >= 0 AND polls <= 5', name='ck_execution_attempt_polls'),
    )
    leg_id: Mapped[str] = mapped_column(ForeignKey('confirmed_order_legs.id'), primary_key=True)
    intent_id: Mapped[str] = mapped_column(ForeignKey('order_execution_runs.intent_id'), nullable=False, index=True)
    binding_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    state: Mapped[str] = mapped_column(String(24), nullable=False)
    claimed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    polls: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    next_poll_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    observed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    evidence_json: Mapped[dict | None] = mapped_column(JSON)
    last_error: Mapped[str | None] = mapped_column(String(80))
