"""Real Celery Beat ticks/memory delivery; disposable SQLite, never PG evidence."""
from copy import deepcopy
from datetime import timedelta
import time
import pytest
from celery.beat import ScheduleEntry
from celery.contrib.testing.worker import start_worker
from celery.app.task import Task
from sqlalchemy import select, func
from test_hosted_analysis_worker import worker_env, linked_env
from test_hosted_order_composition import order_env
from app.uat2.scheduler import SimulationScheduler, validate_schedule, ENTRIES
from app.uat2.runtime import WORKER_ARGS
from app.uat2.analysis_worker import RELAY as ANALYSIS, STAGE, JOB
from app.domains.runs.analysis_workflows.contracts import WorkflowDenied, TOPIC as STAGE_TOPIC
from app.domains.runs.models import AutoRebalanceWorkflow
from app.domains.order_intents.models import OrderIntent
from app.domains.order_intents.service import TOPIC
from app.infrastructure.database.outbox.models import OutboxMessage


def configured(order_env):
    e, analysis, orders, factory, app, deliveries, clock, flow, intent = order_env
    analysis.schedule(app)
    app.now = lambda: clock[0]
    return app


@pytest.mark.parametrize('change', ['extra', 'missing', 'interval', 'queue', 'args', 'unregistered'])
def test_scheduler_refuses_changed_or_unregistered_control_entries(order_env, change):
    app = configured(order_env)
    value = deepcopy(app.conf.beat_schedule)
    key = 'uat2-scoped-analysis-relay'
    if change == 'extra': value['production'] = {'task': 'app.domains.runs.tasks.auto_live', 'schedule': 1}
    elif change == 'missing': value.pop(key)
    elif change == 'interval': value[key]['schedule'] = .01
    elif change == 'queue': value[key]['options']['queue'] = 'ai'
    elif change == 'args': value[key]['args'] = [1]
    else: app.tasks.pop(ANALYSIS)
    app.conf.beat_schedule = value
    with pytest.raises(WorkflowDenied): SimulationScheduler(app)


def test_scheduler_dispatch_guard_rejects_injected_entries_and_late_config_change(order_env):
    app = configured(order_env); scheduler = SimulationScheduler(app)
    bad = ScheduleEntry(name='injected', task='app.domains.runs.tasks.auto_live', schedule=5, app=app)
    with pytest.raises(WorkflowDenied): scheduler.apply_async(bad)
    app.conf.beat_schedule = {}
    with pytest.raises(WorkflowDenied): scheduler.apply_async(scheduler.schedule['uat2-scoped-analysis-relay'])


def test_runtime_has_explicit_embedded_scheduler_and_no_service_or_schedule_file_changes():
    assert '--beat' in WORKER_ARGS
    assert '--scheduler=app.uat2.scheduler:SimulationScheduler' in WORKER_ARGS
    assert '--concurrency=1' in WORKER_ARGS and '--prefetch-multiplier=1' in WORKER_ARGS
    assert not any('schedule=' in arg for arg in WORKER_ARGS)


def test_beat_service_automatically_dispatches_controls_without_schedule_file(order_env, monkeypatch, tmp_path):
    from celery.beat import Service
    from threading import Thread
    app = configured(order_env)
    clock = order_env[6]
    posted = []
    for task_name, _, _ in ENTRIES.values():
        def capture(*args, _name=task_name, **kwargs): posted.append((_name, args, kwargs))
        monkeypatch.setattr(app.tasks[task_name], 'apply_async', capture)
    directory = tmp_path / 'scheduler-state'
    directory.mkdir()
    state = directory / 'must-not-create-schedule'
    service = Service(app, scheduler_cls=SimulationScheduler, max_interval=.05, schedule_filename=str(state))
    assert len(service.scheduler.schedule) == 3
    thread = Thread(target=service.start, daemon=True)
    thread.start()
    try:
        clock[0] += timedelta(seconds=61)
        deadline = time.monotonic() + 3
        while len(posted) < 3 and time.monotonic() < deadline: time.sleep(.02)
        assert {row[0] for row in posted} == {spec[0] for spec in ENTRIES.values()}
        assert len(posted) == 3  # No missed-tick catch-up storm.
        assert all(row[2]['queue'] == 'uat2_simulation' for row in posted)
    finally:
        service.stop(); thread.join(timeout=2)
    assert not thread.is_alive() and not list(directory.iterdir())


