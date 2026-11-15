"""merge auto-live console and dashboard holding heads

Revision ID: a4b5c6d7e8f9
Revises: x0y1z2a3b4c5, z3a4b5c6d7e8
Create Date: 2026-07-26 22:25:00.000000
"""

from typing import Sequence, Union


revision: str = "a4b5c6d7e8f9"
down_revision: Union[str, Sequence[str], None] = (
    "x0y1z2a3b4c5",
    "z3a4b5c6d7e8",
)
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Merge revision: both parent migrations have already applied their own DDL.
    pass


def downgrade() -> None:
    # Merge revision: rollback proceeds through the selected parent branch.
    pass
