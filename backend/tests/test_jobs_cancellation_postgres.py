"""Real two-session cancellation/completion races; opt-in disposable UNIX socket.

No DATABASE_URL, TCP, production identity, broker/provider or Alembic operation.
Run with the separately created synthetic socket + marker, or the existing
guarded disposable LOCAL CI PostgreSQL target. Absent acknowledgement: skip.
"""
import asyncio
import os
from pathlib import Path
from threading import Event
from types import SimpleNamespace
from uuid import uuid4
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
from sqlalchemy import create_engine, func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import Session
from sqlalchemy.schema import CreateSchema, DropSchema

import app.models  # noqa: F401
from app.core.config import settings
from app.domains.auth.models import User
from app.domains.jobs.execution_claim import KEY, admit, checkpoint, LostExecutionOwner
from app.domains.jobs.models import Job
from app.domains.jobs.repository import SyncJobRepository
from app.domains.jobs.router import cancel_job
from app.infrastructure.database.base import Base
from app.infrastructure.database.outbox.models import OutboxMessage
from app.shared.types import JobStatus

SOCKET = "/tmp/jobs-cancel-pg-socket"
MARKER = Path("/tmp/jobs-cancel-pgdata/JOBS_SYNTHETIC_ONLY")
PORT = 55439


@pytest_asyncio.fixture
async def cancel_postgres(monkeypatch):
    socket_mode = os.getenv("CREDX_JOBS_CANCEL_PG_TEST") == "synthetic-socket-only"
    target = None
    if socket_mode:
        if not MARKER.is_file() or not Path(SOCKET, f".s.PGSQL.{PORT}").is_socket():
            pytest.fail("acknowledged synthetic PostgreSQL marker/socket missing")
    elif os.getenv("CREDX_AUDIT_TEST_DATABASE_URL"):
        from test_auto_rebalance_audit_postgres import guarded_test_url
        target = guarded_test_url(os.environ["CREDX_AUDIT_TEST_DATABASE_URL"],
                                 os.getenv("CREDX_AUDIT_TEST_DATABASE_ACK"))
    else:
        pytest.skip("explicit disposable PostgreSQL fixture not acknowledged")
    monkeypatch.setenv("CREDX_RECOVERY_MODE", "0")
    monkeypatch.setattr(settings, "recommendation_audit_enabled", False)
    revoke = AsyncMock()
    monkeypatch.setattr("app.domains.jobs.router.revoke_registered_job_task", revoke)
    monkeypatch.setattr("app.domains.jobs.tasks._publish_job_update", lambda job: None)
    schema = "jobs_cancel_test_" + uuid4().hex
    asynchronous_options = {"server_settings": {"search_path": schema, "statement_timeout": "15000"}}
    synchronous_options = {"options": f"-csearch_path={schema} -cstatement_timeout=15000"}
    if socket_mode:
        asynchronous_options.update(host=SOCKET, port=PORT)
        synchronous_options.update(host=SOCKET, port=PORT)
    engine = create_async_engine(target if target is not None else "postgresql+asyncpg://synthetic@/postgres",
                                 connect_args=asynchronous_options)
    sync = create_engine(target.set(drivername="postgresql+psycopg2") if target is not None
                         else "postgresql+psycopg2://synthetic@/postgres", connect_args=synchronous_options)
    async with engine.begin() as db:
        await db.execute(CreateSchema(schema))
        await db.run_sync(lambda c: Base.metadata.create_all(c, tables=[
            User.__table__, Job.__table__, OutboxMessage.__table__]))
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as db:
        db.add(User(id=1, email="owner@example.invalid", username="synthetic", password_hash="unused"))
        await db.flush()
        db.add(Job(id=1, user_id=1, prompt="synthetic race", provider="fixture", model="fixture",
                   status=JobStatus.PROCESSING, export_status="pending",
                   request_context_json={"source": "synthetic-frozen-input"},
                   runtime_metadata_json={"evidence": "retain"}))
        await db.commit()
    try:
        yield SimpleNamespace(engine=engine, sync=sync, sessions=sessions, revoke=revoke)
    finally:
        sync.dispose()
        async with engine.begin() as db: await db.execute(DropSchema(schema, cascade=True))
        await engine.dispose()


async def thread_event(event):
    assert await asyncio.to_thread(event.wait, 10), "barrier timed out"


async def assert_waiting_for_row_lock(engine, pid):
    """Require actual PostgreSQL lock contention, not just task scheduling."""
    async with engine.connect() as observer:
        for _ in range(500):
            if await observer.scalar(select(func.cardinality(func.pg_blocking_pids(pid)))):
                return
            await asyncio.sleep(0.01)
    pytest.fail("second session never blocked on the first transaction")


