"""Synthetic component/lifecycle tests: no broker, Redis, provider or account I/O."""
import asyncio
from contextlib import asynccontextmanager
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import app.models  # metadata registration, no connections
from app.domains.auth.models import User
from app.domains.jobs.admission import JobAdmission, request_identity
from app.domains.jobs.models import Job
from app.domains.jobs.repository import PostgresJobRepository
from app.domains.jobs.use_cases.create_job import CreateJobCommand, CreateJobUseCase
from app.domains.prompts.models import Prompt
from app.domains.runs.models import Run, RunJob
from app.domains.runs.use_cases import create_run as runs
from app.infrastructure.database.base import Base
from app.infrastructure.database.outbox import dispatch
from app.infrastructure.database.outbox.models import OutboxMessage
from app.shared.exceptions import ConflictException, NotFoundException
from app.shared.pagination import PagedQuery
from app.shared.types import JobStatus


@compiles(JSONB, "sqlite")
def sqlite_jsonb(_type, compiler, **kw):
    return "JSON"


@pytest_asyncio.fixture
async def database(tmp_path, monkeypatch):
    monkeypatch.setenv("CREDX_RECOVERY_MODE", "0")
    monkeypatch.setattr("app.infrastructure.messaging.task_registry.register_job_task", AsyncMock())
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/synthetic.db", connect_args={"timeout": 10})
    async with engine.begin() as conn:
        await conn.run_sync(lambda c: Base.metadata.create_all(c, tables=[m.__table__ for m in
            (User, Prompt, Job, Run, RunJob, JobAdmission, OutboxMessage)]))
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as db:
        for id in (1, 2):
            db.add(User(id=id, email=f"actor{id}@example.invalid", username=f"actor{id}", password_hash="synthetic"))
        await db.commit()
    yield sessions
    await engine.dispose()


class DeadCache:
    async def get(self, key):
        raise AssertionError("Cache must never authorize replay")
    async def set(self, *args):
        raise ConnectionError("synthetic Redis unavailable")


def command(**kwargs):
    return replace(CreateJobCommand(prompt="synthetic request", provider="fixture", model="fixture-model",
                                    user_id=1, idempotency_key="same-key"), **kwargs)


def usecase(db, cache=None):
    # Admission does not depend on a Redis lease or prompt prefix.
    return CreateJobUseCase(db, SimpleNamespace(publish=AsyncMock()), None, cache or DeadCache())


@pytest.mark.asyncio
async def test_admission_cache_loss_terminal_replay_actor_and_payload(database, monkeypatch):
    calls = []
    real = dispatch.dispatch_one
    async def initial(db, id):
        return await real(db, id, lambda *args: calls.append(args))
    monkeypatch.setattr(dispatch, "dispatch_one", initial)
    async with database() as db:
        first = await usecase(db).execute(command())
        job = await db.get(Job, first.job_id)
        job.status, job.response = JobStatus.PARTIAL, "preserved partial result"
        await db.commit()
        replay = await usecase(db).execute(command())
        assert (replay.job_id, replay.status) == (first.job_id, JobStatus.PARTIAL)
        assert (await db.get(Job, first.job_id)).response == "preserved partial result"
        for changed in ({"model": "different"}, {"auto_rebalance_portfolio": "india"},
                        {"scheduled_at": datetime(2030, 1, 1, tzinfo=timezone.utc)}):
            with pytest.raises(ConflictException):
                await usecase(db).execute(command(**changed))
        other = await usecase(db).execute(command(user_id=2))
        assert other.job_id != first.job_id
        assert await db.scalar(select(func.count()).select_from(JobAdmission)) == 2
        assert await db.scalar(select(func.count()).select_from(OutboxMessage)) == 2
        assert len(calls) == 2
        assert calls[0][1] != calls[1][1]


def test_normalized_identity_binds_every_relevant_field():
    base = command(scheduled_at=datetime(2030, 1, 1, tzinfo=timezone.utc))
    equivalent = replace(base, scheduled_at=datetime(2030, 1, 1, 2, tzinfo=timezone(timedelta(hours=2))))
    assert request_identity(base) == request_identity(equivalent)
    assert request_identity(base)[2] != request_identity(replace(base, user_id=2))[2]
    assert request_identity(base)[2] != request_identity(replace(base, prompt="changed"))[2]


