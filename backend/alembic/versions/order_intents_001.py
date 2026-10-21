"""Add durable payload-bound intents; no migration activates execution."""
from alembic import op
import sqlalchemy as sa
revision='order_intents_001'
down_revision='ai_limits_001'
branch_labels=depends_on=None

def upgrade():
    op.create_table('confirmed_order_intents',
        sa.Column('id',sa.String(36),primary_key=True),sa.Column('owner_id',sa.Integer(),sa.ForeignKey('users.id'),nullable=False),
        sa.Column('operation_key_digest',sa.String(64),nullable=False),sa.Column('request_digest',sa.String(64),nullable=False),
        sa.Column('connection_id',sa.String(36),nullable=False),sa.Column('connection_version',sa.Integer(),nullable=False),
        sa.Column('account_id',sa.String(64),nullable=False),sa.Column('app_mode',sa.String(24),nullable=False),
        sa.Column('module_id',sa.String(40),nullable=False),sa.Column('module_version',sa.Integer(),nullable=False),
        sa.Column('payload_json',sa.JSON(),nullable=False),sa.Column('risk_json',sa.JSON()),sa.Column('review_digest',sa.String(64)),
        sa.Column('state',sa.String(24),nullable=False),sa.Column('approval_digest',sa.String(64)),sa.Column('approval_nonce',sa.String(36)),
        sa.Column('approved_by',sa.Integer()),sa.Column('approved_at',sa.DateTime(timezone=True)),sa.Column('expires_at',sa.DateTime(timezone=True)),sa.Column('created_at',sa.DateTime(timezone=True),nullable=False),
        sa.UniqueConstraint('owner_id','operation_key_digest',name='uq_confirmed_order_operation'),
        sa.ForeignKeyConstraint(['connection_id','owner_id'],['integration_connections.id','integration_connections.owner_id']),
        sa.CheckConstraint('connection_version > 0 AND module_version > 0',name='ck_confirmed_order_versions'),
        sa.CheckConstraint("state IN ('draft','validated','awaiting_approval','approved','submitting','acknowledged','unknown','partial','filled','rejected','cancelled','invalidated')",name='ck_confirmed_order_state'))
    op.create_index('ix_confirmed_order_intents_owner_id','confirmed_order_intents',['owner_id'])
    op.create_table('confirmed_order_legs',sa.Column('id',sa.String(36),primary_key=True),sa.Column('intent_id',sa.String(36),sa.ForeignKey('confirmed_order_intents.id'),nullable=False),
        sa.Column('position',sa.Integer(),nullable=False),sa.Column('payload_digest',sa.String(64),nullable=False),sa.Column('client_reference',sa.String(64),nullable=False,unique=True),
        sa.Column('state',sa.String(24),nullable=False),sa.Column('broker_order_id',sa.String(100)),sa.Column('filled_quantity',sa.Integer(),nullable=False),sa.Column('reconciliation_json',sa.JSON()),
        sa.UniqueConstraint('intent_id','position',name='uq_confirmed_order_leg'),sa.CheckConstraint('position >= 0 AND filled_quantity >= 0',name='ck_confirmed_order_leg_values'))
    op.create_index('ix_confirmed_order_legs_intent_id','confirmed_order_legs',['intent_id'])

def downgrade():
    # Financial approval/effect evidence must never be silently discarded.
    if op.get_bind().scalar(sa.text('SELECT count(*) FROM confirmed_order_intents')):raise RuntimeError('Order intent evidence requires guarded backup/restore; downgrade refused')
    op.drop_table('confirmed_order_legs');op.drop_table('confirmed_order_intents')
