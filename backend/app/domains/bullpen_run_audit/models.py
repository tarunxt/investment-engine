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
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.infrastructure.database.base import Base, TimestampMixin


class BullpenRunAuditBlobRecord(Base, TimestampMixin):
    __tablename__ = "bullpen_run_audit_blobs"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    content_type: Mapped[str] = mapped_column(String(128), nullable=False)
    sanitized: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    payload_json: Mapped[dict[str, object] | list[object] | None] = mapped_column(
        JSON,
        nullable=True,
    )
    payload_text: Mapped[str | None] = mapped_column(Text, nullable=True)


class BullpenRunAuditSnapshotRecord(Base, TimestampMixin):
    __tablename__ = "bullpen_run_audit_snapshots"
    __table_args__ = (
        Index(
            "ix_bullpen_run_audit_snapshots_user_started_at",
            "user_id",
            "started_at",
        ),
        Index(
            "ix_bullpen_run_audit_snapshots_user_status",
            "user_id",
            "run_status",
            "started_at",
        ),
        Index(
            "ix_bullpen_run_audit_snapshots_user_triggered_by",
            "user_id",
            "triggered_by",
            "started_at",
        ),
        Index(
            "ix_bullpen_run_audit_snapshots_user_audit_status",
            "user_id",
            "audit_status",
            "started_at",
        ),
        Index(
            "ix_bullpen_run_audit_snapshots_user_feedback_status",
            "user_id",
            "feedback_status",
            "started_at",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    run_id: Mapped[str] = mapped_column(
        ForeignKey("polymarket_auto_live_runs.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    snapshot_version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    snapshot_schema_version: Mapped[int] = mapped_column(Integer, nullable=False)
    is_current: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False, index=True)
    source_kind: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    lifecycle_status: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    audit_status: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    run_status: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    triggered_by: Mapped[str] = mapped_column(String(32), nullable=False)
    dry_run: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    live_execution_requested: Mapped[bool] = mapped_column(
        Boolean,
        default=False,
        nullable=False,
    )
    live_execution_attempted: Mapped[bool] = mapped_column(
        Boolean,
        default=False,
        nullable=False,
    )
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    duration_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)
    execution_version: Mapped[str | None] = mapped_column(String(128), nullable=True)
    strategy_version: Mapped[str | None] = mapped_column(String(128), nullable=True)
    backend_commit_sha: Mapped[str | None] = mapped_column(String(64), nullable=True)
    frontend_build_sha: Mapped[str | None] = mapped_column(String(64), nullable=True)
    deployment_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    build_time: Mapped[str | None] = mapped_column(String(64), nullable=True)
    alembic_revision: Mapped[str | None] = mapped_column(String(128), nullable=True)
    settings_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    canonical_bundle_blob_id: Mapped[str | None] = mapped_column(
        ForeignKey("bullpen_run_audit_blobs.id", ondelete="SET NULL"),
        nullable=True,
    )
    canonical_bundle_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    completeness_pct: Mapped[float] = mapped_column(Float, default=0, nullable=False)
    missing_fields_json: Mapped[list[object]] = mapped_column(JSON, default=list, nullable=False)
    provenance_json: Mapped[dict[str, object]] = mapped_column(JSON, default=dict, nullable=False)
    section_index_json: Mapped[dict[str, object]] = mapped_column(
        JSON,
        default=dict,
        nullable=False,
    )
    source_run_updated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    finalized_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    supersedes_snapshot_id: Mapped[int | None] = mapped_column(
        ForeignKey("bullpen_run_audit_snapshots.id", ondelete="SET NULL"),
        nullable=True,
    )

    stage1_status: Mapped[str | None] = mapped_column(String(32), nullable=True)
    stage2_status: Mapped[str | None] = mapped_column(String(32), nullable=True)
    stage3_status: Mapped[str | None] = mapped_column(String(32), nullable=True)
    scanned_candidate_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    candidate_rows_before_llm: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    llm_candidate_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    llm_configured_call_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    llm_attempted_call_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    llm_succeeded_call_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    llm_failed_call_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    qualified_candidate_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    ranked_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    final_selection_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    decisions_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    orders_planned: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    orders_submitted: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    orders_confirmed: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    orders_filled: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    orders_permanently_failed: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    findings_critical: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    findings_high: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    findings_medium: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    findings_low: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    findings_info: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    validation_failure_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    provider_failure_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    incomplete_data_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    manual_deficiency_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    feedback_status: Mapped[str | None] = mapped_column(String(32), nullable=True)
    feedback_provider: Mapped[str | None] = mapped_column(String(64), nullable=True)
    feedback_model: Mapped[str | None] = mapped_column(String(128), nullable=True)

    canonical_bundle_blob: Mapped[BullpenRunAuditBlobRecord | None] = relationship(
        foreign_keys=[canonical_bundle_blob_id]
    )
    stages: Mapped[list[BullpenRunAuditStageRecord]] = relationship(
        back_populates="snapshot",
        cascade="all, delete-orphan",
        order_by="BullpenRunAuditStageRecord.sequence",
    )
    events: Mapped[list[BullpenRunAuditEventRecord]] = relationship(
        back_populates="snapshot",
        cascade="all, delete-orphan",
        order_by="BullpenRunAuditEventRecord.sequence",
    )
    formulas: Mapped[list[BullpenRunAuditFormulaRecord]] = relationship(
        back_populates="snapshot",
        cascade="all, delete-orphan",
    )
    findings: Mapped[list[BullpenRunAuditFindingRecord]] = relationship(
        back_populates="snapshot",
        cascade="all, delete-orphan",
    )
    remarks: Mapped[list[BullpenRunAuditRemarkRecord]] = relationship(
        back_populates="snapshot",
        cascade="all, delete-orphan",
    )
    manual_checks: Mapped[list[BullpenRunAuditManualCheckRecord]] = relationship(
        back_populates="snapshot",
        cascade="all, delete-orphan",
    )
    feedback_generations: Mapped[list[BullpenRunAuditFeedbackRecord]] = relationship(
        back_populates="snapshot",
        cascade="all, delete-orphan",
        order_by="BullpenRunAuditFeedbackRecord.created_at.desc()",
    )


class BullpenRunAuditStageRecord(Base, TimestampMixin):
    __tablename__ = "bullpen_run_audit_stages"
    __table_args__ = (
        Index("ix_bullpen_run_audit_stages_snapshot_sequence", "snapshot_id", "sequence"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    snapshot_id: Mapped[int] = mapped_column(
        ForeignKey("bullpen_run_audit_snapshots.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    logical_stage_number: Mapped[int] = mapped_column(Integer, nullable=False)
    logical_stage_label: Mapped[str] = mapped_column(String(32), nullable=False)
    source_stage_number: Mapped[int | None] = mapped_column(Integer, nullable=True)
    source_stage_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    source_scope: Mapped[str] = mapped_column(String(32), nullable=False, default="run")
    source_object_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    hard_block: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    inputs_blob_id: Mapped[str | None] = mapped_column(
        ForeignKey("bullpen_run_audit_blobs.id", ondelete="SET NULL"),
        nullable=True,
    )
    outputs_blob_id: Mapped[str | None] = mapped_column(
        ForeignKey("bullpen_run_audit_blobs.id", ondelete="SET NULL"),
        nullable=True,
    )
    raw_stage_blob_id: Mapped[str | None] = mapped_column(
        ForeignKey("bullpen_run_audit_blobs.id", ondelete="SET NULL"),
        nullable=True,
    )
    summary_json: Mapped[dict[str, object]] = mapped_column(JSON, default=dict, nullable=False)

    snapshot: Mapped[BullpenRunAuditSnapshotRecord] = relationship(back_populates="stages")


class BullpenRunAuditEventRecord(Base, TimestampMixin):
    __tablename__ = "bullpen_run_audit_events"
    __table_args__ = (
        Index(
            "ix_bullpen_run_audit_events_snapshot_event_key",
            "snapshot_id",
            "event_key",
            unique=True,
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    snapshot_id: Mapped[int] = mapped_column(
        ForeignKey("bullpen_run_audit_snapshots.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    event_key: Mapped[str] = mapped_column(String(255), nullable=False)
    sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    logical_stage_number: Mapped[int | None] = mapped_column(Integer, nullable=True)
    event_type: Mapped[str] = mapped_column(String(64), nullable=False)
    scope_type: Mapped[str] = mapped_column(String(32), nullable=False)
    scope_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    source_location: Mapped[str | None] = mapped_column(String(255), nullable=True)
    occurred_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    payload_blob_id: Mapped[str | None] = mapped_column(
        ForeignKey("bullpen_run_audit_blobs.id", ondelete="SET NULL"),
        nullable=True,
    )

    snapshot: Mapped[BullpenRunAuditSnapshotRecord] = relationship(back_populates="events")


class BullpenRunAuditFormulaRecord(Base, TimestampMixin):
    __tablename__ = "bullpen_run_audit_formulas"
    __table_args__ = (
        Index(
            "ix_bullpen_run_audit_formulas_snapshot_algorithm",
            "snapshot_id",
            "algorithm_key",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    snapshot_id: Mapped[int] = mapped_column(
        ForeignKey("bullpen_run_audit_snapshots.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    logical_stage_number: Mapped[int | None] = mapped_column(Integer, nullable=True)
    scope_type: Mapped[str] = mapped_column(String(32), nullable=False)
    scope_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    algorithm_key: Mapped[str] = mapped_column(String(128), nullable=False)
    human_name: Mapped[str] = mapped_column(String(255), nullable=False)
    algorithm_version: Mapped[str] = mapped_column(String(64), nullable=False)
    source_module: Mapped[str] = mapped_column(String(255), nullable=False)
    source_function: Mapped[str] = mapped_column(String(255), nullable=False)
    inputs_json: Mapped[dict[str, object]] = mapped_column(JSON, default=dict, nullable=False)
    intermediates_json: Mapped[dict[str, object]] = mapped_column(
        JSON,
        default=dict,
        nullable=False,
    )
    output_json: Mapped[dict[str, object]] = mapped_column(JSON, default=dict, nullable=False)
    recorded_value_json: Mapped[dict[str, object] | None] = mapped_column(JSON, nullable=True)
    recomputed_value_json: Mapped[dict[str, object] | None] = mapped_column(JSON, nullable=True)
    difference_json: Mapped[dict[str, object] | None] = mapped_column(JSON, nullable=True)
    units: Mapped[str | None] = mapped_column(String(64), nullable=True)
    validation_status: Mapped[str] = mapped_column(String(32), nullable=False)
    formula_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    recorded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    snapshot: Mapped[BullpenRunAuditSnapshotRecord] = relationship(back_populates="formulas")


class BullpenRunAuditFindingRecord(Base, TimestampMixin):
    __tablename__ = "bullpen_run_audit_findings"
    __table_args__ = (
        Index(
            "ix_bullpen_run_audit_findings_snapshot_severity",
            "snapshot_id",
            "severity",
        ),
        Index(
            "ix_bullpen_run_audit_findings_snapshot_code",
            "snapshot_id",
            "code",
            "rule_version",
            unique=True,
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    snapshot_id: Mapped[int] = mapped_column(
        ForeignKey("bullpen_run_audit_snapshots.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    rule_version: Mapped[str] = mapped_column(String(64), nullable=False)
    code: Mapped[str] = mapped_column(String(128), nullable=False)
    severity: Mapped[str] = mapped_column(String(16), nullable=False, index=True)
    stage: Mapped[str] = mapped_column(String(32), nullable=False)
    category: Mapped[str] = mapped_column(String(64), nullable=False)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    explanation: Mapped[str] = mapped_column(Text, nullable=False)
    observed_value: Mapped[str | None] = mapped_column(Text, nullable=True)
    expected_value: Mapped[str | None] = mapped_column(Text, nullable=True)
    blocking: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    classification: Mapped[str] = mapped_column(String(32), nullable=False)
    suggested_remediation: Mapped[str | None] = mapped_column(Text, nullable=True)
    evidence_pointers_json: Mapped[list[object]] = mapped_column(JSON, default=list, nullable=False)
    detection_metadata_json: Mapped[dict[str, object]] = mapped_column(
        JSON,
        default=dict,
        nullable=False,
    )
    resolution_status: Mapped[str] = mapped_column(String(32), default="open", nullable=False)
    resolution_remark: Mapped[str | None] = mapped_column(Text, nullable=True)

    snapshot: Mapped[BullpenRunAuditSnapshotRecord] = relationship(back_populates="findings")


class BullpenRunAuditRemarkRecord(Base, TimestampMixin):
    __tablename__ = "bullpen_run_audit_remarks"
    __table_args__ = (
        Index("ix_bullpen_run_audit_remarks_snapshot_scope", "snapshot_id", "scope_type", "scope_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    snapshot_id: Mapped[int] = mapped_column(
        ForeignKey("bullpen_run_audit_snapshots.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    scope_type: Mapped[str] = mapped_column(String(32), nullable=False)
    scope_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    remark_type: Mapped[str] = mapped_column(String(32), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    author_label: Mapped[str | None] = mapped_column(String(255), nullable=True)
    metadata_json: Mapped[dict[str, object]] = mapped_column(JSON, default=dict, nullable=False)
    supersedes_remark_id: Mapped[int | None] = mapped_column(
        ForeignKey("bullpen_run_audit_remarks.id", ondelete="SET NULL"),
        nullable=True,
    )

    snapshot: Mapped[BullpenRunAuditSnapshotRecord] = relationship(back_populates="remarks")


class BullpenRunAuditManualCheckRecord(Base, TimestampMixin):
    __tablename__ = "bullpen_run_audit_manual_checks"
    __table_args__ = (
        Index(
            "ix_bullpen_run_audit_manual_checks_snapshot_check",
            "snapshot_id",
            "check_key",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    snapshot_id: Mapped[int] = mapped_column(
        ForeignKey("bullpen_run_audit_snapshots.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    check_key: Mapped[str] = mapped_column(String(128), nullable=False)
    check_label: Mapped[str] = mapped_column(String(255), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    scope_type: Mapped[str] = mapped_column(String(32), nullable=False, default="run")
    scope_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    remark: Mapped[str | None] = mapped_column(Text, nullable=True)
    metadata_json: Mapped[dict[str, object]] = mapped_column(JSON, default=dict, nullable=False)
    supersedes_check_id: Mapped[int | None] = mapped_column(
        ForeignKey("bullpen_run_audit_manual_checks.id", ondelete="SET NULL"),
        nullable=True,
    )

    snapshot: Mapped[BullpenRunAuditSnapshotRecord] = relationship(back_populates="manual_checks")


class BullpenRunAuditFeedbackRecord(Base, TimestampMixin):
    __tablename__ = "bullpen_run_audit_feedback"
    __table_args__ = (
        Index(
            "ix_bullpen_run_audit_feedback_snapshot_created_at",
            "snapshot_id",
            "created_at",
        ),
        Index(
            "ix_bullpen_run_audit_feedback_snapshot_idempotency",
            "snapshot_id",
            "idempotency_key",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    snapshot_id: Mapped[int] = mapped_column(
        ForeignKey("bullpen_run_audit_snapshots.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    status: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    provider: Mapped[str] = mapped_column(String(64), nullable=False)
    model: Mapped[str] = mapped_column(String(128), nullable=False)
    prompt_version: Mapped[str] = mapped_column(String(64), nullable=False)
    prompt_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    report_version: Mapped[str] = mapped_column(String(32), nullable=False, default="1")
    idempotency_key: Mapped[str] = mapped_column(String(128), nullable=False)
    task_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    chunk_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    chunk_coverage_pct: Mapped[float] = mapped_column(Float, default=0, nullable=False)
    snapshot_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    tokens_in: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    tokens_out: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    estimated_cost: Mapped[float] = mapped_column(Float, default=0, nullable=False)
    latency_seconds: Mapped[float] = mapped_column(Float, default=0, nullable=False)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    raw_output_blob_id: Mapped[str | None] = mapped_column(
        ForeignKey("bullpen_run_audit_blobs.id", ondelete="SET NULL"),
        nullable=True,
    )
    report_blob_id: Mapped[str | None] = mapped_column(
        ForeignKey("bullpen_run_audit_blobs.id", ondelete="SET NULL"),
        nullable=True,
    )
    report_json: Mapped[dict[str, object]] = mapped_column(JSON, default=dict, nullable=False)
    codex_prompt: Mapped[str | None] = mapped_column(Text, nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    rerun_of_feedback_id: Mapped[int | None] = mapped_column(
        ForeignKey("bullpen_run_audit_feedback.id", ondelete="SET NULL"),
        nullable=True,
    )

    snapshot: Mapped[BullpenRunAuditSnapshotRecord] = relationship(
        back_populates="feedback_generations"
    )
    subcalls: Mapped[list[BullpenRunAuditFeedbackSubcallRecord]] = relationship(
        back_populates="feedback",
        cascade="all, delete-orphan",
        order_by="BullpenRunAuditFeedbackSubcallRecord.chunk_index",
    )


class BullpenRunAuditFeedbackSubcallRecord(Base, TimestampMixin):
    __tablename__ = "bullpen_run_audit_feedback_subcalls"
    __table_args__ = (
        Index(
            "ix_bullpen_run_audit_feedback_subcalls_feedback_chunk",
            "feedback_id",
            "chunk_index",
            unique=True,
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    feedback_id: Mapped[int] = mapped_column(
        ForeignKey("bullpen_run_audit_feedback.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    chunk_index: Mapped[int] = mapped_column(Integer, nullable=False)
    section_keys_json: Mapped[list[object]] = mapped_column(JSON, default=list, nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    provider: Mapped[str] = mapped_column(String(64), nullable=False)
    model: Mapped[str] = mapped_column(String(128), nullable=False)
    prompt_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    input_blob_id: Mapped[str | None] = mapped_column(
        ForeignKey("bullpen_run_audit_blobs.id", ondelete="SET NULL"),
        nullable=True,
    )
    raw_output_blob_id: Mapped[str | None] = mapped_column(
        ForeignKey("bullpen_run_audit_blobs.id", ondelete="SET NULL"),
        nullable=True,
    )
    parsed_output_json: Mapped[dict[str, object] | None] = mapped_column(JSON, nullable=True)
    tokens_in: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    tokens_out: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    estimated_cost: Mapped[float] = mapped_column(Float, default=0, nullable=False)
    latency_seconds: Mapped[float] = mapped_column(Float, default=0, nullable=False)
    coverage_pct: Mapped[float] = mapped_column(Float, default=0, nullable=False)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)

    feedback: Mapped[BullpenRunAuditFeedbackRecord] = relationship(back_populates="subcalls")

