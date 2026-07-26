"""add bounded Auto-Live console projections

Revision ID: x0y1z2a3b4c5
Revises: w9x0y1z2a3b
Create Date: 2026-07-26 20:10:00
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "x0y1z2a3b4c5"
down_revision: Union[str, Sequence[str], None] = "w9x0y1z2a3b"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "polymarket_auto_live_runs",
        sa.Column("console_projection", sa.JSON(), nullable=True),
    )
    op.add_column(
        "polymarket_auto_live_decisions",
        sa.Column("console_projection", sa.JSON(), nullable=True),
    )

    # Do not backfill here: production contains multi-gigabyte TOAST payloads,
    # so an all-row JSON rewrite in a release migration would create exactly
    # the CPU and lock pressure this projection is intended to remove. Existing
    # rows remain readable through the full detail endpoint and are explicitly
    # marked projection_available=false in compact reads. Every subsequent
    # normal run/decision save populates the additive projection.


def downgrade() -> None:
    op.drop_column("polymarket_auto_live_decisions", "console_projection")
    op.drop_column("polymarket_auto_live_runs", "console_projection")
