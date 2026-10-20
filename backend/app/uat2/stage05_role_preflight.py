"""Read-only Stage05 deployment evidence; never assigns a role or prints secrets."""
import json
import os
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from app.domains.auth.models import User, UserRole

LEGACY_EMAIL='tarun.singh6893@gmail.com'


def role_preflight(session: Session, extra_emails: str = '') -> dict:
    legacy={LEGACY_EMAIL,*(v.strip().lower() for v in extra_emails.split(',') if v.strip())}
    rows=session.execute(select(User.id,User.email,User.role,User.is_active,User.is_verified)
        .where(func.lower(User.email).in_(legacy))).all()
    matches=[row for row in rows if row.email.lower() in legacy]
    ambiguous=any(sum(row.email.lower()==email for row in matches)>1 for email in legacy)
    proposed=[row.id for row in matches if row.role!=UserRole.ADMIN]
    invalid=ambiguous or any(not row.is_active or not row.is_verified for row in matches if row.role!=UserRole.ADMIN)
    return {'mode':'read_only','current_roles':[{'id':r.id,'role':r.role.value,
                'active':r.is_active,'verified':r.is_verified} for r in matches],
            'proposed_cost_only_grant_ids':proposed,'global_admin_promotions':[],
            'ambiguous_or_invalid':invalid,
            'migration_without_role_change_safe':not invalid and not proposed,
            'specific_security_approval_required':bool(proposed) or invalid,
            'action':'STOP before migration if any proposed/ambiguous/invalid mapping; do not grant under genericStage05 authority'}


def main():
    if os.getenv('CREDX_UAT2')!='1' or os.getenv('CREDX_STAGE05_PREFLIGHT_READ_ONLY')!='1':
        raise SystemExit('Requires explicitly acknowledged existing UAT2 read-only execution')
    import app.models  # canonical relationship registry, no app startup/runtime
    from app.infrastructure.database.sync_session import sync_engine
    if sync_engine.dialect.name!='postgresql':
        raise SystemExit('Existing UAT2 PostgreSQL runtime required')
    with sync_engine.connect().execution_options(postgresql_readonly=True) as connection:
        with Session(bind=connection) as session:
            print(json.dumps(role_preflight(session,os.getenv('COST_DASHBOARD_ADMIN_EMAILS','')),indent=2))

if __name__=='__main__':main()
