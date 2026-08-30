"""add isolated Bullpen 008 Phase 1 tables

Revision ID: f9a0b1c2d3e4
Revises: e8f9g0h1i2j3
Create Date: 2026-08-30 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "f9a0b1c2d3e4"
down_revision: str | Sequence[str] | None = "e8f9g0h1i2j3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _timestamps() -> list[sa.Column]:
    return [
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    ]


def upgrade() -> None:
    op.create_table(
        "bullpen008_settings",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("workflow_profile", sa.String(length=64), nullable=False),
        sa.Column("seeded_from_profile", sa.String(length=64), nullable=True),
        sa.Column("seeded_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("seed_source_hash", sa.String(length=64), nullable=True),
        sa.Column("payload", sa.JSON(), nullable=False),
        *_timestamps(),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "user_id",
            "workflow_profile",
            name="uq_bullpen008_settings_user_profile",
        ),
    )
    op.create_index(
        "ix_bullpen008_settings_user_id", "bullpen008_settings", ["user_id"]
    )
    op.create_index(
        "ix_bullpen008_settings_workflow_profile",
        "bullpen008_settings",
        ["workflow_profile"],
    )

    op.create_table(
        "bullpen008_states",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("workflow_profile", sa.String(length=64), nullable=False),
        sa.Column("running", sa.Boolean(), nullable=False),
        sa.Column("paused", sa.Boolean(), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("next_run_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_run_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_run_id", sa.String(length=64), nullable=True),
        sa.Column("payload", sa.JSON(), nullable=False),
        *_timestamps(),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "user_id",
            "workflow_profile",
            name="uq_bullpen008_states_user_profile",
        ),
    )
    op.create_index(
        "ix_bullpen008_states_due",
        "bullpen008_states",
        ["workflow_profile", "running", "next_run_at"],
    )
    op.create_index("ix_bullpen008_states_user_id", "bullpen008_states", ["user_id"])
    op.create_index(
        "ix_bullpen008_states_workflow_profile",
        "bullpen008_states",
        ["workflow_profile"],
    )

    op.create_table(
        "bullpen008_runs",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("workflow_profile", sa.String(length=64), nullable=False),
        sa.Column("idempotency_key", sa.String(length=128), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("triggered_by", sa.String(length=32), nullable=False),
        sa.Column("shadow_mode", sa.Boolean(), nullable=False),
        sa.Column("execution_enabled", sa.Boolean(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("code_build_version", sa.String(length=128), nullable=True),
        sa.Column("settings_snapshot", sa.JSON(), nullable=False),
        sa.Column("wallet_snapshot", sa.JSON(), nullable=False),
        sa.Column("task_metadata", sa.JSON(), nullable=False),
        sa.Column("run_metadata", sa.JSON(), nullable=False),
        *_timestamps(),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "user_id",
            "workflow_profile",
            "idempotency_key",
            name="uq_bullpen008_runs_idempotency",
        ),
    )
    op.create_index(
        "ix_bullpen008_runs_user_profile_started",
        "bullpen008_runs",
        ["user_id", "workflow_profile", "started_at"],
    )
    op.create_index(
        "ix_bullpen008_runs_user_profile_status",
        "bullpen008_runs",
        ["user_id", "workflow_profile", "status"],
    )
    op.create_index("ix_bullpen008_runs_user_id", "bullpen008_runs", ["user_id"])
    op.create_index(
        "ix_bullpen008_runs_workflow_profile",
        "bullpen008_runs",
        ["workflow_profile"],
    )
    op.create_index("ix_bullpen008_runs_status", "bullpen008_runs", ["status"])

    op.create_table(
        "bullpen008_stage_outputs",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("run_id", sa.String(length=64), nullable=False),
        sa.Column("workflow_profile", sa.String(length=64), nullable=False),
        sa.Column("stage_number", sa.Integer(), nullable=False),
        sa.Column("stage_name", sa.String(length=128), nullable=False),
        sa.Column("stage_version", sa.String(length=128), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("pass_condition", sa.Text(), nullable=False),
        sa.Column("block_reason", sa.Text(), nullable=True),
        sa.Column("previous_stage_output_hash", sa.String(length=64), nullable=True),
        sa.Column("output_hash", sa.String(length=64), nullable=False),
        sa.Column("settings_snapshot_hash", sa.String(length=64), nullable=False),
        sa.Column("wallet_snapshot_hash", sa.String(length=64), nullable=False),
        sa.Column("inputs_json", sa.JSON(), nullable=False),
        sa.Column("calculations_json", sa.JSON(), nullable=False),
        sa.Column("outputs_json", sa.JSON(), nullable=False),
        sa.Column("rejections_json", sa.JSON(), nullable=False),
        sa.Column("warnings_json", sa.JSON(), nullable=False),
        sa.Column("provenance_json", sa.JSON(), nullable=False),
        sa.Column("prompt_version", sa.String(length=128), nullable=True),
        sa.Column("parser_version", sa.String(length=128), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("duration_seconds", sa.Float(), nullable=False),
        *_timestamps(),
        sa.ForeignKeyConstraint(["run_id"], ["bullpen008_runs.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "run_id",
            "workflow_profile",
            "stage_number",
            name="uq_bullpen008_stage_output",
        ),
    )
    op.create_index(
        "ix_bullpen008_stage_outputs_run_stage",
        "bullpen008_stage_outputs",
        ["run_id", "stage_number"],
    )
    op.create_index(
        "ix_bullpen008_stage_outputs_run_id",
        "bullpen008_stage_outputs",
        ["run_id"],
    )
    op.create_index(
        "ix_bullpen008_stage_outputs_workflow_profile",
        "bullpen008_stage_outputs",
        ["workflow_profile"],
    )

    op.create_table(
        "bullpen008_portfolio_certificates",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("run_id", sa.String(length=64), nullable=False),
        sa.Column("workflow_profile", sa.String(length=64), nullable=False),
        sa.Column("certificate_hash", sa.String(length=64), nullable=False),
        sa.Column("portfolio_certified", sa.Boolean(), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        *_timestamps(),
        sa.ForeignKeyConstraint(["run_id"], ["bullpen008_runs.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("certificate_hash"),
        sa.UniqueConstraint(
            "run_id",
            "workflow_profile",
            name="uq_bullpen008_portfolio_certificate",
        ),
    )
    op.create_index(
        "ix_bullpen008_portfolio_certificates_run_id",
        "bullpen008_portfolio_certificates",
        ["run_id"],
    )
    op.create_index(
        "ix_bullpen008_portfolio_certificates_workflow_profile",
        "bullpen008_portfolio_certificates",
        ["workflow_profile"],
    )


def downgrade() -> None:
    op.drop_table("bullpen008_portfolio_certificates")
    op.drop_table("bullpen008_stage_outputs")
    op.drop_table("bullpen008_runs")
    op.drop_table("bullpen008_states")
    op.drop_table("bullpen008_settings")
