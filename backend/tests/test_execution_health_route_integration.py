"""Actual health router and containment middleware with isolated auth/store doubles."""
from types import SimpleNamespace

from fastapi import FastAPI, Header, HTTPException
import httpx
import pytest

from app.core.recovery import RecoveryMiddleware
from app.domains.auth.dependencies import get_current_user
from app.domains.health import progress_reader
from app.domains.health.router import router


@pytest.mark.asyncio
@pytest.mark.parametrize('recovery', [False, True])
async def test_actual_router_separates_liveness_auth_progress_and_unknown(monkeypatch, recovery):
    monkeypatch.setenv('CREDX_RECOVERY_MODE', '1' if recovery else '0')
    calls = []

    async def authenticated(authorization: str | None = Header(None)):
        if authorization != 'synthetic-session':
            raise HTTPException(401)
        return SimpleNamespace(id=7)

    async def observed(factory, jobs, outbox, **kwargs):
        calls.append(kwargs)
        return progress_reader.unknown_progress(recovery=kwargs['recovery'], now=100)

    monkeypatch.setattr(progress_reader, 'read_progress', observed)
    app = FastAPI()
    app.add_middleware(RecoveryMiddleware)
    app.dependency_overrides[get_current_user] = authenticated
    app.include_router(router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://synthetic') as client:
        assert (await client.get('/health/live')).json() == {'status': 'ok'}
        execution = await client.get('/health/execution')
        assert execution.status_code == 200
        assert execution.json()['status'] == 'unknown'
        assert execution.json()['pending_count'] is None
        assert execution.json()['deployment_gate'] is False
        unauthorized = await client.get('/health/execution/progress')
        assert unauthorized.status_code == 401
        assert calls == []
        progress = await client.get('/health/execution/progress?actor_id=999',
                                    headers={'Authorization': 'synthetic-session'})
    assert progress.status_code == 200
    assert calls[0]['actor_id'] == 7
    assert calls[0]['recovery'] is recovery
    assert progress.json()['consumer'] == 'unknown'
    assert progress.json()['sample_receipts'] is None
    assert progress.json()['mode'] == ('recovery' if recovery else 'normal')


@pytest.mark.asyncio
async def test_unavailable_or_pre_migration_schema_is_unknown_not_empty():
    class MissingTable:
        c = SimpleNamespace()

    def must_not_open():
        raise AssertionError('Incompatible schema must fail before session acquisition')

    result = await progress_reader.read_progress(must_not_open, MissingTable, MissingTable,
                                                 actor_id=7, recovery=True, now=100)
    assert result['read_state'] == 'unavailable'
    assert result['sample_size'] is None
    assert result['sample_receipts'] is None
    assert result['status'] == 'unknown'
