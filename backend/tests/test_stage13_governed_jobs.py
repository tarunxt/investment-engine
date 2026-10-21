"""Existing six-stage workflow -> existing Job -> bounded fake worker -> checkpoint."""
from copy import deepcopy
from dataclasses import replace
from datetime import timedelta
import pytest
from sqlalchemy import select
from app.infrastructure.database.base import Base
from app.domains.recommendation_audit.models import SpendAccount,SpendAttempt
from app.domains.jobs.models import Job
from app.domains.runs.analysis_workflows.adapters import QueuedAI
from app.domains.runs.analysis_workflows.bindings import validate_job_request,dependency_results
from app.domains.runs.analysis_workflows.contracts import WorkflowDenied
from app.domains.ai_limits.jobs import SyntheticGovernance,execute_governed_job
from app.domains.ai_limits.contracts import Limits,BoundaryDenied,digest
from app.domains.ai_limits.runner import FakeProvider
from app.shared.types import JobStatus
from test_stage12_durable_analysis import env,NOW,STAGES,TOPIC,create,message,service


def governed(e,*,source_change=None,document_change=None,limits=Limits()):
    Base.metadata.create_all(e.engine,tables=[m.__table__ for m in [SpendAccount,SpendAttempt]])
    e.plan['guardrails_version']='stage13-v1'
    for source_owner in e.states:
        # Governed fixtures must supply actual frozen facts, not let a later
        # callback invent them. Stage12's older ungoverned fixtures are intact.
        e.states[source_owner].setdefault('holdings',{'US:TEST':'10'})
        e.states[source_owner].setdefault('currency','USD')
        e.states[source_owner].setdefault('captured_at',NOW.isoformat())
    def source(db,row,job,now):
        s={'owner_id':row.user_id,'module_id':row.module_id,'captured_at':NOW,'content_hash':row.execution_json['source_hash'],'currency':'USD','holdings':{'US:TEST':'10'},'provenance':{'provider':job.provider,'model':job.model,'prompt_hash':digest(job.prompt),'input_hash':row.execution_json['source_hash'],'prompt_version':job.request_context_json['prompt_version']}}
        s.update(source_change or {});return s
    providers=[]
    def provider(s):
        d={'schema_version':1,'currency':'USD','recommendations':[{'instrument':'US:TEST','action':'hold','current_units':'10','final_units':'10','allocation':'.1'}],'provenance':deepcopy(s['provenance'])};d.update(document_change or {})
        p=FakeProvider(d);providers.append(p);return p
    governance=SyntheticGovernance(limits,source,lambda db,row,job:{'US:TEST'},provider)
    rt=replace(e.runtime,adapter=QueuedAI(governance),governance=governance)
    return rt,providers

def first_job(e,rt):
    row=service(e,rt).create(1,'indmoney_us','stage13-governed-job',now=NOW);e.db.commit()
    assert service(e,rt).consume(message(e).id,now=NOW)=='completed';e.db.commit()
    assert service(e,rt).consume(message(e).id,now=NOW)=='waiting';e.db.commit()
    return row,e.db.scalar(select(Job).order_by(Job.id.desc()))

def test_all_six_actual_workflow_stages_complete_with_fenced_fake_worker(env):
    e=env;rt,providers=governed(e);row,job=first_job(e,rt);at=NOW
    for stage in STAGES[1:]:
        if stage!='threats':
            assert service(e,rt).consume(message(e,at).id,now=at)=='waiting';e.db.commit()
            job=e.db.scalar(select(Job).order_by(Job.id.desc()))
        assert execute_governed_job(e.db,job.id,rt,now=at)['status']=='completed'
        assert job.status==JobStatus.COMPLETED and job.runtime_metadata_json['guardrails']['orders_authorized'] is False
        assert execute_governed_job(e.db,job.id,rt,now=at)['status']=='already_completed'
        at+=timedelta(seconds=6)
        assert service(e,rt).consume(message(e,at).id,now=at)=='completed';e.db.commit()
    assert service(e,rt).detail(1,row.id)['status']=='completed'
    assert len(providers)==5 and sum(p.calls for p in providers)==5
    attempts=e.db.scalars(select(SpendAttempt)).all();assert len(attempts)==5 and {a.status for a in attempts}=={'settled'} and sum(a.actual_usd for a in attempts)==0
    assert service(e,rt).detail(1,row.id)['inputs']['orders_authorized'] is False

