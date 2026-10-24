"""Explicit owned acquisition HTTP action, separate from module selection."""
from types import SimpleNamespace
import pytest
import httpx
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from test_stage18_linked_analysis_preview import linked_env
from app.domains.runs.analysis_router import router, optional_analysis_runtime
from app.domains.auth.dependencies import get_current_user
from app.infrastructure.database.session import get_async_db
from app.domains.modules.models import UserModule
from app.domains.zerodha.models import ZerodhaPortfolioSnapshot
from app.domains.connections.models import IntegrationConnection, ConnectionCredential


@pytest.mark.asyncio
@pytest.mark.parametrize('case', ['valid', 'disabled', 'unbound', 'forged_owner'])
async def test_explicit_source_action_never_uses_client_owner_or_implicit_runtime(linked_env, case):
    e = linked_env
    if case == 'disabled':
        e.db.scalar(select(UserModule).where(UserModule.user_id == 1,
            UserModule.module_id == 'zerodha_rebalance')).enabled = False
        e.db.commit()
    app = FastAPI(); app.include_router(router)
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id=1)
    app.dependency_overrides[optional_analysis_runtime] = lambda: None if case == 'unbound' else e.runtime
    engine = create_async_engine('sqlite+aiosqlite:///' + str(e.path))
    async def database():
        async with AsyncSession(engine, expire_on_commit=False) as db: yield db
    app.dependency_overrides[get_async_db] = database
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            body = {'portfolio': 'india'}
            if case == 'forged_owner': body['owner_id'] = 2
            response = await client.post('/runs/analysis-workflows/synthetic-source', json=body)
        if case == 'valid':
            assert response.status_code == 200 and response.json()['owner_id'] == 1
            assert response.json()['simulation_only'] is True
            assert len(response.json()['source_hash']) == 64
            assert response.headers['cache-control'] == 'private, no-store'
        else:
            assert response.status_code == {'disabled': 403, 'unbound': 503, 'forged_owner': 422}[case]
        e.db.expire_all()
        rows = list(e.db.scalars(select(ZerodhaPortfolioSnapshot)))
        assert len(rows) == (1 if case == 'valid' else 0)
    finally: await engine.dispose()


@pytest.mark.parametrize('owner', [1, 2])
def test_private_preview_requires_exact_known_fake_material_for_both_modes(linked_env, owner):
    from uuid import uuid4
    from app.domains.connections.service import claims
    from scripts.public_launch.preview_stage09 import ring
    from app.domains.runs.analysis_workflows.contracts import WorkflowDenied
    e = linked_env
    ConnectionCredential.__table__.create(e.engine, checkfirst=True)
    connection = e.db.scalar(select(IntegrationConnection).where(IntegrationConnection.owner_id == owner))
    name = 'usera' if owner == 1 else 'userb'
    material = {**claims(connection), 'token': 'synthetic-token-' + name,
        **({'app_key': 'synthetic-key-' + name, 'app_secret': 'synthetic-secret-' + name}
            if owner == 1 else {'platform_ref': 'synthetic-approved-platform'})}
    cipher, version = ring.seal(material)
    secret = ConnectionCredential(id=str(uuid4()), connection_id=connection.id, owner_id=owner,
        ciphertext=cipher, key_version=version)
    connection.credential_ref = secret.id; e.db.add(secret); e.db.commit()
    assert e.preview.synthetic_acquire(e.db, owner, now=e.now).acquisition_json['app_mode'] == connection.app_ownership_mode
    e.db.commit()
    secret.ciphertext = ring.seal({**material, 'token': 'unexpected-fixture-material'})[0]; e.db.commit()
    with pytest.raises(WorkflowDenied): e.preview.synthetic_acquire(e.db, owner, now=e.now)
