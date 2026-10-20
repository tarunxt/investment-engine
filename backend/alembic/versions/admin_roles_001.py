"""Replace existing cost-email exceptions with audited equivalent-scope roles.

No global ADMIN promotion or new identity. Ambiguity/unverified legacy matches
abort the transaction; runtime has no email exception or role-management API.
"""
import os
from datetime import datetime
from alembic import op
import sqlalchemy as sa

revision='admin_roles_001'
down_revision='tenant_idempotency_001'
branch_labels=None
depends_on=None
LEGACY_COST_EMAIL='tarun.singh6893@gmail.com'  # Historical compatibility, not runtime policy.
ROLE='cost_dashboard_admin'
SOURCE='stage05_legacy_cost_scope'


def upgrade():
    bind=op.get_bind()
    users=sa.table('users',sa.column('id',sa.Integer),sa.column('email',sa.String),
        sa.column('role',sa.String),sa.column('is_active',sa.Boolean),sa.column('is_verified',sa.Boolean))
    legacy={LEGACY_COST_EMAIL,*(v.strip().lower() for v in os.getenv('COST_DASHBOARD_ADMIN_EMAILS','').split(',') if v.strip())}
    candidates=list(bind.execute(sa.select(users).where(sa.func.lower(users.c.email).in_(legacy))).mappings())
    for email in legacy:
        matches=[u for u in candidates if u['email'].lower()==email]
        if len(matches)>1:raise RuntimeError('Stage05 legacy cost-admin mapping is ambiguous; security authorization required')
        if matches and matches[0]['role']!='ADMIN' and (not matches[0]['is_active'] or not matches[0]['is_verified']):
            raise RuntimeError('Stage05 legacy cost administrator is inactive/unverified; security authorization required')
    proposed={u['id'] for u in candidates if u['role']!='ADMIN'}
    raw=os.getenv('STAGE05_APPROVED_COST_ROLE_MIGRATION_IDS','')
    try:approved={int(v.strip()) for v in raw.split(',') if v.strip()}
    except ValueError:raise RuntimeError('Invalid Stage05 explicit cost-role authorization') from None
    if proposed!=approved:
        raise RuntimeError('Stage05 equivalent cost-role grants require independently verified explicit user-ID authorization; no live grant under generic Stage05 approval')
    grants=op.create_table('administrative_role_grants',
        sa.Column('id',sa.Integer,primary_key=True),
        sa.Column('user_id',sa.Integer,sa.ForeignKey('users.id',ondelete='CASCADE'),nullable=False),
        sa.Column('role',sa.String(40),nullable=False),sa.Column('source',sa.String(80),nullable=False),
        sa.Column('created_at',sa.DateTime,nullable=False),
        sa.UniqueConstraint('user_id','role',name='uq_administrative_role_user_scope'))
    audit=sa.table('activity_logs',sa.column('user_id',sa.Integer),sa.column('action',sa.String),
        sa.column('details',sa.Text),sa.column('created_at',sa.DateTime))
    for user in candidates:
        if not user['is_active'] or user['role']=='ADMIN':continue
        bind.execute(grants.insert().values(user_id=user['id'],role=ROLE,source=SOURCE,created_at=datetime.utcnow()))
        logged=bind.scalar(sa.select(sa.func.count()).select_from(audit).where(audit.c.user_id==user['id'],audit.c.action=='admin_role_migrated',audit.c.details==SOURCE))
        if not logged:bind.execute(audit.insert().values(user_id=user['id'],action='admin_role_migrated',details=SOURCE,created_at=datetime.utcnow()))


def downgrade():
    # Keep the durable migration audit. Operational rollback restores DB+source.
    op.drop_table('administrative_role_grants')
