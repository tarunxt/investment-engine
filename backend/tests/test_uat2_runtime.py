import os
from types import SimpleNamespace
from unittest.mock import AsyncMock
import pytest
from fastapi.testclient import TestClient
from fastapi import HTTPException
from app.core.uat2 import OWNER_EMAIL
from app.core.security import JWTUtils
from app.domains.auth.dependencies import get_current_user
from app.uat2.adapters import FakeAI, FakeBroker, EmailSink
from app.uat2.main import app


@pytest.fixture
def owner_client(monkeypatch):
    monkeypatch.setenv('CREDX_UAT2', '1')
    monkeypatch.setenv('UAT2_JWT_SIGNING_KEY', 'unit-test-only-signing-material-not-a-deployed-secret')
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id=1, email=OWNER_EMAIL)
    # Route tests deliberately exclude lifespan; separate startup tests below.
    client = TestClient(app)
    try:
        yield client
    finally:
        client.close()
        app.dependency_overrides.clear()


def test_actual_schemas_and_disabled_modules(owner_client):
    assert owner_client.get('/dashboard/summary').status_code == 200
    portfolio = owner_client.get('/zerodha/portfolio')
    assert portfolio.status_code == 200
    assert portfolio.json()['latest']['holdings_count'] == 2
    assert owner_client.post('/zerodha/callback', json={'request_token': 'synthetic'}).status_code == 503
    assert owner_client.post('/zerodha/orders/place-protected-market', json={}).status_code == 503
    assert owner_client.post('/google-sheets/export', json={}).status_code == 503
    assert owner_client.post('/runs', json={}).status_code == 503
    assert owner_client.post('/polymarket/orders', json={}).status_code == 503
    from starlette.websockets import WebSocketDisconnect
    with pytest.raises(WebSocketDisconnect) as exc:
        with owner_client.websocket_connect('/jobs/ws'):
            pass
    assert exc.value.code == 1008


def test_broker_order_is_deterministic_simulation(owner_client):
    order = dict(tradingsymbol='UATTECH', exchange='NSE', transaction_type='BUY',
                 order_type='MARKET', quantity=1, product='CNC')
    first = owner_client.post('/zerodha/orders', json=order)
    second = owner_client.post('/zerodha/orders', json=order)
    assert first.status_code == 200
    assert first.json() == second.json()
    assert first.json()['order_id'].startswith('SIM-')
    assert owner_client.post('/zerodha/orders', json={**order, 'quantity': -1}).status_code == 422


def test_empty_portfolio_state(owner_client, monkeypatch):
    monkeypatch.setenv('UAT2_FIXTURE_STATE', 'empty')
    assert owner_client.get('/zerodha/portfolio').json() == {'latest': None, 'history': []}
    assert owner_client.get('/dashboard/summary').json()['zerodha']['snapshot'] is None


def test_unauthenticated_direct_api_denied(monkeypatch):
    monkeypatch.setenv('CREDX_UAT2', '1')
    client = TestClient(app)
    assert client.get('/zerodha/portfolio').status_code == 401
    assert client.post('/uat2/ai', json={'prompt': 'synthetic'}).status_code == 401
    assert client.get('/uat2/export').status_code == 401


def test_signing_isolation_and_token_type(monkeypatch):
    monkeypatch.setenv('CREDX_UAT2', '0')
    production_style = JWTUtils.create_access_token(1, OWNER_EMAIL, 'user')
    monkeypatch.setenv('CREDX_UAT2', '1')
    monkeypatch.setenv('UAT2_JWT_SIGNING_KEY', 'unit-test-only-signing-material-not-a-deployed-secret')
    assert JWTUtils.verify_token(production_style) is None
    own = JWTUtils.create_access_token(1, OWNER_EMAIL, 'user')
    assert JWTUtils.verify_token(own)['aud'] == 'credx-uat2'
    assert JWTUtils.verify_token(own)['iss'] == 'https://uat2.cred-x.in'
    with pytest.raises(HTTPException):
        JWTUtils.create_access_token(1, 'nonowner@example.test', 'user')
    monkeypatch.setenv('CREDX_UAT2', '0')
    assert JWTUtils.verify_token(own) is None


def test_missing_signing_configuration_fails_closed(monkeypatch):
    monkeypatch.setenv('CREDX_UAT2', '1')
    monkeypatch.delenv('UAT2_JWT_SIGNING_KEY', raising=False)
    with pytest.raises(RuntimeError):
        JWTUtils.create_access_token(1, OWNER_EMAIL, 'user')


def test_no_paid_ai_or_smtp(tmp_path):
    result = FakeAI().generate('synthetic review')
    assert result == FakeAI().generate('synthetic review')
    assert result['cost'] == result['tokens_in'] == result['tokens_out'] == 0
    sink = EmailSink(tmp_path)
    receipt = sink.send('synthetic subject', 'synthetic body')
    assert (tmp_path / receipt['artifact']).is_file()


def test_google_config_never_inherits_production(monkeypatch):
    import asyncio
    from app.domains.auth.google_signin import google_signin_client_id, DEFAULT_GOOGLE_SIGNIN_CLIENT_ID
    monkeypatch.setenv('CREDX_UAT2', '1')
    monkeypatch.delenv('GOOGLE_SIGNIN_CLIENT_ID', raising=False)
    assert asyncio.run(google_signin_client_id(None)) is None
    monkeypatch.setenv('GOOGLE_SIGNIN_CLIENT_ID', DEFAULT_GOOGLE_SIGNIN_CLIENT_ID)
    assert asyncio.run(google_signin_client_id(None)) is None


