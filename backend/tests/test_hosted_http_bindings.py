"""Caller-owned HTTP integration against disposable SQL, never hosted evidence."""
from types import SimpleNamespace
import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from test_stage18_linked_analysis_preview import linked_env
from app.domains.auth.dependencies import get_current_user
from app.domains.runs.analysis_router import router, optional_analysis_runtime
from app.domains.runs.analysis_workflows.contracts import WorkflowDenied
from app.domains.runs.analysis_workflows.runtime import configured_runtime
from app.domains.runs.analysis_workflows.synthetic_sources import SimulationSourceScope
from app.infrastructure.database.session import get_async_db
from app.uat2.http_bindings import SimulationHTTPBinding
from app.uat2.policy_bindings import SESSION


@pytest.mark.asyncio
@pytest.mark.parametrize('storage,owner', [('snapshot', 1), ('snapshot', 2), ('snapshot', 999), ('journal', 1), ('journal', 2)])
async def test_installed_http_binding_uses_owned_session_and_clears_it(linked_env, monkeypatch, storage, owner):
    import app.infrastructure.database.session as module
    e = linked_env
    engine = create_async_engine('sqlite+aiosqlite:///' + str(e.path))
    sessions = []
    factory = async_sessionmaker(engine, expire_on_commit=False)
    def session_factory():
        db = factory(); sessions.append(db); return db
    monkeypatch.setattr(module, 'AsyncSessionLocal', session_factory)
    app = FastAPI(); app.include_router(router)
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id=owner)
    binding = SimulationHTTPBinding(scope=SimulationSourceScope('preview'), source_storage=storage).install(app)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            response = await client.get('/runs/analysis-workflows/config')
            if owner in (1, 2):
                source = await client.post('/runs/analysis-workflows/synthetic-source', json={'portfolio': 'india', 'key': 'http-acquisition-key'})
                assert source.status_code == 200 and source.json()['owner_id'] == owner
                workflow = await client.post('/runs/analysis-workflows', json={
                    'portfolio': 'india', 'key': 'scoped-http-analysis-key'})
                assert workflow.status_code == 200
                assert workflow.json()['owner_id'] == owner
                assert (await client.get('/runs/analysis-workflows')).json()['owner_id'] == owner
        assert response.status_code == (200 if owner in (1, 2) else 503)
        if owner in (1, 2): assert response.json() == {'enabled': True, 'analysis_only': True, 'orders_authorized': False}
        assert sessions and all(SESSION not in db.info for db in sessions)
        assert configured_runtime() is None
        assert binding._app is app
        assert set(app.dependency_overrides) == {get_current_user}
    finally: await engine.dispose()


def test_http_binding_cannot_replace_or_cross_install_dependencies():
    scope = SimulationSourceScope('preview')
    with pytest.raises(WorkflowDenied): SimulationHTTPBinding(scope=object())
    for target in (get_async_db, optional_analysis_runtime):
        app = FastAPI(); app.dependency_overrides[target] = lambda: None
        with pytest.raises(WorkflowDenied): SimulationHTTPBinding(scope=scope).install(app)
        assert set(app.dependency_overrides) == {target}
    app = FastAPI(); binding = SimulationHTTPBinding(scope=scope).install(app)
    with pytest.raises(WorkflowDenied): binding.install(FastAPI())
    with pytest.raises(WorkflowDenied): SimulationHTTPBinding(scope=scope).install(app)


def test_disposable_application_binding_collision_is_rejected_before_mutation():
    from app.domains.public_service.application_bindings import STATE
    app = FastAPI(); setattr(app.state, STATE, object())
    with pytest.raises(WorkflowDenied):
        SimulationHTTPBinding(scope=SimulationSourceScope('preview')).install(app)
    assert not app.dependency_overrides
