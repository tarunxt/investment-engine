"""Append-only settled INR refunds; never replenish workflow allowances.

Revision ID: rebalance_spend_refund_002
Revises: rebalance_spend_cap_001
"""
from alembic import op
import sqlalchemy as sa

revision = "rebalance_spend_refund_002"
down_revision = "rebalance_spend_cap_001"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("rebalance_spend_attempts", sa.Column("settlement_evidence_hash", sa.String(64), nullable=True))
    op.add_column("rebalance_spend_attempts", sa.Column("settlement_reference", sa.String(255), nullable=True))
    op.create_table("rebalance_spend_refunds",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("scope_id", sa.Integer(), sa.ForeignKey("rebalance_spend_scopes.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("attempt_id", sa.Integer(), sa.ForeignKey("rebalance_spend_attempts.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("refund_key", sa.String(128), nullable=False),
        sa.Column("amount_inr", sa.Numeric(24, 8), nullable=False),
        sa.Column("settlement_reference", sa.String(255), nullable=False),
        sa.Column("evidence_hash", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("scope_id", "refund_key", name="uq_rebalance_spend_refund"),
        sa.CheckConstraint("amount_inr > 0", name="ck_rebalance_refund_positive"))


def downgrade():
    op.drop_table("rebalance_spend_refunds")
    op.drop_column("rebalance_spend_attempts", "settlement_reference")
    op.drop_column("rebalance_spend_attempts", "settlement_evidence_hash")
