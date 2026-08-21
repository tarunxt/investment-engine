"""add job web search fields

Revision ID: n7o8p9q0r1s2
Revises: m1n2o3p4q5r6
Create Date: 2026-06-23 00:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "n7o8p9q0r1s2"
down_revision: Union[str, Sequence[str], None] = "m1n2o3p4q5r6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("jobs", sa.Column("web_search_used", sa.Boolean(), nullable=True))
    op.add_column("jobs", sa.Column("web_search_queries", sa.JSON(), nullable=True))
    op.add_column("jobs", sa.Column("web_sources", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("jobs", "web_sources")
    op.drop_column("jobs", "web_search_queries")
    op.drop_column("jobs", "web_search_used")
