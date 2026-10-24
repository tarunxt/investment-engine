"""Advisory revisions recalculate exact source math, never financial authority."""
from copy import deepcopy
from decimal import Decimal
from types import SimpleNamespace
import asyncio
import pytest
from sqlalchemy import select
from app.domains.runs.analysis_workflows.action_plan import project
from app.domains.runs.analysis_workflows.plan_revisions import revise,select_plan
from app.domains.runs.analysis_workflows.contracts import digest,WorkflowDenied
from app.domains.order_intents.contracts import OrderDenied
from app.domains.runs.analysis_workflows.service import Workflows
from app.domains.runs.analysis_router import get_action_plan,revise_action_plan,AdvisoryRevision
from app.domains.jobs.models import Job
from app.domains.runs.models import AutoRebalanceWorkflow
from app.infrastructure.database.outbox.models import OutboxMessage
from app.shared.exceptions import ConflictException,NotFoundException
from test_stage18_linked_analysis_preview import linked_env,complete_analysis


def base():
    source={'owner_id':1,'currency':'USD','captured_at':'2026-10-24T00:00:00Z','holdings':[{'symbol':'UATA','quantity':'1','market_price':'10'},{'symbol':'UATB','quantity':'1','market_price':'20'}]}
    row=SimpleNamespace(user_id=1,id=7,portfolio='indmoney_us',execution_json={'source_hash':digest(source),'plan_hash':'a'*64})
    receipt={'owner_id':1,'workflow_id':7,'orders_authorized':False,'simulation':True,'source_hash':digest(source),'plan_hash':'a'*64,'actionables_result_hash':'b'*64,'recommendations':[{'instrument':name,'current_units':'1','final_units':'1','action':'hold'} for name in ['US:UATA','US:UATB']]}
    return project(receipt,workflow=row,source=source),SimpleNamespace(checkpoint_json={'result':{'original':'unchanged'},'result_hash':'safe'})


@pytest.mark.parametrize('units,after,net',[(['2','3'],'80','-50'),(['0','0'],'0','30'),(['0','2'],'40','-10')])
def test_buy_sell_mixed_recalculate_but_funds_and_execution_remain_blocked(units,after,net):
    original,stage=base();before=deepcopy(stage.checkpoint_json)
    targets=[{'instrument':item['instrument'],'final_units':value} for item,value in zip(original['actions'],units)]
    result=revise(stage,original,original['version'],targets)
    assert result['after_source_value']==after and result['estimated_net_cash_impact']==net
    assert result['cash_before'] is result['cash_after'] is None
    assert result['review_available'] is False and result['orders_authorized'] is False
    assert result['revision_validation']['execution_eligible'] is False
    assert result['revision_validation']['funds']=='not_established'
    assert len(stage.checkpoint_json['advisory_revisions'])==1
    assert {k:v for k,v in stage.checkpoint_json.items() if k!='advisory_revisions'}==before
    assert revise(stage,original,original['version'],targets)['version']==result['version']
    assert len(stage.checkpoint_json['advisory_revisions'])==1
    assert select_plan(stage,original,original['version'])['actions']==original['actions']
    other=[{'instrument':item['instrument'],'final_units':'9'} for item in original['actions']]
    with pytest.raises(ConflictException):revise(stage,original,original['version'],other)
    assert 'current' not in stage.checkpoint_json['advisory_revisions'][0]['record']


def test_unchanged_targets_do_not_create_a_revision_and_missing_prices_are_not_zero():
    original,stage=base();targets=[{'instrument':item['instrument'],'final_units':item['final_units']} for item in original['actions']]
    assert revise(stage,original,original['version'],targets)['version']==original['version']
    assert 'advisory_revisions' not in stage.checkpoint_json
    original['actions'][0]['source_price']=None
    result=revise(stage,original,original['version'],[{**item,'final_units':'3'} for item in targets])
    assert result['estimated_net_cash_impact'] is None and result['after_source_value'] is None
    assert result['revision_validation']['within_default_gross_reference_bound'] is None
    assert result['review_available'] is False


@pytest.mark.parametrize('bad',[[],[{'instrument':'US:FOREIGN','final_units':'1'},{'instrument':'US:UATB','final_units':'1'}],[{'instrument':'US:UATA','final_units':'NaN'},{'instrument':'US:UATB','final_units':'1'}],[{'instrument':'US:UATA','final_units':'-1'},{'instrument':'US:UATB','final_units':'1'}]])
def test_invalid_or_omitted_instruments_cannot_save_or_change_original(bad):
    original,stage=base();before=deepcopy(stage.checkpoint_json)
    with pytest.raises((WorkflowDenied,OrderDenied)):revise(stage,original,original['version'],bad)
    assert stage.checkpoint_json==before


