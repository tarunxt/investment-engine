from __future__ import annotations

from typing import TYPE_CHECKING

from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Index, Integer, JSON, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.infrastructure.database.base import Base, TimestampMixin
from app.domains.jobs.models import JobStatusType
from app.shared.types import JobStatus

if TYPE_CHECKING:
    from app.domains.auth.models import User
    from app.domains.jobs.models import Job
    from app.domains.prompts.models import Prompt


class Run(Base, TimestampMixin):
    __tablename__ = "runs"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=True
    )
    prompt_id: Mapped[int | None] = mapped_column(
        ForeignKey("prompts.id", ondelete="SET NULL"), nullable=True
    )
    prompt: Mapped[str] = mapped_column(Text, nullable=False)
    prompt_preview: Mapped[str] = mapped_column(String(284), nullable=False)
    status: Mapped[JobStatus] = mapped_column(
        JobStatusType, default=JobStatus.PENDING, nullable=False, index=True
    )
    current_stage: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    synthesis_response: Mapped[str | None] = mapped_column(Text, nullable=True)
    decision_response: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Auto-export settings
    auto_export_enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    export_spreadsheet_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    export_sheet_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    export_investment_amount: Mapped[str | None] = mapped_column(Text, nullable=True)
    export_title: Mapped[str | None] = mapped_column(Text, nullable=True)
    export_status: Mapped[str | None] = mapped_column(Text, nullable=True)
    export_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    exported_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    exported_sheet_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    auto_rebalance_portfolio: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    auto_rebalance_sequence: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    auto_rebalance_label: Mapped[str | None] = mapped_column(String(64), nullable=True)

    run_jobs: Mapped[list[RunJob]] = relationship(
        back_populates="run", cascade="all, delete-orphan"
    )
    user: Mapped[User | None] = relationship()


class RunJob(Base, TimestampMixin):
    __tablename__ = "run_jobs"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    run_id: Mapped[int] = mapped_column(
        ForeignKey("runs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    job_id: Mapped[int] = mapped_column(
        ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    stage: Mapped[int] = mapped_column(Integer, default=1, nullable=False)

    run: Mapped[Run] = relationship(back_populates="run_jobs")
    job: Mapped[Job] = relationship()


class FinalActionableHistory(Base, TimestampMixin):
    """Immutable stock-level action captured for one completed rebalance run.

    Raw LLM output remains in ``jobs.response``.  This projection is deliberately
    append-only and queryable by stock so the dashboard never has to download
    every historical run merely to render one ticker's audit trail.
    """

    __tablename__ = "final_actionable_history"
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "market",
            "rebalance_run_id",
            "stock_symbol",
            "formula_version",
            name="uq_final_actionable_history_run_stock_formula",
        ),
        Index(
            "ix_final_actionable_history_lookup",
            "user_id",
            "market",
            "stock_symbol",
            "covered_at",
            "id",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    workflow_id: Mapped[int | None] = mapped_column(
        ForeignKey("auto_rebalance_workflows.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    auto_rebalance_sequence: Mapped[int | None] = mapped_column(
        Integer, nullable=True, index=True
    )
    rebalance_run_id: Mapped[int] = mapped_column(
        ForeignKey("runs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    market: Mapped[str] = mapped_column(String(16), nullable=False, index=True)
    stock_symbol: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    stock_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    covered_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, index=True
    )
    action: Mapped[str | None] = mapped_column(String(32), nullable=True)
    score: Mapped[float | None] = mapped_column(Float, nullable=True)
    consensus_numerator: Mapped[int | None] = mapped_column(Integer, nullable=True)
    consensus_denominator: Mapped[int | None] = mapped_column(Integer, nullable=True)
    historical_current_units: Mapped[float | None] = mapped_column(Float, nullable=True)
    historical_current_value: Mapped[float | None] = mapped_column(Float, nullable=True)
    action_units: Mapped[float | None] = mapped_column(Float, nullable=True)
    amount: Mapped[float | None] = mapped_column(Float, nullable=True)
    technical_scan_run_id: Mapped[int | None] = mapped_column(
        ForeignKey("runs.id", ondelete="SET NULL"), nullable=True, index=True
    )
    formula_version: Mapped[str] = mapped_column(
        String(64), nullable=False, default="score-matrix-v1"
    )
    formula_inputs_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    source_run_ids_json: Mapped[list | None] = mapped_column(JSON, nullable=True)
    snapshot_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    coverage_status: Mapped[str] = mapped_column(
        String(32), nullable=False, default="suggested", index=True
    )

    user: Mapped[User] = relationship()


class AutoRebalanceWorkflow(Base, TimestampMixin):
    """Durable, user-visible parent record for a multi-stage auto-rebalance.

    Individual AI stages still use the established ``runs``/``jobs`` tables.
    This record owns the cross-stage lifecycle so a dashboard timeout can never
    erase where the sequence stopped or why.
    """

    __tablename__ = "auto_rebalance_workflows"
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "portfolio",
            "sequence",
            name="uq_auto_rebalance_workflow_user_portfolio_sequence",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    portfolio: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    sequence: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    label: Mapped[str] = mapped_column(String(128), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="queued", index=True)
    current_stage: Mapped[str] = mapped_column(String(32), nullable=False, default="sync")
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    user: Mapped[User] = relationship()
    stages: Mapped[list[AutoRebalanceWorkflowStage]] = relationship(
        back_populates="workflow", cascade="all, delete-orphan"
    )


class AutoRebalanceWorkflowStage(Base, TimestampMixin):
    """One immutable-in-meaning lifecycle slot per auto-rebalance stage."""

    __tablename__ = "auto_rebalance_workflow_stages"
    __table_args__ = (
        UniqueConstraint(
            "workflow_id",
            "stage",
            name="uq_auto_rebalance_workflow_stage",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    workflow_id: Mapped[int] = mapped_column(
        ForeignKey("auto_rebalance_workflows.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    stage: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="queued", index=True)
    run_id: Mapped[int | None] = mapped_column(
        ForeignKey("runs.id", ondelete="SET NULL"), nullable=True, index=True
    )
    job_id: Mapped[int | None] = mapped_column(
        ForeignKey("jobs.id", ondelete="SET NULL"), nullable=True, index=True
    )
    summary_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    workflow: Mapped[AutoRebalanceWorkflow] = relationship(back_populates="stages")
