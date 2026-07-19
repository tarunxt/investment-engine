import os
from datetime import UTC, datetime
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://test:test@localhost:5432/testdb",
)
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

from app.domains.auth.dependencies import get_current_user
from app.domains.polymarket.router import router as polymarket_router
from app.domains.polymarket.runtime_broker import (
    BullpenCommandDiagnostics,
    BullpenPositionsSnapshot,
)
from app.domains.polymarket.schemas import PolymarketDoctorStatus


def _current_user():
    return SimpleNamespace(id=7)


@pytest.mark.anyio
async def test_runtime_health_reads_cached_snapshot_without_refetching_positions(
    monkeypatch,
):
    snapshot = BullpenPositionsSnapshot(
        payload={"positions": []},
        fetched_at=datetime.now(UTC).isoformat(),
        cli_version="bullpen 0.1.115",
        auth_checked_at="2026-07-19T12:00:00+00:00",
        source="live-cli",
        freshness_state="fresh",
        diagnostics=BullpenCommandDiagnostics(
            command_category="positions",
            pid=1234,
            unix_user="investor",
            effective_home="/home/investor",
        ),
    )

    class FakeBroker:
        async def read_cached_positions_snapshot(self):
            return snapshot

        async def get_positions_snapshot(self, *args, **kwargs):
            raise AssertionError(
                "Runtime health must not trigger a fresh positions snapshot."
            )

    class FakeLiveExecutor:
        async def doctor(self):
            return PolymarketDoctorStatus(ok=True, message="Bullpen runtime healthy.")

    async def fake_get_bot(user_id: int):
        assert user_id == 7
        return SimpleNamespace(live_executor=FakeLiveExecutor())

    app = FastAPI()
    app.include_router(polymarket_router)
    app.dependency_overrides[get_current_user] = _current_user

    monkeypatch.setattr(
        "app.domains.polymarket.router.get_bullpen_runtime_broker",
        lambda: FakeBroker(),
    )
    monkeypatch.setattr(
        "app.domains.polymarket.router.polymarket_bot_manager.get_bot",
        fake_get_bot,
    )

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://testserver",
    ) as client:
        response = await client.get("/polymarket/runtime/health")

    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is True
    assert payload["snapshot"]["payload"] == {"positions": []}
