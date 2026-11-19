import asyncio
import hashlib
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock
from urllib.parse import parse_qs, urlparse

import pytest
from cryptography.fernet import Fernet
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import KitePersonalApp, settings
from app.domains.zerodha import router
from app.domains.zerodha.models import ZerodhaCredential
from app.domains.zerodha.repository import ZerodhaCredentialRepository
from app.domains.zerodha.service import KiteError, ZerodhaService, service_for_user


@pytest.fixture
def personal(monkeypatch):
    app = KitePersonalApp(client_id="AA1234", api_key="second", api_secret="secondsecret")
    monkeypatch.setattr(settings, "zerodha_personal_apps", {22: app})
    monkeypatch.setattr(settings, "zerodha_api_key", "first")
    monkeypatch.setattr(settings, "zerodha_api_secret", "firstsecret")
    return app


def test_concurrent_owners_use_their_own_login_exchange_and_headers(monkeypatch, personal):
    async def run(owner, expected_key, secret):
        result = await router.get_login_url(SimpleNamespace(id=owner))
        assert parse_qs(urlparse(result.login_url).query)["api_key"] == [expected_key]
        svc = service_for_user(owner, ZerodhaService())
        exchange = AsyncMock(return_value={"api_key": expected_key, "user_id": "AA1234", "access_token": "ok"})
        monkeypatch.setattr(svc, "_request_async", exchange)
        await asyncio.sleep(0)
        await svc.exchange_token("request")
        data = exchange.await_args.kwargs["data"]
        assert data["api_key"] == expected_key
        assert data["checksum"] == hashlib.sha256(f"{expected_key}request{secret}".encode()).hexdigest()
        assert svc._auth_headers("ok")["Authorization"] == f"token {expected_key}:ok"

    async def both():
        await asyncio.gather(run(11, "first", "firstsecret"), run(22, "second", "secondsecret"))
    asyncio.run(both())


@pytest.mark.parametrize("reply", [
    {"access_token": "token", "user_id": "ZZ9999", "api_key": "second"},
    {"access_token": "token", "api_key": "second"},
    {"access_token": "token", "user_id": "AA1234", "api_key": "first"},
    {"user_id": "AA1234", "api_key": "second"},
])
def test_unexpected_kite_identity_cannot_produce_a_session(monkeypatch, personal, reply):
    svc = service_for_user(22, ZerodhaService())
    monkeypatch.setattr(svc, "_request_async", AsyncMock(return_value=reply))
    with pytest.raises(KiteError):
        asyncio.run(svc.exchange_token("request"))


def test_existing_rotated_and_retried_sessions(monkeypatch, personal):
    import app.models  # Register the full SQLAlchemy relationship graph.
    from app.domains.zerodha.crypto import encrypt_token
    monkeypatch.setattr(settings, "zerodha_token_encryption_key", Fernet.generate_key().decode())

    async def run():
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        now = datetime.now(timezone.utc)
        try:
            async with engine.begin() as conn:
                await conn.run_sync(ZerodhaCredential.__table__.create)
            async with async_sessionmaker(engine, expire_on_commit=False)() as db:
                repo = ZerodhaCredentialRepository(db)
                for owner in (11, 22):
                    db.add(ZerodhaCredential(user_id=owner, access_token=encrypt_token("legacy"),
                                             login_time=now, expires_at=now + timedelta(hours=1)))
                await db.flush()
                assert await repo.get_plaintext_token(11) == "legacy"
                assert await repo.get_plaintext_token(22) is None
                for token in ("initial", "reconnected"):
                    await repo.upsert(22, token, now, now + timedelta(hours=1))
                    assert await repo.get_plaintext_token(22) == token
                monkeypatch.setattr(settings, "zerodha_personal_apps", {})
                assert await repo.get_plaintext_token(22) is None
                assert await repo.get_plaintext_token(11) == "legacy"
        finally:
            await engine.dispose()
    asyncio.run(run())
