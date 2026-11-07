"""Actual backend lifespan must never activate the analysis dispatch ledger.

Persisted synthetic rows and real auth readiness/prompt seeding are exercised.
External broker/provider/managers are observed fail-closed fixture boundaries.
No worker or Beat process starts; this certifies backend startup only.
"""
import asyncio
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import app.models
from app.domains.auth.models import User, AuthSessionFamily, AuthRefreshIntent
from app.domains.jobs.models import Job
from app.domains.prompts.models import Prompt
from app.infrastructure.database.base import Base
from app.infrastructure.database.outbox.models import OutboxMessage
from app.infrastructure.database.outbox import dispatch


@compiles(JSONB, 'sqlite')
def sqlite_json(_type, compiler, **kwargs):
    return 'JSON'


def registered_analysis_relays(celery):
    """The wildcard task ROUTE is not a scheduled task or registered consumer."""
    prefix = 'app.infrastructure.database.outbox'
    return {
        'tasks': sorted(name for name in celery.tasks if name.startswith(prefix)),
        'beat': sorted(name for name, entry in celery.conf.beat_schedule.items()
                       if str(entry.get('task', '')).startswith(prefix)),
        'steps': sorted(str(step) for steps in celery.steps.values() for step in steps
                        if getattr(step, '__module__', '').startswith(prefix)),
    }


async def frozen_rows(sessions):
    async with sessions() as db:
        jobs = (await db.execute(select(Job).order_by(Job.id))).scalars().all()
        outbox = (await db.execute(select(OutboxMessage).order_by(OutboxMessage.job_id))).scalars().all()
        return deepcopy((
            [{column.key: getattr(job, column.key) for column in Job.__table__.columns} for job in jobs],
            [{column.key: getattr(row, column.key) for column in OutboxMessage.__table__.columns} for row in outbox],
        ))