@pytest.mark.parametrize('source_change',[{'owner_id':2},{'module_id':'zerodha_rebalance'},{'captured_at':NOW+timedelta(days=1)}])
def test_foreign_or_future_source_stops_before_fake_call_and_reservation(env,source_change):
    e=env;rt,providers=governed(e,source_change=source_change);row,job=first_job(e,rt)
    with pytest.raises(BoundaryDenied):execute_governed_job(e.db,job.id,rt,now=NOW)
    assert not providers and not e.db.scalars(select(SpendAttempt)).all()

def test_invalid_model_result_not_consumed_even_after_zero_cost_call(env):
    e=env;rt,providers=governed(e,document_change={'currency':'EUR'});row,job=first_job(e,rt)
    with pytest.raises(BoundaryDenied):execute_governed_job(e.db,job.id,rt,now=NOW)
    assert job.status!=JobStatus.COMPLETED and job.response is None and providers[0].calls==1
    assert e.db.scalar(select(SpendAttempt)).status=='settled'
    assert execute_governed_job(e.db,job.id,rt,now=NOW)['status']=='settled'
    assert sum(p.calls for p in providers)==1

def test_changed_actual_job_and_removed_guardrail_marker_fail_closed(env):
    e=env;rt,providers=governed(e);row,job=first_job(e,rt)
    job.request_context_json={k:v for k,v in job.request_context_json.items() if k!='guardrails_version'};e.db.commit()
    with pytest.raises(BoundaryDenied):execute_governed_job(e.db,job.id,rt,now=NOW)
    from app.domains.runs.analysis_workflows.bindings import frozen_request
    stage=next(s for s in service(e,rt).stages(row) if s.job_id==job.id)
    job.request_context_json=frozen_request(row,stage,dependency_results(service(e,rt).stages(row),stage))['context'];job.model='forged';e.db.commit()
    with pytest.raises(WorkflowDenied):execute_governed_job(e.db,job.id,rt,now=NOW)
    assert not providers

def test_cancelled_work_and_absent_composition_cannot_fall_back_to_provider(env):
    e=env;rt,providers=governed(e);row,job=first_job(e,rt)
    with pytest.raises(BoundaryDenied):execute_governed_job(e.db,job.id,None,now=NOW)
    service(e,rt).control(1,row.id,'cancel',row.control_version,now=NOW);e.db.commit()
    with pytest.raises((BoundaryDenied,WorkflowDenied,PermissionError)):execute_governed_job(e.db,job.id,rt,now=NOW)
    assert not providers

@pytest.mark.parametrize('change',['response','receipt','budget_owner','budget_request','budget_account'])
def test_actual_response_and_budget_revalidated_at_checkpoint_consumption(env,change):
    import json
    e=env;rt,providers=governed(e);row,job=first_job(e,rt)
    execute_governed_job(e.db,job.id,rt,now=NOW)
    if change=='response':
        document=json.loads(job.response);document['recommendations'][0]['allocation']='.9';job.response=json.dumps(document)
        # Even forged matching metadata cannot replace semantic revalidation.
        job.runtime_metadata_json={**job.runtime_metadata_json,'guardrails':{**job.runtime_metadata_json['guardrails'],'output_hash':digest(document)}}
    elif change=='receipt':job.runtime_metadata_json={**job.runtime_metadata_json,'guardrails':{'valid':True}}
    else:
        receipt=e.db.scalar(select(SpendAttempt))
        if change=='budget_owner':receipt.user_id=2
        elif change=='budget_request':receipt.request_hash='a'*64
        else:
            account=SpendAccount(user_id=2,day=NOW.date().isoformat(),cap_usd=1,spent_usd=0,reserved_usd=0)
            e.db.add(account);e.db.flush();receipt.account_id=account.id
    e.db.commit()
    assert service(e,rt).consume(message(e,NOW+timedelta(seconds=6)).id,now=NOW+timedelta(seconds=6))=='failed';e.db.commit()
    assert service(e,rt).detail(1,row.id)['status']=='partial'

