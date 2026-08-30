from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.infrastructure.database.base import Base, TimestampMixin


class Bullpen008SettingsRecord(Base, TimestampMixin):
    __tablename__ = "bullpen008_settings"
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "workflow_profile",
            name="uq_bullpen008_settings_user_profile",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    workflow_profile: Mapped[str] = mapped_column(
        String(64), nullable=False, index=True
    )
    seeded_from_profile: Mapped[str | None] = mapped_column(String(64), nullable=True)
    seeded_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    seed_source_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    payload: Mapped[dict[str, object]] = mapped_column(
        JSON, default=dict, nullable=False
    )


class Bullpen008StateRecord(Base, TimestampMixin):
    __tablename__ = "bullpen008_states"
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "workflow_profile",
            name="uq_bullpen008_states_user_profile",
        ),
        Index(
            "ix_bullpen008_states_due",
            "workflow_profile",
            "running",
            "next_run_at",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    workflow_profile: Mapped[str] = mapped_column(
        String(64), nullable=False, index=True
    )
    running: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    paused: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    status: Mapped[str] = mapped_column(
        String(32), default="shadow-ready", nullable=False
    )
    next_run_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_run_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_run_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    payload: Mapped[dict[str, object]] = mapped_column(
        JSON, default=dict, nullable=False
    )


class Bullpen008RunRecord(Base, TimestampMixin):
    __tablename__ = "bullpen008_runs"
    __table_args__ = (
        Index(
            "ix_bullpen008_runs_user_profile_started",
            "user_id",
            "workflow_profile",
            "started_at",
        ),
        Index(
            "ix_bullpen008_runs_user_profile_status",
            "user_id",
            "workflow_profile",
            "status",
        ),
        UniqueConstraint(
            "user_id",
            "workflow_profile",
            "idempotency_key",
            name="uq_bullpen008_runs_idempotency",
        ),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    workflow_profile: Mapped[str] = mapped_column(
        String(64), nullable=False, index=True
    )
    idempotency_key: Mapped[str] = mapped_column(String(128), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    triggered_by: Mapped[str] = mapped_column(String(32), nullable=False)
    shadow_mode: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    execution_enabled: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False
    )
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    summary: Mapped[str] = mapped_column(Text, nullable=False)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    code_build_version: Mapped[str | None] = mapped_column(String(128), nullable=True)
    settings_snapshot: Mapped[dict[str, object]] = mapped_column(
        JSON, default=dict, nullable=False
    )
    wallet_snapshot: Mapped[dict[str, object]] = mapped_column(
        JSON, default=dict, nullable=False
    )
    task_metadata: Mapped[dict[str, object]] = mapped_column(
        JSON, default=dict, nullable=False
    )
    run_metadata: Mapped[dict[str, object]] = mapped_column(
        JSON, default=dict, nullable=False
    )

    stages: Mapped[list[Bullpen008StageOutputRecord]] = relationship(
        back_populates="run",
        cascade="all, delete-orphan",
        order_by="Bullpen008StageOutputRecord.stage_number",
    )
    certificate: Mapped[Bullpen008PortfolioCertificateRecord | None] = relationship(
        back_populates="run",
        cascade="all, delete-orphan",
        uselist=False,
    )


class Bullpen008StageOutputRecord(Base, TimestampMixin):
    __tablename__ = "bullpen008_stage_outputs"
    __table_args__ = (
        UniqueConstraint(
            "run_id",
            "workflow_profile",
            "stage_number",
            name="uq_bullpen008_stage_output",
        ),
        Index(
            "ix_bullpen008_stage_outputs_run_stage",
            "run_id",
            "stage_number",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    run_id: Mapped[str] = mapped_column(
        ForeignKey("bullpen008_runs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    workflow_profile: Mapped[str] = mapped_column(
        String(64), nullable=False, index=True
    )
    stage_number: Mapped[int] = mapped_column(Integer, nullable=False)
    stage_name: Mapped[str] = mapped_column(String(128), nullable=False)
    stage_version: Mapped[str] = mapped_column(String(128), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    pass_condition: Mapped[str] = mapped_column(Text, nullable=False)
    block_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    previous_stage_output_hash: Mapped[str | None] = mapped_column(
        String(64), nullable=True
    )
    output_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    settings_snapshot_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    wallet_snapshot_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    inputs_json: Mapped[dict[str, object]] = mapped_column(
        JSON, default=dict, nullable=False
    )
    calculations_json: Mapped[dict[str, object]] = mapped_column(
        JSON, default=dict, nullable=False
    )
    outputs_json: Mapped[dict[str, object]] = mapped_column(
        JSON, default=dict, nullable=False
    )
    rejections_json: Mapped[list[object]] = mapped_column(
        JSON, default=list, nullable=False
    )
    warnings_json: Mapped[list[object]] = mapped_column(
        JSON, default=list, nullable=False
    )
    provenance_json: Mapped[dict[str, object]] = mapped_column(
        JSON, default=dict, nullable=False
    )
    prompt_version: Mapped[str | None] = mapped_column(String(128), nullable=True)
    parser_version: Mapped[str | None] = mapped_column(String(128), nullable=True)
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    completed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    duration_seconds: Mapped[float] = mapped_column(Float, nullable=False)

    run: Mapped[Bullpen008RunRecord] = relationship(back_populates="stages")


class Bullpen008PortfolioCertificateRecord(Base, TimestampMixin):
    __tablename__ = "bullpen008_portfolio_certificates"
    __table_args__ = (
        UniqueConstraint(
            "run_id",
            "workflow_profile",
            name="uq_bullpen008_portfolio_certificate",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    run_id: Mapped[str] = mapped_column(
        ForeignKey("bullpen008_runs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    workflow_profile: Mapped[str] = mapped_column(
        String(64), nullable=False, index=True
    )
    certificate_hash: Mapped[str] = mapped_column(
        String(64), nullable=False, unique=True
    )
    portfolio_certified: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False
    )
    payload: Mapped[dict[str, object]] = mapped_column(
        JSON, default=dict, nullable=False
    )

    run: Mapped[Bullpen008RunRecord] = relationship(back_populates="certificate")
