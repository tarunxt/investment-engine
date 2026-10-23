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
async def test_default_client_is_independent_of_sheets(monkeypatch):
    monkeypatch.delenv('GOOGLE_SIGNIN_CLIENT_ID', raising=False)
    db = SimpleNamespace(execute=AsyncMock())
    assert await service.google_signin_client_id(db) == (
        '833980592098-0vt4iu94cqokkv1nmp6oqh6evdgmg5sj.apps.googleusercontent.com'
    )
    db.execute.assert_not_awaited()


def test_recovery_allows_only_required_google_routes():
    assert recovery_http_allowed('GET', '/auth/google/config')
    assert recovery_http_allowed('POST', '/auth/google')
    assert not recovery_http_allowed('POST', '/auth/google/config')
    assert not recovery_http_allowed('POST', '/auth/google/register')


@pytest.mark.asyncio
async def test_new_google_profiles_are_independent_and_reused():
    from sqlalchemy import create_engine, select
    from sqlalchemy.orm import Session
    # Register relationship targets without loading unrelated application services.
    from app.domains.jobs.models import Job  # noqa: F401
    from app.domains.prompts.models import Prompt  # noqa: F401
    from app.domains.auth.models import User, UserProfile, ActivityLog, UserRole

    from sqlalchemy.ext.compiler import compiles
    from sqlalchemy.dialects.postgresql import JSONB
    from app.infrastructure.database.outbox.models import OutboxMessage
    @compiles(JSONB,'sqlite')
    def sqlite_json(*args,**kwargs):return 'JSON'
    engine = create_engine('sqlite://')
    for table in (User.__table__, UserProfile.__table__, ActivityLog.__table__, OutboxMessage.__table__):
        table.create(engine)
    with Session(engine, expire_on_commit=False) as session:
        db = SimpleNamespace(execute=AsyncMock(side_effect=session.execute),
                             flush=AsyncMock(side_effect=session.flush),
                             rollback=AsyncMock(side_effect=session.rollback), add=session.add,
                             run_sync=AsyncMock(side_effect=lambda fn:fn(session)))
        first = await service.resolve_google_user(db, 'first@gmail.com')
        session.commit()
        second = await service.resolve_google_user(db, 'second@gmail.com')
        session.commit()
        assert first.id != second.id
        assert first.profile.user_id == first.id
        assert second.profile.user_id == second.id
        assert first.username != second.username
        assert first.role == second.role == UserRole.USER
        assert first.is_verified and second.is_verified
        assert first.profile.google_sheets_master_url is None
        assert second.profile.google_sheets_master_url is None
        assert first.password_hash != second.password_hash
        assert not service.PasswordUtils.verify_password('password', first.password_hash)
        again = await service.resolve_google_user(db, 'first@gmail.com')
        assert again.id == first.id
        assert len(session.scalars(select(User)).all()) == 2
        assert len(session.scalars(select(ActivityLog)).all()) == 2
        first.role = UserRole.ADMIN
        first.email = 'FIRST@gmail.com'
        session.commit()
        assert (await service.resolve_google_user(db, 'first@gmail.com')).role == UserRole.ADMIN
        first.is_active = False
        session.commit()
        with pytest.raises(HTTPException):
            await service.resolve_google_user(db, 'first@gmail.com')
        assert not first.is_active
    engine.dispose()


@pytest.mark.asyncio
async def test_concurrent_signup_reuses_winner():
    from unittest.mock import Mock
    from app.domains.jobs.models import Job  # noqa: F401
    from app.domains.prompts.models import Prompt  # noqa: F401
    from sqlalchemy.exc import IntegrityError
    winner = SimpleNamespace(id=42, is_active=True, role='user')
    empty = Mock()
    empty.scalars.return_value.all.return_value = []
    found = Mock()
    found.scalars.return_value.all.return_value = [winner]
    db = SimpleNamespace(execute=AsyncMock(side_effect=[empty, found]), add=Mock(),
                         flush=AsyncMock(side_effect=IntegrityError('insert', {}, Exception())),
                         rollback=AsyncMock(),run_sync=AsyncMock(return_value="synthetic-admission"))
    assert await service.resolve_google_user(db, 'winner@gmail.com') is winner
    db.rollback.assert_awaited_once()
