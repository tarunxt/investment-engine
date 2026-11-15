"""add auto rebalance run labels

Revision ID: j2k3l4m5n6o7
Revises: 5b7c9d1e2f30
Create Date: 2026-06-09 00:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "j2k3l4m5n6o7"
down_revision: Union[str, Sequence[str], None] = "5b7c9d1e2f30"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    for table_name in ("runs", "jobs"):
        op.add_column(table_name, sa.Column("auto_rebalance_portfolio", sa.String(length=32), nullable=True))
        op.add_column(table_name, sa.Column("auto_rebalance_sequence", sa.Integer(), nullable=True))
        op.add_column(table_name, sa.Column("auto_rebalance_label", sa.String(length=64), nullable=True))
        op.create_index(
            f"ix_{table_name}_auto_rebalance_portfolio",
            table_name,
            ["auto_rebalance_portfolio"],
        )
        op.create_index(
            f"ix_{table_name}_auto_rebalance_sequence",
            table_name,
            ["auto_rebalance_sequence"],
        )


def downgrade() -> None:
    for table_name in ("jobs", "runs"):
        op.drop_index(f"ix_{table_name}_auto_rebalance_sequence", table_name=table_name)
        op.drop_index(f"ix_{table_name}_auto_rebalance_portfolio", table_name=table_name)
        op.drop_column(table_name, "auto_rebalance_label")
        op.drop_column(table_name, "auto_rebalance_sequence")
        op.drop_column(table_name, "auto_rebalance_portfolio")
