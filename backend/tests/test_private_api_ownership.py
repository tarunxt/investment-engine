"""Real SQL/HTTP ownership regressions; synthetic rows, no provider/Redis I/O."""
from contextlib import asynccontextmanager
from datetime import date, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
import os
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool
from sqlalchemy.schema import CreateSchema, DropSchema

from app.core.security import JWTUtils
from app.domains.auth.models import User, UserProfile, ActivityLog
from app.domains.prompts.models import Prompt
from app.domains.jobs.models import Job
from app.domains.runs.models import Run, RunJob
from app.domains.indmoney_us.models import IndMoneyUsPortfolioSnapshot
from app.domains.google_sheets.models import GoogleSheetsCredential
from app.infrastructure.database.outbox.models import OutboxMessage
from app.infrastructure.database.session import get_async_db
from app.shared.types import JobStatus


@compiles(JSONB, 'sqlite')
def sqlite_jsonb(_type, _compiler, **_kw):
    return 'JSON'


@pytest.fixture
def private_api(monkeypatch):
    from app.core.config import settings
    from app.domains.jobs import router as jobs, tasks
    from app.domains.runs import router as runs
    from app.domains.google_sheets import router as sheets
    from app.domains.indmoney_us import router as snapshots
    monkeypatch.setattr(settings, 'environment', 'test')
    monkeypatch.setattr(settings, 'auth_disabled', False)
    monkeypatch.delenv('CREDX_UAT2', raising=False)
    postgres = os.environ.get('CREDX_PRIVATE_OWNERSHIP_TEST_DATABASE_URL')
    schema = None
    if postgres:
        assert os.environ.get('CREDX_PRIVATE_OWNERSHIP_TEST_DATABASE_ACK') == 'disposable-ci-only'
        assert postgres == 'postgresql+psycopg2://audit_test:audit_test@127.0.0.1:5432/credx_audit_test_ci'
        engine = create_engine(postgres)
        schema = 'stage02_private_' + uuid4().hex
        with engine.begin() as connection:
            connection.execute(CreateSchema(schema))
        engine = engine.execution_options(schema_translate_map={None: schema})
    else:
        engine = create_engine('sqlite://', poolclass=StaticPool,
                               connect_args={'check_same_thread': False})
    for model in (User, UserProfile, ActivityLog, Prompt, Job, Run, RunJob,
                  OutboxMessage, GoogleSheetsCredential, IndMoneyUsPortfolioSnapshot):
        model.__table__.create(engine)
    session = Session(engine, expire_on_commit=False)
    users = []
    for name in ('a', 'b', 'inactive'):
        user = User(email=f'{name}@example.invalid', username=f'synthetic_{name}',
                    password_hash='unusable', is_active=name != 'inactive', is_verified=True)
        user.profile = UserProfile()
        session.add(user)
        users.append(user)
    session.flush()
    records = []
    for user in users[:2]:
        for i in range(3):
            row = Job(user_id=user.id, prompt=f'needle {user.id} {i}', provider='fake',
                      model='fake', status=JobStatus.PENDING, tokens_in=user.id * 10)
            session.add(row)
            records.append(row)
    session.flush()
    owned_runs = []
    for user in users[:2]:
        run = Run(user_id=user.id, prompt='synthetic', prompt_preview='synthetic',
                  status=JobStatus.PENDING, auto_export_enabled=False)
        session.add(run)
        session.flush()
        session.add(RunJob(run_id=run.id, job_id=records[(user.id - 1) * 3].id))
        owned_runs.append(run)
        session.add(IndMoneyUsPortfolioSnapshot(user_id=user.id, snapshot_date=date.today(),
                    captured_at=datetime.now(), raw_text='synthetic', holdings=[]))
    session.commit()
    db = SimpleNamespace(add=session.add, execute=AsyncMock(side_effect=session.execute),
        scalar=AsyncMock(side_effect=session.scalar), flush=AsyncMock(side_effect=session.flush),
        refresh=AsyncMock(side_effect=session.refresh), commit=AsyncMock(side_effect=session.commit),
        rollback=AsyncMock(side_effect=session.rollback))
    async def database():
        yield db
    app = FastAPI()
    for router in (jobs.router, runs.router, sheets.router, snapshots.router):
        app.include_router(router)
    from app.shared.exceptions import AppException
    from fastapi.responses import JSONResponse
    @app.exception_handler(AppException)
    async def app_error(_request, exc):
        return JSONResponse({"detail": exc.message}, status_code=exc.status_code)
    app.dependency_overrides[get_async_db] = database
    revoked = AsyncMock()
    monkeypatch.setattr(jobs, 'revoke_registered_job_task', revoked)
    monkeypatch.setattr(tasks, '_publish_job_update', Mock())
    monkeypatch.setattr(tasks, '_publish_run_update', Mock())
    monkeypatch.setattr(jobs.ProviderFactory, 'supports', lambda *_: True)
    monkeypatch.setattr(jobs.ProviderFactory, 'is_configured', lambda *_: True)
    headers = [{'Authorization': 'Bearer ' + JWTUtils.create_access_token(u.id, u.email, 'user')}
               for u in users]
    with TestClient(app) as client:
        yield SimpleNamespace(client=client, session=session, db=db, users=users, jobs=records,
                              runs=owned_runs, headers=headers, revoked=revoked, app=app)
    session.close()
    if schema:
        with engine.begin() as connection:
            connection.execute(DropSchema(schema, cascade=True))
    engine.dispose()


