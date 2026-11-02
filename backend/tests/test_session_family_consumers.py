"""Actual consumer boundaries with invented family rows; no database sockets."""
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from jose import jwt

from app.core.config import settings
from app.core.security import AuthUtils
from app.domains.auth.dependencies import get_current_user
from app.domains.auth.router import refresh_token
from app.domains.auth.schemas import RefreshTokenRequest
from app.domains.polymarket_auto_live.router import _resolve_persisted_status_user_id
from app.shared import ws_relay
from session_family_fixture import SessionFamilyFixture


async def invoke(consumer, token, db):
    credentials = HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)
    if consumer == "dependency":
        return await get_current_user(credentials, db)
    if consumer == "status":
        return await _resolve_persisted_status_user_id(credentials, db)
    return await refresh_token(RefreshTokenRequest(refresh_token=token), db)


@pytest.mark.asyncio
@pytest.mark.parametrize("consumer", ["dependency", "status", "refresh"])
@pytest.mark.parametrize("state", ["missing", "revoked", "foreign"])
async def test_no_consumer_authorizes_missing_revoked_or_foreign_family(consumer, state):
    db = SessionFamilyFixture(state=state)
    token = db.tokens["refresh_token" if consumer == "refresh" else "access_token"]
    with pytest.raises(HTTPException) as error:
        await invoke(consumer, token, db)
    assert error.value.status_code == 401
    assert db.family_reads == 1
    assert db.commits == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("consumer", ["dependency", "status", "refresh"])
@pytest.mark.parametrize("shape", ["legacy_missing_sid", "short_sid", "null_sid", "wrong_purpose"])
async def test_missing_invalid_sid_legacy_and_wrong_purpose_stay_denied(consumer, shape):
    db = SessionFamilyFixture()
    claims = {"sub": "42", "exp": datetime.now(UTC) + timedelta(minutes=1)}
    if consumer == "refresh":
        claims["type"] = "refresh"
    if shape == "short_sid":
        claims["sid"] = "short"
    elif shape == "null_sid":
        claims["sid"] = None
    elif shape == "wrong_purpose":
        claims["sid"] = db.sid
        if consumer == "refresh":
            claims.pop("type")
        else:
            claims["type"] = "refresh"
    token = jwt.encode(claims, settings.jwt_signing_key.get_secret_value(), algorithm="HS256")
    with pytest.raises(HTTPException) as error:
        await invoke(consumer, token, db)
    assert error.value.status_code == 401
    assert db.reads == db.commits == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("state", ["missing", "revoked", "foreign"])
async def test_real_websocket_identity_rejects_unavailable_family(state, monkeypatch):
    db = SessionFamilyFixture(state=state)
    monkeypatch.setattr(ws_relay, "AsyncSessionLocal", db.session)
    assert await ws_relay.user_id_from_ws_token(db.tokens["access_token"]) is None
    assert db.family_reads == 1


@pytest.mark.asyncio
async def test_real_websocket_identity_accepts_only_active_synthetic_family(monkeypatch):
    db = SessionFamilyFixture()
    monkeypatch.setattr(ws_relay, "AsyncSessionLocal", db.session)
    identity = await ws_relay.user_id_from_ws_token(db.tokens["access_token"])
    assert identity == 42 and identity.claims["sid"] == db.sid
    assert db.family_reads == 1
