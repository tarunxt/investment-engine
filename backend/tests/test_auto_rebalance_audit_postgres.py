"""Opt-in, disposable LOCAL PostgreSQL row-lock regression tests.

Set CREDX_AUDIT_TEST_DATABASE_URL to a localhost PostgreSQL database named
credx_audit_test_* and CREDX_AUDIT_TEST_DATABASE_ACK=disposable-local-only.
Only a fresh random schema is created/dropped. DATABASE_URL is never used as
an integration-test target. Absence of an explicit target skips this suite.
"""
import asyncio
import os
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from sqlalchemy import func, select
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import selectinload
from sqlalchemy.schema import CreateSchema, DropSchema

import app.models  # noqa: F401
from app.domains.auth.models import ActivityLog, User
from app.domains.jobs.models import Job
from app.domains.prompts.models import Prompt
from app.domains.runs import router as routes
from app.domains.runs.models import AutoRebalanceWorkflow, AutoRebalanceWorkflowStage, Run, RunJob
from app.domains.runs.schemas import AutoRebalanceStageUpdateRequest
from app.infrastructure.database.base import Base

OWNER = SimpleNamespace(id=7)
START = datetime(2026, 1, 2, 8, 0, tzinfo=timezone.utc)
FINISH = datetime(2026, 1, 2, 8, 2, tzinfo=timezone.utc)
LATE = datetime(2026, 1, 2, 8, 5, tzinfo=timezone.utc)
TABLES = [model.__table__ for model in (
    User, Prompt, Job, Run, RunJob, AutoRebalanceWorkflow,
    AutoRebalanceWorkflowStage, ActivityLog,
)]


def guarded_test_url(raw, acknowledgement):
    url = make_url(raw)
    if (
        acknowledgement != "disposable-local-only"
        or url.drivername not in {"postgresql", "postgresql+asyncpg"}
        or url.host not in {"localhost", "127.0.0.1", "::1"}
        or not (url.database or "").startswith("credx_audit_test_")
        or url.query
    ):
        raise ValueError("PostgreSQL audit tests require an explicitly acknowledged disposable local test database")
    return url.set(drivername="postgresql+asyncpg")


@pytest.mark.parametrize("raw,ack", [
    ("postgresql://test:test@remote.example/credx_audit_test_ci", "disposable-local-only"),
    ("postgresql://test:test@localhost/production", "disposable-local-only"),
    ("postgresql://test:test@localhost/credx_audit_test_ci", ""),
    ("postgresql://test:test@localhost/credx_audit_test_ci?host=remote.example", "disposable-local-only"),
    ("sqlite:///credx_audit_test_ci", "disposable-local-only"),
])
def test_guard_refuses_non_disposable_targets(raw, ack):
    with pytest.raises(ValueError, match="disposable local"):
        guarded_test_url(raw, ack)


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def postgres_db(monkeypatch):
    raw = os.environ.get("CREDX_AUDIT_TEST_DATABASE_URL")
    if not raw:
        pytest.skip("explicit disposable local PostgreSQL test URL not configured")
    url = guarded_test_url(raw, os.environ.get("CREDX_AUDIT_TEST_DATABASE_ACK"))
    dispatch = Mock()
    monkeypatch.setattr("app.domains.mails.tasks.deliver_completion_email.delay", dispatch)
    monkeypatch.setattr("app.domains.runs.tasks.send_auto_rebalance_success_email_task.delay", Mock())
    schema = "credx_audit_test_" + uuid.uuid4().hex
    engine = create_async_engine(
        url,
        pool_size=3,
        max_overflow=0,
        connect_args={"server_settings": {"search_path": schema, "statement_timeout": "10000"}},
    )
    created = False
    try:
        async with engine.begin() as connection:
            await connection.execute(CreateSchema(schema))
        created = True
        async with engine.begin() as connection:
            await connection.run_sync(lambda db: Base.metadata.create_all(db, tables=TABLES))
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        async with sessions() as db:
            db.add(User(id=7, email="owner@example.test", username="owner", password_hash="unused"))
            await db.flush()
            db.add(AutoRebalanceWorkflow(id=7001, user_id=7, portfolio="india", sequence=42, label="India Run #42"))
            await db.commit()
        yield SimpleNamespace(engine=engine, sessions=sessions, dispatch=dispatch)
    finally:
        if created:
            async with engine.begin() as connection:
                await connection.execute(DropSchema(schema, cascade=True))
        await engine.dispose()


