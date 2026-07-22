"""Readiness regressions for durable Auto-Live Stage 3 order intent work."""

from __future__ import annotations

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
        lambda: {
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
            "stage3_order_worker": (
                "error: 2 pending Stage 3 intents require queue ai, but no worker reports "
                "consuming it. No Celery worker currently reports consuming the ai queue "
                "required by Stage 3 order intents."
            ),
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
        lambda: {
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
