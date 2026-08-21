"""add run export tracking fields

Revision ID: ac4f4d3e1615
Revises: h3i4j5k6l7m8
Create Date: 2026-05-28 15:12:55.162616

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = 'ac4f4d3e1615'
down_revision: Union[str, Sequence[str], None] = 'h3i4j5k6l7m8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('runs', sa.Column('export_status', sa.Text(), nullable=True))
    op.add_column('runs', sa.Column('export_error', sa.Text(), nullable=True))
    op.add_column('runs', sa.Column('exported_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('runs', sa.Column('exported_sheet_url', sa.Text(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('runs', 'exported_sheet_url')
    op.drop_column('runs', 'exported_at')
    op.drop_column('runs', 'export_error')
    op.drop_column('runs', 'export_status')
