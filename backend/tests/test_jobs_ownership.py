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
from app.domains.jobs.models import Job
from app.domains.jobs.repository import PostgresJobRepository
from app.domains.jobs.use_cases.create_job import CreateJobCommand, CreateJobUseCase
from app.domains.prompts.models import Prompt
from app.domains.runs.models import Run, RunJob
from app.infrastructure.database.base import Base
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
            (User, Prompt, Job, Run, RunJob, OutboxMessage)]))
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as db:
        for id in (1, 2):
            db.add(User(id=id, email=f"actor{id}@example.invalid", username=f"actor{id}", password_hash="synthetic"))
        await db.commit()
    yield sessions
    await engine.dispose()


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
        pending_id = (await repo.list_for_user(1, PagedQuery(), status=JobStatus.PENDING)).items[0].id
        terminal_id = filtered.items[0].id
    monkeypatch.setattr("app.domains.jobs.router.revoke_registered_job_task", AsyncMock())
    monkeypatch.setattr("app.domains.jobs.tasks._publish_job_update", lambda job: None)
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
        assert (await client.get("/jobs?limit=0")).status_code == 422
        assert (await client.get("/jobs?limit=1")).status_code == 200
        canceled = await client.post(f"/jobs/{pending_id}/cancel")
        assert canceled.status_code == 200 and canceled.json()["status"] == "failed"
        assert canceled.json()["error_message"] == "Cancelled by user"
        terminal = await client.post(f"/jobs/{terminal_id}/cancel")
        assert terminal.status_code == 200 and terminal.json()["status"] == "partial"
        assert (await client.get("/jobs?status=unknown")).status_code == 400
        assert (await client.post(f"/jobs/{foreign_id}/cancel")).status_code == 404
        def anonymous(): raise HTTPException(401, "Unauthorized")
        app.dependency_overrides[get_current_user] = anonymous
        assert (await client.get("/jobs")).status_code == 401
        assert (await client.get(f"/jobs/{foreign_id}")).status_code == 401


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

