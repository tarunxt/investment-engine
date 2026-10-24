"""Action-plan valuation is advisory, owned, version-bound and missing-safe."""
from copy import deepcopy
from types import SimpleNamespace
import asyncio
import pytest
from sqlalchemy import select
from app.domains.runs.analysis_workflows.action_plan import project
from app.domains.runs.analysis_workflows.contracts import digest,WorkflowDenied
from app.domains.runs.models import AutoRebalanceWorkflow
from app.domains.runs.analysis_router import get_action_plan
from app.shared.exceptions import NotFoundException
from test_stage18_linked_analysis_preview import linked_env,complete_analysis

@pytest.mark.parametrize('owner,portfolio',[(1,'india'),(2,'india'),(1,'indmoney_us'),(2,'indmoney_us')])
def test_actual_governed_result_is_owned_and_projection_has_no_side_effects(linked_env,owner,portfolio):
    e=linked_env;receipt=complete_analysis(e,owner,portfolio);row=e.db.get(AutoRebalanceWorkflow,receipt['workflow_id'])
    result=project(receipt,workflow=row,source=row.execution_json['source'])
    assert result['owner_id']==owner and result['workflow_id']==row.id
    assert result['orders_authorized'] is False and result['simulation'] is True
    assert result['cash_after'] is result['cash_before'] is result['estimated_charges'] is None
    assert result['amendment']['available'] is False and result['coverage']['candidate_universe_accepted'] is False
    assert not e.db.new and not e.db.dirty
    if portfolio=='india':assert result['connection']['account_label'].startswith('***') and 'FAKE_OWNER' not in result['connection']['account_label']
    else:assert result['connection'] is None and result['no_changes'] is True
    foreign=deepcopy(receipt);foreign['owner_id']=3-owner
    with pytest.raises(WorkflowDenied):project(foreign,workflow=row,source=row.execution_json['source'])

@pytest.mark.parametrize('finals',[['2','3'],['0','0'],['1','3'],['1','1']])
def test_buy_sell_mixed_and_unchanged_source_valuations(finals):
    source={'owner_id':1,'currency':'USD','captured_at':'2026-10-24T00:00:00Z','holdings':[{'symbol':'UATA','quantity':'1','market_price':'10'},{'symbol':'UATB','quantity':'1','market_price':'20'}]}
    row=SimpleNamespace(user_id=1,id=7,portfolio='indmoney_us',execution_json={'source_hash':digest(source),'plan_hash':'a'*64})
    receipt={'owner_id':1,'workflow_id':7,'orders_authorized':False,'simulation':True,'source_hash':digest(source),'plan_hash':'a'*64,'actionables_result_hash':'b'*64,'recommendations':[{'instrument':instrument,'current_units':'1','final_units':final,'action':'hold' if final=='1' else 'sell' if final=='0' else 'buy'} for instrument,final in zip(['US:UATA','US:UATB'],finals)]}
    result=project(receipt,workflow=row,source=source)
    assert result['before_source_value']=='30' and result['after_source_value']==str(int(finals[0])*10+int(finals[1])*20)
    assert result['no_changes']==(finals==['1','1'])
    assert result['version']==project(receipt,workflow=row,source=source)['version']
    changed=deepcopy(receipt);changed['actionables_result_hash']='c'*64
    assert project(changed,workflow=row,source=source)['version']!=result['version']
    for holding in source['holdings']:holding.pop('market_price')
    row.execution_json['source_hash']=receipt['source_hash']=digest(source)
    missing=project(receipt,workflow=row,source=source)
    assert missing['before_source_value'] is missing['after_source_value'] is None
    assert all(action['estimated_value'] is None for action in missing['actions'])

def test_actual_endpoint_denies_foreign_and_stale_source(linked_env):
    e=linked_env;receipt=complete_analysis(e,1,'indmoney_us');before=len(list(e.db.scalars(select(AutoRebalanceWorkflow))))
    async def run_sync(fn):return fn(e.db)
    async def read(owner):return await get_action_plan(receipt['workflow_id'],db=SimpleNamespace(run_sync=run_sync),user=SimpleNamespace(id=owner),runtime=e.runtime)
    with pytest.raises(NotFoundException):asyncio.run(read(2))
    result=asyncio.run(read(1));assert result['owner_id']==1
    from test_stage18_linked_analysis_preview import imported_source
    imported_source(e,1)
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as denied:asyncio.run(read(1))
    assert denied.value.status_code==409
    assert len(list(e.db.scalars(select(AutoRebalanceWorkflow))))==before


def test_preview_new_action_plan_is_read_only_and_not_a_wildcard(linked_env):
    allowed=linked_env.preview.allowed
    assert allowed('GET','/runs/analysis-workflows/7/action-plan')
    for method,path in [('POST','/runs/analysis-workflows/7/action-plan'),('DELETE','/runs/analysis-workflows/7/action-plan'),('GET','/runs/analysis-workflows/7/action-plan/approve'),('GET','/runs/analysis-workflows/foreign/action-plan')]:assert not allowed(method,path)
