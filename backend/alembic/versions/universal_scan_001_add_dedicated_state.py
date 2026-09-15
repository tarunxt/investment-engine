"""Add Universal Scan state independent of Bullpen Auto-Live.

Revision ID: universal_scan_001
Revises: sports_rankings_001
"""

from alembic import op
import sqlalchemy as sa


revision = "universal_scan_001"
down_revision = "sports_rankings_001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "universal_scan_settings",
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id"),
    )
    op.create_table(
        "universal_scan_states",
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id"),
    )
    op.execute(
        """
        INSERT INTO universal_scan_settings (user_id, payload, created_at, updated_at)
        SELECT user_id, payload, created_at, updated_at
        FROM polymarket_auto_live_settings
        WHERE payload -> 'universal_scan_auto_run' IS NOT NULL
        """
    )
    op.execute(
        """
        INSERT INTO universal_scan_states (user_id, payload, created_at, updated_at)
        SELECT user_id, payload, created_at, updated_at
        FROM polymarket_auto_live_states
        WHERE payload -> 'universal_scan_auto_run' IS NOT NULL
        """
    )


def downgrade() -> None:
    op.drop_table("universal_scan_states")
    op.drop_table("universal_scan_settings")
