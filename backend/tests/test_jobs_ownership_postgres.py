"""Current-main schema: actor ownership, cache replay and transaction rollback."""
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from sqlalchemy import func, inspect, select

from test_jobs_cancellation_postgres import cancel_postgres
from test_jobs_cache_ownership import Redis, command, usecase
from app.domains.auth.models import User
from app.domains.jobs.models import Job
from app.domains.jobs.repository import PostgresJobRepository
from app.infrastructure.database.base import Base
from app.infrastructure.database.outbox.models import OutboxMessage
from app.shared.pagination import PagedQuery
from app.shared.types import JobStatus


def schema(connection):
    db = inspect(connection)
    return {name: {"columns": [(c['name'],str(c['type']),c['nullable']) for c in db.get_columns(name)],
                   "indexes": db.get_indexes(name), "foreign_keys": db.get_foreign_keys(name)}
            for name in db.get_table_names()}


@pytest.mark.asyncio
async def test_pg_actor_cache_isolation_and_current_main_schema_preservation(cancel_postgres, monkeypatch):
    fixture = cancel_postgres
    from app.domains.jobs.tasks import execute_ai_job
    queue = Mock(return_value=SimpleNamespace(id="synthetic-pg-task"))
    monkeypatch.setattr(execute_ai_job, "delay", queue)
    monkeypatch.setattr("app.domains.jobs.use_cases.create_job.register_job_task", AsyncMock())
    async with fixture.engine.connect() as c: before_schema = await c.run_sync(schema)
    assert 'job_admissions' not in Base.metadata.tables
    assert set(OutboxMessage.__table__.columns.keys()) == {'id','topic','payload','created_at','published_at','attempts'}
    redis = Redis()
    async with fixture.sessions() as db:
        original = await db.get(Job, 1)
        legacy = deepcopy({key:getattr(original,key) for key in ('prompt','response','status','request_context_json','runtime_metadata_json')})
        db.add(User(id=2,email='other@example.invalid',username='synthetic-other',password_hash='unused'))
        await db.execute(select(func.setval(func.pg_get_serial_sequence('jobs','id'), 1000, True)))
        await db.commit()
        first = await usecase(db, redis).execute(command())
        owned = await db.get(Job, first.job_id)
        owned.status, owned.response = JobStatus.PARTIAL, 'original partial evidence'
        await db.commit()
        replay = await usecase(db, redis).execute(command())
        other = await usecase(db, redis).execute(command(user_id=2))
        assert replay.job_id == first.job_id and replay.status == JobStatus.PARTIAL
        assert first.job_id != other.job_id
        repo = PostgresJobRepository(db)
        assert (await repo.list_for_user(1,PagedQuery())).total == 2
        assert (await repo.list_for_user(2,PagedQuery())).total == 1
        assert await repo.get_for_user(first.job_id,2) is None
        assert await repo.get_for_user(999999,2) is None
        old = await db.get(Job,1,populate_existing=True)
        assert {key:getattr(old,key) for key in legacy} == legacy
        assert queue.call_count == 2
    async with fixture.engine.connect() as c: assert await c.run_sync(schema) == before_schema


@pytest.mark.asyncio
async def test_pg_rollback_retains_existing_job_and_schema_without_migration(cancel_postgres):
    fixture = cancel_postgres
    async with fixture.engine.connect() as c: before_schema = await c.run_sync(schema)
    async with fixture.sessions() as db:
        original = await db.get(Job,1)
        before = {key:deepcopy(getattr(original,key)) for key in ('prompt','response','status','export_status','request_context_json','runtime_metadata_json')}
        row, changed = await PostgresJobRepository(db).cancel_for_user(1,1)
        assert changed and row.status == JobStatus.FAILED
        await db.rollback()
    async with fixture.sessions() as db:
        old = await db.get(Job,1)
        assert {key:getattr(old,key) for key in before} == before
        assert await db.scalar(select(func.count()).select_from(Job)) == 1
    async with fixture.engine.connect() as c: assert await c.run_sync(schema) == before_schema
