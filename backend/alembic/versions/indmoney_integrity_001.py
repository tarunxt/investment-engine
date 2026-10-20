"""Add owned preview/acceptance provenance without rewriting legacy snapshots."""
from alembic import op
import sqlalchemy as sa
revision='indmoney_integrity_001'
down_revision='connection_attempts_001'
branch_labels=depends_on=None

def upgrade():
    op.add_column('indmoney_us_portfolio_snapshots',sa.Column('acceptance_state',sa.String(24),nullable=False,server_default='legacy_unverified'))
    for name,kind in [('import_key',sa.String(64)),('content_hash',sa.String(64)),('import_provenance',sa.JSON()),('accepted_at',sa.DateTime(timezone=True)),('supersedes_id',sa.Integer())]:
        op.add_column('indmoney_us_portfolio_snapshots',sa.Column(name,kind,nullable=True))
    op.create_unique_constraint('uq_indmoney_owner_import','indmoney_us_portfolio_snapshots',['user_id','import_key'])
    op.create_foreign_key('fk_indmoney_correction','indmoney_us_portfolio_snapshots','indmoney_us_portfolio_snapshots',['supersedes_id'],['id'],ondelete='RESTRICT')

def downgrade():
    # Explicit rollback only; private Stage11 snapshot/provenance preservation is
    # required before a future approved controller cleanup. Never auto-run here.
    op.drop_constraint('fk_indmoney_correction','indmoney_us_portfolio_snapshots',type_='foreignkey')
    op.drop_constraint('uq_indmoney_owner_import','indmoney_us_portfolio_snapshots',type_='unique')
    for name in ['supersedes_id','accepted_at','import_provenance','content_hash','import_key','acceptance_state']:
        op.drop_column('indmoney_us_portfolio_snapshots',name)
