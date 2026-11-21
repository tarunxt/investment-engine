"""Immutable source publications, independently queued attempts, and final revisions."""
from sqlalchemy import ForeignKey, JSON, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column
from app.infrastructure.database.base import Base, TimestampMixin


class ScorecardRevision(Base, TimestampMixin):
    __tablename__ = "scorecard_revisions"
    __table_args__ = (UniqueConstraint("workflow_id", "request_key"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    workflow_id: Mapped[int] = mapped_column(ForeignKey("auto_rebalance_workflows.id"), index=True)
    request_key: Mapped[str] = mapped_column(String(80))
    digest: Mapped[str] = mapped_column(String(64))
    manifest: Mapped[dict] = mapped_column(JSON)


class ScorecardAttempt(Base, TimestampMixin):
    __tablename__ = "scorecard_attempts"
    __table_args__ = (UniqueConstraint("revision_id", "card", "request_key"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    revision_id: Mapped[int] = mapped_column(ForeignKey("scorecard_revisions.id"), index=True)
    workflow_id: Mapped[int] = mapped_column(ForeignKey("auto_rebalance_workflows.id"), index=True)
    card: Mapped[str] = mapped_column(String(20))
    request_key: Mapped[str] = mapped_column(String(80))
    settings_json: Mapped[dict] = mapped_column(JSON)
    result_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class ScorecardBatch(Base):
    __tablename__ = "scorecard_batches"
    __table_args__ = (UniqueConstraint("attempt_id", "ordinal"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    attempt_id: Mapped[int] = mapped_column(ForeignKey("scorecard_attempts.id"), index=True)
    ordinal: Mapped[int] = mapped_column()
    run_id: Mapped[int] = mapped_column(ForeignKey("runs.id"), unique=True)


class ScorecardFinal(Base, TimestampMixin):
    __tablename__ = "scorecard_finals"
    __table_args__ = (UniqueConstraint("workflow_id", "digest"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    revision_id: Mapped[int] = mapped_column(ForeignKey("scorecard_revisions.id"), index=True)
    workflow_id: Mapped[int] = mapped_column(ForeignKey("auto_rebalance_workflows.id"), index=True)
    digest: Mapped[str] = mapped_column(String(64))
    result_json: Mapped[dict] = mapped_column(JSON)

