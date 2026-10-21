"""Durable fake-only execution/reconciliation evidence; runtime stays disabled."""
from alembic import op
import sqlalchemy as sa

revision = 'order_execution_001'
down_revision = 'order_intents_001'
branch_labels = depends_on = None


def upgrade():
    op.create_table('order_execution_fences',
                    sa.Column('key', sa.String(180), primary_key=True),
                    sa.Column('stopped', sa.Boolean(), nullable=False))
    op.create_table('order_execution_runs',
                    sa.Column('intent_id', sa.String(36), sa.ForeignKey('confirmed_order_intents.id'), primary_key=True),
                    sa.Column('outbox_id', sa.String(36), nullable=False, unique=True),
                    sa.Column('binding_digest', sa.String(64), nullable=False),
                    sa.Column('approval_digest', sa.String(64), nullable=False),
                    sa.Column('started_at', sa.DateTime(timezone=True), nullable=False),
                    sa.Column('limits_json', sa.JSON(), nullable=False))
    op.create_table('order_execution_attempts',
                    sa.Column('leg_id', sa.String(36), sa.ForeignKey('confirmed_order_legs.id'), primary_key=True),
                    sa.Column('intent_id', sa.String(36), sa.ForeignKey('order_execution_runs.intent_id'), nullable=False),
                    sa.Column('binding_digest', sa.String(64), nullable=False),
                    sa.Column('state', sa.String(24), nullable=False),
                    sa.Column('claimed_at', sa.DateTime(timezone=True), nullable=False),
                    sa.Column('polls', sa.Integer(), nullable=False),
                    sa.Column('next_poll_at', sa.DateTime(timezone=True), nullable=False),
                    sa.Column('observed_at', sa.DateTime(timezone=True)),
                    sa.Column('evidence_json', sa.JSON()),
                    sa.Column('last_error', sa.String(80)),
                    sa.UniqueConstraint('leg_id', name='uq_execution_attempt_leg'),
                    sa.CheckConstraint('polls >= 0 AND polls <= 5', name='ck_execution_attempt_polls'))
    op.create_index('ix_order_execution_attempts_intent_id', 'order_execution_attempts', ['intent_id'])


def downgrade():
    if op.get_bind().scalar(sa.select(sa.func.count()).select_from(sa.table('order_execution_runs'))):
        raise RuntimeError('Execution evidence requires guarded backup/restore; downgrade refused')
    op.drop_table('order_execution_attempts')
    op.drop_table('order_execution_runs')
    op.drop_table('order_execution_fences')
