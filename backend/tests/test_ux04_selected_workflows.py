"""Exercise the actual route's SQL boundary before any row materializes."""
from types import SimpleNamespace
from unittest.mock import AsyncMock
import pytest
from app.domains.runs import analysis_router

@pytest.mark.asyncio
@pytest.mark.parametrize('selected,expected', [([],[]),(['zerodha_rebalance'],['india']),(['indmoney_us'],['indmoney_us']),(['zerodha_rebalance','indmoney_us'],['india','indmoney_us'])])
async def test_selected_workflow_query_is_scoped_before_read(monkeypatch,selected,expected):
    monkeypatch.setattr('app.domains.modules.visibility.visible_module_ids',AsyncMock(return_value=selected))
    queries=[]
    class Session:
        def scalars(self,query):
            queries.append(query.compile().params)
            return SimpleNamespace(all=lambda:[])
    async def run_sync(fn):return fn(Session())
    result=await analysis_router.list_analysis_workflows(selected_only=True,db=SimpleNamespace(run_sync=run_sync),user=SimpleNamespace(id=7102),runtime=object())
    assert result=={'owner_id':7102,'items':[]}
    if not expected:assert queries==[]
    else:
        assert queries[0]['user_id_1']==7102
        assert queries[0]['portfolio_1']==expected

@pytest.mark.asyncio
async def test_core_owned_history_keeps_prior_selection_semantics(monkeypatch):
    visibility=AsyncMock(side_effect=AssertionError('Core history must not use dashboard filter'))
    monkeypatch.setattr('app.domains.modules.visibility.visible_module_ids',visibility)
    queries=[]
    class Session:
        def scalars(self,q):queries.append(q.compile().params);return SimpleNamespace(all=lambda:[])
    async def run_sync(fn):return fn(Session())
    await analysis_router.list_analysis_workflows(db=SimpleNamespace(run_sync=run_sync),user=SimpleNamespace(id=7101),runtime=object())
    assert queries[0]['user_id_1']==7101
    assert 'portfolio_1' not in queries[0]

@pytest.mark.asyncio
async def test_single_module_workspace_cannot_read_other_selected_portfolio(monkeypatch):
    monkeypatch.setattr('app.domains.modules.visibility.visible_module_ids',AsyncMock(return_value=['zerodha_rebalance','indmoney_us']))
    queries=[]
    class Session:
        def scalars(self,q):queries.append(q.compile().params);return SimpleNamespace(all=lambda:[])
    async def run_sync(fn):return fn(Session())
    await analysis_router.list_analysis_workflows(selected_only=True,portfolio='india',db=SimpleNamespace(run_sync=run_sync),user=SimpleNamespace(id=7101),runtime=object())
    assert queries[0]['portfolio_1']==['india']
    assert queries[0]['user_id_1']==7101

@pytest.mark.asyncio
@pytest.mark.parametrize('denied',[False,True])
async def test_input_readiness_is_explicit_non_authorizing_and_uses_current_validation(monkeypatch,denied):
    monkeypatch.setattr('app.domains.modules.visibility.visible_module_ids',AsyncMock(return_value=['indmoney_us']))
    checked=[]
    class Service:
        def __init__(self,*args):pass
        def detail(self,owner,id):
            assert (owner,id)==(7101,42)
            return {'id':id,'owner_id':owner,'version':3,'inputs':{'source_hash':'a'*64,'plan_hash':'b'*64}}
        def validate_current(self,row):
            checked.append(row.id)
            if denied:raise analysis_router.WorkflowDenied('Synthetic stale binding')
    monkeypatch.setattr(analysis_router,'Workflows',Service)
    class Session:
        def scalars(self,q):return SimpleNamespace(all=lambda:[SimpleNamespace(id=42)])
    async def run_sync(fn):return fn(Session())
    result=await analysis_router.list_analysis_workflows(selected_only=True,portfolio='indmoney_us',include_readiness=True,db=SimpleNamespace(run_sync=run_sync),user=SimpleNamespace(id=7101),runtime=object())
    assert checked==[42]
    state=result['items'][0]['input_readiness']
    assert state['current'] is (not denied)
    assert state['orders_authorized'] is False
    assert (state['version'],state['source_hash'],state['plan_hash'])==(3,'a'*64,'b'*64)
