"""add bullpen run audit tables

Revision ID: u7v8w9x0y1z2
Revises: t1u2v3w4x5y6
Create Date: 2026-07-18 18:45:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "u7v8w9x0y1z2"
down_revision: Union[str, Sequence[str], None] = "t1u2v3w4x5y6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "bullpen_run_audit_blobs",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("content_type", sa.String(length=128), nullable=False),
        sa.Column("sanitized", sa.Boolean(), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("payload_json", sa.JSON(), nullable=True),
        sa.Column("payload_text", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "bullpen_run_audit_snapshots",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("run_id", sa.String(length=64), nullable=False),
        sa.Column("snapshot_version", sa.Integer(), nullable=False),
        sa.Column("snapshot_schema_version", sa.Integer(), nullable=False),
        sa.Column("is_current", sa.Boolean(), nullable=False),
        sa.Column("source_kind", sa.String(length=32), nullable=False),
        sa.Column("lifecycle_status", sa.String(length=32), nullable=False),
        sa.Column("audit_status", sa.String(length=64), nullable=False),
        sa.Column("run_status", sa.String(length=32), nullable=False),
        sa.Column("triggered_by", sa.String(length=32), nullable=False),
        sa.Column("dry_run", sa.Boolean(), nullable=False),
        sa.Column("live_execution_requested", sa.Boolean(), nullable=False),
        sa.Column("live_execution_attempted", sa.Boolean(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("duration_seconds", sa.Float(), nullable=True),
        sa.Column("execution_version", sa.String(length=128), nullable=True),
        sa.Column("strategy_version", sa.String(length=128), nullable=True),
        sa.Column("backend_commit_sha", sa.String(length=64), nullable=True),
        sa.Column("frontend_build_sha", sa.String(length=64), nullable=True),
        sa.Column("deployment_id", sa.String(length=128), nullable=True),
        sa.Column("build_time", sa.String(length=64), nullable=True),
        sa.Column("alembic_revision", sa.String(length=128), nullable=True),
        sa.Column("settings_hash", sa.String(length=64), nullable=True),
        sa.Column("canonical_bundle_blob_id", sa.String(length=64), nullable=True),
        sa.Column("canonical_bundle_hash", sa.String(length=64), nullable=True),
        sa.Column("completeness_pct", sa.Float(), nullable=False),
        sa.Column("missing_fields_json", sa.JSON(), nullable=False),
        sa.Column("provenance_json", sa.JSON(), nullable=False),
        sa.Column("section_index_json", sa.JSON(), nullable=False),
        sa.Column("source_run_updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finalized_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("supersedes_snapshot_id", sa.Integer(), nullable=True),
        sa.Column("stage1_status", sa.String(length=32), nullable=True),
        sa.Column("stage2_status", sa.String(length=32), nullable=True),
        sa.Column("stage3_status", sa.String(length=32), nullable=True),
        sa.Column("scanned_candidate_count", sa.Integer(), nullable=False),
        sa.Column("candidate_rows_before_llm", sa.Integer(), nullable=False),
        sa.Column("llm_candidate_count", sa.Integer(), nullable=False),
        sa.Column("llm_configured_call_count", sa.Integer(), nullable=False),
        sa.Column("llm_attempted_call_count", sa.Integer(), nullable=False),
        sa.Column("llm_succeeded_call_count", sa.Integer(), nullable=False),
        sa.Column("llm_failed_call_count", sa.Integer(), nullable=False),
        sa.Column("qualified_candidate_count", sa.Integer(), nullable=False),
        sa.Column("ranked_count", sa.Integer(), nullable=False),
        sa.Column("final_selection_count", sa.Integer(), nullable=False),
        sa.Column("decisions_count", sa.Integer(), nullable=False),
        sa.Column("orders_planned", sa.Integer(), nullable=False),
        sa.Column("orders_submitted", sa.Integer(), nullable=False),
        sa.Column("orders_confirmed", sa.Integer(), nullable=False),
        sa.Column("orders_filled", sa.Integer(), nullable=False),
        sa.Column("orders_permanently_failed", sa.Integer(), nullable=False),
        sa.Column("findings_critical", sa.Integer(), nullable=False),
        sa.Column("findings_high", sa.Integer(), nullable=False),
        sa.Column("findings_medium", sa.Integer(), nullable=False),
        sa.Column("findings_low", sa.Integer(), nullable=False),
        sa.Column("findings_info", sa.Integer(), nullable=False),
        sa.Column("validation_failure_count", sa.Integer(), nullable=False),
        sa.Column("provider_failure_count", sa.Integer(), nullable=False),
        sa.Column("incomplete_data_count", sa.Integer(), nullable=False),
        sa.Column("manual_deficiency_count", sa.Integer(), nullable=False),
        sa.Column("feedback_status", sa.String(length=32), nullable=True),
        sa.Column("feedback_provider", sa.String(length=64), nullable=True),
        sa.Column("feedback_model", sa.String(length=128), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["canonical_bundle_blob_id"], ["bullpen_run_audit_blobs.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["run_id"], ["polymarket_auto_live_runs.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["supersedes_snapshot_id"], ["bullpen_run_audit_snapshots.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_bullpen_run_audit_snapshots_user_id", "bullpen_run_audit_snapshots", ["user_id"], unique=False)
    op.create_index("ix_bullpen_run_audit_snapshots_run_id", "bullpen_run_audit_snapshots", ["run_id"], unique=False)
    op.create_index("ix_bullpen_run_audit_snapshots_is_current", "bullpen_run_audit_snapshots", ["is_current"], unique=False)
    op.create_index("ix_bullpen_run_audit_snapshots_source_kind", "bullpen_run_audit_snapshots", ["source_kind"], unique=False)
    op.create_index("ix_bullpen_run_audit_snapshots_lifecycle_status", "bullpen_run_audit_snapshots", ["lifecycle_status"], unique=False)
    op.create_index("ix_bullpen_run_audit_snapshots_audit_status", "bullpen_run_audit_snapshots", ["audit_status"], unique=False)
    op.create_index("ix_bullpen_run_audit_snapshots_run_status", "bullpen_run_audit_snapshots", ["run_status"], unique=False)
    op.create_index(
        "ix_bullpen_run_audit_snapshots_user_started_at",
        "bullpen_run_audit_snapshots",
        ["user_id", "started_at"],
        unique=False,
    )
    op.create_index(
        "ix_bullpen_run_audit_snapshots_user_status",
        "bullpen_run_audit_snapshots",
        ["user_id", "run_status", "started_at"],
        unique=False,
    )
    op.create_index(
        "ix_bullpen_run_audit_snapshots_user_triggered_by",
        "bullpen_run_audit_snapshots",
        ["user_id", "triggered_by", "started_at"],
        unique=False,
    )
    op.create_index(
        "ix_bullpen_run_audit_snapshots_user_audit_status",
        "bullpen_run_audit_snapshots",
        ["user_id", "audit_status", "started_at"],
        unique=False,
    )
    op.create_index(
        "ix_bullpen_run_audit_snapshots_user_feedback_status",
        "bullpen_run_audit_snapshots",
        ["user_id", "feedback_status", "started_at"],
        unique=False,
    )

    op.create_table(
        "bullpen_run_audit_stages",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("snapshot_id", sa.Integer(), nullable=False),
        sa.Column("logical_stage_number", sa.Integer(), nullable=False),
        sa.Column("logical_stage_label", sa.String(length=32), nullable=False),
        sa.Column("source_stage_number", sa.Integer(), nullable=True),
        sa.Column("source_stage_name", sa.String(length=255), nullable=True),
        sa.Column("source_scope", sa.String(length=32), nullable=False),
        sa.Column("source_object_id", sa.String(length=128), nullable=True),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("hard_block", sa.Boolean(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("inputs_blob_id", sa.String(length=64), nullable=True),
        sa.Column("outputs_blob_id", sa.String(length=64), nullable=True),
        sa.Column("raw_stage_blob_id", sa.String(length=64), nullable=True),
        sa.Column("summary_json", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["inputs_blob_id"], ["bullpen_run_audit_blobs.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["outputs_blob_id"], ["bullpen_run_audit_blobs.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["raw_stage_blob_id"], ["bullpen_run_audit_blobs.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["snapshot_id"], ["bullpen_run_audit_snapshots.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_bullpen_run_audit_stages_snapshot_id", "bullpen_run_audit_stages", ["snapshot_id"], unique=False)
    op.create_index(
        "ix_bullpen_run_audit_stages_snapshot_sequence",
        "bullpen_run_audit_stages",
        ["snapshot_id", "sequence"],
        unique=False,
    )

    op.create_table(
        "bullpen_run_audit_events",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("snapshot_id", sa.Integer(), nullable=False),
        sa.Column("event_key", sa.String(length=255), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("logical_stage_number", sa.Integer(), nullable=True),
        sa.Column("event_type", sa.String(length=64), nullable=False),
        sa.Column("scope_type", sa.String(length=32), nullable=False),
        sa.Column("scope_id", sa.String(length=128), nullable=True),
        sa.Column("source_location", sa.String(length=255), nullable=True),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("payload_blob_id", sa.String(length=64), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["payload_blob_id"], ["bullpen_run_audit_blobs.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["snapshot_id"], ["bullpen_run_audit_snapshots.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_bullpen_run_audit_events_snapshot_id", "bullpen_run_audit_events", ["snapshot_id"], unique=False)
    op.create_index(
        "ix_bullpen_run_audit_events_snapshot_event_key",
        "bullpen_run_audit_events",
        ["snapshot_id", "event_key"],
        unique=True,
    )

    op.create_table(
        "bullpen_run_audit_formulas",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("snapshot_id", sa.Integer(), nullable=False),
        sa.Column("logical_stage_number", sa.Integer(), nullable=True),
        sa.Column("scope_type", sa.String(length=32), nullable=False),
        sa.Column("scope_id", sa.String(length=128), nullable=True),
        sa.Column("algorithm_key", sa.String(length=128), nullable=False),
        sa.Column("human_name", sa.String(length=255), nullable=False),
        sa.Column("algorithm_version", sa.String(length=64), nullable=False),
        sa.Column("source_module", sa.String(length=255), nullable=False),
        sa.Column("source_function", sa.String(length=255), nullable=False),
        sa.Column("inputs_json", sa.JSON(), nullable=False),
        sa.Column("intermediates_json", sa.JSON(), nullable=False),
        sa.Column("output_json", sa.JSON(), nullable=False),
        sa.Column("recorded_value_json", sa.JSON(), nullable=True),
        sa.Column("recomputed_value_json", sa.JSON(), nullable=True),
        sa.Column("difference_json", sa.JSON(), nullable=True),
        sa.Column("units", sa.String(length=64), nullable=True),
        sa.Column("validation_status", sa.String(length=32), nullable=False),
        sa.Column("formula_hash", sa.String(length=64), nullable=False),
        sa.Column("recorded_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["snapshot_id"], ["bullpen_run_audit_snapshots.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_bullpen_run_audit_formulas_snapshot_id", "bullpen_run_audit_formulas", ["snapshot_id"], unique=False)
    op.create_index(
        "ix_bullpen_run_audit_formulas_snapshot_algorithm",
        "bullpen_run_audit_formulas",
        ["snapshot_id", "algorithm_key"],
        unique=False,
    )

    op.create_table(
        "bullpen_run_audit_findings",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("snapshot_id", sa.Integer(), nullable=False),
        sa.Column("rule_version", sa.String(length=64), nullable=False),
        sa.Column("code", sa.String(length=128), nullable=False),
        sa.Column("severity", sa.String(length=16), nullable=False),
        sa.Column("stage", sa.String(length=32), nullable=False),
        sa.Column("category", sa.String(length=64), nullable=False),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("explanation", sa.Text(), nullable=False),
        sa.Column("observed_value", sa.Text(), nullable=True),
        sa.Column("expected_value", sa.Text(), nullable=True),
        sa.Column("blocking", sa.Boolean(), nullable=False),
        sa.Column("classification", sa.String(length=32), nullable=False),
        sa.Column("suggested_remediation", sa.Text(), nullable=True),
        sa.Column("evidence_pointers_json", sa.JSON(), nullable=False),
        sa.Column("detection_metadata_json", sa.JSON(), nullable=False),
        sa.Column("resolution_status", sa.String(length=32), nullable=False),
        sa.Column("resolution_remark", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["snapshot_id"], ["bullpen_run_audit_snapshots.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_bullpen_run_audit_findings_snapshot_id", "bullpen_run_audit_findings", ["snapshot_id"], unique=False)
    op.create_index("ix_bullpen_run_audit_findings_severity", "bullpen_run_audit_findings", ["severity"], unique=False)
    op.create_index(
        "ix_bullpen_run_audit_findings_snapshot_severity",
        "bullpen_run_audit_findings",
        ["snapshot_id", "severity"],
        unique=False,
    )
    op.create_index(
        "ix_bullpen_run_audit_findings_snapshot_code",
        "bullpen_run_audit_findings",
        ["snapshot_id", "code", "rule_version"],
        unique=True,
    )

    op.create_table(
        "bullpen_run_audit_remarks",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("snapshot_id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("scope_type", sa.String(length=32), nullable=False),
        sa.Column("scope_id", sa.String(length=128), nullable=True),
        sa.Column("remark_type", sa.String(length=32), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("author_label", sa.String(length=255), nullable=True),
        sa.Column("metadata_json", sa.JSON(), nullable=False),
        sa.Column("supersedes_remark_id", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["snapshot_id"], ["bullpen_run_audit_snapshots.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["supersedes_remark_id"], ["bullpen_run_audit_remarks.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_bullpen_run_audit_remarks_snapshot_id", "bullpen_run_audit_remarks", ["snapshot_id"], unique=False)
    op.create_index("ix_bullpen_run_audit_remarks_user_id", "bullpen_run_audit_remarks", ["user_id"], unique=False)
    op.create_index(
        "ix_bullpen_run_audit_remarks_snapshot_scope",
        "bullpen_run_audit_remarks",
        ["snapshot_id", "scope_type", "scope_id"],
        unique=False,
    )

    op.create_table(
        "bullpen_run_audit_manual_checks",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("snapshot_id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("check_key", sa.String(length=128), nullable=False),
        sa.Column("check_label", sa.String(length=255), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("scope_type", sa.String(length=32), nullable=False),
        sa.Column("scope_id", sa.String(length=128), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("remark", sa.Text(), nullable=True),
        sa.Column("metadata_json", sa.JSON(), nullable=False),
        sa.Column("supersedes_check_id", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["snapshot_id"], ["bullpen_run_audit_snapshots.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["supersedes_check_id"], ["bullpen_run_audit_manual_checks.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_bullpen_run_audit_manual_checks_snapshot_id", "bullpen_run_audit_manual_checks", ["snapshot_id"], unique=False)
    op.create_index("ix_bullpen_run_audit_manual_checks_user_id", "bullpen_run_audit_manual_checks", ["user_id"], unique=False)
    op.create_index(
        "ix_bullpen_run_audit_manual_checks_snapshot_check",
        "bullpen_run_audit_manual_checks",
        ["snapshot_id", "check_key"],
        unique=False,
    )

    op.create_table(
        "bullpen_run_audit_feedback",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("snapshot_id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("provider", sa.String(length=64), nullable=False),
        sa.Column("model", sa.String(length=128), nullable=False),
        sa.Column("prompt_version", sa.String(length=64), nullable=False),
        sa.Column("prompt_hash", sa.String(length=64), nullable=False),
        sa.Column("report_version", sa.String(length=32), nullable=False),
        sa.Column("idempotency_key", sa.String(length=128), nullable=False),
        sa.Column("task_id", sa.String(length=255), nullable=True),
        sa.Column("chunk_count", sa.Integer(), nullable=False),
        sa.Column("chunk_coverage_pct", sa.Float(), nullable=False),
        sa.Column("snapshot_hash", sa.String(length=64), nullable=True),
        sa.Column("tokens_in", sa.Integer(), nullable=False),
        sa.Column("tokens_out", sa.Integer(), nullable=False),
        sa.Column("estimated_cost", sa.Float(), nullable=False),
        sa.Column("latency_seconds", sa.Float(), nullable=False),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("raw_output_blob_id", sa.String(length=64), nullable=True),
        sa.Column("report_blob_id", sa.String(length=64), nullable=True),
        sa.Column("report_json", sa.JSON(), nullable=False),
        sa.Column("codex_prompt", sa.Text(), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("rerun_of_feedback_id", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["raw_output_blob_id"], ["bullpen_run_audit_blobs.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["report_blob_id"], ["bullpen_run_audit_blobs.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["rerun_of_feedback_id"], ["bullpen_run_audit_feedback.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["snapshot_id"], ["bullpen_run_audit_snapshots.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_bullpen_run_audit_feedback_snapshot_id", "bullpen_run_audit_feedback", ["snapshot_id"], unique=False)
    op.create_index("ix_bullpen_run_audit_feedback_user_id", "bullpen_run_audit_feedback", ["user_id"], unique=False)
    op.create_index("ix_bullpen_run_audit_feedback_status", "bullpen_run_audit_feedback", ["status"], unique=False)
    op.create_index(
        "ix_bullpen_run_audit_feedback_snapshot_created_at",
        "bullpen_run_audit_feedback",
        ["snapshot_id", "created_at"],
        unique=False,
    )
    op.create_index(
        "ix_bullpen_run_audit_feedback_snapshot_idempotency",
        "bullpen_run_audit_feedback",
        ["snapshot_id", "idempotency_key"],
        unique=False,
    )

    op.create_table(
        "bullpen_run_audit_feedback_subcalls",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("feedback_id", sa.Integer(), nullable=False),
        sa.Column("chunk_index", sa.Integer(), nullable=False),
        sa.Column("section_keys_json", sa.JSON(), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("provider", sa.String(length=64), nullable=False),
        sa.Column("model", sa.String(length=128), nullable=False),
        sa.Column("prompt_hash", sa.String(length=64), nullable=False),
        sa.Column("input_blob_id", sa.String(length=64), nullable=True),
        sa.Column("raw_output_blob_id", sa.String(length=64), nullable=True),
        sa.Column("parsed_output_json", sa.JSON(), nullable=True),
        sa.Column("tokens_in", sa.Integer(), nullable=False),
        sa.Column("tokens_out", sa.Integer(), nullable=False),
        sa.Column("estimated_cost", sa.Float(), nullable=False),
        sa.Column("latency_seconds", sa.Float(), nullable=False),
        sa.Column("coverage_pct", sa.Float(), nullable=False),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["feedback_id"], ["bullpen_run_audit_feedback.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["input_blob_id"], ["bullpen_run_audit_blobs.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["raw_output_blob_id"], ["bullpen_run_audit_blobs.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_bullpen_run_audit_feedback_subcalls_feedback_id", "bullpen_run_audit_feedback_subcalls", ["feedback_id"], unique=False)
    op.create_index(
        "ix_bullpen_run_audit_feedback_subcalls_feedback_chunk",
        "bullpen_run_audit_feedback_subcalls",
        ["feedback_id", "chunk_index"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("ix_bullpen_run_audit_feedback_subcalls_feedback_chunk", table_name="bullpen_run_audit_feedback_subcalls")
    op.drop_index("ix_bullpen_run_audit_feedback_subcalls_feedback_id", table_name="bullpen_run_audit_feedback_subcalls")
    op.drop_table("bullpen_run_audit_feedback_subcalls")

    op.drop_index("ix_bullpen_run_audit_feedback_snapshot_idempotency", table_name="bullpen_run_audit_feedback")
    op.drop_index("ix_bullpen_run_audit_feedback_snapshot_created_at", table_name="bullpen_run_audit_feedback")
    op.drop_index("ix_bullpen_run_audit_feedback_status", table_name="bullpen_run_audit_feedback")
    op.drop_index("ix_bullpen_run_audit_feedback_user_id", table_name="bullpen_run_audit_feedback")
    op.drop_index("ix_bullpen_run_audit_feedback_snapshot_id", table_name="bullpen_run_audit_feedback")
    op.drop_table("bullpen_run_audit_feedback")

    op.drop_index("ix_bullpen_run_audit_manual_checks_snapshot_check", table_name="bullpen_run_audit_manual_checks")
    op.drop_index("ix_bullpen_run_audit_manual_checks_user_id", table_name="bullpen_run_audit_manual_checks")
    op.drop_index("ix_bullpen_run_audit_manual_checks_snapshot_id", table_name="bullpen_run_audit_manual_checks")
    op.drop_table("bullpen_run_audit_manual_checks")

    op.drop_index("ix_bullpen_run_audit_remarks_snapshot_scope", table_name="bullpen_run_audit_remarks")
    op.drop_index("ix_bullpen_run_audit_remarks_user_id", table_name="bullpen_run_audit_remarks")
    op.drop_index("ix_bullpen_run_audit_remarks_snapshot_id", table_name="bullpen_run_audit_remarks")
    op.drop_table("bullpen_run_audit_remarks")

    op.drop_index("ix_bullpen_run_audit_findings_snapshot_code", table_name="bullpen_run_audit_findings")
    op.drop_index("ix_bullpen_run_audit_findings_snapshot_severity", table_name="bullpen_run_audit_findings")
    op.drop_index("ix_bullpen_run_audit_findings_severity", table_name="bullpen_run_audit_findings")
    op.drop_index("ix_bullpen_run_audit_findings_snapshot_id", table_name="bullpen_run_audit_findings")
    op.drop_table("bullpen_run_audit_findings")

    op.drop_index("ix_bullpen_run_audit_formulas_snapshot_algorithm", table_name="bullpen_run_audit_formulas")
    op.drop_index("ix_bullpen_run_audit_formulas_snapshot_id", table_name="bullpen_run_audit_formulas")
    op.drop_table("bullpen_run_audit_formulas")

    op.drop_index("ix_bullpen_run_audit_events_snapshot_event_key", table_name="bullpen_run_audit_events")
    op.drop_index("ix_bullpen_run_audit_events_snapshot_id", table_name="bullpen_run_audit_events")
    op.drop_table("bullpen_run_audit_events")

    op.drop_index("ix_bullpen_run_audit_stages_snapshot_sequence", table_name="bullpen_run_audit_stages")
    op.drop_index("ix_bullpen_run_audit_stages_snapshot_id", table_name="bullpen_run_audit_stages")
    op.drop_table("bullpen_run_audit_stages")

    op.drop_index("ix_bullpen_run_audit_snapshots_user_feedback_status", table_name="bullpen_run_audit_snapshots")
    op.drop_index("ix_bullpen_run_audit_snapshots_user_audit_status", table_name="bullpen_run_audit_snapshots")
    op.drop_index("ix_bullpen_run_audit_snapshots_user_triggered_by", table_name="bullpen_run_audit_snapshots")
    op.drop_index("ix_bullpen_run_audit_snapshots_user_status", table_name="bullpen_run_audit_snapshots")
    op.drop_index("ix_bullpen_run_audit_snapshots_user_started_at", table_name="bullpen_run_audit_snapshots")
    op.drop_index("ix_bullpen_run_audit_snapshots_run_status", table_name="bullpen_run_audit_snapshots")
    op.drop_index("ix_bullpen_run_audit_snapshots_audit_status", table_name="bullpen_run_audit_snapshots")
    op.drop_index("ix_bullpen_run_audit_snapshots_lifecycle_status", table_name="bullpen_run_audit_snapshots")
    op.drop_index("ix_bullpen_run_audit_snapshots_source_kind", table_name="bullpen_run_audit_snapshots")
    op.drop_index("ix_bullpen_run_audit_snapshots_is_current", table_name="bullpen_run_audit_snapshots")
    op.drop_index("ix_bullpen_run_audit_snapshots_run_id", table_name="bullpen_run_audit_snapshots")
    op.drop_index("ix_bullpen_run_audit_snapshots_user_id", table_name="bullpen_run_audit_snapshots")
    op.drop_table("bullpen_run_audit_snapshots")

    op.drop_table("bullpen_run_audit_blobs")
