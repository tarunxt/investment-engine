"""Focused fake source -> durable governed analysis integration, no listeners/I/O.

The helpers are shared with the linked exact-approval/execution receipt. This is
SQLite preview coverage, not PostgreSQL concurrency or deployed acceptance.
"""
import asyncio
from datetime import datetime, timedelta, timezone
import importlib
from pathlib import Path
import socket
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Session

from app.infrastructure.database.base import Base
import app.infrastructure.database.all_models
from app.domains.auth.models import User
from app.domains.ai_limits.contracts import BoundaryDenied
from app.domains.connections.models import IntegrationConnection
from app.domains.indmoney_us.import_service import ManualImportService
from app.domains.indmoney_us.import_validation import CSV_TEMPLATE
from app.domains.indmoney_us.models import IndMoneyUsPortfolioSnapshot
from app.domains.indmoney_us.schemas import IndMoneyUsPortfolioSnapshotCreateRequest
from app.domains.jobs.models import Job
from app.domains.modules.models import UserModule, UserModulePreferences
from app.domains.prompts.models import Prompt
from app.domains.recommendation_audit.models import SpendAccount, SpendAttempt
from app.domains.runs.analysis_workflows.contracts import STAGES, WorkflowDenied
from app.domains.runs.analysis_workflows.runtime import configured_runtime
from app.domains.runs.analysis_workflows.service import Workflows
from app.domains.runs.models import AutoRebalanceWorkflow, AutoRebalanceWorkflowStage, Run
from app.domains.zerodha.models import ZerodhaPortfolioSnapshot
from app.infrastructure.database.outbox.models import OutboxMessage
from app.shared.exceptions import NotFoundException
from app.shared.types import JobStatus


@compiles(JSONB, 'sqlite')
def json_sqlite(type, compiler, **kw):
    return 'JSON'


@pytest.fixture
def linked_env(tmp_path, monkeypatch):
    monkeypatch.setenv('STAGE01_PREVIEW', 'synthetic-only')
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2]))
    preview = importlib.import_module('scripts.public_launch.preview_stage12')
    def denied(*args, **kwargs):
        raise AssertionError('Linked synthetic acceptance prohibits network calls')
    monkeypatch.setattr(socket.socket, 'connect', denied)
    monkeypatch.setattr(socket.socket, 'connect_ex', denied)
    monkeypatch.setattr(socket, 'create_connection', denied)
    from app.domains.ai_providers.factory import ProviderFactory
    monkeypatch.setattr(ProviderFactory, 'create', denied)
    path = tmp_path / 'linked-analysis.sqlite'
    engine = create_engine('sqlite:///' + str(path))
    models = [User, Prompt, Job, Run, AutoRebalanceWorkflow, AutoRebalanceWorkflowStage,
              OutboxMessage, UserModulePreferences, UserModule, IntegrationConnection,
              IndMoneyUsPortfolioSnapshot, ZerodhaPortfolioSnapshot, SpendAccount, SpendAttempt]
    Base.metadata.create_all(engine, tables=[model.__table__ for model in models])
    db = Session(engine, expire_on_commit=False, autoflush=False)
    now = datetime.now(timezone.utc)
    for owner, mode in ((1, 'user_owned'), (2, 'platform_managed')):
        db.add(User(id=owner, email=f'user{"a" if owner == 1 else "b"}@stage01.example.com',
                    username=f'user{"a" if owner == 1 else "b"}', password_hash='unusable',
                    is_active=True, is_verified=True))
        db.add(UserModulePreferences(user_id=owner, version=1))
        for module in ('indmoney_us', 'zerodha_rebalance'):
            db.add(UserModule(user_id=owner, module_id=module, enabled=True, version=1,
                              schedules_paused=False, config={'schema_version': 1}))
        db.add(IntegrationConnection(owner_id=owner, provider='zerodha', app_ownership_mode=mode,
            provider_account_id='FAKE_OWNER_' + str(owner), status='active',
            token_expires_at=now + timedelta(hours=1), version=7, is_current=True))
    db.commit()
    result = SimpleNamespace(db=db, engine=engine, path=path, now=now, preview=preview,
                             runtime=preview.runtime)
    try:
        yield result
    finally:
        result.db.close()
        engine.dispose()