@pytest.mark.parametrize('path', ['/jobs', '/jobs/1', '/runs', '/runs/1', '/indmoney-us/portfolio'])
def test_private_reads_require_active_identity(private_api, path):
    a = private_api
    assert a.client.get(path).status_code == 401
    assert a.client.get(path, headers=a.headers[2]).status_code == 403


@pytest.mark.parametrize('path,body', [('/jobs', {}), ('/jobs/1/cancel', {}),
    ('/runs', {}), ('/runs/1/cancel', {}), ('/google-sheets/export/job', {'job_id': 1})])
def test_private_writes_reject_anonymous_identity(private_api, path, body):
    assert private_api.client.post(path, json=body).status_code == 401


def test_admin_private_list_does_not_gain_implicit_cross_owner_access(private_api):
    from app.domains.auth.models import UserRole
    a = private_api
    a.users[0].role = UserRole.ADMIN
    a.session.commit()
    response = a.client.get('/jobs', headers=a.headers[0])
    assert response.status_code == 200 and response.json()['total'] == 3


def test_job_list_count_search_pagination_ignore_client_owner(private_api):
    a = private_api
    for headers, expected in zip(a.headers[:2], (a.jobs[:3], a.jobs[3:])):
        first = a.client.get('/jobs?page=1&limit=2&q=needle&user_id=999', headers=headers).json()
        second = a.client.get('/jobs?page=2&limit=2&q=needle', headers=headers).json()
        assert first['total'] == second['total'] == 3
        assert {j['id'] for j in first['items'] + second['items']} == {j.id for j in expected}
        absent = a.client.get('/jobs?status=completed', headers=headers).json()
        assert absent['total'] == 0 and absent['items'] == []


@pytest.mark.parametrize('kind', ['jobs', 'runs'])
def test_foreign_known_guessed_reads_and_cancel_are_same404(private_api, kind):
    a = private_api
    foreign = a.jobs[3].id if kind == 'jobs' else a.runs[1].id
    for method, suffix in [('get', ''), ('post', '/cancel')]:
        responses = [getattr(a.client, method)(f'/{kind}/{id}{suffix}', headers=a.headers[0])
                     for id in (foreign, 999999)]
        assert [r.status_code for r in responses] == [404, 404]
        assert responses[0].json() == responses[1].json()
    assert a.jobs[3].status == a.runs[1].status == JobStatus.PENDING
    a.revoked.assert_not_awaited()


def test_owner_cancel_keeps_foreign_jobs_unchanged(private_api):
    a = private_api
    result = a.client.post(f'/jobs/{a.jobs[0].id}/cancel', headers=a.headers[0])
    assert result.status_code == 200 and result.json()['status'] == 'failed'
    assert a.jobs[3].status == JobStatus.PENDING
    a.revoked.assert_awaited_once_with(a.jobs[0].id)


