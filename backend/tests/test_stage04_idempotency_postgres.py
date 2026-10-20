"""Mandatory disposable Docker PostgreSQL/Redis failure and concurrency gate."""
import asyncio
from contextlib import contextmanager
from dataclasses import replace
from datetime import datetime, timedelta, timezone
import os
from pathlib import Path
import shutil
import socket
import subprocess
import time
from uuid import UUID, uuid4

import pytest
from sqlalchemy import create_engine, func, select, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import NullPool
from sqlalchemy.schema import CreateSchema, DropSchema

URL = 'postgresql+psycopg2://stage04:stage04@postgres:5432/credx_stage04_test'
pytestmark = pytest.mark.skipif(os.getenv('CREDX_STAGE04_DATABASE_ACK') != 'disposable-docker-only',
                               reason='Dedicated disposable Stage04 Docker database not supplied')


@pytest.fixture
def database(monkeypatch):
    assert Path('/.dockerenv').is_file()
    assert os.environ['CREDX_STAGE04_DATABASE_URL'] == URL
    assert not Path('backend/.env').exists() and not Path('.env').exists()
    import app.models
    from app.core.config import settings
    from app.domains.auth.models import User, UserProfile, ActivityLog
    from app.domains.jobs.models import Job
    from app.infrastructure.database.outbox.models import OutboxMessage
    from app.infrastructure.messaging.operation_models import IdempotencyOperation
    monkeypatch.setattr(settings, 'environment', 'test')
    monkeypatch.delenv('CREDX_UAT2', raising=False)
    monkeypatch.setenv('CREDX_RECOVERY_MODE', '0')
    base = create_engine(URL)
    schema = 'stage04_' + uuid4().hex
    with base.begin() as c: c.execute(CreateSchema(schema))
    engine = base.execution_options(schema_translate_map={None:schema})
    from app.domains.modules.models import UserModule,UserModulePreferences
    from app.domains.modules.policy import DefaultFactsResolver,ModuleFacts
    monkeypatch.setattr(DefaultFactsResolver,'resolve_sync',lambda *_:ModuleFacts(jurisdiction='allowed',plan='allowed',connection='ready',execution_capability=True))
    for m in (User, UserProfile, ActivityLog,UserModulePreferences,UserModule, Job, OutboxMessage, IdempotencyOperation):
        m.__table__.create(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    with factory() as s:
        s.add_all([User(id=i, email=f'synthetic-{i}@invalid.test', username=f'synthetic-{i}',
                   password_hash='not-a-login-credential', is_active=True, is_verified=True) for i in (1,2)])
        s.flush()
        for owner in (1,2):s.add(UserModulePreferences(user_id=owner,version=1,updated_at=datetime.utcnow()))
        s.flush()
        for owner in (1,2):
            for module in ('ai_studio','zerodha_rebalance','indmoney_us'):
                s.add(UserModule(user_id=owner,module_id=module,enabled=True,version=1,config={'schema_version':1},schedules_paused=False))
        s.commit()
    ae = create_async_engine(URL.replace('postgresql+psycopg2', 'postgresql+asyncpg'),
                             execution_options={'schema_translate_map':{None:schema}}, poolclass=NullPool)
    af = async_sessionmaker(ae, expire_on_commit=False)
    yield engine, factory, af
    asyncio.run(ae.dispose())
    with base.begin() as c: c.execute(DropSchema(schema, cascade=True))
    base.dispose()


def command(**changes):
    from app.domains.jobs.use_cases.create_job import CreateJobCommand
    return CreateJobCommand(prompt='private synthetic request', provider='fake', model='offline',
                            user_id=1, idempotency_key='same-key', **changes)


async def create(factory, cmd):
    from app.domains.jobs.use_cases.create_job import CreateJobUseCase
    from app.infrastructure.messaging.event_bus import EventBus
    async with factory() as s:
        return await CreateJobUseCase(s, EventBus()).execute(cmd)


def test_twenty_concurrent_equal_requests_create_one_operation(database):
    engine, factory, af = database
    async def race(): return await asyncio.gather(*(create(af, command()) for _ in range(20)))
    results = asyncio.run(race())
    assert len({r.job_id for r in results}) == 1
    from app.domains.jobs.models import Job
    from app.infrastructure.database.outbox.models import OutboxMessage
    from app.infrastructure.messaging.operation_models import IdempotencyOperation
    with factory() as s:
        for model in (Job, OutboxMessage, IdempotencyOperation):
            assert s.scalar(select(func.count()).select_from(model)) == 1


def test_concurrent_conflicts_and_owner_operation_scopes(database):
    _, factory, af = database
    from app.shared.exceptions import ConflictException
    async def race():
        return await asyncio.gather(create(af, command()),
            create(af, replace(command(), prompt='different full payload')), return_exceptions=True)
    results = asyncio.run(race())
    assert sum(isinstance(r, ConflictException) and r.status_code == 409 for r in results) == 1
    async def independent():
        return await asyncio.gather(create(af, replace(command(), user_id=2)),
            create(af, replace(command(), operation='zerodha.events.create')))
    separate = asyncio.run(independent())
    assert len({r.job_id for r in separate} | {r.job_id for r in results if not isinstance(r, Exception)}) == 3


def test_full_digest_normalizes_equivalent_utc_dates_and_rechecks_owner(database):
    _, factory, af = database
    from app.domains.jobs.models import Job
    from app.shared.exceptions import ConflictException
    utc = datetime.now(timezone.utc) + timedelta(days=1)
    first = asyncio.run(create(af, replace(command(), scheduled_at=utc)))
    async def again(): return await create(af, replace(command(), scheduled_at=utc.astimezone(timezone(timedelta(hours=5, minutes=30)))))
    assert asyncio.run(again()).job_id == first.job_id
    for changed in [replace(command(), scheduled_at=utc, model='different'),
                    replace(command(), scheduled_at=utc, auto_rebalance_sequence=2),
                    replace(command(), scheduled_at=utc, prompt=command().prompt+'x')]:
        with pytest.raises(ConflictException): asyncio.run(create(af, changed))
    with factory() as s:
        s.execute(update(Job).where(Job.id==first.job_id).values(user_id=2)); s.commit()
    with pytest.raises(ConflictException, match='unavailable'):
        asyncio.run(again())


def test_failed_transaction_does_not_leave_binding_or_job(database):
    _, factory, af = database
    from app.domains.jobs.use_cases.create_job import CreateJobUseCase
    from app.infrastructure.messaging.event_bus import EventBus
    from app.infrastructure.messaging.idempotency import IdempotencyStore
    from app.domains.jobs.models import Job
    from app.infrastructure.database.outbox.models import OutboxMessage
    from app.infrastructure.messaging.operation_models import IdempotencyOperation
    class CrashBeforeCommit(IdempotencyStore):
        async def bind(self, **values):
            await super().bind(**values)
            raise RuntimeError('synthetic precommit crash')
    async def crash():
        async with af() as s:
            with pytest.raises(RuntimeError, match='precommit'):
                await CreateJobUseCase(s, EventBus(), idempotency=CrashBeforeCommit(s)).execute(command())
            await s.rollback()
    asyncio.run(crash())
    with factory() as s:
        for model in (Job, OutboxMessage, IdempotencyOperation): assert s.scalar(select(func.count()).select_from(model)) == 0
    assert asyncio.run(create(af, command())).job_id


@contextmanager
def redis_process(directory):
    import redis
    assert shutil.which('redis-server'), 'Real Redis binary required, not skipped'
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0)); port=sock.getsockname()[1]
    client=redis.Redis(host='127.0.0.1',port=port,db=15,socket_connect_timeout=.2,socket_timeout=.5)
    process=None
    def start():
        nonlocal process
        process=subprocess.Popen(['redis-server','--bind','127.0.0.1','--port',str(port),
            '--save','','--appendonly','no','--dir',str(directory),'--logfile',str(directory/'redis.log')],
            stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        deadline=time.monotonic()+5
        while time.monotonic()<deadline:
            try:
                if client.ping(): return
            except redis.RedisError: time.sleep(.03)
        raise AssertionError('Disposable Redis did not start')
    def stop():
        if process and process.poll() is None:
            process.terminate(); process.wait(timeout=5)
    start()
    try: yield client, f'redis://127.0.0.1:{port}/15', start, stop
    finally: stop(); client.close()


def test_commit_before_dispatch_redis_restart_and_duplicate_real_celery_delivery(database, tmp_path, monkeypatch):
    from celery import Celery, _state
    from celery.contrib.testing.worker import start_worker
    from app.domains.jobs import tasks
    from app.domains.jobs.models import Job
    from app.infrastructure.database.outbox.models import OutboxMessage
    from app.infrastructure.database.outbox.job_dispatch import dispatch_due
    from app.infrastructure.messaging.job_delivery import guarded_job_delivery, job_delivery_guard
    from app.shared.types import JobStatus
    engine, factory, af = database
    monkeypatch.setattr(tasks, 'SyncSessionLocal', factory)
    # The registered outer lifecycle wrapper resolves this canonical factory.
    # Keep both layers on this test's private schema, preserving real admission.
    monkeypatch.setattr('app.infrastructure.database.sync_session.SyncSessionLocal',factory)
    job_id=asyncio.run(create(af, command())).job_id  # Crash after commit: no dispatcher ran.
    with factory() as s:
        message_id=str(s.scalar(select(OutboxMessage.id)))
        assert s.get(Job,job_id).status==JobStatus.PENDING
    calls=[]
    old_current,old_default=_state.get_current_app(),_state.default_app
    with redis_process(tmp_path) as (redis, url, start, stop):
        app=Celery('stage04-isolated-'+uuid4().hex,broker=url,backend='cache+memory://',set_as_current=False)
        queue='stage04-fixture-'+uuid4().hex
        app.conf.update(task_default_queue=queue, task_default_exchange=queue, task_default_routing_key=queue,
                        task_serializer='json',accept_content=['json'],worker_prefetch_multiplier=1,
                        broker_transport_options={'socket_connect_timeout':.2,'socket_timeout':.5},
                        broker_connection_retry_on_startup=True,task_acks_late=True)
        @app.task(bind=True,name='stage04.fake.'+uuid4().hex,shared=False,lazy=False)
        @guarded_job_delivery
        def fake(self, job_id):
            calls.append(job_id)
            time.sleep(.15)  # Two broker deliveries overlap the same SQL guard.
            with factory() as s:
                s.execute(update(Job).where(Job.id==job_id).values(status=JobStatus.COMPLETED,response='synthetic fake result'))
                s.commit()
        def publish(jid, did):
            with app.connection_for_write(connect_timeout=.2) as connection:
                for _ in range(2): fake.apply_async(args=[jid],kwargs={'dispatch_id':did},connection=connection,retry=False)
        try:
            redis.set('idem:same-key', '{"job_id":999999}')
            redis.set('idem:job:1:same-key', '{"job_id":999999}')
            assert asyncio.run(create(af, command())).job_id==job_id
            stop()  # Real process loss; the database operation/result survives.
            assert asyncio.run(create(af, command())).job_id==job_id
            now=datetime.utcnow()
            with factory() as s: assert dispatch_due(s,publish,now=now)['failed']==1
            start()
            assert redis.get('idem:same-key') is None and redis.get('idem:job:1:same-key') is None
            with factory() as s: assert dispatch_due(s,publish,now=now+timedelta(seconds=31))['published']==1
            redis.flushdb()  # Simulate an accepted-but-lost queue before receipt.
            with start_worker(app,perform_ping_check=False,pool='threads',concurrency=2,shutdown_timeout=10,queues=[queue]):
                with factory() as s: assert dispatch_due(s,publish,now=now+timedelta(seconds=62))['published']==1
                deadline=time.monotonic()+10
                while time.monotonic()<deadline:
                    with factory() as s:
                        if s.get(Job,job_id).status==JobStatus.COMPLETED: break
                    time.sleep(.05)
                assert calls==[job_id]
                tasks.execute_ai_job.run(job_id,dispatch_id=message_id)  # Real task skips terminal replay.
                assert calls==[job_id]
            with factory() as s:
                assert s.get(Job,job_id).status==JobStatus.COMPLETED
                assert dispatch_due(s,publish,now=now+timedelta(seconds=200))['claimed']==0
            with job_delivery_guard(factory,job_id,str(uuid4())) as allowed: assert not allowed
            with engine.begin() as c: assert c.scalar(select(func.pg_try_advisory_xact_lock(1128943426,job_id)))
        finally:
            _state._set_current_app(old_current);_state.set_default_app(old_default);app.close()


def test_relay_scheduling_legacy_rows_owner_mismatch_and_guard_release(database):
    from app.domains.jobs.models import Job
    from app.infrastructure.database.outbox.models import OutboxMessage
    from app.infrastructure.database.outbox.job_dispatch import dispatch_due
    from app.infrastructure.messaging.job_delivery import job_delivery_guard
    from app.shared.types import JobStatus
    engine,factory,af=database
    now=datetime.utcnow()
    future=asyncio.run(create(af, replace(command(),scheduled_at=(now+timedelta(days=1)).replace(tzinfo=timezone.utc)))).job_id
    with factory() as s:
        old=Job(user_id=1,prompt='old legacy',provider='fake',model='fake',status=JobStatus.PENDING);s.add(old);s.flush()
        s.add_all([OutboxMessage(topic='job.created',payload={'job_id':old.id}),
                   OutboxMessage(topic='job.created.v2',payload={'job_id':old.id,'user_id':2})]);s.commit()
        assert dispatch_due(s,lambda *_:pytest.fail('Not due/foreign/legacy must not publish'),now=now)['claimed']==0
        message=str(s.scalar(select(OutboxMessage.id).where(OutboxMessage.payload['job_id'].as_integer()==future)))
    with job_delivery_guard(factory,future,message) as allowed: assert not allowed
    with factory() as s:
        s.execute(update(Job).where(Job.id==future).values(scheduled_at=now));s.commit()
    with pytest.raises(RuntimeError,match='synthetic consumer crash'):
        with job_delivery_guard(factory,future,message) as allowed:
            assert allowed
            raise RuntimeError('synthetic consumer crash')
    with job_delivery_guard(factory,future,message,now=now+timedelta(seconds=181)) as allowed: assert allowed


def test_in_progress_database_lock_timeout_then_owned_retry(database):
    from app.domains.jobs.use_cases.create_job import CreateJobUseCase
    from app.infrastructure.messaging.event_bus import EventBus
    from app.shared.exceptions import ConflictException
    _, _, af = database
    async def race():
        reached, release = asyncio.Event(), asyncio.Event()
        async with af() as first:
            original = first.commit
            async def held_commit():
                reached.set()
                await release.wait()
                await original()
            first.commit = held_commit
            pending = asyncio.create_task(CreateJobUseCase(first, EventBus()).execute(command()))
            await reached.wait()
            try:
                with pytest.raises(ConflictException, match='in progress'):
                    await create(af, command())
            finally:
                release.set()
                result = await pending
        assert (await create(af, command())).job_id == result.job_id
    asyncio.run(race())


def test_permanent_binding_processing_terminal_error_and_key_validation(database):
    from app.domains.jobs.models import Job
    from app.infrastructure.messaging.operation_models import IdempotencyOperation
    from app.infrastructure.database.outbox.models import OutboxMessage
    from app.infrastructure.messaging.job_delivery import job_delivery_guard
    from app.shared.types import JobStatus
    from app.shared.exceptions import ValidationException
    _, factory, af = database
    result=asyncio.run(create(af, command()))
    for state in (JobStatus.PROCESSING, JobStatus.FAILED):
        with factory() as s:
            s.execute(update(Job).where(Job.id==result.job_id).values(status=state,error_message='synthetic error'))
            s.execute(update(IdempotencyOperation).values(created_at=datetime(2000,1,1)))
            s.commit()
        replay=asyncio.run(create(af, command()))
        assert replay.job_id==result.job_id and replay.status==state
    with factory() as s:
        assert s.scalar(select(func.count()).select_from(Job))==1
        assert s.scalar(select(func.count()).select_from(OutboxMessage))==1
        did=str(s.scalar(select(OutboxMessage.id)))
    with job_delivery_guard(factory,result.job_id,did) as allowed: assert not allowed
    for invalid in ('','x'*201):
        with pytest.raises(ValidationException): asyncio.run(create(af,replace(command(),idempotency_key=invalid)))


def test_no_key_same_prompt_prefix_remains_independent_and_postcommit_retry(database):
    from app.domains.jobs.use_cases.create_job import CreateJobUseCase
    from app.infrastructure.messaging.event_bus import EventBus
    from app.domains.jobs.models import Job
    _, factory, af = database
    async def independent():
        return await asyncio.gather(*(create(af,replace(command(),idempotency_key=None,prompt='same-prefix-'*8+suffix)) for suffix in ('A','B')))
    rows=asyncio.run(independent());assert rows[0].job_id!=rows[1].job_id
    class LostResponse(EventBus):
        async def publish(self,event): raise RuntimeError('synthetic response lost after commit')
    async def crashed():
        async with af() as s:
            with pytest.raises(RuntimeError,match='after commit'):
                await CreateJobUseCase(s,LostResponse()).execute(command())
    asyncio.run(crashed())
    replay=asyncio.run(create(af, command()))
    with factory() as s:
        assert s.scalar(select(func.count()).select_from(Job))==3
        assert s.get(Job,replay.job_id).user_id==1


def test_competing_relays_claim_one_publish_interval(database):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    from app.infrastructure.database.outbox.job_dispatch import dispatch_due
    _, factory, af=database
    job=asyncio.run(create(af,command()));barrier=Barrier(2);published=[];now=datetime.utcnow()
    def relay(_):
        with factory() as s:
            barrier.wait(timeout=5)
            return dispatch_due(s,lambda jid,did:published.append((jid,did)),now=now)
    with ThreadPoolExecutor(max_workers=2) as executor: results=list(executor.map(relay,range(2)))
    assert sum(r['claimed'] for r in results)==1 and len(published)==1 and published[0][0]==job.job_id


def test_durable_retry_backoff_and_attempt_limit_survive_new_broker_tasks(database, monkeypatch):
    from celery import Celery
    from app.domains.jobs import tasks
    from app.domains.jobs.models import Job
    from app.infrastructure.database.outbox.models import OutboxMessage
    from app.infrastructure.database.outbox.job_dispatch import dispatch_due
    from app.infrastructure.messaging.job_delivery import defer_retry, guarded_job_delivery
    from app.shared.types import JobStatus
    _,factory,af=database
    monkeypatch.setattr(tasks,'SyncSessionLocal',factory)
    monkeypatch.setattr(tasks,'_publish_job_update',lambda *_:None)
    monkeypatch.setattr(tasks,'_refresh_run_status',lambda *_:None)
    job_id=asyncio.run(create(af,command())).job_id
    with factory() as s: did=str(s.scalar(select(OutboxMessage.id)))
    app=Celery('stage04-retry-'+uuid4().hex,broker='memory://',set_as_current=False)
    attempts=[]
    @app.task(bind=True,name='stage04.retry.'+uuid4().hex,shared=False,lazy=False,max_retries=3)
    @guarded_job_delivery
    def transient(self, job_id):
        attempts.append(self.request.retries)
        assert defer_retry(30)
    try:
        for expected in range(4):
            transient.run(job_id,dispatch_id=did)
            assert attempts==list(range(expected+1))
            transient.run(job_id,dispatch_id=did)  # Duplicate cannot bypass backoff.
            with factory() as s:
                message=s.get(OutboxMessage,UUID(did))
                assert message.execution_attempts==expected+1
                assert message.available_at>datetime.utcnow()
                assert dispatch_due(s,lambda *_:pytest.fail('Backoff must not dispatch'))['claimed']==0
                s.execute(update(OutboxMessage).where(OutboxMessage.id==UUID(did)).values(available_at=datetime.utcnow()-timedelta(seconds=1)));s.commit()
        transient.run(job_id,dispatch_id=did)
        assert attempts==[0,1,2,3]
        with factory() as s:
            assert s.get(Job,job_id).status==JobStatus.FAILED
            assert 'retry limit' in s.get(Job,job_id).error_message
        assert asyncio.run(create(af,command())).job_id==job_id
    finally: app.close()
