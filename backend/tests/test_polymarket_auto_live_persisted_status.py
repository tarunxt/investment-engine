import asyncio
from datetime import UTC, datetime

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.exc import SQLAlchemyError

from app.domains.polymarket_auto_live import bot as auto_live_bot_module
from app.domains.polymarket_auto_live.bot import BullpenAutoLiveBot
from app.domains.polymarket_auto_live.models import (
    PolymarketAutoLiveSettingsRecord,
    PolymarketAutoLiveStateRecord,
)
from app.domains.polymarket_auto_live.router import router as auto_live_router
from app.domains.polymarket_auto_live.schemas import (
    BullpenAutoLivePersistedStatus,
    BullpenAutoLiveSchedulerStatus,
    BullpenAutoLiveSettings,
    BullpenAutoLiveState,
    BullpenAutoLiveStatusConfiguration,
)


def _persisted_status() -> BullpenAutoLivePersistedStatus:
    return BullpenAutoLivePersistedStatus(
        refreshed_at="2026-07-23T12:00:00+00:00",
        configuration=BullpenAutoLiveStatusConfiguration(
            strategy_profile="bullpen_console_top10",
            auto_live_enabled=True,
            dry_run=False,
            allow_live_execution=True,
            require_manual_confirmation=False,
            emergency_stop=False,
            limit_orders_only=True,
            console_order_usd=5,
            console_auto_start_at="2026-07-23T13:00:00+05:30",
            console_auto_refresh_minutes=60,
            console_llm_target_count=2,
            updated_at="2026-07-23T11:59:00+00:00",
        ),
        scheduler=BullpenAutoLiveSchedulerStatus(
            running=True,
            paused=False,
            dry_run=True,
            live_armed=False,
            live_execution_allowed=False,
            emergency_stopped=False,
            status="running",
            mode="dry-run",
            next_run_at="2026-07-23T12:30:00+00:00",
            last_run_at="2026-07-23T11:30:00+00:00",
            last_run_id="run-1",
            active_run_id="run-1",
            active_run_status="running",
            updated_at="2026-07-23T11:59:00+00:00",
        ),
    )


@pytest.mark.anyio
async def test_persisted_status_reads_only_indexed_rows_without_runtime_or_recovery(
    monkeypatch,
):
    now = datetime(2026, 7, 23, 12, 0, tzinfo=UTC)
    settings = BullpenAutoLiveSettings(
        strategy_profile="bullpen_console_top10",
        auto_live_enabled=True,
        dry_run=False,
        allow_live_execution=True,
        require_manual_confirmation=False,
        console_order_usd=5,
        console_auto_start_at="2026-07-23T13:00:00+05:30",
        console_auto_refresh_minutes=60,
    )
    state = BullpenAutoLiveState(
        running=True,
        status="running",
        mode="dry-run",
        next_run_at="2026-07-23T12:30:00+00:00",
        last_run_at="2026-07-23T11:30:00+00:00",
        last_run_id="run-1",
    )
    settings_record = PolymarketAutoLiveSettingsRecord(
        user_id=7,
        payload=settings.model_dump(mode="json"),
        created_at=now,
        updated_at=now,
    )
    state_record = PolymarketAutoLiveStateRecord(
        user_id=7,
        running=state.running,
        paused=state.paused,
        status=state.status,
        mode=state.mode,
        last_run_at=now,
        next_run_at=now,
        payload=state.model_dump(mode="json"),
        created_at=now,
        updated_at=now,
    )

    class FakeSession:
        commits = 0

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def commit(self):
            self.commits += 1

    fake_session = FakeSession()
    calls: list[str] = []

    class FakeRepository:
        def __init__(self, session):
            assert session is fake_session

        async def get_settings_record(self, user_id: int):
            assert user_id == 7
            calls.append("settings")
            return settings_record

        async def get_state_record(self, user_id: int):
            assert user_id == 7
            calls.append("state")
            return state_record

        async def get_active_run_identity(self, user_id: int):
            assert user_id == 7
            calls.append("active-run")
            return "run-1", "running"

        def __getattr__(self, name: str):
            raise AssertionError(f"persisted status must not call repository.{name}")

    async def forbidden_recovery(*_args, **_kwargs):
        raise AssertionError("persisted status must not recover a run")

    def forbidden_guardrail_build(*_args, **_kwargs):
        raise AssertionError("persisted status must not build deep guardrails")

    monkeypatch.setattr(auto_live_bot_module, "AsyncSessionLocal", lambda: fake_session)
    monkeypatch.setattr(
        auto_live_bot_module,
        "AsyncPolymarketAutoLiveRepository",
        FakeRepository,
    )
    monkeypatch.setattr(
        BullpenAutoLiveBot,
        "_get_active_run_or_recover",
        forbidden_recovery,
    )
    monkeypatch.setattr(
        BullpenAutoLiveBot,
        "_build_guardrail_checks",
        forbidden_guardrail_build,
    )

    snapshot = await asyncio.wait_for(
        BullpenAutoLiveBot(user_id=7).get_persisted_status(),
        timeout=0.25,
    )

    assert calls == ["settings", "state", "active-run"]
    assert fake_session.commits == 0
    assert snapshot.source == "persisted"
    assert snapshot.configuration.auto_live_enabled is True
    assert snapshot.configuration.console_llm_target_count == 0
    assert snapshot.scheduler.running is True
    assert snapshot.scheduler.last_run_id == "run-1"
    assert snapshot.scheduler.active_run_id == "run-1"
    assert snapshot.scheduler.active_run_status == "running"
    assert snapshot.scheduler.next_run_at == now.isoformat()


