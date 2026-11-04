"""Opt-in PostgreSQL uniqueness/row-lock fixtures, never DATABASE_URL.

Uses the existing guard: explicitly acknowledged disposable LOCAL database,
random schema; no production migrations, provider or broker calls.
"""
import asyncio
from datetime import datetime, timezone
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import func, select

from test_auto_rebalance_audit_postgres import postgres_db, anyio_backend  # noqa: F401
from test_jobs_admission_dispatch import command, usecase
from app.domains.jobs import admission
from app.domains.jobs.models import Job
from app.domains.jobs.admission import JobAdmission
from app.infrastructure.database.base import Base
from app.infrastructure.database.outbox import dispatch
from app.infrastructure.database.outbox.models import OutboxMessage


@pytest.mark.anyio
async def test_postgres_concurrent_actor_identity_and_scheduled_dispatch(postgres_db, monkeypatch):
    async with postgres_db.engine.begin() as connection:
        await connection.run_sync(lambda db: Base.metadata.create_all(db, tables=[
            JobAdmission.__table__, OutboxMessage.__table__]))
    calls = []
    real_dispatch = dispatch.dispatch_one
    monkeypatch.setattr("app.infrastructure.messaging.task_registry.register_job_task", AsyncMock())
    async def initial(db, id): return await real_dispatch(db, id, lambda *args: calls.append(args))
    monkeypatch.setattr(dispatch, "dispatch_one", initial)
    original = admission.replay_admission
    first_reads, barrier = 0, asyncio.Event()
    async def synchronized(*args):
        nonlocal first_reads
        found = await original(*args)
        first_reads += 1
        if first_reads <= 2:
            if first_reads == 2: barrier.set()
            await asyncio.wait_for(barrier.wait(), 5)
        return found
    monkeypatch.setattr(admission, "replay_admission", synchronized)
    cmd = command(user_id=7, scheduled_at=datetime(2030, 1, 1, tzinfo=timezone.utc))
    async def create():
        async with postgres_db.sessions() as db: return await usecase(db).execute(cmd)
    a, b = await asyncio.gather(create(), create())
    assert a.job_id == b.job_id
    async with postgres_db.sessions() as db:
        assert await db.scalar(select(func.count()).select_from(Job)) == 1
        assert await db.scalar(select(func.count()).select_from(JobAdmission)) == 1
        assert await db.scalar(select(func.count()).select_from(OutboxMessage)) == 1
        assert (await db.get(Job, a.job_id)).scheduled_at == datetime(2030, 1, 1)
    assert len(calls) == 1