def test_actual_beat_tick_memory_worker_restart_and_duplicate_outbox_safety(order_env, monkeypatch):
    e, analysis, orders, factory, app, deliveries, clock, old_flow, intent = order_env
    configured(order_env)
    # Remove the fixture's publication intercepts. The scheduler and consumers
    # below use actual Kombu memory transport and a real solo Celery worker.
    for task in [*analysis.tasks.values(), *orders.tasks.values()]:
        monkeypatch.setattr(task, 'apply_async', Task.apply_async.__get__(task, type(task)))
    from app.domains.runs.analysis_workflows.service import Workflows
    with analysis.session() as db:
        flow_id = Workflows(db, analysis.analysis.runtime).create(
            1, 'india', 'scheduler-new-persisted-flow', now=clock[0]).id
        db.commit()
    posted = []
    for name, _, _ in ENTRIES.values():
        task = app.tasks[name]; original = task.apply_async
        def record(*args, _original=original, _name=name, **kwargs):
            result = _original(*args, **kwargs); posted.append((_name, result)); return result
        monkeypatch.setattr(task, 'apply_async', record)
    def ticks(scheduler):
        clock[0] += timedelta(seconds=6)
        scheduler._heap = None
        before = len(posted)
        for _ in range(4): scheduler.tick()
        for _, result in posted[before:]: result.get(timeout=5, disable_sync_subtasks=False)
        time.sleep(.05)
    options = dict(pool='solo', concurrency=1, perform_ping_check=False,
        queues=['uat2_simulation', 'uat2_analysis', 'uat2_orders', 'uat2_reconcile'], shutdown_timeout=10)
    with start_worker(app, **options):
        scheduler = SimulationScheduler(app)
        ticks(scheduler)
        assert any(name == ANALYSIS for name, _ in posted)
    # New scheduler is deliberately stateless. Durable workflow/outbox state
    # survives the consumer/scheduler restart; no manual relay is submitted.
    with start_worker(app, **options):
        scheduler = SimulationScheduler(app)
        for _ in range(35):
            ticks(scheduler)
            with factory() as db:
                if db.get(AutoRebalanceWorkflow, flow_id).status == 'completed': break
        with factory() as db:
            assert db.get(AutoRebalanceWorkflow, flow_id).status == 'completed'
            assert db.get(OrderIntent, intent).state == 'awaiting_approval'
            assert db.scalar(select(func.count()).select_from(OutboxMessage).where(OutboxMessage.topic == TOPIC)) == 0
        # Scheduler restart/extra relay publication never grants approval or
        # repeats the completed stage; consumer arbitration remains durable.
        with factory() as db:
            event = db.scalar(select(OutboxMessage).where(
                OutboxMessage.payload['workflow_id'].as_integer() == flow_id,
                OutboxMessage.topic == STAGE_TOPIC))
            assert event is not None and event.execution_attempts == 1
        first = analysis.tasks[STAGE].apply_async(args=[str(event.id)], queue='uat2_analysis', retry=False)
        second = analysis.tasks[STAGE].apply_async(args=[str(event.id)], queue='uat2_analysis', retry=False)
        assert first.get(timeout=5, disable_sync_subtasks=False) == 'duplicate'
        assert second.get(timeout=5, disable_sync_subtasks=False) == 'duplicate'
    assert {name for name, _ in posted} <= {value[0] for value in ENTRIES.values()}
    assert all(name.startswith(('uat2.', 'celery.')) for name in app.tasks)


def test_uncertain_publish_relay_retry_cannot_repeat_stage_after_scheduler_loss(worker_env, monkeypatch):
    e, worker, factory, app, deliveries, clock, flow = worker_env
    # Existing durable relay has an at-least-once boundary: publication can
    # succeed while its caller observes a transport failure.
    task = worker.tasks[STAGE]
    def uncertain(*, args, queue, retry):
        deliveries.append((STAGE, args))
        raise OSError('synthetic lost publish acknowledgement')
    monkeypatch.setattr(task, 'apply_async', uncertain)
    result = worker.relay()
    assert result['workflows']['deferred'] == 1
    first = deliveries[-1][1][0]
    clock[0] += timedelta(seconds=31)
    worker.relay()
    assert deliveries[-1][1][0] == first
    assert worker.stage(first) == 'completed'
    assert worker.stage(first) == 'duplicate'
    with factory() as db:
        from uuid import UUID
        row = db.get(OutboxMessage, UUID(first))
        assert row.execution_attempts == 1 and row.attempts == 2
