"""Durable per-market rebalance spending scopes; no grants for old usage.

Revision ID: rebalance_spend_cap_001
Revises: recommendation_audit_001
"""
from alembic import op
import sqlalchemy as sa

revision = "rebalance_spend_cap_001"
down_revision = "recommendation_audit_001"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("rebalance_spend_scopes",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("portfolio", sa.String(32), nullable=False),
        sa.Column("cap_inr", sa.Numeric(24, 8), nullable=False),
        sa.Column("settled_inr", sa.Numeric(24, 8), nullable=False),
        sa.Column("reserved_inr", sa.Numeric(24, 8), nullable=False),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("policy_version", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("user_id", "portfolio", name="uq_rebalance_spend_owner_market"),
        sa.CheckConstraint("portfolio IN ('india', 'indmoney_us')", name="ck_rebalance_spend_market"),
        sa.CheckConstraint("cap_inr = 20 AND settled_inr >= 0 AND reserved_inr >= 0", name="ck_rebalance_spend_amounts"))
    op.create_table("rebalance_spend_bindings",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("scope_id", sa.Integer(), sa.ForeignKey("rebalance_spend_scopes.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("portfolio", sa.String(32), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.UniqueConstraint("user_id", "portfolio", "sequence", name="uq_rebalance_spend_workflow"),
        sa.CheckConstraint("sequence > 0", name="ck_rebalance_spend_sequence"))
    op.create_table("rebalance_spend_attempts",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("scope_id", sa.Integer(), sa.ForeignKey("rebalance_spend_scopes.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("job_id", sa.Integer(), sa.ForeignKey("jobs.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("attempt_key", sa.String(128), nullable=False),
        sa.Column("provider", sa.String(64), nullable=False),
        sa.Column("model", sa.String(128)),
        sa.Column("upper_inr", sa.Numeric(24, 8), nullable=False),
        sa.Column("actual_inr", sa.Numeric(24, 8)),
        sa.Column("tariff_version", sa.String(128), nullable=False),
        sa.Column("fx_version", sa.String(128), nullable=False),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("receipt", sa.String(255)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("scope_id", "attempt_key", name="uq_rebalance_spend_attempt"),
        sa.CheckConstraint("upper_inr > 0 AND (actual_inr IS NULL OR actual_inr >= 0)", name="ck_rebalance_attempt_amounts"))
    op.create_index("ix_rebalance_spend_attempts_scope_id", "rebalance_spend_attempts", ["scope_id"])


def downgrade():
    # Explicit migration rollback only; no runtime reset/automatic deletion.
    op.drop_index("ix_rebalance_spend_attempts_scope_id", table_name="rebalance_spend_attempts")
    op.drop_table("rebalance_spend_attempts")
    op.drop_table("rebalance_spend_bindings")
    op.drop_table("rebalance_spend_scopes")
