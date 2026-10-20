"""Mandatory isolated backend-Docker PostgreSQL concurrency/migration checks."""
import asyncio
from datetime import datetime
import os
from pathlib import Path
import subprocess
import sys
from uuid import uuid4

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, func, inspect, select
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool
from sqlalchemy.schema import CreateSchema, DropSchema

URL='postgresql+psycopg2://stage06:stage06@postgres:5432/credx_stage06_test'
pytestmark=pytest.mark.skipif(os.getenv('CREDX_STAGE06_DATABASE_ACK')!='disposable-docker-only',
                             reason='Named disposable Stage06 backend Docker test required')


@pytest.fixture
def database(monkeypatch):
    assert Path('/.dockerenv').is_file()
    assert os.environ['DATABASE_URL']==URL
    assert not Path('.env').exists() and not Path('backend/.env').exists()
    import app.models
    from app.domains.auth.models import User, UserProfile, ActivityLog
    from app.domains.modules.models import UserModule, UserModulePreferences
    monkeypatch.delenv('CREDX_UAT2',raising=False)
    monkeypatch.delenv('COST_DASHBOARD_ADMIN_EMAILS',raising=False)
    monkeypatch.delenv('STAGE05_APPROVED_COST_ROLE_MIGRATION_IDS',raising=False)
    root=create_engine(URL)
    schema='stage06_'+uuid4().hex
    with root.begin() as c:c.execute(CreateSchema(schema))
    engine=create_engine(URL,connect_args={'options':f'-csearch_path={schema}'})
    from app.domains.jobs.models import Job
    from app.domains.runs.models import Run,RunJob,AutoRebalanceWorkflow,AutoRebalanceWorkflowStage
    from app.domains.prompts.models import Prompt
    from app.infrastructure.database.outbox.models import OutboxMessage
    for model in (User,UserProfile,ActivityLog,UserModulePreferences,UserModule,Prompt,Job,Run,RunJob,AutoRebalanceWorkflow,AutoRebalanceWorkflowStage,OutboxMessage):
        model.__table__.create(engine)
    with Session(engine) as s:
        users=[User(email=f'{name}@stage06.example.com',username=f'synthetic_{name}',
                    password_hash='unusable',is_active=True,is_verified=True,profile=UserProfile()) for name in ['a','b']]
        s.add_all(users);s.commit();ids=[u.id for u in users]
    factory=async_sessionmaker(create_async_engine(URL.replace('+psycopg2','+asyncpg'),
        connect_args={'server_settings':{'search_path':schema}},poolclass=NullPool),expire_on_commit=False)
    try:yield engine,factory,ids,schema
    finally:
        engine.dispose()
        with root.begin() as c:c.execute(DropSchema(schema,cascade=True))
        root.dispose()


@pytest.mark.asyncio
@pytest.mark.parametrize('initial_version',[0,1])
async def test_independent_transactions_have_one_winner_and_no_partial_rows(database,initial_version):
    from app.domains.modules.service import patch_modules
    from app.domains.modules.schemas import ModulePatch
    from app.domains.modules.models import UserModule,UserModulePreferences
    from app.domains.auth.models import ActivityLog
    engine,factory,ids,_=database
    owner=ids[0]
    if initial_version:
        async with factory() as s:
            await patch_modules(s,owner,ModulePatch.model_validate({'expected_version':0,
                'updates':[{'module_id':'sports_rankings','enabled':True}]}))
    # Both callers hold the same expected version, each with its own actual
    # PostgreSQL connection. The DB CAS/unique constraint arbitrates the race.
    async def patch(id):
        async with factory() as s:
            try:
                return await patch_modules(s,owner,ModulePatch.model_validate({'expected_version':initial_version,
                    'updates':[{'module_id':id,'enabled':True}]}))
            except HTTPException as exc:
                assert exc.status_code==409
                return 'conflict'
    results=await asyncio.gather(patch('market_scanner'),patch('ai_studio'))
    assert sum(r=='conflict' for r in results)==1
    winner=next(r for r in results if r!='conflict')
    assert winner['version']==initial_version+1
    with Session(engine) as s:
        assert s.get(UserModulePreferences,owner).version==initial_version+1
        rows=s.scalars(select(UserModule).where(UserModule.user_id==owner)).all()
        assert len(rows)==initial_version+1
        assert len({r.module_id for r in rows})==len(rows)
        assert s.scalar(select(func.count()).select_from(ActivityLog).where(ActivityLog.action=='module_preferences_updated'))==initial_version+1
        assert s.scalar(select(func.count()).select_from(UserModulePreferences).where(UserModulePreferences.user_id==ids[1]))==0


