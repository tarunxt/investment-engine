"""Short-lived session-bound one-use authorization attempts; no legacy mutations."""
from alembic import op
import sqlalchemy as sa
revision = 'connection_attempts_001'
down_revision = 'integration_connections_001'
branch_labels = depends_on = None

def upgrade():
    op.create_table('connection_attempts',
        sa.Column('id', sa.String(36), primary_key=True),
        sa.Column('owner_id', sa.Integer(), nullable=False),
        sa.Column('connection_id', sa.String(36), nullable=False),
        sa.Column('connection_version', sa.Integer(), nullable=False),
        sa.Column('app_mode', sa.String(24), nullable=False),
        sa.Column('app_fingerprint', sa.String(64), nullable=False),
        sa.Column('session_digest', sa.String(64), nullable=False),
        sa.Column('state_digest', sa.String(64), nullable=False, unique=True),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('consumed_at', sa.DateTime(timezone=True)),
        sa.Column('review_completed_at', sa.DateTime(timezone=True)),
        sa.Column('candidate_ciphertext', sa.Text()),
        sa.Column('candidate_key_version', sa.Integer()),
        sa.Column('created_at', sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(['connection_id','owner_id'], ['integration_connections.id','integration_connections.owner_id'], ondelete='CASCADE'),
        sa.CheckConstraint('connection_version > 0', name='ck_attempt_connection_version'))
    op.create_index('ix_connection_attempts_owner_id','connection_attempts',['owner_id'])
    op.create_table('connection_binding_history',
        sa.Column('id',sa.String(36),primary_key=True),sa.Column('connection_id',sa.String(36),nullable=False),
        sa.Column('owner_id',sa.Integer(),nullable=False),sa.Column('connection_version',sa.Integer(),nullable=False),
        sa.Column('app_mode',sa.String(24),nullable=False),sa.Column('provider_account_id',sa.String(64),nullable=False),
        sa.Column('ciphertext',sa.Text(),nullable=False),sa.Column('key_version',sa.Integer(),nullable=False),
        sa.Column('created_at',sa.DateTime(),nullable=False,server_default=sa.func.now()),
        sa.Column('updated_at',sa.DateTime(),nullable=False,server_default=sa.func.now()),
        sa.ForeignKeyConstraint(['connection_id','owner_id'],['integration_connections.id','integration_connections.owner_id'],ondelete='CASCADE'),
        sa.UniqueConstraint('connection_id','connection_version',name='uq_binding_history_version'))
    op.create_index('ix_connection_binding_history_owner_id','connection_binding_history',['owner_id'])


def downgrade():
    # Controller must privately preserve Stage10 attempt/history material first.
    # Existing Stage09 connection identities and ciphertext tables remain.
    op.drop_table('connection_binding_history')
    op.drop_table('connection_attempts')
