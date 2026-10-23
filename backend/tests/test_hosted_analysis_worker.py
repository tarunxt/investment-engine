"""Persisted application worker composition; fake delivery, SQLite evidence."""
from datetime import timedelta
import pytest
from celery import Celery
from sqlalchemy import select
from sqlalchemy.orm import Session
from test_stage18_linked_analysis_preview import linked_env
from app.domains.runs.models import AutoRebalanceWorkflow
from app.domains.runs.analysis_workflows.contracts import WorkflowDenied, STAGES
from app.domains.runs.analysis_workflows.service import Workflows
from app.domains.runs.analysis_workflows.synthetic_sources import SimulationSourceScope, acquire
from app.domains.modules.models import UserModule
from app.domains.jobs.models import Job
from app.shared.types import JobStatus
from app.domains.recommendation_audit.models import SpendAttempt
from app.uat2.policy_bindings import install_session_binding
from app.uat2.analysis_worker import SimulationAnalysisWorker, STAGE, JOB, RELAY, QUEUE


@pytest.fixture
def worker_env(linked_env, monkeypatch, request):
    e = linked_env; monkeypatch.setenv('CREDX_UAT2', '1')
    factory = lambda: Session(e.engine, expire_on_commit=False)
    clock = [e.now]
    worker = SimulationAnalysisWorker(factory, scope=SimulationSourceScope('preview'), clock=lambda: clock[0], source_storage=getattr(request, 'param', 'snapshot'))
    install_session_binding(e.db, worker.scope)
    worker.analysis.acquire(e.db, 1, key='worker-acquisition-key')
    flow = Workflows(e.db, worker.analysis.runtime).create(1, 'india', 'worker-persisted-flow', now=e.now)
    e.db.commit()
    app = Celery('isolated-test', broker='memory://', backend='cache+memory://', set_as_current=False)
    app.conf.update(task_serializer='json', result_serializer='json', accept_content=['json'],
                    task_routes={}, beat_schedule={})
    worker.register(app)
    deliveries = []
    for name, task in worker.tasks.items():
        def publish(*, args, queue, retry, kind=name):
            assert queue == QUEUE and retry is False
            deliveries.append((kind, args))
        monkeypatch.setattr(task, 'apply_async', publish)
    yield e, worker, factory, app, deliveries, clock, flow.id
    app.close()


def test_worker_relay_complete_six_stages_and_five_governed_jobs_without_global_runtime(worker_env):
    e, worker, factory, app, deliveries, clock, flow_id = worker_env
    from app.domains.runs.analysis_workflows.runtime import configured_runtime
    assert configured_runtime() is None
    for _ in range(40):
        worker.relay()
        batch = list(deliveries); deliveries.clear()
        for kind, args in batch:
            if kind == STAGE: worker.stage(*args)
            elif kind == JOB: worker.job(*args)
            else: pytest.fail('No task except owned stage/job may be published')
        with factory() as db:
            if db.get(AutoRebalanceWorkflow, flow_id).status == 'completed': break
        clock[0] += timedelta(seconds=6)
    with factory() as db:
        install_session_binding(db, worker.scope)
        service = Workflows(db, worker.analysis.runtime)
        row = service.owned(1, flow_id)
        assert row.status == 'completed'
        assert [stage.stage for stage in service.stages(row)] == list(STAGES)
        assert all(stage.status == 'completed' for stage in service.stages(row))
        attempts = list(db.scalars(select(SpendAttempt)))
        assert len(attempts) == 5 and all(attempt.status == 'settled' for attempt in attempts)
        assert worker.analysis.completed_analysis(db, 1, flow_id, now=clock[0])['orders_authorized'] is False
    assert configured_runtime() is None


