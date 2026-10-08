from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from uuid import uuid4

from sqlalchemy import JSON, DateTime, Integer, Numeric, String, Text, UniqueConstraint, event
from sqlalchemy.orm import Mapped, mapped_column

from app.infrastructure.database.base import Base


def utcnow():
    return datetime.now(timezone.utc)


class EvidenceRecord(Base):
    """Tenant-scoped immutable bytes/metadata; deliberately no cascading run FK."""
    __tablename__ = "recommendation_evidence"
    __table_args__ = (UniqueConstraint("user_id", "kind", "source_key", "content_hash", name="uq_recommendation_evidence_revision"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    user_id: Mapped[int] = mapped_column(Integer, index=True)
    kind: Mapped[str] = mapped_column(String(32))
    source_key: Mapped[str] = mapped_column(String(128), index=True)
    run_id: Mapped[int | None] = mapped_column(Integer, index=True)
    job_id: Mapped[int | None] = mapped_column(Integer, index=True)
    content_hash: Mapped[str] = mapped_column(String(64))
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    payload: Mapped[dict] = mapped_column(JSON)
    content: Mapped[str | None] = mapped_column(Text)


class DecisionRecord(Base):
    __tablename__ = "recommendation_decisions"
    __table_args__ = (UniqueConstraint("user_id", "content_hash", name="uq_recommendation_decision_revision"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    user_id: Mapped[int] = mapped_column(Integer, index=True)
    run_id: Mapped[int] = mapped_column(Integer, index=True)
    market: Mapped[str] = mapped_column(String(16), index=True)
    symbol: Mapped[str] = mapped_column(String(64), index=True)
    exchange: Mapped[str] = mapped_column(String(32))
    decision_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    provenance: Mapped[str] = mapped_column(String(32))
    content_hash: Mapped[str] = mapped_column(String(64))
    payload: Mapped[dict] = mapped_column(JSON)


class VerificationRecord(Base):
    __tablename__ = "recommendation_verifications"
    __table_args__ = (
        UniqueConstraint("user_id", "request_hash", name="uq_recommendation_verification_request"),
        UniqueConstraint("user_id", "idempotency_key", name="uq_recommendation_verification_key"),
    )
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    user_id: Mapped[int] = mapped_column(Integer, index=True)
    current_id: Mapped[str] = mapped_column(String(36))
    previous_id: Mapped[str | None] = mapped_column(String(36))
    request_hash: Mapped[str] = mapped_column(String(64))
    idempotency_key: Mapped[str] = mapped_column(String(128))
    request: Mapped[dict] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(32), default="queued", index=True)
    verdict: Mapped[str | None] = mapped_column(String(32))
    result: Mapped[dict | None] = mapped_column(JSON)
    error: Mapped[str | None] = mapped_column(String(1000))
    budget_usd: Mapped[Decimal] = mapped_column(Numeric(18, 8), default=0)
    spent_usd: Mapped[Decimal] = mapped_column(Numeric(18, 8), default=0)
    reserved_usd: Mapped[Decimal] = mapped_column(Numeric(18, 8), default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    fence: Mapped[int] = mapped_column(Integer, default=0)
    dispatch_pending: Mapped[bool] = mapped_column(default=True)
    last_dispatch_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class SpendAccount(Base):
    __tablename__ = "recommendation_spend_accounts"
    __table_args__ = (UniqueConstraint("user_id", "day", name="uq_recommendation_spend_day"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    user_id: Mapped[int] = mapped_column(Integer)
    day: Mapped[str] = mapped_column(String(10))
    cap_usd: Mapped[Decimal] = mapped_column(Numeric(18, 8), default=0)
    spent_usd: Mapped[Decimal] = mapped_column(Numeric(18, 8), default=0)
    reserved_usd: Mapped[Decimal] = mapped_column(Numeric(18, 8), default=0)


class SpendAttempt(Base):
    __tablename__ = "recommendation_spend_attempts"
    __table_args__ = (UniqueConstraint("verification_id", "attempt_key", name="uq_recommendation_attempt"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    verification_id: Mapped[str] = mapped_column(String(36), index=True)
    user_id: Mapped[int] = mapped_column(Integer)
    account_id: Mapped[str] = mapped_column(String(36))
    attempt_key: Mapped[str] = mapped_column(String(128))
    adapter: Mapped[str] = mapped_column(String(100))
    tariff_version: Mapped[str] = mapped_column(String(100))
    upper_bound_usd: Mapped[Decimal] = mapped_column(Numeric(18, 8))
    actual_usd: Mapped[Decimal | None] = mapped_column(Numeric(18, 8))
    status: Mapped[str] = mapped_column(String(32), default="reserved")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


def immutable(mapper, connection, target):
    raise ValueError("Recommendation evidence and decisions are append-only; create a new revision")


for _model in (EvidenceRecord, DecisionRecord):
    event.listen(_model, "before_update", immutable)
    event.listen(_model, "before_delete", immutable)
