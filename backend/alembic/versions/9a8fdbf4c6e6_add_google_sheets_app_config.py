"""add google sheets app config

Revision ID: 9a8fdbf4c6e6
Revises: 067226f7ad9f
Create Date: 2026-05-31 13:36:31.550821

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '9a8fdbf4c6e6'
down_revision: Union[str, Sequence[str], None] = '067226f7ad9f'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table('google_sheets_app_configs',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('client_id', sa.String(length=255), nullable=False),
    sa.Column('client_secret_enc', sa.Text(), nullable=False),
    sa.Column('updated_by_user_id', sa.Integer(), nullable=True),
    sa.Column('created_at', sa.DateTime(), nullable=False),
    sa.Column('updated_at', sa.DateTime(), nullable=False),
    sa.ForeignKeyConstraint(['updated_by_user_id'], ['users.id'], ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_google_sheets_app_configs_updated_by_user_id'), 'google_sheets_app_configs', ['updated_by_user_id'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_google_sheets_app_configs_updated_by_user_id'), table_name='google_sheets_app_configs')
    op.drop_table('google_sheets_app_configs')
