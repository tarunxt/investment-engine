from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import (
    BigInteger,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.infrastructure.database.base import Base, TimestampMixin


class LlmProviderUsageCallRecord(Base, TimestampMixin):
    """Durable billing telemetry for one successful upstream LLM response."""

    __tablename__ = "llm_provider_usage_calls"
    __table_args__ = (
        UniqueConstraint(
            "provider",
            "provider_request_id",
            name="uq_llm_provider_usage_call_request",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    job_id: Mapped[int | None] = mapped_column(
        ForeignKey("jobs.id", ondelete="SET NULL"), nullable=True, index=True
    )
    provider: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    model: Mapped[str] = mapped_column(String(128), nullable=False)
    provider_request_id: Mapped[str] = mapped_column(String(255), nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, index=True
    )
    tokens_in: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    tokens_out: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    cache_hit_tokens: Mapped[int] = mapped_column(
        BigInteger, nullable=False, default=0
    )
    cache_miss_tokens: Mapped[int] = mapped_column(
        BigInteger, nullable=False, default=0
    )
    actual_cost: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)


class LlmProviderUsageDailySnapshot(Base, TimestampMixin):
    """Authoritative provider-console total for one provider calendar day."""

    __tablename__ = "llm_provider_usage_daily_snapshots"
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "provider",
            "usage_date",
            "timezone",
            name="uq_llm_provider_usage_daily_snapshot",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    provider: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    model: Mapped[str] = mapped_column(String(128), nullable=False)
    usage_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    timezone: Mapped[str] = mapped_column(String(64), nullable=False)
    requests: Mapped[int] = mapped_column(Integer, nullable=False)
    tokens_in: Mapped[int] = mapped_column(BigInteger, nullable=False)
    tokens_out: Mapped[int] = mapped_column(BigInteger, nullable=False)
    cache_hit_tokens: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    cache_miss_tokens: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    actual_cost: Mapped[float] = mapped_column(Float, nullable=False)
    source: Mapped[str] = mapped_column(String(128), nullable=False)
    captured_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
