"""add job provider metadata

Revision ID: 8a9b4c5d6e7f
Revises: 7e2d653621be
Create Date: 2026-05-10 06:55:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '8a9b4c5d6e7f'
down_revision: Union[str, Sequence[str], None] = '7e2d653621be'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('jobs', sa.Column('error_message', sa.Text(), nullable=True))
    op.add_column('jobs', sa.Column('tokens_in', sa.Integer(), nullable=True))
    op.add_column('jobs', sa.Column('tokens_out', sa.Integer(), nullable=True))
    op.add_column('jobs', sa.Column('estimated_cost', sa.Float(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('jobs', 'estimated_cost')
    op.drop_column('jobs', 'tokens_out')
    op.drop_column('jobs', 'tokens_in')
    op.drop_column('jobs', 'error_message')