def test_existing_celery_worker_entry_uses_governance_without_provider_factory(env,monkeypatch,synthetic_module_unit_context):
    """Detached Celery unit context; SQL ownership is tested without it above."""
    from sqlalchemy.orm import Session
    from unittest.mock import Mock
    from app.domains.jobs import tasks
    from app.domains.runs import models
    from app.domains.runs.analysis_workflows import runtime
    from app.domains.ai_providers.factory import ProviderFactory
    e=env;rt,providers=governed(e);row,job=first_job(e,rt)
    Base.metadata.create_all(e.engine,tables=[models.RunJob.__table__])
    monkeypatch.setattr(runtime,'_registered',rt)
    monkeypatch.setattr(tasks,'SyncSessionLocal',lambda:Session(e.engine,expire_on_commit=False,autoflush=False))
    monkeypatch.setattr(tasks,'_publish_job_update',Mock());monkeypatch.setattr(tasks,'_refresh_run_status',Mock())
    live_factory=Mock(side_effect=AssertionError('Real provider factory must not run'))
    monkeypatch.setattr(ProviderFactory,'create',live_factory)
    tasks.execute_ai_job.run(job.id)
    e.db.expire_all();assert e.db.get(Job,job.id).status==JobStatus.COMPLETED
    live_factory.assert_not_called();assert sum(p.calls for p in providers)==1

def test_worker_cannot_cancel_or_leapfrog_another_owners_fair_turn(env):
    from app.domains.ai_limits.budget import Budgets
    from app.domains.ai_limits.jobs import job_request
    from app.domains.modules.lifecycle import WorkIdentity
    from app.infrastructure.database.outbox.models import OutboxMessage
    e=env;rt,providers=governed(e);row1,job1=first_job(e,rt)
    row2=service(e,rt).create(2,'indmoney_us','second-owner',now=NOW);e.db.commit()
    def next_other():return e.db.scalar(select(OutboxMessage).where(OutboxMessage.topic==TOPIC,OutboxMessage.payload['owner_id'].as_integer()==2,OutboxMessage.execution_attempts==0))
    assert service(e,rt).consume(next_other().id,now=NOW)=='completed';e.db.commit()
    assert service(e,rt).consume(next_other().id,now=NOW)=='waiting';e.db.commit()
    job2=e.db.scalar(select(Job).order_by(Job.id.desc()))
    policy=lambda db,i:rt.policy(db,i.owner_id,'indmoney_us',version=i.version)
    budget=Budgets(e.db,Limits(),policy)
    first=budget.enqueue(WorkIdentity(1,'indmoney_us',1),'analysis-job:'+str(job1.id),'generation-1',job_request(row1,job1),input_tokens=len(job1.prompt.encode()),output_tokens=Limits().max_output_tokens,fanout=1,now=NOW);e.db.commit()
    assert execute_governed_job(e.db,job2.id,rt,now=NOW)['status']=='waiting_for_admission'
    assert first.status=='queued' and sum(p.calls for p in providers)==0
    assert execute_governed_job(e.db,job1.id,rt,now=NOW)['status']=='completed'
    assert execute_governed_job(e.db,job2.id,rt,now=NOW)['status']=='completed'
    assert sum(p.calls for p in providers)==2

@pytest.mark.parametrize('state',['waiting_for_admission','quota_blocked'])
def test_worker_admission_backoff_uses_existing_outbox_or_partial_without_io(env,monkeypatch,synthetic_module_unit_context,state):
    from sqlalchemy.orm import Session
    from unittest.mock import Mock
    from app.domains.jobs import tasks
    from app.domains.runs import models
    from app.domains.ai_limits import jobs
    from app.domains.ai_providers.factory import ProviderFactory
    e=env;rt,providers=governed(e);row,job=first_job(e,rt)
    Base.metadata.create_all(e.engine,tables=[models.RunJob.__table__])
    monkeypatch.setattr(tasks,'SyncSessionLocal',lambda:Session(e.engine,expire_on_commit=False,autoflush=False))
    monkeypatch.setattr(tasks,'_publish_job_update',Mock());monkeypatch.setattr(tasks,'_refresh_run_status',Mock())
    monkeypatch.setattr(jobs,'execute_governed_job',Mock(return_value={'status':state,'job_id':job.id}))
    defer=Mock(return_value=True);monkeypatch.setattr(tasks,'defer_retry',defer)
    live=Mock(side_effect=AssertionError('No live provider fallback'));monkeypatch.setattr(ProviderFactory,'create',live)
    tasks.execute_ai_job.run(job.id);e.db.expire_all()
    if state=='waiting_for_admission':defer.assert_called_once_with(5);assert e.db.get(Job,job.id).status==JobStatus.PENDING
    else:defer.assert_not_called();assert e.db.get(Job,job.id).status==JobStatus.PARTIAL
    assert tasks._classify_exc(BoundaryDenied('quota'),0)==(False,0)
    live.assert_not_called();assert not providers
