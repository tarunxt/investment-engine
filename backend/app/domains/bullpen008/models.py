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
    action_plan: Mapped[Bullpen008ActionPlanRecord | None] = relationship(
        back_populates="run", cascade="all, delete-orphan", uselist=False
    )
    execution_intents: Mapped[list[Bullpen008ExecutionIntentRecord]] = relationship(
        back_populates="run", cascade="all, delete-orphan"
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


class Bullpen008ActionPlanRecord(Base, TimestampMixin):
    __tablename__ = "bullpen008_action_plans"
    __table_args__ = (
        UniqueConstraint("run_id", "workflow_profile", name="uq_bullpen008_action_plan"),
        UniqueConstraint("plan_hash", name="uq_bullpen008_action_plan_hash"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    run_id: Mapped[str] = mapped_column(
        ForeignKey("bullpen008_runs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    workflow_profile: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    stage4_certificate_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    plan_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    plan_certified: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    account_identity: Mapped[str | None] = mapped_column(String(255), nullable=True)
    wallet_version: Mapped[str] = mapped_column(String(64), nullable=False)
    payload: Mapped[dict[str, object]] = mapped_column(JSON, default=dict, nullable=False)
    certified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    run: Mapped[Bullpen008RunRecord] = relationship(back_populates="action_plan")


class Bullpen008ExecutionIntentRecord(Base, TimestampMixin):
    __tablename__ = "bullpen008_execution_intents"
    __table_args__ = (
        UniqueConstraint("workflow_profile", "action_id", name="uq_bullpen008_execution_action"),
        UniqueConstraint("idempotency_key", name="uq_bullpen008_execution_idempotency"),
        Index("ix_bullpen008_execution_intents_run_status", "run_id", "status"),
        Index("ix_bullpen008_execution_intents_remote_order", "remote_order_id"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    run_id: Mapped[str] = mapped_column(
        ForeignKey("bullpen008_runs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    workflow_profile: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    plan_id: Mapped[str] = mapped_column(
        ForeignKey("bullpen008_action_plans.id", ondelete="CASCADE"), nullable=False, index=True
    )
    action_id: Mapped[str] = mapped_column(String(64), nullable=False)
    action_type: Mapped[str] = mapped_column(String(32), nullable=False)
    market_id: Mapped[str] = mapped_column(String(500), nullable=False)
    condition_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    side: Mapped[str | None] = mapped_column(String(8), nullable=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    idempotency_key: Mapped[str] = mapped_column(String(128), nullable=False)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    stage4_certificate_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    stage5_plan_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    attempt_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    remote_order_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    remote_transaction_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    filled_shares: Mapped[float] = mapped_column(Float, default=0, nullable=False)
    filled_value_usd: Mapped[float] = mapped_column(Float, default=0, nullable=False)
    average_price_cents: Mapped[float | None] = mapped_column(Float, nullable=True)
    fees_usd: Mapped[float | None] = mapped_column(Float, nullable=True)
    blocker_code: Mapped[str | None] = mapped_column(String(96), nullable=True)
    failure_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    retryable: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    payload: Mapped[dict[str, object]] = mapped_column(JSON, default=dict, nullable=False)
    first_submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    reconciled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    terminal_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    run: Mapped[Bullpen008RunRecord] = relationship(back_populates="execution_intents")
    attempts: Mapped[list[Bullpen008ExecutionAttemptRecord]] = relationship(
        back_populates="intent", cascade="all, delete-orphan", order_by="Bullpen008ExecutionAttemptRecord.attempt_number"
    )
    events: Mapped[list[Bullpen008ExecutionEventRecord]] = relationship(
        back_populates="intent", cascade="all, delete-orphan", order_by="Bullpen008ExecutionEventRecord.id"
    )


class Bullpen008ExecutionAttemptRecord(Base, TimestampMixin):
    __tablename__ = "bullpen008_execution_attempts"
    __table_args__ = (
        UniqueConstraint("intent_id", "attempt_number", name="uq_bullpen008_execution_attempt"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    intent_id: Mapped[str] = mapped_column(
        ForeignKey("bullpen008_execution_intents.id", ondelete="CASCADE"), nullable=False, index=True
    )
    attempt_number: Mapped[int] = mapped_column(Integer, nullable=False)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    result_status: Mapped[str] = mapped_column(String(32), nullable=False)
    remote_order_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    remote_transaction_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    error_code: Mapped[str | None] = mapped_column(String(96), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    sanitized_request: Mapped[dict[str, object]] = mapped_column(JSON, default=dict, nullable=False)
    sanitized_response: Mapped[dict[str, object]] = mapped_column(JSON, default=dict, nullable=False)
    reconciliation: Mapped[dict[str, object]] = mapped_column(JSON, default=dict, nullable=False)

    intent: Mapped[Bullpen008ExecutionIntentRecord] = relationship(back_populates="attempts")


class Bullpen008ExecutionEventRecord(Base, TimestampMixin):
    __tablename__ = "bullpen008_execution_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    intent_id: Mapped[str] = mapped_column(
        ForeignKey("bullpen008_execution_intents.id", ondelete="CASCADE"), nullable=False, index=True
    )
    workflow_profile: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    from_status: Mapped[str | None] = mapped_column(String(32), nullable=True)
    to_status: Mapped[str] = mapped_column(String(32), nullable=False)
    reason_code: Mapped[str | None] = mapped_column(String(96), nullable=True)
    evidence: Mapped[dict[str, object]] = mapped_column(JSON, default=dict, nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    intent: Mapped[Bullpen008ExecutionIntentRecord] = relationship(back_populates="events")


class Bullpen008AlertRecord(Base, TimestampMixin):
    __tablename__ = "bullpen008_alerts"
    __table_args__ = (
        UniqueConstraint("workflow_profile", "idempotency_key", name="uq_bullpen008_alert_idempotency"),
        Index("ix_bullpen008_alerts_user_market", "user_id", "market_id", "created_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    workflow_profile: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    market_id: Mapped[str] = mapped_column(String(500), nullable=False)
    side: Mapped[str] = mapped_column(String(8), nullable=False)
    source: Mapped[str] = mapped_column(String(64), nullable=False)
    breach_type: Mapped[str] = mapped_column(String(32), nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(128), nullable=False)
    llm_odds: Mapped[float | None] = mapped_column(Float, nullable=True)
    actual_odds: Mapped[float | None] = mapped_column(Float, nullable=True)
    recovered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    payload: Mapped[dict[str, object]] = mapped_column(JSON, default=dict, nullable=False)
