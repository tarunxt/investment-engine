"""Setup catalogue scope: explicit module never broadens visibility or owner."""
import asyncio
from types import SimpleNamespace

import pytest
from app.domains.modules.registry import ModuleId
from app.domains.runs import router as routes
from app.domains.modules import visibility


@pytest.mark.parametrize('module,visible,expected', [
    (ModuleId.ZERODHA_REBALANCE, ['zerodha_rebalance', 'indmoney_us'], ['zerodha_rebalance']),
    (ModuleId.INDMONEY_US, ['zerodha_rebalance', 'indmoney_us'], ['indmoney_us']),
    (ModuleId.INDMONEY_US, ['zerodha_rebalance'], []),
    (ModuleId.AI_STUDIO, [], []),
])
def test_explicit_setup_module_intersects_visibility_even_without_selected_flag(monkeypatch,module,visible,expected):
    calls=[]
    async def selected(db,owner):
        assert owner==42
        return visible
    class Repository:
        def __init__(self,db): pass
        async def list(self,query,**kwargs):
            calls.append(kwargs)
            return SimpleNamespace(items=[],to_dict=lambda:{'items':[],'total':0})
    monkeypatch.setattr(visibility,'visible_module_ids',selected)
    monkeypatch.setattr(routes,'PostgresRunRepository',Repository)
    result=asyncio.run(routes.list_runs(page=1,limit=20,summary=True,selected_only=False,
        module_id=module,db=object(),current_user=SimpleNamespace(id=42)))
    assert result['items']==[]
    assert calls==[{'user_id':42,'module_ids':expected,'summary':True}]


def test_module_query_is_enum_validated_on_actual_http_route():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    app=FastAPI()
    app.include_router(routes.router)
    app.dependency_overrides[routes.get_current_user]=lambda:SimpleNamespace(id=42)
    app.dependency_overrides[routes.get_async_db]=lambda:object()
    with TestClient(app) as client:
        response=client.get('/runs?module_id=foreign-or-invented&summary=true')
    assert response.status_code==422
    assert any(error['loc']==['query','module_id'] for error in response.json()['detail'])


from test_stage18_linked_analysis_preview import linked_env

def test_actual_sqlite_summary_excludes_foreign_other_module_and_unbound_sources(linked_env,monkeypatch):
    from sqlalchemy.ext.asyncio import create_async_engine,AsyncSession
    from app.domains.runs.models import Run,RunJob
    from app.shared.types import JobStatus
    e=linked_env
    RunJob.__table__.create(e.engine,checkfirst=True)
    for id,owner,module in [(501,1,'zerodha_rebalance'),(502,1,'indmoney_us'),(503,2,'zerodha_rebalance'),(504,1,None)]:
        e.db.add(Run(id=id,user_id=owner,module_id=module,module_version=2 if module else None,
            prompt='Untrusted text naming both India and US; not authority',prompt_preview='Synthetic',status=JobStatus.COMPLETED))
    e.db.commit()
    async def visible(db,owner):return ['zerodha_rebalance','indmoney_us']
    monkeypatch.setattr(visibility,'visible_module_ids',visible)
    async def read():
        engine=create_async_engine('sqlite+aiosqlite:///'+str(e.path))
        try:
            async with AsyncSession(engine) as db:
                result=await routes.list_runs(page=1,limit=20,summary=True,selected_only=False,module_id=ModuleId.ZERODHA_REBALANCE,db=db,current_user=SimpleNamespace(id=1))
                assert result['total']==1
                assert result['items'][0].updated_at.tzinfo is None  # Stored legacy time is not an offset-bearing instant.
                assert [(r.id,r.module_id,r.module_version) for r in result['items']]==[(501,'zerodha_rebalance',2)]
        finally:await engine.dispose()
    asyncio.run(read())
