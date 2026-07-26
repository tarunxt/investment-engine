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
from app.domains.auth.models import UserRole
from app.domains.polymarket.router import router as polymarket_router
from app.domains.polymarket.runtime_broker import (
    BullpenCommandDiagnostics,
    BullpenCredentialArtifact,
    BullpenPositionsSnapshotMetadata,
    BullpenPositionsSnapshot,
    BullpenRuntimeCachedHealth,
    BullpenRuntimePassiveHealth,
)


def _current_user():
    return SimpleNamespace(id=7, role=UserRole.ADMIN)


@pytest.mark.anyio
async def test_singleton_runtime_rejects_non_admin_users(monkeypatch):
    app = FastAPI()
    app.include_router(polymarket_router)
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(
        id=8,
        role=UserRole.USER,
    )
    monkeypatch.setattr(
        "app.domains.polymarket.router.get_bullpen_runtime_broker",
        lambda: (_ for _ in ()).throw(
            AssertionError("Unauthorized users must not reach the singleton runtime.")
        ),
    )

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://testserver",
    ) as client:
        response = await client.get("/polymarket/runtime/health")

    assert response.status_code == 403


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
    snapshot_metadata = BullpenPositionsSnapshotMetadata(
        fetched_at=snapshot.fetched_at,
        cli_version=snapshot.cli_version,
        credential_artifact=BullpenCredentialArtifact(
            path="/home/investor/.bullpen/credentials.json.enc",
            inode=11,
            mtime=22.0,
            mtime_ns=22,
            size=33,
        ),
        auth_checked_at=snapshot.auth_checked_at,
        source=snapshot.source,
        freshness_state=snapshot.freshness_state,
        diagnostics=snapshot.diagnostics,
    )

    class FakeBroker:
        async def get_positions_snapshot(self, *args, **kwargs):
            raise AssertionError(
                "Runtime health must not trigger a fresh positions snapshot."
            )

        async def read_passive_health(self):
            return BullpenRuntimePassiveHealth(
                ok=True,
                checked_at="2026-07-19T12:05:00+00:00",
                broker_health=BullpenRuntimeCachedHealth(
                    ok=True,
                    checked_at="2026-07-19T12:05:00+00:00",
                    message="Cached broker health is ready.",
                    cli_version="bullpen 0.1.115",
                    command_path="/usr/local/bin/bullpen",
                    effective_home="/home/investor",
                    credential_artifact=snapshot_metadata.credential_artifact,
                ),
                auth_checked_at="2026-07-19T12:00:00+00:00",
                latest_snapshot=snapshot_metadata,
                last_failure=None,
                cli_version="bullpen 0.1.115",
                command_path="/usr/local/bin/bullpen",
            )

    async def fake_get_bot(_user_id: int):
        raise AssertionError("Passive runtime health must not invoke bot doctor checks.")

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
    assert payload["snapshot"]["fetched_at"] == snapshot.fetched_at
    assert "payload" not in payload["snapshot"]
    assert payload["doctor"]["message"] == "Cached broker health is ready."