def imported_source(env, owner=1, *, accept=True):
    """Use the real preview/digest-acceptance service, not an accepted-row seed."""
    env.db.commit()
    async def run():
        engine = create_async_engine('sqlite+aiosqlite:///' + str(env.path))
        try:
            async with AsyncSession(engine, expire_on_commit=False) as db:
                service = ManualImportService(db)
                row = await service.preview(owner, IndMoneyUsPortfolioSnapshotCreateRequest(
                    raw_text=CSV_TEMPLATE, captured_at=env.now, format='csv'))
                await db.commit()
                if accept:
                    row = await service.accept(owner, row.id, row.content_hash)
                    await db.commit()
                return row.id
        finally:
            await engine.dispose()
    return asyncio.run(run())


def current_source(env, owner=1, portfolio='india'):
    if portfolio == 'indmoney_us':
        return imported_source(env, owner)
    row = env.preview.synthetic_acquire(env.db, owner, now=env.now)
    env.db.commit()
    return row.id


def next_job_message(env):
    return env.db.scalar(select(OutboxMessage).join(Job,
        (OutboxMessage.payload['job_id'].as_integer() == Job.id)
        & (OutboxMessage.payload['user_id'].as_integer() == Job.user_id)).where(
            OutboxMessage.topic == 'job.created.v2', Job.status.in_(JobStatus.active()),
            OutboxMessage.execution_attempts == 0).order_by(OutboxMessage.created_at, OutboxMessage.id))


def complete_analysis(env, owner=1, portfolio='india', *, key='linked-fake-analysis'):
    """Restart SQL sessions across every tick; complete exactly one six-stage run."""
    snapshot_id = current_source(env, owner, portfolio)
    row = Workflows(env.db, env.runtime).create(owner, portfolio, key,
                                               snapshot_id=snapshot_id, now=env.now)
    workflow_id = row.id
    env.db.commit()
    for _ in range(20):
        env.db.close()
        env.db = Session(env.engine, expire_on_commit=False, autoflush=False)
        outcome = env.preview.advance(env.db, now=env.now)
        env.db.commit()
        queued = next_job_message(env)
        if queued is not None:
            result = env.preview.publish_governed_job(env.db, queued.payload['job_id'], queued.id, now=env.now)
            env.db.commit()
            assert result['status'] == 'completed', result
        detail = Workflows(env.db, env.runtime).detail(owner, workflow_id)
        if detail['status'] == 'completed':
            return env.preview.completed_analysis(env.db, owner, workflow_id, now=env.now)
        assert outcome in {'completed', 'waiting'}, detail
        env.now += timedelta(seconds=6)
    raise AssertionError('Finite linked analysis did not complete')


def first_job(env, owner=1):
    snapshot_id = current_source(env, owner)
    row = Workflows(env.db, env.runtime).create(owner, 'india', 'linked-queued-job',
                                               snapshot_id=snapshot_id, now=env.now)
    env.db.commit()
    assert env.preview.advance(env.db, now=env.now) == 'completed'
    env.db.commit()
    assert env.preview.advance(env.db, now=env.now) == 'waiting'
    env.db.commit()
    message = next_job_message(env)
    return row, message


@pytest.mark.parametrize('owner,mode', [(1, 'user_owned'), (2, 'platform_managed')])
def test_current_connection_modes_complete_all_six_governed_stages(linked_env, owner, mode):
    e = linked_env
    receipt = complete_analysis(e, owner)
    detail = Workflows(e.db, e.runtime).detail(owner, receipt['workflow_id'])
    assert [stage['stage'] for stage in detail['stages']] == list(STAGES)
    assert all(stage['status'] == 'completed' for stage in detail['stages'])
    assert receipt['source']['connection']['mode'] == mode
    assert receipt['source']['connection']['version'] == 7
    assert receipt['source']['acquisition']['simulation'] is True
    assert receipt['recommendations'] == [{'instrument': 'NSE:SYNTHETIC0', 'action': 'trim',
        'current_units': '3e0', 'final_units': '1', 'allocation': '.1'}]
    assert receipt['orders_authorized'] is False
    attempts = list(e.db.scalars(select(SpendAttempt)))
    assert len(attempts) == 5
    assert {attempt.status for attempt in attempts} == {'settled'}
    assert sum(attempt.actual_usd for attempt in attempts) == 0
    assert all(attempt.request_hash and attempt.module_version == 1 for attempt in attempts)
    assert configured_runtime() is None


