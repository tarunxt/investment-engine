"""A11 ordinary ownership boundary; excluded specialized adapter is always mocked.

A valid specialized context is client-selected, not evidence of trusted origin.
These tests preserve that existing branch and certify no unclaimed ordinary call.
"""
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from pydantic import ValidationError
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.domains.jobs import tasks
from app.domains.jobs.models import Job
from app.domains.jobs.execution_claim import KEY
from app.domains.ai_providers.base import AIProviderResponse
from app.domains.ai_providers.factory import ProviderFactory
from app.domains.runs.schemas import PolymarketEventRunContext
from app.core.recovery import RecoveryBlocked


def specialized_context():
    question = dict(question_ref='synthetic-1', question_id='synthetic-1',
                    question='Synthetic question', category='synthetic',
                    current_time_utc='2026-11-07T00:00:00Z', current_time_et='2026-11-06T19:00:00-05:00')
    return dict(kind='polymarket_bullpen_event', prompt_template='Synthetic template',
                question_payload=[question], prepared_context={'question_payload':[question]},
                evidence_options={'require_fresh_internet_evidence':False})


@pytest.fixture
def worker(monkeypatch):
    monkeypatch.setenv('CREDX_RECOVERY_MODE', '0')
    engine = create_engine('sqlite://', poolclass=StaticPool, connect_args={'check_same_thread':False})
    Job.__table__.create(engine)
    sessions = sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(tasks, 'SyncSessionLocal', sessions)
    monkeypatch.setattr(tasks, '_publish_job_update', MagicMock())
    monkeypatch.setattr(tasks, '_refresh_run_status', MagicMock())
    monkeypatch.setattr(tasks, 'register_job_task_sync', MagicMock())
    provider = MagicMock()
    provider.generate.return_value = AIProviderResponse(content='synthetic ordinary output', tokens_in=1,
        tokens_out=2, cost=0, provider='synthetic', model='synthetic')
    factory = MagicMock(return_value=provider)
    monkeypatch.setattr(ProviderFactory, 'create', factory)
    specialized = MagicMock(return_value=SimpleNamespace(response_text='synthetic specialized output',
        status='completed', tokens_in=1, tokens_out=2, estimated_cost=0,
        runtime_metadata={'synthetic_specialized':True}, web_search_used=False,
        web_search_queries=[], web_sources=[]))
    monkeypatch.setattr(tasks, 'execute_bullpen_llm_target', specialized)
    prepare = MagicMock(side_effect=AssertionError('fixture must not perform evidence acquisition'))
    monkeypatch.setattr(tasks, 'prepare_polymarket_event_context', prepare)
    def seed(context):
        with sessions() as db:
            db.add(Job(id=1,user_id=7,prompt='synthetic analysis',provider='synthetic',model='synthetic',
                       status='pending',request_context_json=context,auto_rebalance_portfolio='india'))
            db.commit()
    def row():
        with sessions() as db: return db.get(Job,1)
    yield SimpleNamespace(sessions=sessions, seed=seed, row=row, factory=factory, provider=provider,
                          specialized=specialized, prepare=prepare)
    engine.dispose()


@pytest.mark.parametrize('context', [None, {'kind':'ordinary'}, {'kind':123}, {'kind':'POLYMARKET_BULLPEN_EVENT'}])
def test_ordinary_or_nonmatching_stored_kind_requires_durable_owner(worker, context):
    worker.seed(context)
    def generate(**kwargs):
        current = worker.row()
        assert current.runtime_metadata_json[KEY]['state'] == 'owned'
        assert current.runtime_metadata_json[KEY]['provider_started'] is True
        return AIProviderResponse(content='synthetic ordinary output',tokens_in=1,tokens_out=2,cost=0,
                                  provider='synthetic',model='synthetic')
    worker.provider.generate.side_effect = generate
    tasks.execute_ai_job.run(1)
    current = worker.row()
    assert current.status == 'completed'
    assert current.runtime_metadata_json[KEY]['state'] == 'finished'
    worker.provider.generate.assert_called_once()
    worker.specialized.assert_not_called()


def test_valid_existing_specialized_dispatch_remains_excluded_not_ordinary(worker):
    context = specialized_context()
    worker.seed(context)
    tasks.execute_ai_job.push_request(id='synthetic-specialized-delivery', retries=0)
    try:
        tasks.execute_ai_job.run(1)
    finally:
        tasks.execute_ai_job.pop_request()
    tasks.register_job_task_sync.assert_called_once_with(1, 'synthetic-specialized-delivery')
    current = worker.row()
    assert current.status == 'completed'
    assert current.response == 'synthetic specialized output'
    assert KEY not in (current.runtime_metadata_json or {})
    worker.specialized.assert_called_once()
    assert isinstance(worker.specialized.call_args.args[0], PolymarketEventRunContext)
    assert worker.specialized.call_args.args[0].model_dump(mode='json')['question_payload']
    worker.factory.assert_not_called()
    worker.prepare.assert_not_called()


@pytest.mark.parametrize('context', [
    {'kind':'polymarket_bullpen_event'},
    {'kind':'polymarket_bullpen_event', 'prompt_template':'synthetic', 'question_payload':'forged'},
    {'kind':' polymarket_bullpen_event ', 'prompt_template':'synthetic', 'question_payload':[]},
])
def test_malformed_persisted_specialized_context_never_enters_any_adapter(worker, context):
    worker.seed(context)
    try:
        tasks.execute_ai_job.run(1)
    except ValidationError:
        # Existing excluded retry policy may surface its validation error when
        # invoked directly; it must never reach an inference adapter.
        pass
    current = worker.row()
    assert current.status != 'completed'
    worker.factory.assert_not_called()
    worker.specialized.assert_not_called()
    worker.prepare.assert_not_called()