@pytest.mark.asyncio
@pytest.mark.parametrize('recovery', [True, False], ids=['recovery', 'normal'])
async def test_backend_lifespan_does_not_register_start_or_drain_analysis_outbox(tmp_path, monkeypatch, recovery):
    monkeypatch.setenv('CREDX_RECOVERY_MODE', '1' if recovery else '0')
    from celery import Celery, Task
    from app.domains.ai_providers.factory import ProviderFactory
    from app.domains.jobs.tasks import execute_ai_job
    from app.infrastructure.messaging.celery_app import celery
    from app.domains.auth import session_startup
    from app.domains.recommendation_audit import outbox as audit_outbox
    import app.main as main

    engine = create_async_engine(f'sqlite+aiosqlite:///{tmp_path}/startup.db')
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as conn:
        await conn.run_sync(lambda c: Base.metadata.create_all(c, tables=[model.__table__ for model in
            (User, AuthSessionFamily, AuthRefreshIntent, Prompt, Job, OutboxMessage)]))
    async with sessions() as db:
        db.add(User(id=7, email='startup@example.invalid', username='synthetic', password_hash='unused'))
        for ident, state in enumerate(('pending', 'uncertain'), start=1):
            job = Job(id=ident, user_id=7, prompt='synthetic untouched backlog', provider='synthetic',
                      model='synthetic', status='pending', auto_rebalance_portfolio='india',
                      runtime_metadata_json={'synthetic_lineage': ident})
            db.add(job)
            await db.flush()
            obligation = dispatch.obligation(job)
            obligation.state = state
            obligation.attempts = 0 if state == 'pending' else 1
            obligation.claim_token = None if state == 'pending' else 'existing-uncertain-claim'
            db.add(obligation)
        await db.commit()

    spies = {
        'relay': AsyncMock(side_effect=AssertionError('backend launched analysis relay')),
        'dispatch': AsyncMock(side_effect=AssertionError('backend dispatched persisted job')),
        'publisher': MagicMock(side_effect=AssertionError('backend reached analysis publisher')),
        'celery_send': MagicMock(side_effect=AssertionError('backend published a task')),
        'task_apply': MagicMock(side_effect=AssertionError('backend enqueued a task')),
        'execute': MagicMock(side_effect=AssertionError('backend executed a job')),
        'provider': MagicMock(side_effect=AssertionError('backend created a provider')),
        'audit_service': MagicMock(side_effect=AssertionError('backend started audit relay service')),
        'audit_consumer': MagicMock(side_effect=AssertionError('backend started audit consumer relay')),
    }
    monkeypatch.setattr(dispatch, 'relay_pass', spies['relay'])
    monkeypatch.setattr(dispatch, 'dispatch_one', spies['dispatch'])
    monkeypatch.setattr(dispatch, 'celery_publisher', spies['publisher'])
    monkeypatch.setattr(Celery, 'send_task', spies['celery_send'])
    monkeypatch.setattr(Task, 'apply_async', spies['task_apply'])
    monkeypatch.setattr(execute_ai_job, 'run', spies['execute'])
    monkeypatch.setattr(ProviderFactory, 'create', spies['provider'])
    monkeypatch.setattr(audit_outbox.RelayService, 'start', spies['audit_service'])
    monkeypatch.setattr(audit_outbox.AuditOutboxRelay, 'start', spies['audit_consumer'])
    monkeypatch.setattr(main, 'AsyncSessionLocal', sessions)
    readiness = AsyncMock(wraps=session_startup.require_session_schema)
    seed = AsyncMock(wraps=main.seed_system_prompts)
    monkeypatch.setattr(session_startup, 'require_session_schema', readiness)
    monkeypatch.setattr(main, 'seed_system_prompts', seed)
    broker = SimpleNamespace(validate_startup=MagicMock())
    monkeypatch.setattr(main, 'get_bullpen_runtime_broker', lambda: broker)
    close_broker = AsyncMock()
    monkeypatch.setattr(main, 'close_bullpen_runtime_broker', close_broker)
    shutdowns = []
    for manager in (main.polymarket_bot_manager, main.polymarket_auto_live_bot_manager,
                    main.polymarket_direct_bot_manager):
        shutdown = AsyncMock()
        shutdowns.append(shutdown)
        monkeypatch.setattr(manager, 'shutdown', shutdown)
    dispose = AsyncMock()
    monkeypatch.setattr(main, 'async_engine', SimpleNamespace(dispose=dispose))

    before = await frozen_rows(sessions)
    assert registered_analysis_relays(celery) == {'tasks': [], 'beat': [], 'steps': []}
    try:
        # Twice proves repeated backend-only restart does not consume backlog.
        for _ in range(2):
            async with main.app.router.lifespan_context(main.app):
                await asyncio.sleep(0)
                assert await frozen_rows(sessions) == before
                assert registered_analysis_relays(celery) == {'tasks': [], 'beat': [], 'steps': []}
                for spy in spies.values():
                    spy.assert_not_called()
            assert await frozen_rows(sessions) == before
        assert readiness.await_count == seed.await_count == 2
        assert broker.validate_startup.call_count == 2
        assert close_broker.await_count == dispose.await_count == 2
        for shutdown in shutdowns:
            assert shutdown.await_count == 2
        async with sessions() as db:
            # Ordinary startup still performs real idempotent prompt seeding.
            prompts = (await db.execute(select(Prompt).where(Prompt.is_system.is_(True)))).scalars().all()
            assert prompts
            assert len({prompt.name for prompt in prompts}) == len(prompts)
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_analysis_relay_without_activation_never_reads_or_publishes():
    # No session API is provided: default-inactive must return before DB access.
    publisher = MagicMock(side_effect=AssertionError('inactive relay published'))
    assert await dispatch.relay_pass(object(), publisher) == {'blocked': True}
    assert await dispatch.relay_pass(object(), publisher, enabled=True) == {'blocked': True}
    assert await dispatch.relay_pass(object(), publisher, consumer_fence_verified=True) == {'blocked': True}
    publisher.assert_not_called()
