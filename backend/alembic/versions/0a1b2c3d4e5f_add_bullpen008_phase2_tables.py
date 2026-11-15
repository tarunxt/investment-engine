"""add isolated Bullpen 008 Phase 2 action and execution tables

Revision ID: 0a1b2c3d4e5f
Revises: f9a0b1c2d3e4
Create Date: 2026-08-30 18:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0a1b2c3d4e5f"
down_revision: str | Sequence[str] | None = "f9a0b1c2d3e4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _timestamps() -> list[sa.Column]:
    return [
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    ]


def upgrade() -> None:
    op.create_table(
        "bullpen008_action_plans",
        sa.Column("id", sa.String(64), nullable=False),
        sa.Column("run_id", sa.String(64), nullable=False),
        sa.Column("workflow_profile", sa.String(64), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("stage4_certificate_hash", sa.String(64), nullable=False),
        sa.Column("plan_hash", sa.String(64), nullable=False),
        sa.Column("plan_certified", sa.Boolean(), nullable=False),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("account_identity", sa.String(255), nullable=True),
        sa.Column("wallet_version", sa.String(64), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("certified_at", sa.DateTime(timezone=True), nullable=True),
        *_timestamps(),
        sa.ForeignKeyConstraint(["run_id"], ["bullpen008_runs.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("run_id", "workflow_profile", name="uq_bullpen008_action_plan"),
        sa.UniqueConstraint("plan_hash", name="uq_bullpen008_action_plan_hash"),
    )
    op.create_index("ix_bullpen008_action_plans_run_id", "bullpen008_action_plans", ["run_id"])
    op.create_index("ix_bullpen008_action_plans_workflow_profile", "bullpen008_action_plans", ["workflow_profile"])

    op.create_table(
        "bullpen008_execution_intents",
        sa.Column("id", sa.String(64), nullable=False),
        sa.Column("run_id", sa.String(64), nullable=False),
        sa.Column("workflow_profile", sa.String(64), nullable=False),
        sa.Column("plan_id", sa.String(64), nullable=False),
        sa.Column("action_id", sa.String(64), nullable=False),
        sa.Column("action_type", sa.String(32), nullable=False),
        sa.Column("market_id", sa.String(500), nullable=False),
        sa.Column("condition_id", sa.String(255), nullable=True),
        sa.Column("side", sa.String(8), nullable=True),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("idempotency_key", sa.String(128), nullable=False),
        sa.Column("request_hash", sa.String(64), nullable=False),
        sa.Column("stage4_certificate_hash", sa.String(64), nullable=False),
        sa.Column("stage5_plan_hash", sa.String(64), nullable=False),
        sa.Column("attempt_count", sa.Integer(), nullable=False),
        sa.Column("remote_order_id", sa.String(255), nullable=True),
        sa.Column("remote_transaction_id", sa.String(255), nullable=True),
        sa.Column("filled_shares", sa.Float(), nullable=False),
        sa.Column("filled_value_usd", sa.Float(), nullable=False),
        sa.Column("average_price_cents", sa.Float(), nullable=True),
        sa.Column("fees_usd", sa.Float(), nullable=True),
        sa.Column("blocker_code", sa.String(96), nullable=True),
        sa.Column("failure_message", sa.Text(), nullable=True),
        sa.Column("retryable", sa.Boolean(), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("first_submitted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reconciled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("terminal_at", sa.DateTime(timezone=True), nullable=True),
        *_timestamps(),
        sa.ForeignKeyConstraint(["run_id"], ["bullpen008_runs.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["plan_id"], ["bullpen008_action_plans.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("workflow_profile", "action_id", name="uq_bullpen008_execution_action"),
        sa.UniqueConstraint("idempotency_key", name="uq_bullpen008_execution_idempotency"),
    )
    op.create_index("ix_bullpen008_execution_intents_run_id", "bullpen008_execution_intents", ["run_id"])
    op.create_index("ix_bullpen008_execution_intents_plan_id", "bullpen008_execution_intents", ["plan_id"])
    op.create_index("ix_bullpen008_execution_intents_workflow_profile", "bullpen008_execution_intents", ["workflow_profile"])
    op.create_index("ix_bullpen008_execution_intents_status", "bullpen008_execution_intents", ["status"])
    op.create_index("ix_bullpen008_execution_intents_run_status", "bullpen008_execution_intents", ["run_id", "status"])
    op.create_index("ix_bullpen008_execution_intents_remote_order", "bullpen008_execution_intents", ["remote_order_id"])

    op.create_table(
        "bullpen008_execution_attempts",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("intent_id", sa.String(64), nullable=False),
        sa.Column("attempt_number", sa.Integer(), nullable=False),
        sa.Column("request_hash", sa.String(64), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("result_status", sa.String(32), nullable=False),
        sa.Column("remote_order_id", sa.String(255), nullable=True),
        sa.Column("remote_transaction_id", sa.String(255), nullable=True),
        sa.Column("error_code", sa.String(96), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("sanitized_request", sa.JSON(), nullable=False),
        sa.Column("sanitized_response", sa.JSON(), nullable=False),
        sa.Column("reconciliation", sa.JSON(), nullable=False),
        *_timestamps(),
        sa.ForeignKeyConstraint(["intent_id"], ["bullpen008_execution_intents.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("intent_id", "attempt_number", name="uq_bullpen008_execution_attempt"),
    )
    op.create_index("ix_bullpen008_execution_attempts_intent_id", "bullpen008_execution_attempts", ["intent_id"])

    op.create_table(
        "bullpen008_execution_events",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("intent_id", sa.String(64), nullable=False),
        sa.Column("workflow_profile", sa.String(64), nullable=False),
        sa.Column("from_status", sa.String(32), nullable=True),
        sa.Column("to_status", sa.String(32), nullable=False),
        sa.Column("reason_code", sa.String(96), nullable=True),
        sa.Column("evidence", sa.JSON(), nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        *_timestamps(),
        sa.ForeignKeyConstraint(["intent_id"], ["bullpen008_execution_intents.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_bullpen008_execution_events_intent_id", "bullpen008_execution_events", ["intent_id"])
    op.create_index("ix_bullpen008_execution_events_workflow_profile", "bullpen008_execution_events", ["workflow_profile"])

    op.create_table(
        "bullpen008_alerts",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("workflow_profile", sa.String(64), nullable=False),
        sa.Column("market_id", sa.String(500), nullable=False),
        sa.Column("side", sa.String(8), nullable=False),
        sa.Column("source", sa.String(64), nullable=False),
        sa.Column("breach_type", sa.String(32), nullable=False),
        sa.Column("idempotency_key", sa.String(128), nullable=False),
        sa.Column("llm_odds", sa.Float(), nullable=True),
        sa.Column("actual_odds", sa.Float(), nullable=True),
        sa.Column("recovered_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("payload", sa.JSON(), nullable=False),
        *_timestamps(),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("workflow_profile", "idempotency_key", name="uq_bullpen008_alert_idempotency"),
    )
    op.create_index("ix_bullpen008_alerts_user_id", "bullpen008_alerts", ["user_id"])
    op.create_index("ix_bullpen008_alerts_workflow_profile", "bullpen008_alerts", ["workflow_profile"])
    op.create_index("ix_bullpen008_alerts_user_market", "bullpen008_alerts", ["user_id", "market_id", "created_at"])


def downgrade() -> None:
    op.drop_table("bullpen008_alerts")
    op.drop_table("bullpen008_execution_events")
    op.drop_table("bullpen008_execution_attempts")
    op.drop_table("bullpen008_execution_intents")
    op.drop_table("bullpen008_action_plans")