def test_corrupt_cross_owner_run_link_is_hidden_from_count_detail_cancel(private_api):
    a = private_api
    a.session.add(RunJob(run_id=a.runs[0].id, job_id=a.jobs[3].id))
    a.session.commit()
    response = a.client.get('/runs', headers=a.headers[0])
    assert response.status_code == 200 and response.json()['total'] == 0
    assert a.client.get(f'/runs/{a.runs[0].id}', headers=a.headers[0]).status_code == 404
    assert a.client.post(f'/runs/{a.runs[0].id}/cancel', headers=a.headers[0]).status_code == 404
    assert a.jobs[3].status == JobStatus.PENDING


@pytest.mark.parametrize('kind,key', [('job', 'job_id'), ('run', 'run_id')])
def test_foreign_export_rejected_before_credentials_or_queue(private_api, kind, key):
    a = private_api
    foreign = a.jobs[3].id if kind == 'job' else a.runs[1].id
    responses = [a.client.post(f'/google-sheets/export/{kind}', json={key: id}, headers=a.headers[0])
                 for id in (foreign, 999999)]
    assert [r.status_code for r in responses] == [404, 404]
    assert responses[0].json() == responses[1].json()


def test_snapshot_foreign_id_is_indistinguishable(private_api):
    a = private_api
    ids = list(a.session.scalars(select(IndMoneyUsPortfolioSnapshot.id)))
    r = [a.client.get(f'/indmoney-us/portfolio/{id}', headers=a.headers[0]) for id in (ids[1], 999999)]
    assert [x.status_code for x in r] == [404, 404] and r[0].json() == r[1].json()


def test_create_replay_uses_server_owner_and_per_owner_cache(private_api, monkeypatch):
    a = private_api
    from app.domains.jobs import router, tasks
    from app.domains.jobs.use_cases import create_job
    cache = {}
    class Idempotency:
        async def get(self, key): return cache.get(key)
        async def set(self, key, value): cache[key] = value
    class Lock:
        @asynccontextmanager
        async def acquire(self, *args, **kwargs): yield
    monkeypatch.setattr(router, '_get_redis', lambda: None)
    monkeypatch.setattr(router, 'IdempotencyStore', lambda _: Idempotency())
    monkeypatch.setattr(router, 'RedisLock', lambda _: Lock())
    monkeypatch.setattr(create_job, 'register_job_task', AsyncMock())
    monkeypatch.setattr(router.event_bus, 'publish', AsyncMock())
    dispatch = Mock(return_value=SimpleNamespace(id='synthetic-task'))
    monkeypatch.setattr(tasks.execute_ai_job, 'delay', dispatch)
    body = dict(prompt='synthetic create', provider='fake', model='fake', user_id=a.users[1].id)
    created = []
    for headers, owner in zip(a.headers[:2], a.users[:2]):
        h = {**headers, 'Idempotency-Key': 'same-client-key'}
        first = a.client.post('/jobs', json=body, headers=h)
        again = a.client.post('/jobs', json=body, headers=h)
        assert first.status_code == again.status_code == 200
        assert first.json()['id'] == again.json()['id']
        job = a.session.get(Job, first.json()['id'])
        assert job.user_id == owner.id
        created.append(job.id)
    assert created[0] != created[1] and dispatch.call_count == 2


@pytest.mark.asyncio
async def test_private_repository_requires_explicit_owner(private_api):
    from app.domains.jobs.repository import PostgresJobRepository
    from app.domains.runs.repository import PostgresRunRepository
    for repo, id in [(PostgresJobRepository(private_api.db), 1),
                     (PostgresRunRepository(private_api.db), 1)]:
        with pytest.raises(TypeError): await repo.get(id)