@pytest.mark.asyncio
async def test_lost_response_publish_failure_and_replay_do_not_republish(database, monkeypatch):
    real = dispatch.dispatch_one
    calls = []
    def accepted_then_timeout(*args):
        calls.append(args)
        raise TimeoutError("synthetic broker ack lost")
    async def initial(db, id): return await real(db, id, accepted_then_timeout)
    monkeypatch.setattr(dispatch, "dispatch_one", initial)
    async with database() as db:
        with pytest.raises(TimeoutError): await usecase(db).execute(command())
        row = (await db.execute(select(OutboxMessage))).scalar_one()
        assert row.state == "uncertain" and row.published_at is None
        replay = await usecase(db).execute(command())
        assert replay.job_id == row.job_id and len(calls) == 1
        assert await dispatch.relay_pass(db, accepted_then_timeout) == {"blocked": True}
        assert await db.scalar(select(func.count()).select_from(Job)) == 1


@pytest.mark.asyncio
async def test_concurrent_same_key_one_durable_job(database, monkeypatch):
    calls = []
    real = dispatch.dispatch_one
    async def initial(db, id): return await real(db, id, lambda *args: calls.append(args))
    monkeypatch.setattr(dispatch, "dispatch_one", initial)
    # Both execute their first admission lookup before either inserts.
    from app.domains.jobs import admission
    original = admission.replay_admission
    barrier, count = asyncio.Event(), 0
    async def synchronized(*args):
        nonlocal count
        found = await original(*args)
        count += 1
        if count <= 2:
            if count == 2: barrier.set()
            await barrier.wait()
        return found
    monkeypatch.setattr(admission, "replay_admission", synchronized)
    async def create():
        async with database() as db: return await usecase(db).execute(command())
    results = await asyncio.gather(create(), create())
    assert results[0].job_id == results[1].job_id
    async with database() as db:
        assert await db.scalar(select(func.count()).select_from(Job)) == 1
        assert await db.scalar(select(func.count()).select_from(OutboxMessage)) == 1
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_owner_query_filters_pagination_and_http(database, monkeypatch):
    from fastapi import FastAPI, HTTPException
    from httpx import ASGITransport, AsyncClient
    from app.domains.jobs.router import router
    from app.domains.auth.dependencies import get_current_user
    from app.infrastructure.database.session import get_async_db
    async with database() as db:
        for actor in (1, 2):
            for status in JobStatus:
                db.add(Job(user_id=actor, prompt="preserve searchable evidence", provider="fixture", model="fixture", status=status))
        await db.commit()
        repo = PostgresJobRepository(db)
        own = await repo.list_for_user(1, PagedQuery(page=1, limit=1), search="evidence")
        foreign_id = (await repo.list_for_user(2, PagedQuery())).items[0].id
        assert own.total == len(JobStatus) and len(own.items) == 1
        assert await repo.get_for_user(foreign_id, 1) is None
        assert await repo.get_for_user(999999, 1) is None
        filtered = await repo.list_for_user(1, PagedQuery(), status=JobStatus.PARTIAL)
        assert filtered.total == 1 and filtered.items[0].status == JobStatus.PARTIAL
    app = FastAPI(); app.include_router(router)
    async def session():
        async with database() as db: yield db
    app.dependency_overrides[get_async_db] = session
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id=1)
    async with AsyncClient(transport=ASGITransport(app), base_url="http://synthetic") as client:
        for id in (foreign_id, 999999):
            result = await client.get(f"/jobs/{id}")
            assert result.status_code == 404 and result.json() == {"detail": "Job not found"}
        assert (await client.get("/jobs?limit=100")).json()["total"] == len(JobStatus)
        assert (await client.get("/jobs?limit=101")).status_code == 422
        assert (await client.get("/jobs?status=unknown")).status_code == 400
        assert (await client.post(f"/jobs/{foreign_id}/cancel")).status_code == 404
        def anonymous(): raise HTTPException(401, "Unauthorized")
        app.dependency_overrides[get_current_user] = anonymous
        assert (await client.get("/jobs")).status_code == 401
        assert (await client.get(f"/jobs/{foreign_id}")).status_code == 401