def test_changed_specialized_context_cannot_fall_through_to_unclaimed_ordinary(worker, monkeypatch):
    worker.seed(specialized_context())
    def change_context(job):
        job.request_context_json = None
    monkeypatch.setattr(tasks, '_publish_job_update', change_context)
    tasks.execute_ai_job.run(1)
    current = worker.row()
    assert current.status != 'completed'
    assert current.response is None
    worker.factory.assert_not_called()
    worker.specialized.assert_not_called()


@pytest.mark.parametrize('context', [specialized_context(), {'kind':'polymarket_bullpen_event'}, {'kind':'forged'}])
def test_recovery_rejects_specialized_or_unknown_context_before_any_worker_write(worker, monkeypatch, context):
    worker.seed(context)
    before = worker.row()
    monkeypatch.setenv('CREDX_RECOVERY_MODE','1')
    with pytest.raises(RecoveryBlocked): tasks.execute_ai_job.run(1)
    after = worker.row()
    assert after.status == before.status == 'pending'
    assert after.runtime_metadata_json == before.runtime_metadata_json is None
    assert after.request_context_json == context
    worker.factory.assert_not_called()
    worker.specialized.assert_not_called()
    tasks.register_job_task_sync.assert_not_called()
    tasks._publish_job_update.assert_not_called()


@pytest.mark.parametrize('context,accepted', [
    (specialized_context(), True),
    ({'kind':'polymarket_bullpen_event'}, False),
    ({**specialized_context(),'kind':'ordinary'}, False),
    ({**specialized_context(),'kind':' polymarket_bullpen_event '}, False),
    ({**specialized_context(),'question_payload':'forged'}, False),
])
def test_authenticated_ingress_validates_client_context_and_uses_server_actor(monkeypatch, context, accepted):
    from app.domains.runs import router as routes
    monkeypatch.setenv('CREDX_RECOVERY_MODE','0')
    for method in ('supports','is_configured'):
        monkeypatch.setattr(routes.ProviderFactory,method,lambda *args:True)
    monkeypatch.setattr(routes.ProviderFactory,'model_compatibility',lambda *args:(True,None))
    monkeypatch.setattr(routes,'_get_redis',lambda:object())
    monkeypatch.setattr(routes,'RedisLock',lambda _:object())
    calls=[]
    class UseCase:
        def __init__(self,**kwargs): pass
        async def execute(self,cmd):
            calls.append(cmd)
            raise HTTPException(418,'synthetic validated command boundary')
    monkeypatch.setattr(routes,'CreateRunUseCase',UseCase)
    app=FastAPI();app.include_router(routes.router)
    async def session(): yield object()
    app.dependency_overrides[routes.get_async_db]=session
    app.dependency_overrides[routes.get_current_user]=lambda:SimpleNamespace(id=7)
    with TestClient(app) as client:
        response=client.post('/runs',json={'prompt':'synthetic','targets':[{'provider':'synthetic','model':'synthetic'}],
            'user_id':999,'polymarket_event_context':deepcopy(context)})
    assert response.status_code == (418 if accepted else 422)
    if accepted:
        assert len(calls)==1 and calls[0].user_id==7
        assert calls[0].polymarket_event_context == PolymarketEventRunContext.model_validate(context).model_dump(mode='json')
    else:
        assert calls==[]


from test_jobs_admission_dispatch import database


@pytest.mark.asyncio
@pytest.mark.parametrize('recovery', [False, True])
async def test_run_persistence_preserves_validated_client_context_and_owner(database, monkeypatch, recovery):
    from contextlib import asynccontextmanager
    from sqlalchemy import select, func
    from app.domains.runs.use_cases import create_run as producer
    from app.domains.runs.models import Run, RunJob
    from app.infrastructure.database.outbox.models import OutboxMessage
    monkeypatch.setenv('CREDX_RECOVERY_MODE', '1' if recovery else '0')
    targets = [producer.RunModelTarget(provider='synthetic', model='synthetic')]
    monkeypatch.setattr(producer, 'filter_recently_available_targets', AsyncMock(return_value=(targets, [])))
    monkeypatch.setattr(producer, 'freeze_output_source_context', AsyncMock(return_value=None))
    publisher = AsyncMock()
    monkeypatch.setattr(producer, 'dispatch_one', publisher)
    class Lock:
        @asynccontextmanager
        async def acquire(self, *args, **kwargs): yield
    context = PolymarketEventRunContext.model_validate(specialized_context()).model_dump(mode='json')
    async with database() as db:
        command = producer.CreateRunCommand(prompt='synthetic', targets=targets, user_id=1,
            polymarket_event_context=context, allow_parallel=True)
        if recovery:
            with pytest.raises(RecoveryBlocked):
                await producer.CreateRunUseCase(db, Lock()).execute(command)
            assert await db.scalar(select(func.count()).select_from(Job)) == 0
            assert await db.scalar(select(func.count()).select_from(OutboxMessage)) == 0
            publisher.assert_not_called()
        else:
            result = await producer.CreateRunUseCase(db, Lock()).execute(command)
            job = (await db.execute(select(Job))).scalar_one()
            link = (await db.execute(select(RunJob))).scalar_one()
            obligation = (await db.execute(select(OutboxMessage))).scalar_one()
            assert result.user_id == job.user_id == 1
            assert job.request_context_json == context
            assert link.run_id == result.id and link.job_id == job.id
            assert obligation.job_id == job.id and obligation.topic == 'analysis.dispatch.v1'
            assert obligation.state == 'pending'
            publisher.assert_awaited_once()
