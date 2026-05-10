"""add prompt master columns

Revision ID: b2c3d4e5f6a7
Revises: a1b2c3d4e5f6
Create Date: 2026-05-10 13:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'b2c3d4e5f6a7'
down_revision: Union[str, Sequence[str], None] = 'a1b2c3d4e5f6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('prompts', sa.Column('user_id', sa.Integer(), sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True))
    op.add_column('prompts', sa.Column('description', sa.Text(), nullable=True))
    op.add_column('prompts', sa.Column('is_system', sa.Boolean(), nullable=False, server_default='false'))
    op.add_column('prompts', sa.Column('is_active', sa.Boolean(), nullable=False, server_default='true'))
    op.create_index(op.f('ix_prompts_user_id'), 'prompts', ['user_id'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_prompts_user_id'), table_name='prompts')
    op.drop_column('prompts', 'is_active')
    op.drop_column('prompts', 'is_system')
    op.drop_column('prompts', 'description')
    op.drop_column('prompts', 'user_id')
