"""Add private versioned integration bindings; retain every legacy ciphertext."""
from uuid import NAMESPACE_URL,uuid5
from alembic import op
import sqlalchemy as sa
revision='integration_connections_001'
down_revision='module_lifecycle_001'
branch_labels=None
depends_on=None

def upgrade():
    op.create_table('integration_connections',
        sa.Column('id',sa.String(36),primary_key=True),sa.Column('owner_id',sa.Integer(),sa.ForeignKey('users.id',ondelete='CASCADE'),nullable=False),
        sa.Column('provider',sa.String(32),nullable=False),sa.Column('app_ownership_mode',sa.String(24),nullable=False),
        sa.Column('provider_account_id',sa.String(64),nullable=True),sa.Column('credential_ref',sa.String(100),nullable=True),
        sa.Column('token_expires_at',sa.DateTime(timezone=True),nullable=True),sa.Column('status',sa.String(32),nullable=False),
        sa.Column('version',sa.Integer(),nullable=False),sa.Column('is_current',sa.Boolean(),nullable=False),
        sa.Column('created_at',sa.DateTime(),nullable=False,server_default=sa.func.now()),sa.Column('updated_at',sa.DateTime(),nullable=False,server_default=sa.func.now()),
        sa.UniqueConstraint('id','owner_id',name='uq_connection_id_owner'),
        sa.CheckConstraint("app_ownership_mode IN ('user_owned','platform_managed')",name='ck_connection_mode'),sa.CheckConstraint('version > 0',name='ck_connection_version'))
    op.create_index('ix_integration_connections_owner_id','integration_connections',['owner_id'])
    op.create_index('uq_connection_current_owner_provider','integration_connections',['owner_id','provider'],unique=True,postgresql_where=sa.text('is_current = true'),sqlite_where=sa.text('is_current = 1'))
    op.create_table('connection_credentials',
        sa.Column('id',sa.String(36),primary_key=True),sa.Column('connection_id',sa.String(36),nullable=False),sa.Column('owner_id',sa.Integer(),nullable=False),
        sa.Column('ciphertext',sa.Text(),nullable=False),sa.Column('key_version',sa.Integer(),nullable=False),
        sa.Column('created_at',sa.DateTime(),nullable=False,server_default=sa.func.now()),sa.Column('updated_at',sa.DateTime(),nullable=False,server_default=sa.func.now()),
        sa.ForeignKeyConstraint(['connection_id','owner_id'],['integration_connections.id','integration_connections.owner_id'],ondelete='CASCADE'),
        sa.UniqueConstraint('connection_id',name='uq_connection_private_material'),sa.CheckConstraint('key_version > 0',name='ck_connection_key_version'))
    op.create_index('ix_connection_credentials_owner_id','connection_credentials',['owner_id'])
    bind=op.get_bind()
    # Metadata only: neither decrypt/copy secrets nor invent provider identity or
    # approval. Existing shared-app rows require explicit verified adoption.
    legacy=sa.table('zerodha_credentials',sa.column('id',sa.Integer()),sa.column('user_id',sa.Integer()),sa.column('expires_at',sa.DateTime(timezone=True)))
    target=sa.table('integration_connections',sa.column('id',sa.String()),sa.column('owner_id',sa.Integer()),sa.column('provider',sa.String()),sa.column('app_ownership_mode',sa.String()),sa.column('credential_ref',sa.String()),sa.column('token_expires_at',sa.DateTime(timezone=True)),sa.column('status',sa.String()),sa.column('version',sa.Integer()),sa.column('is_current',sa.Boolean()))
    for row in bind.execute(sa.select(legacy.c.id,legacy.c.user_id,legacy.c.expires_at)):
        bind.execute(target.insert().values(id=str(uuid5(NAMESPACE_URL,f'credx:zerodha:legacy:{row.user_id}:{row.id}')),owner_id=row.user_id,provider='zerodha',app_ownership_mode='platform_managed',credential_ref=f'legacy:zerodha:{row.id}',token_expires_at=row.expires_at,status='legacy_review',version=1,is_current=True))

def downgrade():
    op.drop_table('connection_credentials');op.drop_table('integration_connections')
