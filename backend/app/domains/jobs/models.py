from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.types import TypeDecorator

from app.infrastructure.database.base import Base, TimestampMixin
from app.shared.types import JobStatus

if TYPE_CHECKING:
    from app.domains.auth.models import User


class JobStatusType(TypeDecorator):
    """Stores JobStatus as VARCHAR — avoids a PostgreSQL native ENUM type
    which requires ALTER TYPE to add new values."""

    impl = String(50)
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if isinstance(value, JobStatus):
            return value.value
        return value

    def process_result_value(self, value, dialect):
        if value is not None:
            return JobStatus(value)
        return value


class Job(Base, TimestampMixin):
    __tablename__ = "jobs"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)

    user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=True
    )

    prompt: Mapped[str] = mapped_column(Text, nullable=False)
    provider: Mapped[str] = mapped_column(String(100), nullable=False)
    model: Mapped[str] = mapped_column(String(100), nullable=False)

    status: Mapped[JobStatus] = mapped_column(
        JobStatusType,
        default=JobStatus.PENDING,
        nullable=False,
        index=True,
    )

    response: Mapped[str | None] = mapped_column(Text, nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)

    tokens_in: Mapped[int | None] = mapped_column(Integer, nullable=True)
    tokens_out: Mapped[int | None] = mapped_column(Integer, nullable=True)
    estimated_cost: Mapped[float | None] = mapped_column(Float, nullable=True)
    web_search_used: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    web_search_queries: Mapped[list[str] | None] = mapped_column(JSON, nullable=True)
    web_sources: Mapped[list[str] | None] = mapped_column(JSON, nullable=True)
    export_status: Mapped[str | None] = mapped_column(String(32), nullable=True)
    export_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    exported_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    exported_sheet_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    auto_rebalance_portfolio: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    auto_rebalance_sequence: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    auto_rebalance_label: Mapped[str | None] = mapped_column(String(64), nullable=True)

    scheduled_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    user: Mapped[User] = relationship(back_populates="jobs")