@pytest.mark.asyncio
async def test_all_or_nothing_unavailable_patch_leaves_no_header_or_audit(database):
    from app.domains.modules.service import patch_modules
    from app.domains.modules.schemas import ModulePatch
    from app.domains.modules.models import UserModulePreferences,UserModule
    from app.domains.auth.models import ActivityLog
    engine,factory,ids,_=database
    async with factory() as s:
        with pytest.raises(HTTPException) as exc:
            await patch_modules(s,ids[0],ModulePatch.model_validate({'expected_version':0,'updates':[
                {'module_id':'market_scanner','enabled':True},{'module_id':'bullpen_live','enabled':True}]}))
        assert exc.value.status_code==409
    with Session(engine) as s:
        for model in (UserModulePreferences,UserModule,ActivityLog):
            assert s.scalar(select(func.count()).select_from(model))==0


@pytest.mark.asyncio
async def test_google_first_signin_race_is_one_profile_and_no_optional_grants(database,monkeypatch):
    from app.domains.auth import google_signin
    from app.domains.auth.models import User,UserProfile,UserRole
    from app.domains.modules.models import UserModule,UserModulePreferences
    engine,factory,_,_=database
    monkeypatch.setattr(google_signin.PasswordUtils,'hash_password',lambda _value:'synthetic-unusable-hash')
    async def login():
        async with factory() as s:
            user=await google_signin.resolve_google_user(s,'concurrent.module.fixture@gmail.com')
            await s.commit()
            return user.id
    first,second=await asyncio.gather(login(),login())
    assert first==second
    with Session(engine) as s:
        assert s.scalar(select(func.count()).select_from(User).where(User.email=='concurrent.module.fixture@gmail.com'))==1
        assert s.scalar(select(func.count()).select_from(UserProfile).where(UserProfile.user_id==first))==1
        assert s.get(User,first).role==UserRole.USER
        assert s.scalar(select(func.count()).select_from(UserModulePreferences))==0
        assert s.scalar(select(func.count()).select_from(UserModule))==0


@pytest.mark.asyncio
async def test_failed_google_transaction_has_no_partial_user_profile_or_modules(database,monkeypatch):
    from app.domains.auth import google_signin
    from app.domains.auth.models import User,UserProfile
    from app.domains.modules.models import UserModule,UserModulePreferences
    engine,factory,_,_=database
    monkeypatch.setattr(google_signin.PasswordUtils,'hash_password',lambda _value:'synthetic-unusable-hash')
    async with factory() as s:
        user=await google_signin.resolve_google_user(s,'rollback.module.fixture@gmail.com')
        owner=user.id
        await s.rollback()
    with Session(engine) as s:
        assert s.get(User,owner) is None and s.get(UserProfile,owner) is None
        for model in (UserModulePreferences,UserModule):assert s.scalar(select(func.count()).select_from(model))==0


