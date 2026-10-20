"""Durable tenant/operation request binding; existing jobs/outbox retained."""
from alembic import op
import sqlalchemy as sa

revision = 'tenant_idempotency_001'
down_revision = 'recommendation_audit_001'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('outbox', sa.Column('available_at', sa.DateTime(), nullable=True))
    op.add_column('outbox', sa.Column('execution_attempts', sa.Integer(), nullable=False, server_default='0'))
    op.create_table('idempotency_operations',
        sa.Column('id', sa.String(36), primary_key=True),
        sa.Column('user_id', sa.Integer(), sa.ForeignKey('users.id', ondelete='CASCADE'), nullable=False),
        sa.Column('operation', sa.String(100), nullable=False),
        sa.Column('key_digest', sa.String(64), nullable=False),
        sa.Column('request_digest', sa.String(64), nullable=False),
        sa.Column('job_id', sa.Integer(), sa.ForeignKey('jobs.id', ondelete='RESTRICT'), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.UniqueConstraint('user_id', 'operation', 'key_digest', name='uq_idempotency_owner_operation_key'))


def downgrade():
    op.drop_table('idempotency_operations')
    op.drop_column('outbox', 'execution_attempts')
    op.drop_column('outbox', 'available_at')
