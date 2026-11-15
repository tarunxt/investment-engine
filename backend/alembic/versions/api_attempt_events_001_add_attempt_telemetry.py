"""Add append-only API attempt lifecycle telemetry.

Revision ID: api_attempt_events_001
Revises: universal_scan_001
"""

from alembic import op
import sqlalchemy as sa

revision = "api_attempt_events_001"
down_revision = "universal_scan_001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "api_usage_attempt_events",
        sa.Column("attempt_id", sa.String(36), nullable=False),
        sa.Column("event_id", sa.String(36), nullable=False),
        sa.Column("event_kind", sa.String(16), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=True),
        sa.Column("job_id", sa.Integer(), nullable=True),
        sa.Column("execution_id", sa.String(128), nullable=True),
        sa.Column("job_attempt", sa.Integer(), nullable=True),
        sa.Column("run_id", sa.String(128), nullable=True),
        sa.Column("workflow_id", sa.String(128), nullable=True),
        sa.Column("market", sa.String(64), nullable=True),
        sa.Column("stage", sa.String(64), nullable=True),
        sa.Column("sample_id", sa.String(128), nullable=True),
        sa.Column("phase", sa.String(64), nullable=False),
        sa.Column("parent_attempt_id", sa.String(36), nullable=True),
        sa.Column("retry_of_attempt_id", sa.String(36), nullable=True),
        sa.Column("requested_provider", sa.String(64), nullable=False),
        sa.Column("requested_model", sa.String(128), nullable=True),
        sa.Column("actual_provider", sa.String(64), nullable=False),
        sa.Column("actual_model", sa.String(128), nullable=True),
        sa.Column("provider_request_id", sa.String(255), nullable=True),
        sa.Column("provider_response_id", sa.String(255), nullable=True),
        sa.Column("response_dedupe_key", sa.String(64), nullable=True),
        sa.Column("request_dedupe_key", sa.String(64), nullable=True),
        sa.Column("duplicate_of_attempt_id", sa.String(36), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("latency_ms", sa.Float(), nullable=True),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("http_status", sa.Integer(), nullable=True),
        sa.Column("finish_reason", sa.String(128), nullable=True),
        sa.Column("error_type", sa.String(128), nullable=True),
        sa.Column("instrumentation_scope", sa.String(64), nullable=False),
        sa.Column("reuse_status", sa.String(32), nullable=True),
        sa.Column("search_result_count", sa.Integer(), nullable=True),
        sa.Column("reported_usage", sa.JSON(), nullable=True),
        sa.Column("inferred_usage", sa.JSON(), nullable=True),
        sa.Column("prompt_hash", sa.String(64), nullable=True),
        sa.Column("evidence_hash", sa.String(64), nullable=True),
        sa.Column("schema_hash", sa.String(64), nullable=True),
        sa.Column("tariff_version", sa.String(128), nullable=True),
        sa.Column("tariff_effective_date", sa.Date(), nullable=True),
        sa.Column("tariff_rates", sa.JSON(), nullable=True),
        sa.Column("tariff_estimated_cost_usd", sa.Float(), nullable=True),
        sa.Column("tool_tariff_estimated_cost_usd", sa.Float(), nullable=True),
        sa.Column("tool_provider_billed_cost_usd", sa.Float(), nullable=True),
        sa.Column("provider_billed_cost_usd", sa.Float(), nullable=True),
        sa.Column("allocated_cost_usd", sa.Float(), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["job_id"], ["jobs.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("event_id"),
        sa.UniqueConstraint("attempt_id", "event_kind", name="uq_api_attempt_event_kind"),
        sa.UniqueConstraint("response_dedupe_key"),
        sa.UniqueConstraint("request_dedupe_key"),
    )
    op.create_index("ix_api_usage_attempt_events_attempt_id", "api_usage_attempt_events", ["attempt_id"])
    op.create_index("ix_api_usage_attempt_events_user_id", "api_usage_attempt_events", ["user_id"])
    op.create_index("ix_api_usage_attempt_events_job_id", "api_usage_attempt_events", ["job_id"])
    op.create_index("ix_api_usage_attempt_events_execution_id", "api_usage_attempt_events", ["execution_id"])
    op.create_index("ix_api_usage_attempt_events_run_id", "api_usage_attempt_events", ["run_id"])
    op.create_index("ix_api_usage_attempt_events_actual_provider", "api_usage_attempt_events", ["actual_provider"])
    op.create_index("ix_api_usage_attempt_events_started_at", "api_usage_attempt_events", ["started_at"])


def downgrade() -> None:
    op.drop_table("api_usage_attempt_events")
