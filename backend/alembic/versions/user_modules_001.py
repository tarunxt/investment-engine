"""Versioned optional module selection; default-deny absence, no opt-in backfill."""
from alembic import op
import sqlalchemy as sa

revision = 'user_modules_001'
down_revision = 'admin_roles_001'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table('user_module_preferences',
        sa.Column('user_id', sa.Integer, sa.ForeignKey('users.id', ondelete='CASCADE'), primary_key=True),
        sa.Column('version', sa.Integer, nullable=False),
        sa.Column('updated_at', sa.DateTime, nullable=False),
        sa.CheckConstraint('version >= 0', name='ck_user_module_preferences_version'))
    op.create_table('user_modules',
        sa.Column('id', sa.Integer, primary_key=True),
        sa.Column('user_id', sa.Integer, sa.ForeignKey('user_module_preferences.user_id', ondelete='CASCADE'), nullable=False),
        sa.Column('module_id', sa.String(40), nullable=False),
        sa.Column('enabled', sa.Boolean, nullable=False),
        sa.Column('config', sa.JSON, nullable=False),
        sa.Column('version', sa.Integer, nullable=False),
        sa.UniqueConstraint('user_id', 'module_id', name='uq_user_module_owner_id'),
        sa.CheckConstraint('version > 0', name='ck_user_module_version'))
    op.create_index('ix_user_modules_user_id', 'user_modules', ['user_id'])
    # No records are created: neither legacy flags nor another user's settings
    # establish verified module opt-in. New Google transactions need no writes.


def downgrade():
    op.drop_index('ix_user_modules_user_id', table_name='user_modules')
    op.drop_table('user_modules')
    op.drop_table('user_module_preferences')
