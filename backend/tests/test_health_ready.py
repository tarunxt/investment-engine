"""Readiness regressions for durable Auto-Live Stage 3 order intent work."""

from __future__ import annotations

import asyncio
import time

from fastapi import FastAPI
import httpx
import pytest
import redis.asyncio as aioredis

from app.domains.health import router as health_router


class _FakeAsyncSession:
    def __init__(self, pending_stage3_intents: int) -> None:
        self.pending_stage3_intents = pending_stage3_intents

    async def __aenter__(self) -> _FakeAsyncSession:
        return self

    async def __aexit__(self, *_args: object) -> None:
        return None

    async def execute(self, _statement: object) -> object:
        return object()

    async def scalar(self, _statement: object) -> int:
        return self.pending_stage3_intents


class _FakeRedis:
    async def ping(self) -> bool:
        return True

    async def aclose(self) -> None:
        return None


def _ready_app() -> FastAPI:
    app = FastAPI()
    app.include_router(health_router.router)
    return app


def _install_healthy_dependencies(
    monkeypatch: pytest.MonkeyPatch,
    *,
    pending_stage3_intents: int,
) -> None:
    monkeypatch.setattr(
        health_router,
        "AsyncSessionLocal",
        lambda: _FakeAsyncSession(pending_stage3_intents),
    )
    monkeypatch.setattr(aioredis, "from_url", lambda _url: _FakeRedis())


@pytest.mark.anyio
async def test_ready_returns_503_when_pending_stage3_intents_have_no_ai_consumer(
    monkeypatch: pytest.MonkeyPatch,
):
    _install_healthy_dependencies(monkeypatch, pending_stage3_intents=2)
    monkeypatch.setattr(
        health_router,
        "celery_ai_queue_consumer_diagnostics",
        lambda *_args: {
            "ok": False,
            "required_queue": "ai",
            "error": "No Celery worker currently reports consuming the ai queue required by Stage 3 order intents.",
        },
    )

    transport = httpx.ASGITransport(app=_ready_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.get("/health/ready")

    assert response.status_code == 503
    assert response.json() == {
        "status": "degraded",
        "checks": {
            "postgres": "ok",
            "redis": "ok",
            "stage3_order_worker": "unavailable",
        },
        "pending_stage3_intents": 2,
    }


@pytest.mark.anyio
async def test_ready_returns_200_after_an_ai_consumer_recovers(
    monkeypatch: pytest.MonkeyPatch,
):
    _install_healthy_dependencies(monkeypatch, pending_stage3_intents=2)
    monkeypatch.setattr(
        health_router,
        "celery_ai_queue_consumer_diagnostics",
        lambda *_args: {
            "ok": True,
            "required_queue": "ai",
            "consuming_workers": ["celery@worker-1"],
            "error": None,
        },
    )

    transport = httpx.ASGITransport(app=_ready_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.get("/health/ready")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "checks": {
            "postgres": "ok",
            "redis": "ok",
            "stage3_order_worker": "ok",
        },
        "pending_stage3_intents": 2,
    }


@pytest.mark.anyio
async def test_ready_allows_celery_inspector_to_use_its_full_reply_window(
    monkeypatch: pytest.MonkeyPatch,
):
    _install_healthy_dependencies(monkeypatch, pending_stage3_intents=1)
    observed_timeouts: list[float] = []

    def delayed_healthy_diagnostics(timeout: float):
        observed_timeouts.append(timeout)
        time.sleep(timeout + 0.01)
        return {
            "ok": True,
            "required_queue": "ai",
            "consuming_workers": ["celery@worker-1"],
            "error": None,
        }

    monkeypatch.setattr(
        health_router,
        "celery_ai_queue_consumer_diagnostics",
        delayed_healthy_diagnostics,
    )
    monkeypatch.setattr(
        health_router,
        "READY_WORKER_INSPECT_TIMEOUT_SECONDS",
        0.01,
    )
    monkeypatch.setattr(health_router, "READY_WORKER_TIMEOUT_SECONDS", 0.05)

    transport = httpx.ASGITransport(app=_ready_app())
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://testserver",
    ) as client:
        response = await client.get("/health/ready")

    assert response.status_code == 200
    assert observed_timeouts == [0.01]


@pytest.mark.anyio
async def test_ready_redacts_dependency_errors_from_public_response(
    monkeypatch: pytest.MonkeyPatch,
):
    postgres_secret = "postgresql://aiuser:do-not-leak@postgres.internal:5432/aidb"
    redis_secret = "MISCONF Redis password=do-not-leak stop-writes-on-bgsave-error"

    class FailingSession:
        async def __aenter__(self):
            raise RuntimeError(postgres_secret)

        async def __aexit__(self, *_args: object) -> None:
            return None

    class FailingRedis:
        async def ping(self) -> bool:
            raise RuntimeError(redis_secret)

        async def aclose(self) -> None:
            return None

    monkeypatch.setattr(health_router, "AsyncSessionLocal", lambda: FailingSession())
    monkeypatch.setattr(aioredis, "from_url", lambda _url: FailingRedis())

    transport = httpx.ASGITransport(app=_ready_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.get("/health/ready")

    assert response.status_code == 503
    assert response.json() == {
        "status": "degraded",
        "checks": {
            "postgres": "unavailable",
            "redis": "unavailable",
        },
        "pending_stage3_intents": None,
    }
    assert postgres_secret not in response.text
    assert redis_secret not in response.text


@pytest.mark.anyio
async def test_ready_bounds_a_stalled_postgres_check_and_keeps_redis_independent(
    monkeypatch: pytest.MonkeyPatch,
):
    class StalledSession:
        async def __aenter__(self):
            await asyncio.sleep(1)
            return self

        async def __aexit__(self, *_args: object) -> None:
            return None

    monkeypatch.setattr(health_router, "AsyncSessionLocal", lambda: StalledSession())
    monkeypatch.setattr(aioredis, "from_url", lambda _url: _FakeRedis())
    monkeypatch.setattr(health_router, "READY_POSTGRES_TIMEOUT_SECONDS", 0.01)

    transport = httpx.ASGITransport(app=_ready_app())
    started_at = time.perf_counter()
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.get("/health/ready")
    elapsed_seconds = time.perf_counter() - started_at

    assert response.status_code == 503
    assert response.json() == {
        "status": "degraded",
        "checks": {"postgres": "unavailable", "redis": "ok"},
        "pending_stage3_intents": None,
    }
    assert elapsed_seconds < 0.25