@pytest.mark.anyio
async def test_persisted_status_route_skips_runtime_broker_and_sets_timing_headers(
    monkeypatch,
):
    app = FastAPI()
    app.include_router(auto_live_router)
    runtime_calls = 0

    async def fake_read_persisted_status(_credentials):
        return _persisted_status(), 7, 0.12

    def forbidden_runtime_broker():
        nonlocal runtime_calls
        runtime_calls += 1
        raise AssertionError("persisted status must not access the runtime broker")

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.router._read_persisted_status",
        fake_read_persisted_status,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.router.get_bullpen_runtime_broker",
        forbidden_runtime_broker,
    )

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://testserver",
    ) as client:
        response = await client.get("/polymarket/auto-live/status")

    assert response.status_code == 200
    assert response.json()["source"] == "persisted"
    assert response.json()["scheduler"]["status"] == "running"
    assert response.headers["cache-control"].startswith("private, max-age=5")
    assert "db;dur=" in response.headers["server-timing"]
    assert "app;dur=" in response.headers["server-timing"]
    assert response.headers["vary"] == "Authorization, Cookie"
    assert runtime_calls == 0


@pytest.mark.anyio
async def test_persisted_status_route_fails_fast_when_database_read_does_not_finish(
    monkeypatch,
):
    app = FastAPI()
    app.include_router(auto_live_router)

    async def fake_read_persisted_status(_credentials):
        await asyncio.sleep(1)
        return _persisted_status(), 7, 1_000

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.router._read_persisted_status",
        fake_read_persisted_status,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.router.PERSISTED_STATUS_TIMEOUT_SECONDS",
        0.01,
    )

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://testserver",
    ) as client:
        response = await client.get("/polymarket/auto-live/status")

    assert response.status_code == 503
    assert "temporarily unavailable" in response.json()["detail"]
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["server-timing"].startswith("app;dur=")


@pytest.mark.anyio
async def test_persisted_status_route_redacts_database_failure_details(
    monkeypatch,
):
    app = FastAPI()
    app.include_router(auto_live_router)
    secret = "postgresql://aiuser:do-not-leak@postgres.internal:5432/aidb"

    async def fake_read_persisted_status(_credentials):
        raise SQLAlchemyError(secret)

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.router._read_persisted_status",
        fake_read_persisted_status,
    )

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://testserver",
    ) as client:
        response = await client.get("/polymarket/auto-live/status")

    assert response.status_code == 503
    assert response.json()["detail"] == (
        "Auto-Live status is temporarily unavailable. Retry shortly."
    )
    assert secret not in response.text
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["server-timing"].startswith("app;dur=")


@pytest.mark.anyio
async def test_persisted_status_route_rejects_malformed_snapshot_without_raw_500(
    monkeypatch,
):
    app = FastAPI()
    app.include_router(auto_live_router)

    async def fake_read_persisted_status(_credentials):
        return {"source": "persisted", "scheduler": "corrupt"}, 7, 0.1

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.router._read_persisted_status",
        fake_read_persisted_status,
    )

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://testserver",
    ) as client:
        response = await client.get("/polymarket/auto-live/status")

    assert response.status_code == 503
    assert response.json()["detail"] == (
        "Auto-Live status is temporarily unavailable. Retry shortly."
    )