@pytest.mark.asyncio
@pytest.mark.parametrize("claimed", [False, True])
async def test_completion_commit_wins_over_stale_api_cancellation(cancel_postgres, claimed):
    fixture = cancel_postgres
    token = None
    if claimed:
        with Session(fixture.sync) as db:
            token = admit(db, 1, 'synthetic-combined-delivery')
            assert token
            checkpoint(db, 1, token, provider_started=True)
    completion_locked, release_completion = Event(), Event()
    class CompletionSession(Session):
        def commit(self):
            self.flush()
            completion_locked.set()
            assert release_completion.wait(10), "completion release timed out"
            super().commit()
    def complete():
        with CompletionSession(fixture.sync, expire_on_commit=False) as db:
            job = db.get(Job, 1)
            repo = SyncJobRepository(db)
            if token: repo.execution_token = token
            repo.update_status(job, JobStatus.COMPLETED,
                response="immutable completed result", tokens_in=11, tokens_out=19,
                estimated_cost=0.125, runtime_metadata_json={"evidence": "completed", **({KEY: {"owner_token": "forged"}} if claimed else {})})
    async with fixture.sessions() as api:
        stale = await api.get(Job, 1)
        assert stale.status == JobStatus.PROCESSING
        api_pid = await api.scalar(select(func.pg_backend_pid()))
        stale.response = "dirty stale API output must never autoflush"
        worker = asyncio.create_task(asyncio.to_thread(complete))
        await thread_event(completion_locked)
        cancellation = asyncio.create_task(cancel_job(1, api, SimpleNamespace(id=1)))
        try:
            await assert_waiting_for_row_lock(fixture.engine, api_pid)
        finally:
            release_completion.set()
        await worker
        returned = await cancellation
        assert returned.status == JobStatus.COMPLETED
        assert returned.response == "immutable completed result"
        assert (returned.tokens_in, returned.tokens_out, returned.estimated_cost) == (11, 19, 0.125)
        assert returned.error_message is None and returned.export_status == "pending"
        assert returned.request_context_json == {"source": "synthetic-frozen-input"}
        assert returned.runtime_metadata_json["evidence"] == "completed"
        if claimed:
            record = returned.runtime_metadata_json[KEY]
            assert record["owner_token"] == token and record["state"] == "finished"
            assert record["provider_started"] is True
        else:
            assert returned.runtime_metadata_json == {"evidence": "completed"}
        fixture.revoke.assert_not_awaited()
    async with fixture.sessions() as db:
        final = await db.get(Job, 1)
        assert final.status == JobStatus.COMPLETED and final.response == "immutable completed result"


@pytest.mark.asyncio
@pytest.mark.parametrize("claimed", [False, True])
async def test_cancellation_commit_wins_over_stale_worker_completion(cancel_postgres, claimed):
    fixture = cancel_postgres
    token = None
    if claimed:
        with Session(fixture.sync) as db:
            token = admit(db, 1, 'synthetic-combined-delivery')
            assert token
            checkpoint(db, 1, token, provider_started=True)
    stale_loaded, publish_completion, completion_attempted = Event(), Event(), Event()
    cancellation_written, release_cancellation = asyncio.Event(), asyncio.Event()
    worker_pid = []
    class CancellationSession(AsyncSession):
        async def commit(self):
            cancellation_written.set()
            await asyncio.wait_for(release_cancellation.wait(), 10)
            await super().commit()
    def complete():
        with Session(fixture.sync, expire_on_commit=False) as db:
            job = db.get(Job, 1)
            assert job.status == JobStatus.PROCESSING
            worker_pid.append(db.scalar(select(func.pg_backend_pid())))
            stale_loaded.set()
            assert publish_completion.wait(10), "stale worker release timed out"
            completion_attempted.set()
            job.response = "dirty stale worker output must never autoflush"
            repo = SyncJobRepository(db)
            if token: repo.execution_token = token
            if claimed:
                with pytest.raises(LostExecutionOwner):
                    repo.update_status(job, JobStatus.COMPLETED, response="stale result must not replace cancellation", tokens_in=99, runtime_metadata_json={"evidence": "stale-worker"})
            else:
                repo.update_status(job, JobStatus.COMPLETED, response="stale result must not replace cancellation", tokens_in=99, runtime_metadata_json={"evidence": "stale-worker"})
            assert job.status == JobStatus.FAILED
            assert job.response is None
    worker = asyncio.create_task(asyncio.to_thread(complete))
    await thread_event(stale_loaded)
    async with CancellationSession(fixture.engine, expire_on_commit=False) as api:
        cancellation = asyncio.create_task(cancel_job(1, api, SimpleNamespace(id=1)))
        await asyncio.wait_for(cancellation_written.wait(), 10)
        publish_completion.set()
        await thread_event(completion_attempted)
        try:
            await assert_waiting_for_row_lock(fixture.engine, worker_pid[0])
        finally:
            release_cancellation.set()
        returned = await cancellation
        await worker
        assert returned.status == JobStatus.FAILED and returned.error_message == "Cancelled by user"
        fixture.revoke.assert_awaited_once_with(1)
    async with fixture.sessions() as db:
        final = await db.get(Job, 1)
        assert final.status == JobStatus.FAILED and final.error_message == "Cancelled by user"
        assert final.response is None and final.tokens_in is None
        assert final.export_status == "failed" and final.export_error == "Cancelled by user"
        assert final.request_context_json == {"source": "synthetic-frozen-input"}
        assert final.runtime_metadata_json["evidence"] == "retain"
        if claimed:
            assert final.runtime_metadata_json[KEY]["owner_token"] == token
            assert final.runtime_metadata_json[KEY]["provider_started"] is True
        else:
            assert final.runtime_metadata_json == {"evidence": "retain"}


