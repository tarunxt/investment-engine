"""Synthetic identities only; no live Google calls or database content."""
import pytest
from fastapi import HTTPException
from app.core.uat2 import (
    OWNER_EMAIL, require_password_auth_allowed, require_uat2_owner, uat2_mode,
)


def test_production_policy_unchanged(monkeypatch):
    monkeypatch.delenv('CREDX_UAT2', raising=False)
    require_uat2_owner('synthetic@example.test')
    require_password_auth_allowed()
    assert not uat2_mode()


@pytest.mark.parametrize('email', [
    'synthetic@example.test', 'tarun.singh6893+test@gmail.com',
    'tarunsingh6893@gmail.com', 'Tarun.Singh6893@gmail.com', None, '',
])
def test_only_exact_owner_passes(monkeypatch, email):
    monkeypatch.setenv('CREDX_UAT2', '1')
    with pytest.raises(HTTPException) as exc:
        require_uat2_owner(email)
    assert exc.value.status_code == 403
    require_uat2_owner(OWNER_EMAIL)


def test_password_auth_disabled_even_for_owner(monkeypatch):
    monkeypatch.setenv('CREDX_UAT2', '1')
    with pytest.raises(HTTPException):
        require_password_auth_allowed()


def test_malformed_mode_fails_closed(monkeypatch):
    monkeypatch.setenv('CREDX_UAT2', 'true')
    with pytest.raises(RuntimeError):
        uat2_mode()


@pytest.mark.asyncio
async def test_nonowner_google_denied_before_any_database_access(monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    from app.domains.auth.google_signin import resolve_google_user
    monkeypatch.setenv('CREDX_UAT2', '1')
    db = SimpleNamespace(execute=AsyncMock(), add=AsyncMock(), flush=AsyncMock())
    with pytest.raises(HTTPException):
        await resolve_google_user(db, 'synthetic@example.test')
    db.execute.assert_not_awaited()
    db.add.assert_not_called()
    db.flush.assert_not_awaited()


@pytest.mark.asyncio
async def test_alternate_login_denied_before_lookup(monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    from app.domains.auth.router import login, register, forgot_password, reset_password
    monkeypatch.setenv('CREDX_UAT2', '1')
    db = SimpleNamespace(execute=AsyncMock())
    for route in (login, register, forgot_password, reset_password):
        with pytest.raises(HTTPException) as exc:
            await route(SimpleNamespace(), db)
        assert exc.value.status_code == 403
    db.execute.assert_not_awaited()


def test_uat2_cannot_enable_development_bypass(monkeypatch):
    from app.domains.auth.dependencies import is_auth_disabled
    from app.core.config import settings
    monkeypatch.setenv('CREDX_UAT2', '1')
    monkeypatch.setattr(settings, 'auth_disabled', True)
    monkeypatch.setattr(settings, 'environment', 'development')
    assert not is_auth_disabled()