@pytest.mark.anyio
@pytest.mark.parametrize("case", ["simultaneous_first_writes", "delayed_retry_after_completion"])
async def test_parent_lock_serializes_real_sessions_and_refreshes_stale_identity_map(postgres_db, case):
    first_locked = asyncio.Event()
    release_first = asyncio.Event()
    second_attempted = asyncio.Event()
    second_locked = asyncio.Event()

    class FirstSession(AsyncSession):
        async def execute(self, statement, *args, **kwargs):
            result = await super().execute(statement, *args, **kwargs)
            if getattr(statement, "_for_update_arg", None) is not None:
                first_locked.set()
                await asyncio.wait_for(release_first.wait(), timeout=5)
            return result

    class SecondSession(AsyncSession):
        async def execute(self, statement, *args, **kwargs):
            is_lock = getattr(statement, "_for_update_arg", None) is not None
            if is_lock:
                second_attempted.set()
            result = await super().execute(statement, *args, **kwargs)
            if is_lock:
                second_locked.set()
            return result

    async def write(db, stage, status, **fields):
        return await routes.update_auto_rebalance_stage(
            "india", 42, stage, AutoRebalanceStageUpdateRequest(status=status, **fields), db, OWNER,
        )

    if case == "delayed_retry_after_completion":
        async with postgres_db.sessions() as db:
            await write(db, "sync", "completed", completed_at=START)
            for stage in ("threats", "swing", "rebalance", "technical"):
                await write(db, stage, "skipped", completed_at=START)

    async with FirstSession(postgres_db.engine, expire_on_commit=False) as first, SecondSession(
        postgres_db.engine, expire_on_commit=False,
    ) as second:
        # Deliberately retain stale parent and relationship state. The locked
        # route read must refresh it after another session commits.
        stale = (await second.execute(select(AutoRebalanceWorkflow).options(
            selectinload(AutoRebalanceWorkflow.stages),
        ))).scalar_one()
        assert stale.status in {"queued", "processing"}
        if case == "simultaneous_first_writes":
            first_call = write(first, "sync", "processing", started_at=START)
            second_call = write(second, "sync", "completed", completed_at=FINISH)
        else:
            first_call = write(first, "actionables", "completed", completed_at=FINISH)
            second_call = write(second, "sync", "processing", completed_at=LATE, error_message="stale")
        first_task = asyncio.create_task(first_call)
        second_task = None
        try:
            await asyncio.wait_for(first_locked.wait(), timeout=5)
            second_task = asyncio.create_task(second_call)
            await asyncio.wait_for(second_attempted.wait(), timeout=5)
            with pytest.raises(asyncio.TimeoutError):
                await asyncio.wait_for(second_locked.wait(), timeout=0.15)
            release_first.set()
            results = await asyncio.wait_for(asyncio.gather(first_task, second_task), timeout=10)
        finally:
            release_first.set()
            if second_task is None:
                second_call.close()
            for task in (first_task, second_task):
                if task is not None and not task.done():
                    task.cancel()
            await asyncio.gather(*(task for task in (first_task, second_task) if task is not None), return_exceptions=True)

    assert second_locked.is_set()
    assert results[1].status == "completed"
    async with postgres_db.sessions() as db:
        workflow = await db.get(AutoRebalanceWorkflow, 7001)
        sync = (await db.execute(select(AutoRebalanceWorkflowStage).where(
            AutoRebalanceWorkflowStage.stage == "sync",
        ))).scalar_one()
        count = await db.scalar(select(func.count()).select_from(AutoRebalanceWorkflowStage))
        events = await db.scalar(select(func.count()).select_from(ActivityLog))
        if case == "simultaneous_first_writes":
            assert (workflow.status, workflow.current_stage, count, events) == ("processing", "sync", 1, 1)
            assert sync.completed_at == FINISH
        else:
            assert (workflow.status, workflow.current_stage, count, events) == ("completed", "actionables", 6, 2)
            assert workflow.completed_at == FINISH
            assert sync.completed_at == START and sync.error_message is None
    assert postgres_db.dispatch.call_count == events


@pytest.mark.anyio
async def test_simultaneous_overall_email_requests_share_one_durable_outbox_event(postgres_db, monkeypatch):
    from app.domains.runs.schemas import AutoRebalanceCompletionEmailRequest

    class LegacyRedis:
        calls = 0

        async def get(self, key):
            self.calls += 1
            return None

        async def aclose(self):
            pass

    redis = LegacyRedis()
    monkeypatch.setattr(routes, "_get_redis", lambda: redis)
    async with postgres_db.sessions() as db:
        for stage in routes.AUTO_REBALANCE_STAGE_ORDER:
            await routes.update_auto_rebalance_stage(
                "india", 42, stage,
                AutoRebalanceStageUpdateRequest(status="completed" if stage == "actionables" else "skipped", completed_at=FINISH),
                db, OWNER,
            )
    body = AutoRebalanceCompletionEmailRequest(portfolio="india", sequence=42, label="client", completed_at=LATE)

    async def queue():
        async with postgres_db.sessions() as db:
            return await routes.queue_auto_rebalance_completion_email(body, OWNER, db)

    results = await asyncio.wait_for(asyncio.gather(queue(), queue()), timeout=10)
    assert sorted(result["status"] for result in results) == ["already_queued", "queued"]
    async with postgres_db.sessions() as db:
        rows = (await db.execute(select(ActivityLog).where(ActivityLog.resource_id == 7001))).scalars().all()
        assert len(rows) == 1 and rows[0].action == "completion.pending"
        event_id = rows[0].id
    assert [call.args for call in postgres_db.dispatch.call_args_list].count((event_id,)) == 1
    assert redis.calls == 1
