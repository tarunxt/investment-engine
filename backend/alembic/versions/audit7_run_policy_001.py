"""Freeze optional side-effect policy on new auto-rebalance workflows.

Revision ID: audit7_run_policy_001
Revises: recommendation_audit_001
"""
from alembic import op
import sqlalchemy as sa

revision = "audit7_run_policy_001"
down_revision = "recommendation_audit_001"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("auto_rebalance_workflows", sa.Column("side_effect_policy_json", sa.JSON(), nullable=True))


def downgrade():
    op.drop_column("auto_rebalance_workflows", "side_effect_policy_json")
