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
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {column["name"] for column in inspector.get_columns("prompts")}
    indexes = {index["name"] for index in inspector.get_indexes("prompts")}

    if "user_id" not in columns:
        op.add_column('prompts', sa.Column('user_id', sa.Integer(), sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True))
    if "description" not in columns:
        op.add_column('prompts', sa.Column('description', sa.Text(), nullable=True))
    if "is_system" not in columns:
        op.add_column('prompts', sa.Column('is_system', sa.Boolean(), nullable=False, server_default='false'))
    if "is_active" not in columns:
        op.add_column('prompts', sa.Column('is_active', sa.Boolean(), nullable=False, server_default='true'))
    if op.f('ix_prompts_user_id') not in indexes:
        op.create_index(op.f('ix_prompts_user_id'), 'prompts', ['user_id'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_prompts_user_id'), table_name='prompts')
    op.drop_column('prompts', 'is_active')
    op.drop_column('prompts', 'is_system')
    op.drop_column('prompts', 'description')
    op.drop_column('prompts', 'user_id')
