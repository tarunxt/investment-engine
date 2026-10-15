import json
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import HTTPException
from google.auth import crypt, jwt

from app.domains.auth import google_signin as service
from app.core.recovery import recovery_http_allowed


@pytest.fixture
def signed_identity(monkeypatch):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    public = key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()
    signer = crypt.RSASigner.from_string(private, key_id='test-key')
    response = SimpleNamespace(status=200, data=json.dumps({'test-key': public}).encode())
    monkeypatch.setattr(service, '_BoundedGoogleRequest', lambda: lambda *a, **kw: response)

    def issue(**overrides):
        now = int(time.time())
        claims = dict(iss='https://accounts.google.com', aud='test-client', sub='google-subject',
                      email='Owner@gmail.com', email_verified=True, iat=now, exp=now + 300)
        claims.update(overrides)
        return jwt.encode(signer, claims).decode()
    return issue


def test_verified_google_identity(signed_identity):
    assert service.verify_google_identity(signed_identity(), 'test-client') == 'owner@gmail.com'
    assert service.verify_google_identity(signed_identity(email='person@company.com', hd='company.com'), 'test-client') == 'person@company.com'


@pytest.mark.parametrize('override', [
    {'aud': 'another-client'}, {'iss': 'https://attacker.example'},
    {'exp': 1}, {'email_verified': False}, {'email_verified': 'true'},
    {'sub': ''}, {'email': None}, {'email': 'person@thirdparty.com'},
])
def test_rejects_untrusted_claims(signed_identity, override):
    with pytest.raises(HTTPException) as exc:
        service.verify_google_identity(signed_identity(**override), 'test-client')
    assert exc.value.status_code in {401, 403}


def test_rejects_forged_token_and_missing_configuration(signed_identity):
    credential = signed_identity()
    header, payload, signature = credential.split('.')
    with pytest.raises(HTTPException) as exc:
        service.verify_google_identity(f'{header}.{payload}.AAAA{signature[4:]}', 'test-client')
    assert exc.value.status_code == 401
    with pytest.raises(HTTPException) as exc:
        service.verify_google_identity(credential, None)
    assert exc.value.status_code == 503


@pytest.mark.parametrize('matches', [[], [SimpleNamespace(is_active=False)],
    [SimpleNamespace(is_active=True), SimpleNamespace(is_active=True)]])
def test_rejects_unknown_inactive_and_ambiguous_accounts(matches):
    with pytest.raises(HTTPException):
        service.require_existing_google_user(matches)


def test_preserves_existing_account_and_role():
    user = SimpleNamespace(id=17, is_active=True, role='viewer')
    assert service.require_existing_google_user([user]) is user
    assert user.role == 'viewer'


@pytest.mark.asyncio
async def test_client_id_override_does_not_read_database(monkeypatch):
    monkeypatch.setenv('GOOGLE_SIGNIN_CLIENT_ID', ' dedicated-client ')
    db = SimpleNamespace(execute=AsyncMock())
    assert await service.google_signin_client_id(db) == 'dedicated-client'
    db.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_existing_config_selects_only_public_id(monkeypatch):
    monkeypatch.delenv('GOOGLE_SIGNIN_CLIENT_ID', raising=False)
    db = SimpleNamespace(execute=AsyncMock(return_value=SimpleNamespace(scalar_one_or_none=lambda: 'existing-client')))
    assert await service.google_signin_client_id(db) == 'existing-client'
    statement = db.execute.call_args.args[0]
    assert [column.name for column in statement.selected_columns] == ['client_id']


def test_recovery_allows_only_required_google_routes():
    assert recovery_http_allowed('GET', '/auth/google/config')
    assert recovery_http_allowed('POST', '/auth/google')
    assert not recovery_http_allowed('POST', '/auth/google/config')
    assert not recovery_http_allowed('POST', '/auth/google/register')