def test_real_import_acceptance_is_the_frozen_governed_source(linked_env):
    e = linked_env
    preview_id = imported_source(e, accept=False)
    with pytest.raises(WorkflowDenied, match='accepted'):
        e.preview.source(e.db, 1, 'indmoney_us', preview_id)
    e.db.rollback()
    receipt = complete_analysis(e, portfolio='indmoney_us')
    snapshot = e.db.get(IndMoneyUsPortfolioSnapshot, preview_id)
    assert snapshot.acceptance_state == 'accepted'
    assert receipt['source']['snapshot_id'] == preview_id
    assert receipt['source']['content_hash'] == snapshot.content_hash
    assert receipt['source']['holdings'] == snapshot.holdings
    assert receipt['recommendations'][0]['instrument'] == 'US:UATA'
    assert receipt['recommendations'][0]['action'] == 'hold'
    with pytest.raises(WorkflowDenied):
        e.preview.source(e.db, 2, 'indmoney_us', preview_id)
    with pytest.raises(NotFoundException):
        e.preview.completed_analysis(e.db, 2, receipt['workflow_id'], now=e.now)


@pytest.mark.parametrize('change', ['connection_version', 'module_disable', 'cancel'])
def test_changed_binding_or_cancellation_cannot_call_fake_worker(linked_env, change):
    e = linked_env
    row, message = first_job(e)
    if change == 'connection_version':
        connection = e.db.scalar(select(IntegrationConnection).where(IntegrationConnection.owner_id == 1))
        connection.version += 1
    elif change == 'module_disable':
        e.db.scalar(select(UserModule).where(UserModule.user_id == 1,
            UserModule.module_id == 'zerodha_rebalance')).enabled = False
    else:
        Workflows(e.db, e.runtime).control(1, row.id, 'cancel', 0, now=e.now)
    e.db.commit()
    result = e.preview.publish_governed_job(e.db, message.payload['job_id'], message.id, now=e.now)
    e.db.commit()
    assert result['status'] == 'denied'
    assert e.db.get(Job, message.payload['job_id']).status == JobStatus.FAILED
    assert not list(e.db.scalars(select(SpendAttempt)))
    e.now += timedelta(seconds=6)
    assert e.preview.advance(e.db, now=e.now) == ('obsolete' if change == 'cancel' else 'policy_denied')


def test_synthetic_acquisition_cannot_relabel_legacy_or_changed_connection(linked_env):
    e = linked_env
    e.db.add(ZerodhaPortfolioSnapshot(user_id=1, snapshot_date=e.now.date(), captured_at=e.now,
        source='manual', holdings=[], net_positions=[], day_positions=[]))
    e.db.commit()
    with pytest.raises(WorkflowDenied, match='relabelled'):
        e.preview.synthetic_acquire(e.db, 1, now=e.now)
    e.db.rollback()
    current_source(e, 2)
    connection = e.db.scalar(select(IntegrationConnection).where(IntegrationConnection.owner_id == 2))
    connection.version += 1
    e.db.commit()
    with pytest.raises(WorkflowDenied, match='mismatch'):
        e.preview.synthetic_acquire(e.db, 2, now=e.now)


def test_foreign_job_outbox_binding_is_denied_before_work(linked_env):
    e = linked_env
    row, message = first_job(e)
    message.payload = {**message.payload, 'user_id': 2}
    e.db.commit()
    with pytest.raises(WorkflowDenied, match='binding'):
        e.preview.publish_governed_job(e.db, message.payload['job_id'], message.id, now=e.now)
    assert not list(e.db.scalars(select(SpendAttempt)))


@pytest.mark.parametrize('change', ['budget_owner', 'cancelled_job'])
def test_completed_receipt_rechecks_budget_and_actual_output(linked_env, change):
    e = linked_env
    receipt = complete_analysis(e)
    if change == 'budget_owner':
        e.db.scalar(select(SpendAttempt)).user_id = 2
    else:
        e.db.scalar(select(Job)).module_cancel_requested = True
    e.db.commit()
    with pytest.raises((BoundaryDenied, WorkflowDenied)):
        e.preview.completed_analysis(e.db, 1, receipt['workflow_id'], now=e.now)

