"""add job export tracking fields

Revision ID: 0ca009f851a5
Revises: ac4f4d3e1615
Create Date: 2026-05-28 17:36:33.705050

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '0ca009f851a5'
down_revision: Union[str, Sequence[str], None] = 'ac4f4d3e1615'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('jobs', sa.Column('export_status', sa.String(length=32), nullable=True))
    op.add_column('jobs', sa.Column('export_error', sa.Text(), nullable=True))
    op.add_column('jobs', sa.Column('exported_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('jobs', sa.Column('exported_sheet_url', sa.Text(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('jobs', 'exported_sheet_url')
    op.drop_column('jobs', 'exported_at')
    op.drop_column('jobs', 'export_error')
    op.drop_column('jobs', 'export_status')