@pytest.mark.asyncio
async def test_fanout_partial_failure_stagger_and_resume_only_missing(database, monkeypatch):
    targets = [runs.RunModelTarget("gemini", "fixture-1"), runs.RunModelTarget("gemini", "fixture-2"),
               runs.RunModelTarget("fixture", "fixture-3")]
    monkeypatch.setattr(runs, "filter_recently_available_targets", AsyncMock(return_value=(targets, [])))
    monkeypatch.setattr(runs, "freeze_output_source_context", AsyncMock(return_value=None))
    calls = []
    def partial(job_id, task_id, eta):
        calls.append((job_id, task_id, eta))
        if len(calls) == 2: raise ConnectionError("synthetic second publication failed")
    async def initial(db, id): return await dispatch.dispatch_one(db, id, partial)
    monkeypatch.setattr(runs, "dispatch_one", initial)
    class Lock:
        @asynccontextmanager
        async def acquire(self, *args, **kwargs): yield
    async with database() as db:
        with pytest.raises(ConnectionError):
            await runs.CreateRunUseCase(db, Lock()).execute(runs.CreateRunCommand(
                prompt="synthetic", targets=targets, user_id=1, allow_parallel=True))
        rows = list((await db.execute(select(OutboxMessage).order_by(OutboxMessage.job_id))).scalars())
        assert [r.state for r in rows] == ["delivered", "uncertain", "pending"]
        assert await db.scalar(select(func.count()).select_from(Run)) == 1
        assert await db.scalar(select(func.count()).select_from(RunJob)) == 3
        etas = [datetime.fromisoformat(r.payload["eta"]) for r in rows]
        assert (etas[1] - etas[0]).total_seconds() == 20
        delivered = []
        result = await dispatch.relay_pass(db, lambda *args: delivered.append(args), enabled=True,
            consumer_fence_verified=True, now=dispatch.utcnow()+timedelta(minutes=10))
        assert result == {"delivered": 2, "uncertain": 0}
        assert [v[0] for v in delivered] == [rows[1].job_id, rows[2].job_id]
        assert delivered[0][1] == calls[1][1]  # stable ID after uncertain acceptance
        assert delivered[0][2] == etas[1]  # expired ETA retained
        assert (await dispatch.relay_pass(db, lambda *args: pytest.fail("duplicate"), enabled=True,
            consumer_fence_verified=True))["delivered"] == 0


@pytest.mark.asyncio
async def test_terminal_suppression_dead_letter_and_commit_before_publish(database):
    async with database() as db:
        jobs = [Job(user_id=1, prompt="synthetic", provider="fixture", model="fixture", status=s)
                for s in (JobStatus.FAILED, JobStatus.PENDING)]
        db.add_all(jobs); await db.flush()
        messages = [dispatch.obligation(j) for j in jobs]
        messages[1].attempts = dispatch.MAX_ATTEMPTS
        db.add_all(messages); await db.commit()
        ids = [m.id for m in messages]
        for id in ids:
            assert not await dispatch.dispatch_one(db, id, lambda *a: pytest.fail("must not publish"))
        assert [r.state for r in (await db.execute(select(OutboxMessage).order_by(OutboxMessage.job_id))).scalars()] == ["suppressed", "dead_letter"]
        job = Job(user_id=1, prompt="synthetic", provider="fixture", model="fixture", status=JobStatus.PENDING)
        db.add(job); await db.flush(); row = dispatch.obligation(job); db.add(row); await db.commit()
        id = row.id
        with pytest.MonkeyPatch.context() as patch:
            patch.setattr(db, "commit", AsyncMock(side_effect=ConnectionError("synthetic DB commit failure")))
            with pytest.raises(ConnectionError):
                await dispatch.dispatch_one(db, id, lambda *a: pytest.fail("no broker before commit"))
        await db.rollback()


@pytest.mark.asyncio
async def test_crash_after_acceptance_ack_db_failure_and_stale_cache(database, monkeypatch):
    async with database() as db:
        job = Job(user_id=1, prompt="synthetic", provider="fixture", model="fixture", status=JobStatus.PENDING)
        db.add(job); await db.flush(); row = dispatch.obligation(job); db.add(row); await db.commit()
        id, job_id = row.id, job.id
        class SyntheticProcessDeath(BaseException): pass
        def crash(*args): raise SyntheticProcessDeath()
        with pytest.raises(SyntheticProcessDeath): await dispatch.dispatch_one(db, id, crash)
        await db.rollback()
        row = await db.get(OutboxMessage, id)
        assert row.state == "uncertain" and row.attempts == 1
        assert not await dispatch.dispatch_one(db, id, lambda *a: pytest.fail("unfenced replay"))
        await db.rollback()
        row = await db.get(OutboxMessage, id)
        row.state, row.next_attempt_at = "pending", None
        await db.commit()
        commit = db.commit
        commits = 0
        async def fail_ack_commit():
            nonlocal commits
            commits += 1
            if commits == 2: raise ConnectionError("synthetic acknowledgement commit lost")
            await commit()
        monkeypatch.setattr(db, "commit", fail_ack_commit)
        accepted = []
        with pytest.raises(ConnectionError):
            await dispatch.dispatch_one(db, id, lambda *a: accepted.append(a))
        await db.rollback()
        assert len(accepted) == 1
        assert (await db.get(OutboxMessage, id)).state == "uncertain"
        owned = await PostgresJobRepository(db).get_for_user(job_id, 1)
        assert owned.dispatch_status == "uncertain"


