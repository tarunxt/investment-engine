import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import httpx
from cryptography.fernet import Fernet
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import app.models  # register relationships
from app.core.config import settings
from app.domains.auth.models import User
from app.domains.zerodha import router
from app.domains.zerodha.audit import ZerodhaAuditLog
from app.domains.zerodha.models import ZerodhaCredential
from app.domains.zerodha.repository import ZerodhaCredentialRepository


def test_settings_link_switch_renew_remove_and_legacy_sessions(monkeypatch):
    monkeypatch.setattr(settings, "zerodha_token_encryption_key", Fernet.generate_key().decode())
    monkeypatch.setattr(settings, "zerodha_personal_apps", {})
    user = SimpleNamespace(id=11)
    svc = Mock(is_configured=True, direct_market_orders_enabled=False, order_submission_blocked_reason=None,
               exchange_token=AsyncMock(), get_profile=AsyncMock(), invalidate_token=AsyncMock())
    monkeypatch.setattr(router, "_svc", svc)
    monkeypatch.setattr(router.sync_portfolio_snapshot_task, "delay", Mock(return_value=SimpleNamespace(id="test")))

    async def exercise():
        db_engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        try:
            async with db_engine.begin() as conn:
                for table in [User.__table__, ZerodhaCredential.__table__, ZerodhaAuditLog.__table__]:
                    await conn.run_sync(table.create)
            sessions = async_sessionmaker(db_engine, expire_on_commit=False)
            async def session():
                async with sessions() as db:
                    yield db
            app = FastAPI()
            app.include_router(router.router)
            app.dependency_overrides[router.get_current_user] = lambda: user
            app.dependency_overrides[router.get_async_db] = session
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
                async def read():
                    response = await client.get("/zerodha/connection")
                    response.raise_for_status()
                    assert response.headers["cache-control"] == "private, no-store"
                    return response.json()

                async def login(revision, account, target=None):
                    svc.exchange_token.return_value = {
                        "user_id": account, "user_name": "Fixture", "email": "fixture@example.test",
                        "pan": "ABCDE1234F", "access_token": f"session-{account}-{revision}",
                        "api_key": "not-for-display", "exchanges": ["NSE"], "products": ["CNC"],
                    }
                    return await client.post("/zerodha/callback", json={"request_token": "fixture",
                        "expected_revision": revision, "target_client_id": target or account})

                empty = await read()
                assert not empty["linked"]
                assert (await login(empty["revision"], "AA1234")).is_success
                a = await read()
                assert a["linked"] and a["session_active"]
                assert a["profile"]["masked_pan"] == "••••••234F"
                assert "ABCDE1234F" not in str(a) and "session-AA" not in str(a) and "not-for-display" not in str(a)
                assert (await login(a["revision"], "AA1234", "BB4567")).status_code == 400
                assert (await read()) == a
                assert (await login(a["revision"], "AA1234")).is_success
                renewed = await read()
                assert a["first_added_at"] == renewed["first_added_at"]
                assert (await login(renewed["revision"], "BB4567")).is_success
                b = await read()
                assert b["profile"]["client_id"] == "BB4567" and b["first_added_at"] > a["first_added_at"]
                assert (await client.delete("/zerodha/disconnect", params={"expected_revision": a["revision"]})).status_code == 409
                assert (await login(a["revision"], "CC4567")).status_code == 409
                assert (await read()) == b
                user.id = 22
                other = await read()
                assert not other["linked"]
                assert (await login(b["revision"], "BB4567")).status_code == 409
                user.id = 11
                assert (await client.delete("/zerodha/disconnect", params={"expected_revision": b["revision"]})).is_success
                assert not (await read())["linked"]
                assert (await login(empty["revision"], "AA1234")).is_success
                assert (await read())["first_added_at"] == a["first_added_at"]

                # Active legacy rows hydrate from Kite, then survive normal daily expiry.
                user.id = 22
                now = datetime.now(timezone.utc)
                async with sessions() as db:
                    credential = await ZerodhaCredentialRepository(db).upsert(22, "legacy", now, now + timedelta(hours=1))
                    credential.created_at = (now - timedelta(days=30)).replace(tzinfo=None)
                    await db.commit()
                svc.get_profile.return_value = {"user_id": "CC9999", "user_name": "Legacy"}
                legacy = await read()
                assert legacy["profile"]["name"] == "Legacy"
                assert not legacy["profile"]["masked_pan"]
                assert legacy["first_added_at"] is None
                assert legacy["connection_record_created_at"].startswith((now - timedelta(days=30)).date().isoformat())
                async with sessions() as db:
                    credential = await ZerodhaCredentialRepository(db).get_stored(22)
                    credential.expires_at = now - timedelta(minutes=1)
                    await db.commit()
                expired = await read()
                assert expired["linked"] and not expired["session_active"] and expired["profile"] == legacy["profile"]
                assert svc.get_profile.await_count == 1
        finally:
            await db_engine.dispose()
    asyncio.run(exercise())
