"""Run only inside a backend container against a named disposable PostgreSQL."""
from contextlib import contextmanager
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
from uuid import uuid4

from alembic.migration import MigrationContext
from alembic.operations import Operations
import pytest
from sqlalchemy import create_engine, func, inspect, select
from sqlalchemy.orm import Session
from sqlalchemy.schema import CreateSchema, DropSchema

URL='postgresql+psycopg2://stage05:stage05@postgres:5432/credx_stage05_test'
pytestmark=pytest.mark.skipif(os.getenv('CREDX_STAGE05_DATABASE_ACK')!='disposable-docker-only',
                             reason='Named disposable Stage05 backend Docker test required')

@pytest.fixture
def database(monkeypatch):
    assert Path('/.dockerenv').is_file()
    assert os.environ['DATABASE_URL']==URL
    assert not Path('.env').exists()
    import app.models
    from app.domains.auth.models import User, ActivityLog
    root=create_engine(URL)
    schema='stage05_'+uuid4().hex
    with root.begin() as c:c.execute(CreateSchema(schema))
    engine=create_engine(URL,connect_args={'options':f'-csearch_path={schema}'})
    User.__table__.create(engine)
    ActivityLog.__table__.create(engine)
    monkeypatch.delenv('COST_DASHBOARD_ADMIN_EMAILS',raising=False)
    monkeypatch.delenv('STAGE05_APPROVED_COST_ROLE_MIGRATION_IDS',raising=False)
    try:yield engine
    finally:
        engine.dispose()
        with root.begin() as c:c.execute(DropSchema(schema,cascade=True))
        root.dispose()


def revision():
    spec=importlib.util.spec_from_file_location('stage05_revision',Path(__file__).resolve().parents[1]/'alembic/versions/admin_roles_001.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module


def apply(engine, direction='upgrade'):
    with engine.begin() as connection:
        with Operations.context(MigrationContext.configure(connection)):
            getattr(revision(),direction)()


def seed(engine, **overrides):
    from app.domains.auth.models import User, UserRole
    values=dict(email='tarun.singh6893@gmail.com',username='synthetic_'+uuid4().hex,
        password_hash='unusable',role=UserRole.USER,is_active=True,is_verified=True)
    values.update(overrides)
    with Session(engine) as session:
        user=User(**values);session.add(user);session.commit();return user.id


def test_equivalent_cost_scope_never_promotes_global_admin_and_audit_survives(database,monkeypatch):
    from app.domains.auth.models import User, UserRole, ActivityLog
    from app.domains.auth.admin_roles import AdministrativeRoleGrant
    user_id=seed(database)
    operator_id=seed(database,email='existing-operator@example.com',role=UserRole.ADMIN)
    monkeypatch.setenv('STAGE05_APPROVED_COST_ROLE_MIGRATION_IDS',str(user_id))
    apply(database)
    with Session(database) as s:
        assert s.get(User,user_id).role==UserRole.USER
        assert s.get(User,operator_id).role==UserRole.ADMIN
        grants=s.scalars(select(AdministrativeRoleGrant)).all()
        assert [(g.user_id,g.role) for g in grants]==[(user_id,'cost_dashboard_admin')]
        assert s.scalar(select(ActivityLog.action).where(ActivityLog.user_id==user_id))=='admin_role_migrated'
    apply(database,'downgrade')
    with Session(database) as s:assert len(s.scalars(select(ActivityLog)).all())==1
    apply(database)
    with Session(database) as s:assert len(s.scalars(select(ActivityLog)).all())==1


@pytest.mark.parametrize('case', ['no_approval','extra_id','wrong_id','invalid_id','inactive','unverified','ambiguous'])
def test_unproven_or_inactive_mapping_aborts_before_schema_or_role_change(database,monkeypatch,case):
    from app.domains.auth.models import User, UserRole, ActivityLog
    user_id=seed(database,is_active=case!='inactive',is_verified=case!='unverified')
    if case=='ambiguous':seed(database,email='TARUN.SINGH6893@gmail.com')
    approved={'no_approval':'','extra_id':f'{user_id},999','wrong_id':'999','invalid_id':'wrong'}.get(case,str(user_id))
    monkeypatch.setenv('STAGE05_APPROVED_COST_ROLE_MIGRATION_IDS',approved)
    with pytest.raises(RuntimeError):apply(database)
    assert 'administrative_role_grants' not in inspect(database).get_table_names()
    with Session(database) as s:
        assert s.get(User,user_id).role==UserRole.USER
        assert s.scalars(select(ActivityLog)).all()==[]


def test_existing_global_admin_remains_admin_without_new_grant(database):
    from app.domains.auth.models import User,UserRole
    from app.domains.auth.admin_roles import AdministrativeRoleGrant
    user_id=seed(database,role=UserRole.ADMIN)
    apply(database)
    with Session(database) as s:
        assert s.get(User,user_id).role==UserRole.ADMIN
        assert s.scalars(select(AdministrativeRoleGrant)).all()==[]


def test_exact_alembic_full_chain_roundtrip_in_container(database,monkeypatch):
    # A separate disposable schema avoids any mutation of other test fixtures.
    schema=database.url.query.get('options')
    with database.connect() as c: schema=c.scalar(select(func.current_schema()))
    # User/Activity fixture tables are removed only from this random test schema.
    from app.domains.auth.models import User,ActivityLog,UserRole
    ActivityLog.__table__.drop(database);User.__table__.drop(database)
    env={**os.environ,'PGOPTIONS':f'-csearch_path={schema}'}
    def alembic(*args):
        subprocess.run([sys.executable,'-m','alembic',*args],cwd=Path(__file__).resolve().parents[1],env=env,check=True,capture_output=True,text=True,timeout=60)
    alembic('upgrade','tenant_idempotency_001')
    owner=seed(database,role=UserRole.ADMIN)
    alembic('upgrade','head')
    with Session(database) as s:assert s.get(User,owner).role==UserRole.ADMIN
    assert 'administrative_role_grants' in inspect(database).get_table_names()
    alembic('downgrade','tenant_idempotency_001')
    assert 'administrative_role_grants' not in inspect(database).get_table_names()
    alembic('upgrade','head')
    with Session(database) as s:assert s.get(User,owner).role==UserRole.ADMIN