@pytest.mark.asyncio
async def test_foreign_and_missing_websocket_never_subscribe(database, monkeypatch):
    from app.domains.jobs import ws_router
    async with database() as db:
        db.add(Job(id=900, user_id=2, prompt="foreign secret", provider="fixture", model="fixture"))
        await db.commit()
    monkeypatch.setattr(ws_router, "AsyncSessionLocal", database)
    monkeypatch.setattr(ws_router, "user_id_from_ws_token", AsyncMock(return_value=1))
    relay = AsyncMock()
    monkeypatch.setattr(ws_router, "relay_channel", relay)
    for id in (900, 999):
        socket = SimpleNamespace(accept=AsyncMock(), close=AsyncMock(), send_json=AsyncMock())
        await ws_router.ws_job_detail(socket, id, "synthetic-token")
        socket.close.assert_awaited_once_with(code=1008, reason="Job unavailable")
        socket.send_json.assert_not_awaited()
        relay.assert_not_awaited()
    monkeypatch.setattr(ws_router, "user_id_from_ws_token", AsyncMock(return_value=None))
    socket = SimpleNamespace(close=AsyncMock(), accept=AsyncMock())
    await ws_router.ws_job_detail(socket, 900, None)
    socket.accept.assert_not_awaited()


@pytest.mark.asyncio
async def test_recovery_relay_blocks_non_equity_and_legacy_topics(database, monkeypatch):
    from app.core.recovery import RecoveryBlocked
    monkeypatch.setenv("CREDX_RECOVERY_MODE", "1")
    async with database() as db:
        job = Job(user_id=1, prompt="synthetic", provider="fixture", model="fixture", status=JobStatus.PENDING)
        db.add(job); await db.flush(); message = dispatch.obligation(job)
        db.add_all([message, OutboxMessage(topic="financial.forbidden", payload={})]); await db.commit()
        id = message.id
        with pytest.raises(RecoveryBlocked):
            await dispatch.dispatch_one(db, id, lambda *a: pytest.fail("disallowed publish"))
        assert (await db.get(OutboxMessage, id)).state == "dead_letter"
        assert (await dispatch.relay_pass(db, lambda *a: pytest.fail("legacy publish"), enabled=True,
                                         consumer_fence_verified=True))["delivered"] == 0


@pytest.mark.asyncio
async def test_corrupt_admission_cannot_serialize_foreign_result(database, monkeypatch):
    async def no_broker(*args): pass
    monkeypatch.setattr(dispatch, "dispatch_one", no_broker)
    async with database() as db:
        await usecase(db).execute(command())
        foreign = Job(user_id=2, prompt="foreign synthetic", provider="fixture", model="fixture")
        db.add(foreign); await db.flush()
        row = (await db.execute(select(JobAdmission))).scalar_one()
        row.job_id = foreign.id
        await db.commit()
        with pytest.raises(NotFoundException): await usecase(db).execute(command())


@pytest.mark.asyncio
async def test_background_export_foreign_and_missing_are_identical(database, monkeypatch):
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from app.domains.google_sheets import tasks
    async with database() as db:
        db.add(Job(id=901, user_id=2, prompt="foreign synthetic", provider="fixture", model="fixture"))
        await db.commit()
        url = str(db.bind.url).replace("sqlite+aiosqlite", "sqlite")
    engine = create_engine(url)
    monkeypatch.setattr(tasks, "SyncSessionLocal", sessionmaker(engine))
    def forbidden(*args, **kwargs): pytest.fail("No credential or export boundary may be reached")
    monkeypatch.setattr(tasks, "decrypt_token", forbidden)
    monkeypatch.setattr(tasks._svc, "append_sheet", forbidden)
    try:
        for id in (901, 999):
            assert tasks.export_job_to_sheets_task.run(1, id, "https://example.invalid/synthetic") == {
                "status": "failed", "error": "Job not found"}
    finally:
        engine.dispose()


@pytest.mark.asyncio
async def test_owner_query_rejects_missing_principal(database):
    from app.shared.exceptions import ForbiddenException
    async with database() as db:
        db.add(Job(user_id=None, prompt="historical unowned", provider="fixture", model="fixture"))
        await db.commit()
        repo = PostgresJobRepository(db)
        assert await repo.get_for_user(1, None) is None
        with pytest.raises(ForbiddenException): await repo.list_for_user(None, PagedQuery())
