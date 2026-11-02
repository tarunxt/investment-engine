"""Actual imported auth consumers; synthetic JWTs and database doubles only.

These tests do not start the application, contact services, or claim BFF/live
WebSocket acceptance. JWT verification and the four consumer bodies are real.
"""
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from jose import jwt

import app.models  # canonical mapper registration; no connection
from app.core.config import settings
from app.core.security import AuthUtils, JWTUtils
from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import UserRole
from app.domains.auth.router import refresh_token
from app.domains.auth.schemas import RefreshTokenRequest
from app.domains.polymarket_auto_live.router import _resolve_persisted_status_user_id
from app.shared.ws_relay import user_id_from_token
from session_family_fixture import SessionFamilyFixture


def token_for(shape, fixture=None):
    pair = (fixture or SessionFamilyFixture()).tokens
    if shape in ('access', 'refresh'):
        return pair[f'{shape}_token']
    claims = {'sub': '42', 'exp': datetime.now(UTC) + timedelta(minutes=1)}
    if shape == 'explicit_access':
        claims['type'] = 'access'
    elif shape == 'missing_exp':
        claims.pop('exp')
    elif shape == 'expired':
        claims['exp'] = datetime.now(UTC) - timedelta(minutes=1)
    elif shape == 'malformed':
        return 'synthetic.invalid.token'
    return jwt.encode(claims, settings.jwt_signing_key.get_secret_value(), algorithm='HS256')



@pytest.mark.asyncio
@pytest.mark.parametrize('consumer', ['dependency', 'status', 'refresh', 'websocket'])
@pytest.mark.parametrize('shape', ['access', 'refresh', 'explicit_access', 'missing_exp', 'expired', 'malformed'])
async def test_actual_imported_consumers_enforce_purpose_before_database(consumer, shape, monkeypatch):
    monkeypatch.setattr('socket.socket.connect', Mock(side_effect=AssertionError('offline fixture')))
    db = SessionFamilyFixture()
    token = token_for(shape, db)
    credentials = HTTPAuthorizationCredentials(scheme='Bearer', credentials=token)
    accepted = shape == ('refresh' if consumer == 'refresh' else 'access')
    if consumer == 'websocket':
        assert user_id_from_token(token) == (42 if accepted else None)
        assert db.reads == 0
        return
    async def invoke():
        if consumer == 'dependency':
            return await get_current_user(credentials, db)
        if consumer == 'status':
            return await _resolve_persisted_status_user_id(credentials, db)
        return await refresh_token(RefreshTokenRequest(refresh_token=token), db)
    if not accepted:
        with pytest.raises(HTTPException) as exc:
            await invoke()
        assert exc.value.status_code == 401
        assert db.reads == 0
        return
    result = await invoke()
    assert db.reads == (3 if consumer == 'refresh' else 2)
    assert db.family_reads == 1
    if consumer == 'dependency':
        assert result is db.user
    elif consumer == 'status':
        assert result == 42
    else:
        assert result.user.id == 42
        assert JWTUtils.verify_access_token(result.access_token)['sub'] == '42'
        assert JWTUtils.verify_refresh_token(result.refresh_token)['sub'] == '42'
        assert result.expires_in == 900
