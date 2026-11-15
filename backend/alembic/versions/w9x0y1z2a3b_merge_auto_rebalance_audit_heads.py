"""merge auto-rebalance audit and active-run index heads

Revision ID: w9x0y1z2a3b
Revises: q2r3s4t5u6v, v8w9x0y1z2a
Create Date: 2026-07-24 00:00:00.000000
"""

from typing import Sequence, Union


revision: str = "w9x0y1z2a3b"
down_revision: Union[str, Sequence[str], None] = (
    "q2r3s4t5u6v",
    "v8w9x0y1z2a",
)
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Merge revision: both parent migrations have already applied their own DDL.
    pass


def downgrade() -> None:
    # Merge revision: rollback proceeds through the selected parent branch.
    pass
