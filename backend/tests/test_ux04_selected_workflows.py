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