def test_disable_between_relay_and_delivery_never_runs_fake_provider(worker_env):
    e, worker, factory, app, deliveries, clock, flow_id = worker_env
    worker.relay()
    assert deliveries and deliveries[0][0] == STAGE
    e.db.scalar(select(UserModule).where(UserModule.user_id == 1,
        UserModule.module_id == 'zerodha_rebalance')).enabled = False
    e.db.commit()
    assert worker.stage(*deliveries[0][1]) == 'policy_denied'
    with factory() as db:
        assert not list(db.scalars(select(SpendAttempt)))
        assert db.get(AutoRebalanceWorkflow, flow_id).status == 'paused'


def test_explicit_registration_and_bounded_schedule_do_not_import_production_tasks(worker_env):
    e, worker, factory, app, deliveries, clock, flow_id = worker_env
    assert set(worker.tasks) == {STAGE, JOB, RELAY}
    assert app.conf.beat_schedule == {}
    assert worker.schedule(app)['options'] == {'queue': QUEUE, 'expires': 5}
    assert worker.schedule(app)['schedule'] == 5
    assert len(app.conf.beat_schedule) == 1
    for task in worker.tasks.values():
        assert task.max_retries == 0 and task.acks_late and task.reject_on_worker_lost
        assert task.soft_time_limit == 10 and task.time_limit == 15
    app.conf.broker_url = 'redis://not-the-approved-transport/0'
    with pytest.raises(WorkflowDenied): worker.relay()


def test_worker_has_no_implicit_factory_scope_or_transport(linked_env):
    with pytest.raises(WorkflowDenied): SimulationAnalysisWorker(None, scope=SimulationSourceScope('hosted'))
    with pytest.raises(WorkflowDenied): SimulationAnalysisWorker(lambda: None, scope=None)
    worker = SimulationAnalysisWorker(lambda: None, scope=SimulationSourceScope('hosted'))
    with pytest.raises(WorkflowDenied): worker.relay()


def test_worker_relay_leaves_unrelated_pending_jobs_untouched(worker_env):
    e, worker, factory, app, deliveries, clock, flow_id = worker_env
    from app.infrastructure.database.outbox.models import OutboxMessage
    legacy = Job(user_id=1, module_id='zerodha_rebalance', module_version=1,
        prompt='synthetic unrelated legacy fixture', provider='fake', model='offline', status=JobStatus.PENDING)
    e.db.add(legacy); e.db.flush()
    event = OutboxMessage(topic='job.created.v2', payload={'job_id': legacy.id, 'user_id': 1})
    e.db.add(event); e.db.commit()
    worker.relay()
    assert all(kind != JOB for kind, _ in deliveries)
    with factory() as db:
        assert db.get(Job, legacy.id).status == JobStatus.PENDING
        assert db.get(OutboxMessage, event.id).published_at is None


def test_stage_process_loss_rolls_back_claim_then_new_worker_recovers(worker_env):
    from dataclasses import replace
    from app.infrastructure.database.outbox.models import OutboxMessage
    e, worker, factory, app, deliveries, clock, flow_id = worker_env
    worker.relay(); message = deliveries[0][1][0]
    def crash(*args, **kwargs): raise SystemExit('synthetic process loss before fake adapter')
    worker.analysis.runtime = replace(worker.analysis.runtime, adapter=crash)
    with pytest.raises(SystemExit): worker.stage(message)
    with factory() as db:
        from uuid import UUID
        assert db.get(OutboxMessage, UUID(message)).execution_attempts == 0
        assert db.get(AutoRebalanceWorkflow, flow_id).status == 'queued'
    restarted = SimulationAnalysisWorker(factory, scope=worker.scope, clock=lambda: clock[0])
    assert restarted.stage(message) == 'completed'
    assert restarted.stage(message) == 'duplicate'


@pytest.mark.parametrize('worker_env', ['journal'], indirect=True)
def test_journal_worker_complete_persisted_six_stage_pipeline(worker_env):
    test_worker_relay_complete_six_stages_and_five_governed_jobs_without_global_runtime(worker_env)
