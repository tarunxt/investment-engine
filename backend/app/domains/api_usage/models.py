from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import (
    BigInteger,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    JSON,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.infrastructure.database.base import Base, TimestampMixin


class ApiUsageAttemptEvent(Base):
    """One observable SDK/HTTP invocation, including failed and partial calls.

    Provider usage is evidence; costs here are explicitly estimates, never bills.
    An SDK invocation can contain hidden wire retries (see instrumentation_scope).
    """

    __tablename__ = "api_usage_attempt_events"
    __table_args__ = (UniqueConstraint("attempt_id", "event_kind", name="uq_api_attempt_event_kind"),)

    attempt_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    event_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    event_kind: Mapped[str] = mapped_column(String(16), nullable=False)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), index=True)
    job_id: Mapped[int | None] = mapped_column(ForeignKey("jobs.id", ondelete="SET NULL"), index=True)
    execution_id: Mapped[str | None] = mapped_column(String(128), index=True)
    job_attempt: Mapped[int | None] = mapped_column(Integer)
    run_id: Mapped[str | None] = mapped_column(String(128), index=True)
    workflow_id: Mapped[str | None] = mapped_column(String(128))
    market: Mapped[str | None] = mapped_column(String(64))
    stage: Mapped[str | None] = mapped_column(String(64))
    sample_id: Mapped[str | None] = mapped_column(String(128))
    phase: Mapped[str] = mapped_column(String(64), nullable=False)
    parent_attempt_id: Mapped[str | None] = mapped_column(String(36))
    retry_of_attempt_id: Mapped[str | None] = mapped_column(String(36))
    requested_provider: Mapped[str] = mapped_column(String(64), nullable=False)
    requested_model: Mapped[str | None] = mapped_column(String(128))
    actual_provider: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    actual_model: Mapped[str | None] = mapped_column(String(128))
    provider_request_id: Mapped[str | None] = mapped_column(String(255))
    provider_response_id: Mapped[str | None] = mapped_column(String(255))
    # A response ID deduplicates delivery, not prompt/model or independent samples.
    response_dedupe_key: Mapped[str | None] = mapped_column(String(64), unique=True)
    request_dedupe_key: Mapped[str | None] = mapped_column(String(64), unique=True)
    duplicate_of_attempt_id: Mapped[str | None] = mapped_column(String(36))
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    latency_ms: Mapped[float | None] = mapped_column(Float)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    http_status: Mapped[int | None] = mapped_column(Integer)
    finish_reason: Mapped[str | None] = mapped_column(String(128))
    error_type: Mapped[str | None] = mapped_column(String(128))
    instrumentation_scope: Mapped[str] = mapped_column(String(64), nullable=False)
    reuse_status: Mapped[str | None] = mapped_column(String(32))
    search_result_count: Mapped[int | None] = mapped_column(Integer)
    reported_usage: Mapped[dict | None] = mapped_column(JSON)
    inferred_usage: Mapped[dict | None] = mapped_column(JSON)
    prompt_hash: Mapped[str | None] = mapped_column(String(64))
    evidence_hash: Mapped[str | None] = mapped_column(String(64))
    schema_hash: Mapped[str | None] = mapped_column(String(64))
    tariff_version: Mapped[str | None] = mapped_column(String(128))
    tariff_effective_date: Mapped[date | None] = mapped_column(Date)
    tariff_rates: Mapped[dict | None] = mapped_column(JSON)
    tariff_estimated_cost_usd: Mapped[float | None] = mapped_column(Float)
    tool_tariff_estimated_cost_usd: Mapped[float | None] = mapped_column(Float)
    tool_provider_billed_cost_usd: Mapped[float | None] = mapped_column(Float)
    provider_billed_cost_usd: Mapped[float | None] = mapped_column(Float)
    allocated_cost_usd: Mapped[float | None] = mapped_column(Float)


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
