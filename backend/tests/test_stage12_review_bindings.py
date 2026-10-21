"""Independent-review regressions: no providers, receipts are explicitly fake."""
from copy import deepcopy
from dataclasses import replace
from datetime import timedelta
import pytest
from sqlalchemy import select
from app.domains.connections.models import IntegrationConnection
from app.domains.zerodha.models import ZerodhaPortfolioSnapshot
from app.domains.runs.analysis_workflows.runtime import owned_source
from app.domains.runs.analysis_workflows.acquisition import acquisition_payload,sane_capture
from app.domains.runs.analysis_workflows.contracts import digest,utc,WorkflowDenied
from app.domains.runs.analysis_workflows.adapters import QueuedAI
from app.domains.runs.analysis_workflows.effects import job_scope,validate_effect
from app.domains.runs.analysis_workflows import runtime as composition
from app.domains.jobs.models import Job
from test_stage12_durable_analysis import env,create,service,message,NOW


def india(e,*,captured=NOW,bound=True):
    IntegrationConnection.__table__.create(e.engine)
    ZerodhaPortfolioSnapshot.__table__.create(e.engine)
    snapshot=ZerodhaPortfolioSnapshot(user_id=1,snapshot_date=captured.date(),captured_at=captured,source='connection_sync' if bound else 'manual',holdings=[{'symbol':'SYNTHETIC_ACCOUNT_ONLY','quantity':1}],net_positions=[],day_positions=[])
    connection=IntegrationConnection(owner_id=1,provider='zerodha',app_ownership_mode='user_owned',provider_account_id='FAKE_ACCOUNT',status='active',token_expires_at=NOW+timedelta(hours=2),version=7,is_current=True)
    e.db.add_all([snapshot,connection]);e.db.flush()
    if bound:
        # Test-only acquisition evidence; no running producer fabricates this.
        snapshot.acquisition_json={'schema_version':1,'kind':'connection_acquisition_v1','owner_id':1,'snapshot_id':snapshot.id,'connection_id':connection.id,'connection_version':connection.version,'provider':'zerodha','provider_account_id':connection.provider_account_id,'app_mode':connection.app_ownership_mode,'captured_at':utc(snapshot.captured_at).isoformat(),'content_hash':digest(acquisition_payload(snapshot))}
    e.db.commit();return snapshot,connection


def test_review_legacy_snapshot_cannot_be_relabelled_new_account(env):
    e=env;s,c=india(e,captured=NOW-timedelta(hours=2),bound=False)
    c.provider_account_id='NEW_ACCOUNT';e.db.commit()
    with pytest.raises(WorkflowDenied,match='provenance'):owned_source(e.db,1,'india',now=NOW)


def test_matching_snapshot_acquisition_is_admitted_and_copied(env):
    e=env;s,c=india(e)
    result=owned_source(e.db,1,'india',now=NOW)
    assert result['connection']=={'id':c.id,'version':7,'account':'FAKE_ACCOUNT','mode':'user_owned'}
    assert result['acquisition']==s.acquisition_json
    result['acquisition']['connection_version']=99
    assert s.acquisition_json['connection_version']==7

@pytest.mark.parametrize('field,value',[
 ('schema_version',True),('kind','manual'),('owner_id',2),('owner_id',True),
 ('snapshot_id',999),('connection_id','different'),('connection_version',8),
 ('provider','other'),('provider_account_id','OLD_ACCOUNT'),('app_mode','platform_managed'),
 ('captured_at','2000-01-01T00:00:00+00:00'),('content_hash','wrong')])
def test_receipt_binding_mismatch_is_denied(env,field,value):
    e=env;s,c=india(e);s.acquisition_json={**s.acquisition_json,field:value}
    from sqlalchemy.orm.attributes import flag_modified
    flag_modified(s,'acquisition_json');e.db.commit()
    with pytest.raises(WorkflowDenied):owned_source(e.db,1,'india',now=NOW)

@pytest.mark.parametrize('field,value',[
 ('version',8),('provider_account_id','NEW_ACCOUNT'),('app_ownership_mode','platform_managed'),
 ('status','configured'),('is_current',False),('token_expires_at',NOW),('token_expires_at',NOW-timedelta(seconds=1))])
def test_connection_changes_do_not_reuse_old_acquisition(env,field,value):
    e=env;s,c=india(e);setattr(c,field,value);e.db.commit()
    with pytest.raises(WorkflowDenied):owned_source(e.db,1,'india',now=NOW)

@pytest.mark.parametrize('field,value',[
 ('holdings',[{'symbol':'OTHER','quantity':100}]),('net_positions',[{'pnl':100}]),
 ('day_positions',[{'quantity':2}]),('holdings_market_value',500),('available_margin',50),
 ('captured_at',NOW-timedelta(seconds=1)),('source','manual')])
def test_acquired_financial_payload_mutation_invalidates_receipt(env,field,value):
    e=env;s,c=india(e);setattr(s,field,value);e.db.commit()
    with pytest.raises(WorkflowDenied):owned_source(e.db,1,'india',now=NOW)

@pytest.mark.parametrize('offset,allowed',[(timedelta(days=365),False),(timedelta(seconds=61),False),(timedelta(seconds=60),True),(timedelta(seconds=30),True),(timedelta(hours=-48),True),(timedelta(hours=-48,seconds=-1),False)])
def test_snapshot_time_upper_and_lower_bounds(env,offset,allowed):
    e=env;s,c=india(e,captured=NOW+offset)
    if allowed:assert owned_source(e.db,1,'india',now=NOW)['snapshot_id']==s.id
    else:
        with pytest.raises(WorkflowDenied):owned_source(e.db,1,'india',now=NOW)


