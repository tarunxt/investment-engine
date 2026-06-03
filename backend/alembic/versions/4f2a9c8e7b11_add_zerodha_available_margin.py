"""add zerodha available margin

Revision ID: 4f2a9c8e7b11
Revises: 9a8fdbf4c6e6
Create Date: 2026-06-03 00:00:00.000000
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "4f2a9c8e7b11"
down_revision: Union[str, Sequence[str], None] = "9a8fdbf4c6e6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "zerodha_portfolio_snapshots",
        sa.Column("available_margin", sa.Float(), nullable=False, server_default="0"),
    )
    op.alter_column("zerodha_portfolio_snapshots", "available_margin", server_default=None)


def downgrade() -> None:
    op.drop_column("zerodha_portfolio_snapshots", "available_margin")