def test_named_migration_full_baseline_preservation_and_roundtrip(database):
    engine,_,_,schema=database
    from app.domains.auth.models import User,UserProfile,ActivityLog,UserRole
    from app.domains.modules.models import UserModule,UserModulePreferences
    # Only this generated fixture schema is cleared to test the actual chain.
    from app.domains.jobs.models import Job
    from app.domains.runs.models import Run,RunJob,AutoRebalanceWorkflow,AutoRebalanceWorkflowStage
    from app.domains.prompts.models import Prompt
    from app.infrastructure.database.outbox.models import OutboxMessage
    for model in (AutoRebalanceWorkflowStage,AutoRebalanceWorkflow,RunJob,Run,Job,Prompt,OutboxMessage,UserModule,UserModulePreferences,ActivityLog,UserProfile,User):model.__table__.drop(engine)
    env={**os.environ,'PGOPTIONS':f'-csearch_path={schema}'}
    backend=Path(__file__).resolve().parents[1]
    def migrate(direction,target):
        subprocess.run([sys.executable,'-m','alembic',direction,target],cwd=backend,env=env,
            check=True,capture_output=True,text=True,timeout=90)
    migrate('upgrade','admin_roles_001')
    with Session(engine) as s:
        user=User(email='retained-owner@stage06.example.com',username='retained_owner',password_hash='unusable',
            is_active=True,is_verified=True,role=UserRole.ADMIN,
            profile=UserProfile(timezone='Asia/Kolkata',zerodha_buy_threshold=3.5,
                google_sheets_master_url='https://example.invalid/owned-sheet'))
        s.add(user);s.commit();owner=user.id
    # Compare all prior tables/columns/indexes/constraints/data. Only the two
    # named additive06 tables are excluded, never existing columns or values.
    sys.path.insert(0,str(backend/'scripts'))
    from verify_api_attempt_migration import baseline_snapshot
    before=baseline_snapshot(engine,exclude_tables=frozenset())
    migrate('upgrade','user_modules_001')
    after=baseline_snapshot(engine,exclude_tables=frozenset({'user_modules','user_module_preferences'}))
    assert before==after
    with Session(engine) as s:
        assert s.get(User,owner).role==UserRole.ADMIN
        assert s.get(UserProfile,owner).timezone=='Asia/Kolkata'
        assert s.scalar(select(func.count()).select_from(UserModulePreferences))==0
        assert s.scalar(select(func.count()).select_from(UserModule))==0
    assert inspect(engine).get_unique_constraints('user_modules')[0]['column_names']==['user_id','module_id']
    migrate('downgrade','admin_roles_001')
    assert not inspect(engine).has_table('user_modules')
    assert not inspect(engine).has_table('user_module_preferences')
    assert baseline_snapshot(engine,exclude_tables=frozenset())==before
    migrate('upgrade','user_modules_001')
    assert baseline_snapshot(engine,exclude_tables=frozenset({'user_modules','user_module_preferences'}))==before


@pytest.mark.asyncio
async def test_post_flush_response_failure_rolls_back_actual_postgres(database,monkeypatch):
    from app.domains.modules import service
    from app.domains.modules.schemas import ModulePatch
    from app.domains.modules.models import UserModule,UserModulePreferences
    from app.domains.auth.models import ActivityLog
    engine,factory,ids,_=database
    async def fail(*args,**kwargs):raise RuntimeError('synthetic post-flush response failure')
    monkeypatch.setattr(service,'describe',fail)
    async with factory() as s:
        with pytest.raises(RuntimeError,match='synthetic post-flush'):
            await service.patch_modules(s,ids[0],ModulePatch.model_validate({'expected_version':0,
                'updates':[{'module_id':'sports_rankings','enabled':True}]}))
    with Session(engine) as s:
        for model in (UserModulePreferences,UserModule,ActivityLog):
            assert s.scalar(select(func.count()).select_from(model))==0


@pytest.mark.asyncio
async def test_reused_reader_refreshes_selection_after_other_transaction_disables(database):
    from app.domains.modules.service import patch_modules
    from app.domains.modules.schemas import ModulePatch
    from app.domains.modules.store import read_snapshot
    from app.domains.modules.registry import ModuleId
    _,factory,ids,_=database
    def change(version,enabled):
        return ModulePatch.model_validate({'expected_version':version,
            'updates':[{'module_id':'sports_rankings','enabled':enabled}]})
    async with factory() as writer:await patch_modules(writer,ids[0],change(0,True))
    async with factory() as reader:
        original=await read_snapshot(reader,ids[0]);assert original.selected(ModuleId.SPORTS_RANKINGS)
        async with factory() as writer:await patch_modules(writer,ids[0],change(1,False))
        current=await read_snapshot(reader,ids[0])
        assert current.version==2 and not current.selected(ModuleId.SPORTS_RANKINGS)
        assert current.rows[ModuleId.SPORTS_RANKINGS].version==2