def test_large_gross_change_is_flagged_and_tampered_receipt_is_unavailable():
    original,stage=base();result=revise(stage,original,original['version'],[{'instrument':item['instrument'],'final_units':'100000'} for item in original['actions']])
    assert result['revision_validation']['within_default_gross_reference_bound'] is False
    assert result['review_available'] is False
    stage.checkpoint_json['advisory_revisions'][0]['record']['targets']['US:UATA']='0'
    with pytest.raises(WorkflowDenied):select_plan(stage,original)


def test_actual_owned_route_persists_versions_without_jobs_dispatch_or_original_evidence_change(linked_env):
    e=linked_env;receipt=complete_analysis(e,1,'indmoney_us');id=receipt['workflow_id'];flow=e.db.get(AutoRebalanceWorkflow,id);service=Workflows(e.db,e.runtime)
    original=project(receipt,workflow=flow,source=flow.execution_json['source']);checkpoint=deepcopy(service.stages(flow)[-1].checkpoint_json);frozen=deepcopy(flow.execution_json)
    before=[len(list(e.db.scalars(select(model)))) for model in (AutoRebalanceWorkflow,Job,OutboxMessage)]
    async def run_sync(fn):return fn(e.db)
    async def commit():e.db.commit()
    async def rollback():e.db.rollback()
    db=SimpleNamespace(run_sync=run_sync,commit=commit,rollback=rollback)
    body=AdvisoryRevision(expected_version=original['version'],targets=[{'instrument':item['instrument'],'final_units':'1'} for item in original['actions']])
    async def mutate(owner):return await revise_action_plan(id,body,db=db,user=SimpleNamespace(id=owner),runtime=e.runtime)
    with pytest.raises(NotFoundException):asyncio.run(mutate(2))
    result=asyncio.run(mutate(1));assert result['version']!=original['version']
    assert asyncio.run(mutate(1))['version']==result['version']
    assert before==[len(list(e.db.scalars(select(model)))) for model in (AutoRebalanceWorkflow,Job,OutboxMessage)]
    assert flow.execution_json==frozen
    stored=service.stages(flow)[-1].checkpoint_json
    assert {k:v for k,v in stored.items() if k!='advisory_revisions'}==checkpoint
    assert e.preview.completed_analysis(e.db,1,id,now=e.now)['recommendations']==receipt['recommendations']
    async def read(version):return await get_action_plan(id,db=db,user=SimpleNamespace(id=1),runtime=e.runtime,version=version)
    assert asyncio.run(read(original['version']))['version']==original['version']
    assert asyncio.run(read(None))['version']==result['version']


def test_preview_only_admits_exact_numeric_advisory_revision_path(linked_env):
    allowed=linked_env.preview.allowed
    assert allowed('POST','/runs/analysis-workflows/7/action-plan/revisions')
    for method,path in [('DELETE','/runs/analysis-workflows/7/action-plan/revisions'),('POST','/runs/analysis-workflows/foreign/action-plan/revisions'),('POST','/runs/analysis-workflows/7/action-plan/approve'),('POST','/runs/analysis-workflows/7/action-plan/revisions/execute')]:assert not allowed(method,path)


def test_revision_history_is_bounded_without_discarding_prior_versions():
    original,stage=base();parent=original['version']
    for index in range(20):
        result=revise(stage,original,parent,[{'instrument':item['instrument'],'final_units':str(index+2)} for item in original['actions']]);parent=result['version']
    before=deepcopy(stage.checkpoint_json)
    with pytest.raises(WorkflowDenied):revise(stage,original,parent,[{'instrument':item['instrument'],'final_units':'50'} for item in original['actions']])
    assert stage.checkpoint_json==before and len(select_plan(stage,original)['versions'])==21


def test_revision_schema_cannot_inject_approval_or_override_prices():
    from pydantic import ValidationError
    with pytest.raises(ValidationError):AdvisoryRevision(expected_version='a'*64,targets=[{'instrument':'US:UATA','final_units':'1','source_price':'0.01'}])
    with pytest.raises(ValidationError):AdvisoryRevision(expected_version='a'*64,targets=[{'instrument':'US:UATA','final_units':'1'}],orders_authorized=True)
