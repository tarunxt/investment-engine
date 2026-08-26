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


@pytest.mark.anyio
async def test_runtime_display_positions_allows_signed_in_user_and_strips_runtime_credentials(
    monkeypatch,
):
    snapshot = BullpenPositionsSnapshot(
        payload={
            "positions": [
                {"market": "Current wallet row", "outcome": "Yes", "shares": 2.0}
            ],
            "summary": {"total_value": 22.91},
        },
        fetched_at="2026-08-10T05:15:15+00:00",
        cli_version="bullpen 0.1.116",
        credential_artifact=BullpenCredentialArtifact(
            path="/home/ubuntu/.bullpen/credentials.json.enc",
            inode=99,
            mtime=100.0,
            mtime_ns=100,
            size=200,
        ),
        account_identity="0xabc123",
        position_classifier_version=4,
        source="redis-cache",
        freshness_state="cached",
        diagnostics=BullpenCommandDiagnostics(
            command_category="positions",
            pid=1234,
            unix_user="ubuntu",
            effective_home="/home/ubuntu",
            snapshot_producer_source="operator-cli-display-bridge",
        ),
    )

    class FakeBroker:
        async def read_display_positions_snapshot(self):
            return snapshot

        async def read_cached_positions_snapshot(self):
            raise AssertionError("Display snapshot should be preferred.")

        async def get_positions_snapshot(self, **kwargs):
            assert kwargs["caller_source"] == "ui-history-portfolio-refresh"
            return snapshot

    app = FastAPI()
    app.include_router(polymarket_router)
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(
        id=8,
        role=UserRole.USER,
    )
    monkeypatch.setattr(
        "app.domains.polymarket.router.get_bullpen_runtime_broker",
        lambda: FakeBroker(),
    )

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.get(
            "/polymarket/runtime/positions/display",
            params={
                "force_fresh": "true",
                "max_age_seconds": "0",
                "caller_source": "ui-history-portfolio-refresh",
            },
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is True
    assert len(payload["snapshot"]["payload"]["positions"]) == 1
    assert payload["snapshot"]["account_identity"] == "0xabc123"
    assert payload["snapshot"]["position_classifier_version"] == 4
    assert "credential_artifact" not in payload["snapshot"]
    assert "diagnostics" not in payload["snapshot"]


@pytest.mark.anyio
async def test_runtime_display_positions_replaces_a_different_cli_account(
    monkeypatch,
):
    silver_snapshot = BullpenPositionsSnapshot(
        payload={"positions": [], "summary": {"cash_balance": 133.67}},
        fetched_at="2026-08-26T10:00:00+00:00",
        account_identity="0x1111111111111111111111111111111111111111",
        source="live-cli",
        freshness_state="fresh",
        diagnostics=BullpenCommandDiagnostics(
            command_category="positions", pid=1, effective_home="/home/investor"
        ),
    )
    intrepid_wallet = "0xa70b18abdebf0704b41901c33e8477ea1085afdf"
    intrepid_snapshot = BullpenPositionsSnapshot(
        payload={"positions": [], "summary": {"cash_balance": 9.21}},
        fetched_at="2026-08-26T10:01:00+00:00",
        account_identity=intrepid_wallet,
        source="redis-cache",
        freshness_state="cached",
        diagnostics=BullpenCommandDiagnostics(
            command_category="positions", pid=1, effective_home="/home/investor"
        ),
    )

    class FakeBroker:
        async def read_display_positions_snapshot(self):
            return silver_snapshot

        async def read_cached_positions_snapshot(self):
            return silver_snapshot

        async def get_positions_snapshot(self, **kwargs):
            return silver_snapshot

    async def fake_public_snapshot(broker, *, wallet, caller_source):
        assert isinstance(broker, FakeBroker)
        assert wallet == intrepid_wallet
        assert caller_source == "ui-passive-refresh"
        return intrepid_snapshot

    app = FastAPI()
    app.include_router(polymarket_router)
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(
        id=8,
        role=UserRole.USER,
    )
    monkeypatch.setattr(
        "app.domains.polymarket.router.get_bullpen_runtime_broker",
        lambda: FakeBroker(),
    )
    monkeypatch.setattr(
        "app.domains.polymarket.router.read_public_display_wallet_snapshot",
        fake_public_snapshot,
    )

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.get(
            "/polymarket/runtime/positions/display",
            params={
                "passive": "true",
                "caller_source": "ui-passive-refresh",
                "expected_account_identity": intrepid_wallet,
            },
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["snapshot"]["account_identity"] == intrepid_wallet
    assert payload["snapshot"]["payload"]["summary"]["cash_balance"] == 9.21


@pytest.mark.anyio
async def test_operational_runtime_positions_remain_admin_only(monkeypatch):
    app = FastAPI()
    app.include_router(polymarket_router)
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(
        id=8,
        role=UserRole.USER,
    )
    monkeypatch.setattr(
        "app.domains.polymarket.router.get_bullpen_runtime_broker",
        lambda: (_ for _ in ()).throw(
            AssertionError("Non-admin users must not reach the operational runtime.")
        ),
    )

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.get("/polymarket/runtime/positions")

    assert response.status_code == 403