@pytest.mark.asyncio
@pytest.mark.parametrize('token_kind', ['missing', 'wrong', 'expired'])
async def test_claimed_result_rejects_missing_wrong_and_expired_tokens(cancel_postgres, token_kind):
    fixture = cancel_postgres
    with Session(fixture.sync, expire_on_commit=False) as db:
        token = admit(db, 1, 'combined-negative-delivery')
        checkpoint(db, 1, token, provider_started=True)
        job = db.get(Job, 1)
        if token_kind == 'expired':
            job.runtime_metadata_json = {**job.runtime_metadata_json, KEY: {
                **job.runtime_metadata_json[KEY], 'expires_at': 0}}
            db.commit()
        repo = SyncJobRepository(db)
        if token_kind != 'missing': repo.execution_token = 'wrong-owner' if token_kind == 'wrong' else token
        job.response = 'dirty rejected output must not autoflush'
        with pytest.raises(LostExecutionOwner):
            repo.update_status(job, JobStatus.COMPLETED, response='rejected', tokens_in=99,
                               runtime_metadata_json={KEY: {'owner_token': 'forged'}, 'evidence': 'forged'})
        db.refresh(job)
        assert job.status == JobStatus.PROCESSING and job.response is None and job.tokens_in is None
        assert job.runtime_metadata_json['evidence'] == 'retain'
        assert job.runtime_metadata_json[KEY]['owner_token'] == token
        assert job.runtime_metadata_json[KEY]['provider_started'] is True


@pytest.mark.asyncio
async def test_owner_and_null_owner_scopes_cannot_expose_or_cancel_other_jobs(cancel_postgres):
    from app.domains.jobs.repository import PostgresJobRepository
    fixture = cancel_postgres
    async with fixture.sessions() as db:
        db.add(Job(id=2, user_id=None, prompt='synthetic legacy orphan', provider='fixture',
                   model='fixture', status=JobStatus.PROCESSING, response='private orphan'))
        await db.commit()
        repo = PostgresJobRepository(db)
        assert await repo.get_for_user(1, None) is None
        assert await repo.get_for_user(1, 999) is None
        assert await repo.get_for_user(2, 1) is None
        assert await repo.cancel_for_user(1, None) == (None, False)
        assert await repo.cancel_for_user(1, 999) == (None, False)
        assert await repo.cancel_for_user(2, 1) == (None, False)
        owner = await repo.get_for_user(1, 1)
        assert owner.id == 1 and owner.dispatch_status is None
        await db.rollback()
    async with fixture.sessions() as db:
        assert (await db.get(Job, 1)).status == JobStatus.PROCESSING
        orphan = await db.get(Job, 2)
        assert orphan.status == JobStatus.PROCESSING and orphan.response == 'private orphan'
    fixture.revoke.assert_not_awaited()


@pytest.mark.asyncio
async def test_owner_scoped_diagnostics_preserve_claim_through_fenced_completion(cancel_postgres):
    from app.domains.jobs.repository import PostgresJobRepository
    fixture = cancel_postgres
    with Session(fixture.sync) as db:
        token = admit(db, 1, 'combined-diagnostics-delivery')
        checkpoint(db, 1, token, provider_started=True)
    async with fixture.sessions() as db:
        repo = PostgresJobRepository(db)
        owned = await repo.get_for_user(1, 1)
        assert owned.id == 1
        await repo.update_status(1, JobStatus.PROCESSING, runtime_metadata_json={
            'diagnostic': 'retained', KEY: {'owner_token': 'forged'}})
        await db.commit()
    with Session(fixture.sync, expire_on_commit=False) as db:
        job = db.get(Job, 1)
        assert job.runtime_metadata_json[KEY]['owner_token'] == token
        repo = SyncJobRepository(db); repo.execution_token = token
        repo.update_status(job, JobStatus.COMPLETED, response='synthetic owned output',
                           tokens_in=4, tokens_out=6, estimated_cost=.01,
                           runtime_metadata_json={'terminal_evidence': 'retained', KEY: {'owner_token': 'forged-again'}})
        assert job.status == JobStatus.COMPLETED
        assert job.runtime_metadata_json['evidence'] == 'retain'
        assert job.runtime_metadata_json['diagnostic'] == 'retained'
        assert job.runtime_metadata_json['terminal_evidence'] == 'retained'
        assert job.runtime_metadata_json[KEY]['owner_token'] == token
        assert job.runtime_metadata_json[KEY]['state'] == 'finished'
        assert job.runtime_metadata_json[KEY]['provider_started'] is True
