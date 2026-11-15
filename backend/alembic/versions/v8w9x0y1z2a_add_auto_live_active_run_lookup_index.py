"""add Auto-Live active run lookup index

Revision ID: v8w9x0y1z2a
Revises: u7v8w9x0y1z2
Create Date: 2026-07-23 00:00:00.000000
"""

from typing import Sequence, Union

from alembic import op


revision: str = "v8w9x0y1z2a"
down_revision: Union[str, Sequence[str], None] = "u7v8w9x0y1z2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_index(
        "ix_polymarket_auto_live_runs_user_status_started_at",
        "polymarket_auto_live_runs",
        ["user_id", "status", "started_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_polymarket_auto_live_runs_user_status_started_at",
        table_name="polymarket_auto_live_runs",
    )