def test_other_owner_and_explicit_stale_snapshot_reference_denied(env):
    e=env;s,c=india(e)
    with pytest.raises(WorkflowDenied):owned_source(e.db,2,'india',now=NOW)
    with pytest.raises(WorkflowDenied):owned_source(e.db,1,'india',s.id+1,now=NOW)

def test_legacy_overwrite_clears_receipt_even_if_caller_supplies_one(env):
    repository='SyncZerodhaPortfolioSnapshotRepository'
    import app.domains.zerodha.repository as module
    e=env;s,c=india(e)
    data={field:deepcopy(getattr(s,field)) for field in ['captured_at','source','holdings_count','net_positions_count','day_positions_count','holdings_market_value','holdings_pnl','holdings_day_change_value','available_margin','positions_pnl','positions_m2m','holdings','net_positions','day_positions']}
    data['acquisition_json']=deepcopy(s.acquisition_json)
    getattr(module,repository)._apply_snapshot(s,data)
    assert s.acquisition_json is None


def queued(e):
    row=create(e);rt=replace(e.runtime,adapter=QueuedAI())
    service(e,rt).consume(message(e).id,now=NOW);e.db.commit()
    service(e,rt).consume(message(e).id,now=NOW);e.db.commit()
    return row,rt,e.db.scalar(select(Job))

@pytest.mark.parametrize('field,value',[
 ('provider','UNAPPROVED_PROVIDER'),('model','UNAPPROVED_MODEL'),('prompt','DIFFERENT_PROMPT'),
 ('user_id',2),('module_id','ai_studio'),('module_version',99),
 ('auto_rebalance_portfolio','india'),('auto_rebalance_sequence',99),('auto_rebalance_label','different')])
def test_actual_job_mutation_denied_at_effect_and_result_consumption(env,monkeypatch,field,value):
    e=env;row,rt,job=queued(e);monkeypatch.setattr(composition,'_registered',rt)
    with job_scope(job.id):validate_effect(e.db)
    e.db.commit();setattr(job,field,value);e.db.commit()
    with job_scope(job.id),pytest.raises(PermissionError):validate_effect(e.db)
    e.db.rollback()
    assert service(e,rt).consume(message(e,NOW+timedelta(seconds=6)).id,now=NOW+timedelta(seconds=6))=='failed';e.db.commit()
    assert service(e).detail(1,row.id)['status']=='partial'


def test_review_simultaneous_provider_model_prompt_mutation_is_rejected(env,monkeypatch):
    e=env;row,rt,job=queued(e);monkeypatch.setattr(composition,'_registered',rt)
    job.provider='UNAPPROVED_PROVIDER';job.model='UNAPPROVED_MODEL';job.prompt='DIFFERENT_PROMPT';e.db.commit()
    with job_scope(job.id),pytest.raises(WorkflowDenied):validate_effect(e.db)

@pytest.mark.parametrize('field,value',[
 ('prompt_version','wrong'),('plan_version','wrong'),('orders_authorized',True),
 ('analysis_only',False),('workflow_id',999),('stage','rebalance'),('kind','manual'),
 ('source_hash','wrong'),('plan_hash','wrong')])
def test_context_binding_cannot_override_actual_plan(env,monkeypatch,field,value):
    e=env;row,rt,job=queued(e);monkeypatch.setattr(composition,'_registered',rt)
    job.request_context_json={**job.request_context_json,field:value};e.db.commit()
    with job_scope(job.id),pytest.raises(PermissionError):validate_effect(e.db)


def test_prior_checkpoint_mutation_cannot_change_generated_prompt(env,monkeypatch):
    e=env;row,rt,job=queued(e);monkeypatch.setattr(composition,'_registered',rt)
    stage=service(e).stages(row)[0]
    stage.checkpoint_json={**stage.checkpoint_json,'result':{'tampered':True}};e.db.commit()
    with job_scope(job.id),pytest.raises(WorkflowDenied):validate_effect(e.db)

@pytest.mark.parametrize('offset,allowed',[(timedelta(seconds=30),True),(timedelta(seconds=61),False),(timedelta(days=365),False),(timedelta(hours=-49),False)])
def test_us_snapshot_time_guard_is_independent_of_import_approval(env,offset,allowed):
    from app.domains.indmoney_us.models import IndMoneyUsPortfolioSnapshot as Snapshot
    from app.domains.indmoney_us.schemas import IndMoneyUsPortfolioSnapshotCreateRequest as Request
    from app.domains.indmoney_us.import_validation import parse_import,CSV_TEMPLATE
    e=env;Snapshot.__table__.create(e.engine)
    payload=parse_import(Request(raw_text=CSV_TEMPLATE,captured_at=NOW+offset,format='csv'))
    payload['acceptance_state']='accepted'
    snapshot=Snapshot(user_id=1,**payload);e.db.add(snapshot);e.db.commit()
    if allowed:assert owned_source(e.db,1,'indmoney_us',now=NOW)['owner_id']==1
    else:
        with pytest.raises(WorkflowDenied):owned_source(e.db,1,'indmoney_us',now=NOW)


def test_acquisition_receipt_is_not_inferred_for_connection_sync_label_alone(env):
    e=env;s,c=india(e);s.acquisition_json=None;e.db.commit()
    with pytest.raises(WorkflowDenied,match='provenance'):owned_source(e.db,1,'india',now=NOW)
