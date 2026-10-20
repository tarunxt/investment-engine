"""Mandatory Docker PostgreSQL callback race and additive migration acceptance.

Not claimed executed locally. Use the dedicated Stage10 CI job; no live DB URL.
"""
import asyncio,os,subprocess,sys
from pathlib import Path
import pytest
from sqlalchemy import select,inspect
from app.domains.connections.authorization import ConnectionAuthorization
from app.domains.connections.models import ConnectionAttempt
from app.domains.connections.service import ConnectionStore
from app.domains.connections.material import PlatformCredentialService,AppMaterial
from app.domains.connections.fake_authorization import FakeKiteAuthorization
from app.domains.connections.crypto import ConnectionFault
from pydantic import SecretStr
from test_stage09_connections_postgres import database

pytestmark=pytest.mark.skipif(os.getenv('CREDX_STAGE09_DATABASE_ACK')!='disposable-docker-only',reason='Named disposable backend Docker PostgreSQL only; mandatory Stage10 job rejects skips')
CALLBACK='http://localhost:54321/console/profile/connections'

@pytest.mark.asyncio
@pytest.mark.parametrize('mode',['user_owned','platform_managed'])
async def test_real_postgres_parallel_callbacks_exchange_once(database,mode):
    engine,factory,owner,schema,ring=database
    platform=PlatformCredentialService({('fake',1):AppMaterial(SecretStr('fake-key'),SecretStr('fake-secret'),'fake',1)},approved=True,approval_reference='synthetic-only')
    provider=FakeKiteAuthorization()
    def service(db):return ConnectionAuthorization(ConnectionStore(db,keyring=ring,platform=platform),provider,callback_url=CALLBACK,allowed_callbacks={CALLBACK})
    async with factory() as db:
        store=ConnectionStore(db,keyring=ring,platform=platform)
        kw={'app_key':'fake-key','app_secret':'fake-secret'} if mode=='user_owned' else {'platform_ref':'fake'}
        row=await store.provision(owner,mode=mode,**kw)
        attempt=await service(db).start(owner,row.id,1,'session-a')
    async def complete():
        async with factory() as db:
            try:return await service(db).callback(owner,attempt['attempt_id'],'session-a',state=attempt['state'],request_token='fake-ok')
            except ConnectionFault as exc:
                await db.rollback();return exc.code
    results=await asyncio.gather(complete(),complete())
    assert sum(isinstance(value,dict) and value.get('review_required') is True for value in results)==1
    assert 'CONNECTION_ATTEMPT_ALREADY_USED' in results and provider.exchanges==1
    async with factory() as db:
        stored=(await db.execute(select(ConnectionAttempt).where(ConnectionAttempt.id==attempt['attempt_id']))).scalar_one()
        assert stored.consumed_at and stored.candidate_ciphertext
        current=await ConnectionStore(db,keyring=ring,platform=platform).current(owner)
        assert current.version==1 and current.provider_account_id is None


def test_actual_stage10_migration_preserves_all_stage09_tables(database):
    engine,factory,_,schema,ring=database
    from app.infrastructure.database.base import Base
    Base.metadata.drop_all(engine)
    env={**os.environ,'PGOPTIONS':f'-csearch_path={schema}'}
    backend=Path(__file__).resolve().parents[1]
    def migrate(direction,target):subprocess.run([sys.executable,'-m','alembic',direction,target],cwd=backend,env=env,check=True,capture_output=True,text=True,timeout=90)
    migrate('upgrade','integration_connections_001')
    from app.domains.auth.models import User,UserProfile
    from sqlalchemy.orm import Session
    with Session(engine) as db:
        user=User(email='migration@stage10.example.invalid',username='synthetic_migration',password_hash='unusable',is_active=True,is_verified=True,profile=UserProfile())
        db.add(user);db.commit();seed_owner=user.id
    async def seed_binding():
        async with factory() as db:
            store=ConnectionStore(db,keyring=ring,platform=PlatformCredentialService())
            await store.provision(seed_owner,mode='user_owned',app_key='fake-preserved-key',app_secret='fake-preserved-secret')
    asyncio.run(seed_binding())
    sys.path.insert(0,str(backend/'scripts'))
    from verify_api_attempt_migration import baseline_snapshot
    before=baseline_snapshot(engine,exclude_tables=frozenset())
    for _ in range(2):
        migrate('upgrade','connection_attempts_001')
        assert 'connection_attempts' in inspect(engine).get_table_names()
        assert baseline_snapshot(engine,exclude_tables=frozenset({'connection_attempts','connection_binding_history'}))==before
        migrate('downgrade','integration_connections_001')
        assert 'connection_attempts' not in inspect(engine).get_table_names()
        assert baseline_snapshot(engine,exclude_tables=frozenset())==before


def test_postgres_mode_constraint_decompilations_have_identical_domain(database):
    """Exact two-form canonicalization must retain actual PostgreSQL rejection."""
    import importlib.util
    import sqlalchemy as sa
    from sqlalchemy.exc import IntegrityError,DataError
    engine,_,_,_,_=database
    path=Path(__file__).resolve().parents[2]/'deploy/uat2/native/schema_service.py'
    spec=importlib.util.spec_from_file_location('stage10_constraint_helper',path)
    helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
    catalogs=[]
    for index,expression in enumerate(helper.MODE_CHECK_FORMS):
        table=sa.Table('mode_contract_'+str(index),sa.MetaData(),
            sa.Column('app_ownership_mode',sa.String(24),nullable=False),
            sa.CheckConstraint(expression,name='ck_connection_mode'))
        table.create(engine)
        checks=sa.inspect(engine).get_check_constraints(table.name)
        assert checks[0]['sqltext'] in helper.MODE_CHECK_FORMS
        catalogs.append(helper.canonical_checks('integration_connections',checks))
        for value in ['user_owned','platform_managed']:
            with engine.begin() as db:db.execute(table.insert().values(app_ownership_mode=value))
        for value in ['other','USER_OWNED','',None,'real-money','x'*25]:
            with pytest.raises((IntegrityError,DataError)):
                with engine.begin() as db:db.execute(table.insert().values(app_ownership_mode=value))
    assert catalogs[0]==catalogs[1]
