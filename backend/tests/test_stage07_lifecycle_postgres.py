"""Disposable backend Docker PostgreSQL lifecycle fencing and migration proof."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from threading import Event
import json,os,subprocess,sys
from uuid import uuid4
import pytest
from sqlalchemy import create_engine,select,func,inspect
from sqlalchemy.orm import Session,sessionmaker
from sqlalchemy.ext.asyncio import create_async_engine,async_sessionmaker
from sqlalchemy.pool import NullPool
from sqlalchemy.schema import CreateSchema,DropSchema
URL='postgresql+psycopg2://stage07:stage07@postgres:5432/credx_stage07_test'
pytestmark=pytest.mark.skipif(os.getenv('CREDX_STAGE07_DATABASE_ACK')!='disposable-docker-only',reason='Named Stage07 backend Docker fixture only')

@pytest.fixture
def database(monkeypatch):
    assert Path('/.dockerenv').is_file() and os.environ['DATABASE_URL']==URL
    assert not Path('.env').exists() and not Path('backend/.env').exists()
    import app.models
    from app.infrastructure.database.base import Base
    from app.domains.auth.models import User,UserProfile
    from app.domains.modules.policy import DefaultFactsResolver,ModuleFacts
    monkeypatch.delenv('CREDX_UAT2',raising=False)
    monkeypatch.delenv('STAGE05_APPROVED_COST_ROLE_MIGRATION_IDS',raising=False)
    monkeypatch.delenv('COST_DASHBOARD_ADMIN_EMAILS',raising=False)
    monkeypatch.setattr(DefaultFactsResolver,'resolve_sync',lambda *_:ModuleFacts(jurisdiction='allowed',plan='allowed',connection='ready',execution_capability=True))
    root=create_engine(URL,poolclass=NullPool);schema='stage07_'+uuid4().hex
    with root.begin() as c:c.execute(CreateSchema(schema))
    engine=create_engine(URL,connect_args={'options':f'-csearch_path={schema} -c statement_timeout=5000 -c lock_timeout=3000'},poolclass=NullPool)
    Base.metadata.create_all(engine)
    factory=async_sessionmaker(create_async_engine(URL.replace('+psycopg2','+asyncpg'),poolclass=NullPool,
        connect_args={'server_settings':{'search_path':schema,'statement_timeout':'5000','lock_timeout':'3000'}}),expire_on_commit=False)
    with Session(engine) as s:
        u=User(email='owner@stage07.example.com',username='synthetic_owner',password_hash='unusable',is_active=True,is_verified=True,profile=UserProfile())
        s.add(u);s.commit();owner=u.id
    try:yield engine,factory,owner,schema
    finally:
        engine.dispose()
        with root.begin() as c:c.execute(DropSchema(schema,cascade=True))
        root.dispose()

async def patch(factory,owner,version,enabled):
    from app.domains.modules.service import patch_modules
    from app.domains.modules.schemas import ModulePatch
    async with factory() as s:
        return await patch_modules(s,owner,ModulePatch.model_validate({'expected_version':version,'updates':[{'module_id':'ai_studio','enabled':enabled}]}))

@pytest.mark.asyncio
async def test_disable_commit_prevents_later_effect_and_stale_worker(database):
    from app.domains.modules.lifecycle import effect_guard,WorkIdentity,ModuleLifecycleDenied
    engine,factory,owner,_=database
    await patch(factory,owner,0,True);await patch(factory,owner,1,False)
    with pytest.raises(ModuleLifecycleDenied):
        with effect_guard(sessionmaker(engine),WorkIdentity(owner,'ai_studio',1)):pytest.fail('Effect after disable')
    await patch(factory,owner,2,True)
    with pytest.raises(ModuleLifecycleDenied):
        with effect_guard(sessionmaker(engine),WorkIdentity(owner,'ai_studio',1)):pytest.fail('Stale worker after reenable')

@pytest.mark.asyncio
async def test_already_started_effect_linearizes_before_waiting_disable(database):
    from app.domains.modules.lifecycle import effect_guard,WorkIdentity
    engine,factory,owner,_=database;await patch(factory,owner,0,True)
    started=Event();release=Event();finished=Event();effects=[]
    def fake_effect():
        with effect_guard(sessionmaker(engine),WorkIdentity(owner,'ai_studio',1)):
            started.set();assert release.wait(2);effects.append('accepted-before-disable')
        finished.set()
    with ThreadPoolExecutor(max_workers=1) as pool:
        future=pool.submit(fake_effect);assert await asyncio.to_thread(started.wait,2)
        disabling=asyncio.create_task(patch(factory,owner,1,False))
        await asyncio.sleep(.1);assert not disabling.done()
        release.set();await disabling;future.result(timeout=2)
    assert finished.is_set() and effects==['accepted-before-disable']

@pytest.mark.asyncio
async def test_transactional_cancel_and_event_rollback_on_response_failure(database,monkeypatch):
    from app.domains.modules import service
    from app.domains.jobs.models import Job
    from app.infrastructure.database.outbox.models import OutboxMessage
    from app.shared.types import JobStatus
    engine,factory,owner,_=database;await patch(factory,owner,0,True)
    with Session(engine) as s:
        job=Job(user_id=owner,prompt='Synthetic',provider='synthetic',model='offline',status=JobStatus.PENDING,module_id='ai_studio',module_version=1)
        s.add(job);s.commit();id=job.id;before=s.scalar(select(func.count()).select_from(OutboxMessage))
    async def fail(*a,**kw):raise RuntimeError('synthetic response failure')
    monkeypatch.setattr(service,'describe',fail)
    with pytest.raises(RuntimeError):await patch(factory,owner,1,False)
    with Session(engine) as s:
        assert s.get(Job,id).status==JobStatus.PENDING and not s.get(Job,id).module_cancel_requested
        assert s.scalar(select(func.count()).select_from(OutboxMessage))==before


def test_actual_named_migration_preserves_prior_columns_rows_roles_and_roundtrip(database):
    engine,_,owner,schema=database
    from app.infrastructure.database.base import Base
    Base.metadata.drop_all(engine)
    env={**os.environ,'PGOPTIONS':f'-csearch_path={schema}'};backend=Path(__file__).resolve().parents[1]
    def migrate(direction,target):subprocess.run([sys.executable,'-m','alembic',direction,target],cwd=backend,env=env,check=True,capture_output=True,text=True,timeout=90)
    migrate('upgrade','user_modules_001')
    sys.path.insert(0,str(backend/'scripts'));from verify_api_attempt_migration import baseline_snapshot
    import sqlalchemy as sa
    metadata=sa.MetaData()
    with engine.begin() as c:
        metadata.reflect(c,only=['users','jobs','runs','user_module_preferences','user_modules'])
        now=datetime.utcnow()
        c.execute(metadata.tables['users'].insert().values(id=1,email='retained@stage07.example.com',username='retained',password_hash='unusable',role='USER',is_active=True,is_verified=True,created_at=now,updated_at=now))
        c.execute(metadata.tables['jobs'].insert().values(id=1,user_id=1,prompt='Retained synthetic output',provider='synthetic',model='offline',status='completed',response='Frozen history',created_at=now,updated_at=now))
        c.execute(metadata.tables['runs'].insert().values(id=1,user_id=1,prompt='Retained',prompt_preview='Retained',status='completed',auto_export_enabled=False,current_stage=1,created_at=now,updated_at=now))
        c.execute(metadata.tables['user_module_preferences'].insert().values(user_id=1,version=1,updated_at=now))
        c.execute(metadata.tables['user_modules'].insert().values(id=1,user_id=1,module_id='ai_studio',enabled=True,version=1,config={'schema_version':1}))
    before=baseline_snapshot(engine,exclude_tables=frozenset())
    migrate('upgrade','module_lifecycle_001')
    after=baseline_snapshot(engine,exclude_tables=frozenset())
    additions={'user_modules':{'schedules_paused':('BOOLEAN',False,'true')},'jobs':{'module_id':('VARCHAR(40)',True,None),'module_version':('INTEGER',True,None),'module_cancel_requested':('BOOLEAN',False,'false')},'runs':{'module_id':('VARCHAR(40)',True,None),'module_version':('INTEGER',True,None),'module_cancel_requested':('BOOLEAN',False,'false')}}
    additions['auto_rebalance_workflows']=additions['jobs']
    for table,columns in additions.items():
        existing={c[0] for c in before[table]['columns']};new={c[0]:tuple(c[1:]) for c in after[table]['columns'] if c[0] not in existing}
        assert new==columns
        after[table]['columns']=[c for c in after[table]['columns'] if c[0] in existing]
        checked=[]
        for encoded in after[table]['rows']:
            row=json.loads(encoded)
            for column in columns:
                value=row.pop(column)
                assert value is (True if column=='schedules_paused' else False) if column in {'schedules_paused','module_cancel_requested'} else value is None
            checked.append(json.dumps(row,sort_keys=True))
        after[table]['rows']=sorted(checked)
    assert before==after
    migrate('downgrade','user_modules_001');assert baseline_snapshot(engine,exclude_tables=frozenset())==before
    migrate('upgrade','module_lifecycle_001')
    assert {'module_id','module_version','module_cancel_requested'}<= {c['name'] for c in inspect(engine).get_columns('jobs')}


@pytest.mark.asyncio
async def test_dispatch_fence_and_late_broker_redelivery_after_disable(database):
    from app.domains.modules.lifecycle import ModuleLifecycleDenied,WorkIdentity,current_sync
    from app.infrastructure.database.outbox.job_dispatch import dispatch_due
    from app.infrastructure.database.outbox.models import OutboxMessage
    from app.domains.jobs.models import Job
    from app.shared.types import JobStatus
    engine,factory,owner,_=database;await patch(factory,owner,0,True)
    with Session(engine) as s:
        job=Job(user_id=owner,prompt='Fake dispatch race',provider='synthetic',model='offline',status=JobStatus.PENDING,module_id='ai_studio',module_version=1)
        s.add(job);s.flush();job_id=job.id
        s.add(OutboxMessage(topic='job.created.v2',payload={'job_id':job_id,'user_id':owner}));s.commit()
    started=Event();release=Event();packets=[]
    def publish(id,message):started.set();assert release.wait(2);packets.append(id)
    def dispatch():
        with Session(engine) as s:return dispatch_due(s,publish)
    with ThreadPoolExecutor(max_workers=1) as pool:
        future=pool.submit(dispatch);assert await asyncio.to_thread(started.wait,2)
        disabling=asyncio.create_task(patch(factory,owner,1,False));await asyncio.sleep(.1)
        assert not disabling.done();release.set();await disabling
        assert future.result(timeout=2)['published']==1
    assert packets==[job_id]
    with Session(engine) as s:
        assert s.get(Job,job_id).status==JobStatus.FAILED
        with pytest.raises(ModuleLifecycleDenied):current_sync(s,WorkIdentity(owner,'ai_studio',1))
        assert dispatch_due(s,lambda *_:pytest.fail('Late disabled redelivery'))['claimed']==0


@pytest.mark.asyncio
async def test_two_tabs_conflict_and_repeated_toggle_events_never_restart_history(database):
    from fastapi import HTTPException
    from app.domains.modules.lifecycle import apply_selection_event,TOPIC
    from app.infrastructure.database.outbox.models import OutboxMessage
    from app.domains.modules.models import UserModule,UserModulePreferences
    engine,factory,owner,_=database;await patch(factory,owner,0,True)
    async def tab(enabled):
        try:return await patch(factory,owner,1,enabled)
        except HTTPException as e:assert e.status_code==409;return 'conflict'
    results=await asyncio.gather(tab(False),tab(True));assert results.count('conflict')==1
    with Session(engine) as s:assert s.get(UserModulePreferences,owner).version==2
    await patch(factory,owner,2,False);await patch(factory,owner,3,True)
    with Session(engine) as s:
        events=s.scalars(select(OutboxMessage).where(OutboxMessage.topic==TOPIC).order_by(OutboxMessage.created_at.desc())).all()
        for event in [*events,*reversed(events)]:assert apply_selection_event(s,event)
        s.commit()
        row=s.scalar(select(UserModule).where(UserModule.user_id==owner,UserModule.module_id=='ai_studio'))
        assert row.enabled and row.schedules_paused and row.version==4

@pytest.mark.asyncio
async def test_sync_effect_lock_wait_is_bounded_without_factory_timeouts(database):
    import time
    from app.domains.modules.lifecycle import effect_guard,WorkIdentity,ModuleLifecycleDenied
    from app.domains.modules.models import UserModulePreferences
    engine,factory,owner,schema=database
    await patch(factory,owner,0,True)
    normal=create_engine(URL,connect_args={'options':f'-csearch_path={schema}'},poolclass=NullPool)
    try:
        with Session(engine) as blocker:
            blocker.scalar(select(UserModulePreferences).where(UserModulePreferences.user_id==owner).with_for_update())
            def attempt():
                started=time.monotonic()
                with pytest.raises(ModuleLifecycleDenied,match='fence busy'):
                    with effect_guard(sessionmaker(normal),WorkIdentity(owner,'ai_studio',1)):
                        pytest.fail('Contended effect started')
                return time.monotonic()-started
            elapsed=await asyncio.to_thread(attempt)
            assert 1.5<elapsed<4
    finally:normal.dispose()

@pytest.mark.asyncio
async def test_async_effect_lock_wait_keeps_event_loop_responsive(database):
    from app.domains.modules.lifecycle import async_effect_guard,WorkIdentity,ModuleLifecycleDenied
    from app.domains.modules.models import UserModulePreferences
    engine,factory,owner,_=database
    await patch(factory,owner,0,True)
    ticks=[]
    async def heartbeat():
        for _ in range(12):
            await asyncio.sleep(.1);ticks.append(True)
    with Session(engine) as blocker:
        blocker.scalar(select(UserModulePreferences).where(UserModulePreferences.user_id==owner).with_for_update())
        beat=asyncio.create_task(heartbeat())
        with pytest.raises(ModuleLifecycleDenied,match='fence busy'):
            async with async_effect_guard(factory,WorkIdentity(owner,'ai_studio',1)):
                pytest.fail('Contended async effect started')
        assert len(ticks)>=10
        await beat
