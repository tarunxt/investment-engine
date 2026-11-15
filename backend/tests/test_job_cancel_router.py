from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI

from app.domains.auth.dependencies import get_current_user
from app.domains.jobs.router import router as jobs_router
from app.infrastructure.database.session import get_async_db
from app.shared.types import JobStatus


def _current_user():
    return SimpleNamespace(id=7)


class _FakeDbSession:
    def __init__(self) -> None:
        self.committed = False

    async def commit(self) -> None:
        self.committed = True


def _build_job(status: JobStatus = JobStatus.PROCESSING):
    timestamp = datetime(2026, 6, 25, 12, 0, tzinfo=UTC)
    return SimpleNamespace(
        id=17,
        prompt="Threats scan",
        provider="openai",
        model="gpt-4o-mini",
        status=status,
        response=None,
        error_message=None,
        tokens_in=None,
        tokens_out=None,
        estimated_cost=None,
        web_search_used=None,
        web_search_queries=None,
        web_sources=None,
        request_context_json=None,
        runtime_metadata_json=None,
        export_status="pending",
        export_error=None,
        exported_at=None,
        exported_sheet_url=None,
        auto_rebalance_portfolio="zerodha",
        auto_rebalance_sequence=12,
        auto_rebalance_label="India Run #12",
        scheduled_at=None,
        user_id=7,
        created_at=timestamp,
        updated_at=timestamp,
    )


@pytest.mark.anyio
async def test_cancel_job_marks_failed_and_revokes_worker(monkeypatch):
    fake_db = _FakeDbSession()
    fake_job = _build_job()
    revoked_job_ids: list[int] = []
    published_job_ids: list[int] = []

    class _FakeRepo:
        def __init__(self, session) -> None:
            assert session is fake_db

        async def get(self, job_id):
            assert int(job_id) == 17
            return fake_job

    async def _fake_get_async_db():
        yield fake_db

    async def _fake_revoke(job_id: int):
        revoked_job_ids.append(job_id)
        return "task-17"

    def _fake_publish(job):
        published_job_ids.append(job.id)

    monkeypatch.setattr(
        "app.domains.jobs.router.PostgresJobRepository",
        _FakeRepo,
    )
    monkeypatch.setattr(
        "app.domains.jobs.router.revoke_registered_job_task",
        _fake_revoke,
    )
    monkeypatch.setattr(
        "app.domains.jobs.tasks._publish_job_update",
        _fake_publish,
    )

    app = FastAPI()
    app.include_router(jobs_router)
    app.dependency_overrides[get_current_user] = _current_user
    app.dependency_overrides[get_async_db] = _fake_get_async_db

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.post("/jobs/17/cancel")

    assert response.status_code == 200
    assert fake_db.committed is True
    assert fake_job.status == JobStatus.FAILED
    assert fake_job.error_message == "Cancelled by user"
    assert fake_job.export_status == "failed"
    assert fake_job.export_error == "Cancelled by user"
    assert revoked_job_ids == [17]
    assert published_job_ids == [17]
    assert response.json()["status"] == "failed"
