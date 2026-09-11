"""add durable hourly rebalance status

Revision ID: 3d4e5f6a7b8c
Revises: 2c3d4e5f6a7b
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "3d4e5f6a7b8c"
down_revision: str | None = "2c3d4e5f6a7b"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "polymarket_auto_live_states",
        sa.Column("latest_hourly_rebalance_status", sa.String(length=32), nullable=True),
    )
    op.add_column(
        "polymarket_auto_live_states",
        sa.Column(
            "latest_hourly_rebalance_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )
    op.add_column(
        "polymarket_auto_live_states",
        sa.Column("latest_hourly_rebalance_detail", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column(
        "polymarket_auto_live_states", "latest_hourly_rebalance_detail"
    )
    op.drop_column("polymarket_auto_live_states", "latest_hourly_rebalance_at")
    op.drop_column("polymarket_auto_live_states", "latest_hourly_rebalance_status")
