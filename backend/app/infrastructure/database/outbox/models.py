from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB, UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.infrastructure.database.base import Base


class OutboxMessage(Base):
    """Transactional outbox — written in the same DB transaction as the domain
    write. Analysis dispatch has an explicit, default-inactive relay seam."""

    __tablename__ = "outbox"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True), primary_key=True, default=uuid4
    )
    topic: Mapped[str] = mapped_column(String(200), nullable=False, index=True)
    payload: Mapped[dict] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False, index=True
    )
    published_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    job_id: Mapped[int | None] = mapped_column(ForeignKey("jobs.id"), nullable=True, unique=True)
    state: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    claim_token: Mapped[str | None] = mapped_column(String(36), nullable=True)
    next_attempt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_error_type: Mapped[str | None] = mapped_column(String(100), nullable=True)
