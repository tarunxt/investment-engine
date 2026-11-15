"""Actual creation/cache lifecycle with synthetic DB, Redis and task publication."""
from contextlib import asynccontextmanager
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
import json

import pytest
from sqlalchemy import func, select

from test_jobs_admission_dispatch import database
from app.domains.jobs.creation_identity import OPERATION, payload_fingerprint, request_key
from app.domains.jobs.models import Job
from app.domains.jobs.use_cases.create_job import CreateJobCommand, CreateJobUseCase
from app.infrastructure.messaging.idempotency import IdempotencyStore
from app.shared.exceptions import ConflictException, NotFoundException
from app.shared.types import JobStatus


class Redis:
    def __init__(self): self.values = {}
    async def get(self, key): return self.values.get(key)
    async def setex(self, key, ttl, data): self.values[key] = data


class Lock:
    @asynccontextmanager
    async def acquire(self, *args, **kwargs): yield


def command(**fields):
    return replace(CreateJobCommand(prompt="synthetic request", provider="fixture", model="model", user_id=1,
                                    idempotency_key="same-key"), **fields)


def usecase(db, redis):
    return CreateJobUseCase(db, SimpleNamespace(publish=AsyncMock()), Lock(), IdempotencyStore(redis))


@pytest.fixture
def queue(monkeypatch):
    from app.infrastructure.database.outbox import dispatch
    calls = Mock()
    real_dispatch = dispatch.dispatch_one
    async def publish(db, message_id):
        return await real_dispatch(db, message_id, calls)
    monkeypatch.setattr(dispatch, "dispatch_one", publish)
    monkeypatch.setattr("app.infrastructure.messaging.task_registry.register_job_task", AsyncMock())
    return calls


@pytest.mark.asyncio
async def test_cache_miss_hit_and_actor_or_payload_changes(database, queue):
    redis = Redis()
    redis.values['idem:same-key'] = json.dumps({"job_id": 9999, "status": "completed"})
    async with database() as db:
        first = await usecase(db, redis).execute(command())
        job = await db.get(Job, first.job_id)
        job.status, job.response = JobStatus.PARTIAL, "preserved partial evidence"
        await db.commit()
        replay = await usecase(db, redis).execute(command())
        assert replay.job_id == first.job_id and replay.status == JobStatus.PARTIAL
        assert (await db.get(Job, first.job_id)).response == "preserved partial evidence"
        for changes in ({"model": "other"}, {"provider": "other"}, {"auto_rebalance_portfolio": "india"},
                        {"prompt": "changed"}, {"scheduled_at": datetime(2030,1,1,tzinfo=timezone.utc)}):
            with pytest.raises(ConflictException): await usecase(db, redis).execute(command(**changes))
        second = await usecase(db, redis).execute(command(user_id=2))
        assert second.job_id != first.job_id
        assert await db.scalar(select(func.count()).select_from(Job)) == 2
        assert queue.call_count == 2
        bound = json.loads(redis.values['idem:' + request_key(1, OPERATION, 'same-key')])
        assert bound['actor_id'] == 1 and bound['operation'] == OPERATION
        assert bound['payload_fingerprint'] == payload_fingerprint(command())


@pytest.mark.asyncio
@pytest.mark.parametrize("cached_id", [900, 999])
async def test_stale_foreign_and_missing_cache_ids_never_authorize_replay(database, queue, cached_id):
    redis = Redis()
    async with database() as db:
        db.add(Job(id=900, user_id=2, prompt="foreign synthetic", provider="fixture", model="model"))
        await db.commit()
        await IdempotencyStore(redis).set_for_request(1, OPERATION, 'same-key', payload_fingerprint(command()), {'job_id': cached_id})
        created = await usecase(db, redis).execute(command())
        assert created.job_id not in {900, 999}
        assert (await db.get(Job, created.job_id)).user_id == 1
        assert (await db.get(Job, 900)).user_id == 2
        assert queue.call_count == 1
        assert await db.scalar(select(func.count()).select_from(Job)) == 2


@pytest.mark.asyncio
async def test_owned_but_wrong_payload_cache_id_is_not_replayed(database, queue):
    redis = Redis()
    async with database() as db:
        db.add(Job(id=901, user_id=1, prompt="different synthetic", provider="fixture", model="model"))
        await db.commit()
        await IdempotencyStore(redis).set_for_request(1, OPERATION, 'same-key', payload_fingerprint(command()), {'job_id': 901})
        created = await usecase(db, redis).execute(command())
        assert created.job_id != 901
        assert (await db.get(Job, created.job_id)).prompt == command().prompt
        assert (await db.get(Job, 901)).prompt == "different synthetic"
        assert queue.call_count == 1


@pytest.mark.asyncio
async def test_broker_failure_keeps_bound_id_and_retry_does_not_dispatch(database, queue):
    redis = Redis()
    queue.side_effect = TimeoutError("synthetic broker acknowledgement ambiguity")
    async with database() as db:
        with pytest.raises(TimeoutError): await usecase(db, redis).execute(command())
        replay = await usecase(db, redis).execute(command())
        assert replay.status == JobStatus.PENDING
        assert queue.call_count == 1
        assert await db.scalar(select(func.count()).select_from(Job)) == 1


def test_normalized_schedule_and_cache_identity_are_explicit():
    base = command(scheduled_at=datetime(2030,1,1,tzinfo=timezone.utc))
    equivalent = replace(base, scheduled_at=datetime(2030,1,1,2,tzinfo=timezone(timedelta(hours=2))))
    assert payload_fingerprint(base) == payload_fingerprint(equivalent)
    assert request_key(1, OPERATION, 'same-key') != request_key(2, OPERATION, 'same-key')
    assert request_key(1, OPERATION, 'same-key') != request_key(1, 'different.operation', 'same-key')
    assert 'same-key' not in request_key(1, OPERATION, 'same-key')


@pytest.mark.asyncio
async def test_cache_outage_cannot_block_durable_creation_or_authorize_replay(database, queue):
    redis = Redis()
    redis.get = AsyncMock(side_effect=ConnectionError("synthetic cache unavailable"))
    async with database() as db:
        first = await usecase(db, redis).execute(command())
        replay = await usecase(db, redis).execute(command())
        assert replay.job_id == first.job_id
        redis.get.assert_not_awaited()
        assert await db.scalar(select(func.count()).select_from(Job)) == 1
        assert queue.call_count == 1


@pytest.mark.asyncio
@pytest.mark.parametrize('state', list(JobStatus))
async def test_every_existing_state_replays_current_owned_job(database, queue, state):
    redis = Redis()
    async with database() as db:
        first = await usecase(db, redis).execute(command())
        existing = await db.get(Job, first.job_id)
        existing.status = state
        existing.response = 'retained synthetic output'
        existing.error_message = 'Cancelled by user' if state == JobStatus.FAILED else None
        await db.commit()
        replay = await usecase(db, redis).execute(command())
        assert replay.job_id == first.job_id and replay.status == state
        assert (await db.get(Job, first.job_id)).response == 'retained synthetic output'
        assert queue.call_count == 1
