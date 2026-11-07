"""Durable original-job execution fence, deadline and resource reservations.

Revision ID: rebalance_execution_003
Revises: rebalance_spend_refund_002
"""
from alembic import op
import sqlalchemy as sa

revision = "rebalance_execution_003"
down_revision = "rebalance_spend_refund_002"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("rebalance_executions",
        sa.Column("job_id", sa.Integer(), sa.ForeignKey("jobs.id", ondelete="RESTRICT"), primary_key=True),
        sa.Column("scope_id", sa.Integer(), sa.ForeignKey("rebalance_spend_scopes.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("fence_token", sa.String(36)),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("deadline_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("output_used", sa.Integer(), nullable=False),
        sa.Column("output_reserved", sa.Integer(), nullable=False),
        sa.Column("tools_used", sa.Integer(), nullable=False),
        sa.Column("tools_reserved", sa.Integer(), nullable=False),
        sa.CheckConstraint("output_used >= 0 AND output_reserved >= 0 AND tools_used >= 0 AND tools_reserved >= 0", name="ck_rebalance_execution_counts"))
    op.create_table("rebalance_resource_reservations",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("job_id", sa.Integer(), sa.ForeignKey("rebalance_executions.job_id", ondelete="RESTRICT"), nullable=False),
        sa.Column("attempt_key", sa.String(128), nullable=False),
        sa.Column("fence_token", sa.String(36), nullable=False),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("output_bound", sa.Integer(), nullable=False),
        sa.Column("tools_bound", sa.Integer(), nullable=False),
        sa.Column("output_actual", sa.Integer()),
        sa.Column("tools_actual", sa.Integer()),
        sa.UniqueConstraint("job_id", "attempt_key", name="uq_rebalance_resource_attempt"),
        sa.CheckConstraint("output_bound >= 0 AND output_bound <= 12000 AND (output_bound > 0 OR tools_bound > 0) AND tools_bound >= 0 AND tools_bound <= 4", name="ck_rebalance_resource_bounds"),
        sa.CheckConstraint("(output_actual IS NULL OR output_actual >= 0) AND (tools_actual IS NULL OR tools_actual >= 0)", name="ck_rebalance_resource_actuals"))


def downgrade():
    op.drop_table("rebalance_resource_reservations")
    op.drop_table("rebalance_executions")
