"""add job event runtime metadata

Revision ID: p1q2r3s4t5u6
Revises: 602557c3ae1b, n7o8p9q0r1s2
Create Date: 2026-06-23 20:30:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "p1q2r3s4t5u6"
down_revision: Union[str, Sequence[str], None] = (
    "602557c3ae1b",
    "n7o8p9q0r1s2",
)
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column("jobs", sa.Column("request_context_json", sa.JSON(), nullable=True))
    op.add_column("jobs", sa.Column("runtime_metadata_json", sa.JSON(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("jobs", "runtime_metadata_json")
    op.drop_column("jobs", "request_context_json")