def test_startup_rejects_real_adapters(monkeypatch):
    from app.core.uat2 import validate_uat2_startup
    from app.core.config import settings
    monkeypatch.setenv('CREDX_UAT2', '1')
    monkeypatch.setattr(settings, 'environment', 'uat2')
    monkeypatch.setattr(settings, 'auth_disabled', False)
    monkeypatch.setenv('GOOGLE_SIGNIN_CLIENT_ID', 'independent-test-client')
    monkeypatch.setenv('UAT2_JWT_SIGNING_KEY', 'unit-test-only-signing-material-not-a-deployed-secret')
    monkeypatch.setenv('UAT2_ADAPTERS', 'real')
    with pytest.raises(RuntimeError, match='simulation'):
        validate_uat2_startup()


@pytest.mark.asyncio
async def test_refresh_denied_for_nonowner_before_token_issuance(monkeypatch):
    from app.domains.auth.router import refresh_token
    from app.domains.auth.schemas import RefreshTokenRequest
    from app.domains.auth.models import UserRole
    from unittest.mock import Mock
    monkeypatch.setenv('CREDX_UAT2', '1')
    monkeypatch.setattr(JWTUtils, 'verify_token', lambda token: {'sub': '9', 'type': 'refresh'})
    result = Mock()
    result.scalar_one_or_none.return_value = SimpleNamespace(is_active=True, email='nonowner@example.test', id=9, role=UserRole.USER)
    db = SimpleNamespace(execute=AsyncMock(return_value=result))
    with pytest.raises(HTTPException) as exc:
        await refresh_token(RefreshTokenRequest(refresh_token='synthetic-token'), db)
    assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_refresh_token_cannot_authorize_direct_api(monkeypatch):
    from fastapi.security import HTTPAuthorizationCredentials
    from app.domains.auth.dependencies import get_current_user
    monkeypatch.setenv('CREDX_UAT2', '1')
    monkeypatch.setattr(JWTUtils, 'verify_token', lambda token: {'sub': '1', 'type': 'refresh', 'email': OWNER_EMAIL})
    db = SimpleNamespace(execute=AsyncMock())
    with pytest.raises(HTTPException) as exc:
        await get_current_user(HTTPAuthorizationCredentials(scheme='Bearer', credentials='synthetic'), db)
    assert exc.value.status_code == 401
    db.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_nonowner_existing_user_cannot_authorize_direct_api(monkeypatch):
    from fastapi.security import HTTPAuthorizationCredentials
    from app.domains.auth.dependencies import get_current_user
    from unittest.mock import Mock
    monkeypatch.setenv('CREDX_UAT2', '1')
    monkeypatch.setattr(JWTUtils, 'verify_token', lambda token: {'sub': '9', 'email': 'nonowner@example.test'})
    result = Mock()
    result.scalar_one_or_none.return_value = SimpleNamespace(is_active=True, email='nonowner@example.test')
    db = SimpleNamespace(execute=AsyncMock(return_value=result))
    with pytest.raises(HTTPException) as exc:
        await get_current_user(HTTPAuthorizationCredentials(scheme='Bearer', credentials='synthetic'), db)
    assert exc.value.status_code == 403


def test_native_runtime_uses_only_dedicated_loopback_endpoints(monkeypatch):
    from app.core.uat2 import validate_uat2_startup, certificate_proxy_url, artifact_directory
    from app.core.config import settings
    monkeypatch.setenv('CREDX_UAT2','1')
    for key in ('OPENAI_API_KEY','ANTHROPIC_API_KEY','GEMINI_API_KEY','DEEPSEEK_API_KEY','ZERODHA_API_KEY','ZERODHA_API_SECRET','GOOGLE_CLIENT_SECRET','SMTP_PASSWORD','SMTP_HOST','TAVILY_API_KEY','BULLPEN_API_KEY'):
        monkeypatch.delenv(key,raising=False)
    monkeypatch.setenv('UAT2_RUNTIME','native')
    monkeypatch.setenv('UAT2_ADAPTERS','simulation')
    monkeypatch.setenv('UAT2_SOURCE_COMMIT','a'*40)
    monkeypatch.setenv('GOOGLE_SIGNIN_CLIENT_ID','independent-test-client')
    monkeypatch.setenv('UAT2_JWT_SIGNING_KEY','unit-test-only-jwt-material-never-deployed')
    monkeypatch.setattr(settings,'environment','uat2')
    monkeypatch.setattr(settings,'auth_disabled',False)
    monkeypatch.setattr(settings,'database_url','postgresql://credx_uat2:synthetic-test-only@127.0.0.1:5542/credx_uat2')
    monkeypatch.setattr(settings,'redis_url','redis://127.0.0.1:6479/0')
    validate_uat2_startup()
    assert certificate_proxy_url()=='http://127.0.0.1:18082/certs'
    assert artifact_directory()=='/var/lib/credx-uat2/artifacts'
    monkeypatch.setattr(settings,'redis_url','redis://127.0.0.1:6379/0')
    with pytest.raises(RuntimeError):validate_uat2_startup()