@pytest.mark.parametrize('kind', ['jobs', 'runs'])
def test_foreign_websocket_never_subscribes(private_api, monkeypatch, kind):
    from app.domains.jobs import ws_router as jobs_ws
    from app.domains.runs import ws_router as runs_ws
    a = private_api
    module = jobs_ws if kind == 'jobs' else runs_ws
    @asynccontextmanager
    async def database(): yield a.db
    monkeypatch.setattr(module, 'AsyncSessionLocal', database)
    monkeypatch.setattr(module, 'user_id_from_ws_token', AsyncMock(return_value=a.users[0].id))
    relay = AsyncMock()
    monkeypatch.setattr(module, 'relay_channel', relay)
    app = FastAPI()
    app.include_router(module.router)
    foreign = a.jobs[3].id if kind == 'jobs' else a.runs[1].id
    from starlette.websockets import WebSocketDisconnect
    with TestClient(app) as client:
        for id in (foreign, 999999):
            with pytest.raises(WebSocketDisconnect) as exc:
                with client.websocket_connect(f'/ws/{kind}/{id}?token=synthetic'): pass
            assert exc.value.code == 4004
    relay.assert_not_awaited()


@pytest.mark.asyncio
async def test_foreign_prompt_reference_rejected_before_dispatch(private_api):
    from app.domains.runs.use_cases.create_run import CreateRunUseCase, CreateRunCommand, RunModelTarget
    from app.shared.exceptions import NotFoundException
    a = private_api
    prompt = Prompt(user_id=a.users[1].id, name='Private B', body='private', is_system=False)
    a.session.add(prompt)
    a.session.commit()
    use_case = CreateRunUseCase(a.db, lock=None)
    for id in (prompt.id, 999999):
        with pytest.raises(NotFoundException, match='Prompt not found'):
            await use_case.execute(CreateRunCommand(prompt='synthetic', user_id=a.users[0].id,
                targets=[RunModelTarget('fake', 'fake')], prompt_id=id))
    assert len(a.session.scalars(select(Run)).all()) == 2


@pytest.mark.parametrize('kind', ['job', 'run'])
def test_export_worker_failure_does_not_mutate_foreign_resource(private_api, monkeypatch, kind):
    from app.domains.google_sheets import tasks
    a = private_api
    monkeypatch.setattr(tasks, 'SyncSessionLocal', lambda: a.session)
    row = a.jobs[3] if kind == 'job' else a.runs[1]
    before = row.export_status
    task = tasks.export_job_to_sheets_task if kind == 'job' else tasks.export_run_to_sheets_task
    result = task.run(a.users[0].id, row.id, None)
    assert result['status'] == 'failed'
    assert a.session.get(type(row), row.id).export_status == before


def test_usage_rows_and_joined_run_metadata_are_owner_scoped(private_api):
    from app.domains.api_usage.router import router
    a = private_api
    # A stale/corrupt run link must not disclose B's run ID, stage or error.
    a.runs[1].export_error = 'private B diagnostic'
    a.session.add(RunJob(run_id=a.runs[1].id, job_id=a.jobs[1].id, stage=2))
    a.session.commit()
    a.app.include_router(router)
    response = a.client.get('/api-usage/llms/performance', headers=a.headers[0])
    assert response.status_code == 200
    data = response.json()
    assert data['total_scans'] == 3
    assert 'private B diagnostic' not in response.text
    scans = data['groups'][0]['scans']
    assert {s['job_id'] for s in scans} == {j.id for j in a.jobs[:3]}
    own_unlinked = next(s for s in scans if s['job_id'] == a.jobs[1].id)
    assert own_unlinked['run_id'] is None and own_unlinked['stage'] is None


def test_uat2_mounts_only_read_handlers_and_retains_fail_closed_mutations(private_api):
    from app.uat2.main import app
    from app.domains.auth.dependencies import get_current_user
    a = private_api
    async def db(): yield a.db
    app.dependency_overrides[get_async_db] = db
    app.dependency_overrides[get_current_user] = lambda: a.users[0]
    # Lifespan/startup policy is covered separately; no live settings used.
    client = TestClient(app)
    try:
        response = client.get('/jobs')
        assert response.status_code == 200, response.text
        assert response.json()['total'] == 3
        assert client.get('/runs?summary=true').json()['total'] == 1
        assert client.get(f'/jobs/{a.jobs[3].id}').status_code == 404
        assert client.post('/jobs', json={}).status_code == 503
        assert client.post(f'/jobs/{a.jobs[0].id}/cancel').status_code == 503
    finally:
        client.close()
        app.dependency_overrides.clear()
