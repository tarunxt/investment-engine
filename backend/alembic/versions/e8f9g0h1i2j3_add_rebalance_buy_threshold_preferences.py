"""add rebalance buy threshold preferences

Revision ID: e8f9g0h1i2j3
Revises: d7e8f9g0h1i2
Create Date: 2026-08-23 18:30:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "e8f9g0h1i2j3"
down_revision: Union[str, Sequence[str], None] = "d7e8f9g0h1i2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "user_profiles",
        sa.Column(
            "zerodha_buy_threshold",
            sa.Float(),
            nullable=False,
            server_default=sa.text("2.5"),
        ),
    )
    op.add_column(
        "user_profiles",
        sa.Column(
            "indmoney_buy_threshold",
            sa.Float(),
            nullable=False,
            server_default=sa.text("2.5"),
        ),
    )


def downgrade() -> None:
    op.drop_column("user_profiles", "indmoney_buy_threshold")
    op.drop_column("user_profiles", "zerodha_buy_threshold")
