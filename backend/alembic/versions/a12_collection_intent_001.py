"""Add durable cost-collection admission. Runtime migration separately gated.

Revision ID: a12_collection_intent_001
Revises: audit7_run_policy_001
No migration or collector activation is authorized by this source change.
"""
from alembic import op
import sqlalchemy as sa

revision = "a12_collection_intent_001"
down_revision = "audit7_run_policy_001"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "cost_collection_intents",
        sa.Column("scope_key", sa.String(32), primary_key=True),
        sa.Column("owner_token", sa.String(32), nullable=False),
        sa.Column("state", sa.String(16), nullable=False),
        sa.Column("request_inflight", sa.Boolean(), nullable=False),
        sa.Column("request_sequence", sa.Integer(), nullable=False),
        sa.Column("started_at", sa.DateTime(), nullable=False),
        sa.Column("completed_at", sa.DateTime(), nullable=True),
        sa.Column("next_allowed_at", sa.DateTime(), nullable=False),
    )


def downgrade():
    # Never silently erase unresolved external acceptance or permit duplicate work.
    raise RuntimeError("Intent ledger removal requires separate operator reconciliation; automatic downgrade disabled")
