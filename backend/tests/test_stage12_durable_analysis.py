"""Real local SQL transactions with deterministic adapters, never provider I/O."""
from copy import deepcopy
from datetime import datetime,timezone,timedelta
from types import SimpleNamespace
import json
import pytest
from sqlalchemy import create_engine,select
from sqlalchemy.orm import Session
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.dialects.postgresql import JSONB
from app.infrastructure.database.base import Base
import app.infrastructure.database.all_models
from app.domains.auth.models import User
from app.shared.types import JobStatus
from app.domains.jobs.models import Job
from app.domains.prompts.models import Prompt
from app.domains.runs.models import Run,AutoRebalanceWorkflow as Workflow,AutoRebalanceWorkflowStage as Stage
from app.domains.modules.models import UserModule,UserModulePreferences
from app.domains.modules.policy import ModuleFacts
from app.infrastructure.database.outbox.models import OutboxMessage
from app.domains.runs.analysis_workflows.contracts import *
from app.domains.runs.analysis_workflows.service import Workflows
from app.domains.runs.analysis_workflows.runtime import policy
from app.domains.runs.analysis_workflows.adapters import DeterministicAnalysis,QueuedAI
from app.domains.runs.analysis_workflows.dispatch import dispatch
from app.shared.exceptions import NotFoundException,ConflictException

@compiles(JSONB,'sqlite')
def json_sqlite(type,compiler,**kw):return 'JSON'

NOW=datetime.now(timezone.utc)
@pytest.fixture
def env(tmp_path):
    engine=create_engine('sqlite:///'+str(tmp_path/'synthetic.sqlite'))
    tables=[User,Prompt,Job,Run,Workflow,Stage,OutboxMessage,UserModulePreferences,UserModule]
    Base.metadata.create_all(engine,tables=[t.__table__ for t in tables])
    db=Session(engine,expire_on_commit=False,autoflush=False)
    for id in [1,2]:
        db.add(User(id=id,email=f'owner{id}@stage12.example.invalid',username=f'synthetic{id}',password_hash='unusable',is_active=True,is_verified=True))
        db.add(UserModulePreferences(user_id=id,version=1))
        db.add(UserModule(user_id=id,module_id='indmoney_us',enabled=True,version=1,schedules_paused=False,config={'schema_version':1}))
    db.commit()
    states={1:{'owner_id':1,'snapshot_id':1,'version':1,'connection':{'version':1,'valid':True}},2:{'owner_id':2,'snapshot_id':2,'version':1,'connection':None}}
    plan={'version':'synthetic-plan-1','stages':{key:{'provider':'synthetic','model':'offline','prompt_version':'p1','template':'Synthetic analysis only'} for key in STAGES[1:]}}
    def source(s,owner,portfolio,id=None):
        data=deepcopy(states[owner])
        if data.get('connection') and not data['connection']['valid']:raise WorkflowDenied('Invalid token')
        return data
    facts=ModuleFacts(jurisdiction='allowed',plan='allowed',connection='not_required')
    runtime=Runtime(lambda s,o,p,**kw:policy(s,o,p,facts=facts,**kw),source,lambda portfolio:deepcopy(plan),DeterministicAnalysis(),lambda portfolio,due,now:{'timezone':'Asia/Kolkata','calendar_version':'synthetic-weekday-v1','market_open':True,'max_lateness_seconds':60,'missed_policy':'skip'})
    e=SimpleNamespace(db=db,engine=engine,runtime=runtime,states=states,plan=plan)
    yield e
    db.close();engine.dispose()

def service(e,runtime=None):return Workflows(e.db,runtime or e.runtime)
def create(e,key='synthetic-key-1',**kw):
    row=service(e).create(1,'indmoney_us',key,now=NOW,**kw);e.db.commit();return row

def message(e,at=NOW):return e.db.scalar(select(OutboxMessage).where(OutboxMessage.topic==TOPIC,OutboxMessage.execution_attempts==0,OutboxMessage.available_at<=naive(at)).order_by(OutboxMessage.created_at,OutboxMessage.id))
def drain(e,*,at=NOW,runtime=None):
    outcomes=[]
    for _ in range(40):
        m=message(e,at)
        if m is None:break
        outcomes.append(service(e,runtime).consume(m.id,now=at));e.db.commit()
    return outcomes

def test_browser_absence_and_worker_restart_complete_all_six_persisted_stages(env):
    e=env;row=create(e)
    # Recreate sessions between every task, as after browser loss/worker restart.
    for stage in STAGES:
        id=message(e).id;e.db.close();e.db=Session(e.engine,expire_on_commit=False,autoflush=False)
        assert service(e).consume(id,now=NOW)=='completed';e.db.commit()
    d=service(e).detail(1,row.id);assert d['status']=='completed'
    assert all(s['status']=='completed' and s['attempts']==1 for s in d['stages'])
    assert d['inputs']['orders_authorized'] is False
    assert [s['checkpoint']['dependencies'] for s in d['stages']]==[list(STAGES[:i]) for i in range(6)]

@pytest.mark.parametrize('boundary',['before_stage','after_adapter','after_checkpoint'])
@pytest.mark.parametrize('index',range(6))
def test_worker_crash_at_each_stage_transaction_boundary_is_recoverable(env,boundary,index):
    e=env;row=create(e)
    for _ in range(index):service(e).consume(message(e).id,now=NOW);e.db.commit()
    id=message(e).id
    def crash(point):
        if point==boundary:raise RuntimeError('synthetic crash')
    with pytest.raises(RuntimeError):service(e).consume(id,now=NOW,fault=crash)
    e.db.rollback();assert service(e).consume(id,now=NOW)=='completed';e.db.commit()
    assert service(e).consume(id,now=NOW)=='duplicate';e.db.commit();drain(e)
    assert service(e).detail(1,row.id)['status']=='completed'
    assert all(s['attempts']==1 for s in service(e).detail(1,row.id)['stages'])

def test_duplicate_creation_and_different_input_conflict(env):
    e=env;row=create(e);assert create(e).id==row.id
    e.states[1]['version']=2
    with pytest.raises(ConflictException):create(e)
    e.db.rollback()

def test_transactional_creation_rollback_leaves_no_work_or_dispatch(env):
    e=env;service(e).create(1,'indmoney_us','rollback-key',now=NOW);e.db.rollback()
    assert e.db.scalars(select(Workflow)).all()==[] and e.db.scalars(select(OutboxMessage)).all()==[]

@pytest.mark.parametrize('mutation',['module_disable','module_version','inactive_user','token','portfolio','connection','plan'])
def test_fresh_policy_or_version_change_blocks_every_next_stage(env,mutation):
    e=env;row=create(e);service(e).consume(message(e).id,now=NOW);e.db.commit()
    if mutation=='module_disable':e.db.scalar(select(UserModule).where(UserModule.user_id==1)).enabled=False
    elif mutation=='module_version':e.db.scalar(select(UserModule).where(UserModule.user_id==1)).version=2
    elif mutation=='inactive_user':e.db.get(User,1).is_active=False
    elif mutation=='token':e.states[1]['connection']['valid']=False
    elif mutation=='portfolio':e.states[1]['version']=2
    elif mutation=='connection':e.states[1]['connection']['version']=2
    else:e.plan['version']='changed'
    e.db.commit();assert service(e).consume(message(e).id,now=NOW)=='policy_denied';e.db.commit()
    assert service(e).detail(1,row.id)['status']=='paused'
    with pytest.raises(PermissionError):service(e).control(1,row.id,'resume',1)
    e.db.rollback()

@pytest.mark.parametrize('action',['pause','cancel'])
def test_controls_fence_stale_deliveries_and_survive_browser_reload(env,action):
    e=env;row=create(e);old=message(e).id;service(e).control(1,row.id,action,0);e.db.commit()
    assert service(e).consume(old,now=NOW)=='obsolete';e.db.commit()
    if action=='pause':service(e).control(1,row.id,'resume',1,now=NOW);e.db.commit();drain(e);assert service(e).detail(1,row.id)['status']=='completed'
    else:
        with pytest.raises(ConflictException):service(e).control(1,row.id,'resume',1)

def test_owner_and_control_cas_are_enforced(env):
    e=env;row=create(e)
    with pytest.raises(NotFoundException):service(e).detail(2,row.id)
    with pytest.raises(NotFoundException):service(e).control(2,row.id,'cancel',0)
    service(e).control(1,row.id,'pause',0);e.db.commit()
    with pytest.raises(ConflictException):service(e).control(1,row.id,'resume',0)

def test_bounded_transient_retry_and_explicit_failed_retry_preserve_checkpoint(env):
    e=env;row=create(e);calls=[]
    def transient(db,row,stage,deps,now):calls.append(stage.stage);raise TransientAnalysisError()
    runtime=Runtime(e.runtime.policy,e.runtime.source,e.runtime.plan,transient,e.runtime.calendar)
    at=NOW
    for i in range(3):
        result=service(e,runtime).consume(message(e,at).id,now=at);e.db.commit();at+=timedelta(seconds=10)
    assert result=='failed' and len(calls)==3
    d=service(e).detail(1,row.id);assert d['status']=='failed' and len(d['stages'][0]['checkpoint']['attempts'])==3
    service(e).control(1,row.id,'retry',0,now=at);e.db.commit();drain(e,at=at)
    d=service(e).detail(1,row.id);assert d['status']=='completed' and d['stages'][0]['attempts']==4


def test_partial_failure_never_borrows_historical_result(env):
    e=env;row=create(e)
    def adapter(db,row,stage,deps,now):
        if stage.stage=='swing':raise PermanentAnalysisError()
        return DeterministicAnalysis()(db,row,stage,deps,now)
    runtime=Runtime(e.runtime.policy,e.runtime.source,e.runtime.plan,adapter,e.runtime.calendar)
    drain(e,runtime=runtime);d=service(e).detail(1,row.id)
    assert d['status']=='partial' and d['stages'][2]['status']=='failed' and all(s['status']=='pending' for s in d['stages'][3:])


def test_outbox_uncertain_publish_redelivers_but_consumer_deduplicates(env):
    e=env;row=create(e);deliveries=[]
    def publish(id):deliveries.append(id);raise RuntimeError('unknown publish acknowledgment')
    assert dispatch(e.db,publish,e.runtime,now=NOW)['deferred']==1
    dispatch(e.db,lambda id:deliveries.append(id),e.runtime,now=NOW+timedelta(seconds=31))
    assert len(deliveries)==2 and deliveries[0]==deliveries[1]
    assert service(e).consume(deliveries[0],now=NOW)=='completed';e.db.commit()
    assert service(e).consume(deliveries[1],now=NOW)=='duplicate';e.db.commit()


def test_schedule_tick_dedup_future_due_lateness_and_pause_policy(env):
    e=env;future=NOW+timedelta(minutes=5)
    row=create(e,scheduled_at=future,schedule_id='synthetic-daily')
    assert create(e,key='different-client-key',scheduled_at=future,schedule_id='synthetic-daily').id==row.id
    id=e.db.scalar(select(OutboxMessage.id).where(OutboxMessage.topic==TOPIC))
    assert service(e).consume(id,now=NOW)=='not_due';e.db.commit()
    assert service(e).consume(id,now=future+timedelta(minutes=2))=='missed';e.db.commit()
    assert service(e).detail(1,row.id)['status']=='skipped'
    module=e.db.scalar(select(UserModule).where(UserModule.user_id==1));module.schedules_paused=True;e.db.commit()
    with pytest.raises(PermissionError):create(e,'paused-schedule',scheduled_at=future,schedule_id='other')
    assert service(e).detail(1,row.id)['status']=='skipped'


def test_disabled_module_denies_dispatch_before_publication(env):
    e=env;row=create(e);e.db.scalar(select(UserModule).where(UserModule.user_id==1)).enabled=False;e.db.commit()
    called=[];assert dispatch(e.db,lambda id:called.append(id),e.runtime,now=NOW)['denied']==1;assert called==[]


def test_queue_adapter_uses_existing_job_and_transactional_outbox_without_provider(env):
    e=env;row=create(e);runtime=Runtime(e.runtime.policy,e.runtime.source,e.runtime.plan,QueuedAI(),e.runtime.calendar)
    assert service(e,runtime).consume(message(e).id,now=NOW)=='completed';e.db.commit()
    assert service(e,runtime).consume(message(e).id,now=NOW)=='waiting';e.db.commit()
    job=e.db.scalar(select(Job));assert job.user_id==1 and job.export_status=='disabled' and job.request_context_json['orders_authorized'] is False
    assert len(e.db.scalars(select(OutboxMessage).where(OutboxMessage.topic=='job.created.v2')).all())==1
    from app.shared.types import JobStatus
    job.status=JobStatus.COMPLETED;job.response='Synthetic queued result';job.estimated_cost=0;e.db.commit()
    assert service(e,runtime).consume(message(e,NOW+timedelta(seconds=6)).id,now=NOW+timedelta(seconds=6))=='completed';e.db.commit()
    assert service(e).detail(1,row.id)['stages'][1]['checkpoint']['result']['data']['job_id']==job.id


def test_manual_retry_preserves_total_attempt_counter_and_job_receipts(env):
    e=env;row=create(e)
    def fail(*args):raise PermanentAnalysisError('synthetic failure')
    rt=__import__('dataclasses').replace(e.runtime,adapter=fail)
    assert service(e,rt).consume(message(e).id,now=NOW)=='failed';e.db.commit()
    service(e).control(1,row.id,'retry',0,now=NOW);e.db.commit();drain(e)
    detail=service(e).detail(1,row.id)
    assert detail['stages'][0]['attempts']==2
    assert [a['number'] for a in detail['stages'][0]['checkpoint']['attempts']]==[1,2]

@pytest.mark.parametrize('change',['source','plan','owner','kind','module'])
def test_immutable_input_receipts_cannot_be_rewritten_through_orm(env,change):
    e=env;row=create(e)
    if change=='source':row.execution_json={**row.execution_json,'source_hash':'tampered'}
    elif change=='plan':row.execution_json={**row.execution_json,'plan_hash':'tampered'}
    elif change=='owner':row.user_id=2
    elif change=='kind':row.orchestration_kind=None
    else:row.module_version=99
    with pytest.raises(ValueError):e.db.flush()
    e.db.rollback()

def test_active_work_is_bounded_and_invalid_delivery_cannot_advance(env):
    e=env;row=create(e);create(e,key='second-workflow')
    with pytest.raises(ConflictException):create(e,key='third-workflow')
    e.db.rollback()
    for bad in ['not-a-uuid','00000000-0000-0000-0000-000000000000']:
        assert service(e).consume(bad,now=NOW)=='invalid_delivery'
    assert service(e).detail(1,row.id)['stages'][0]['attempts']==0

def test_dependency_hash_tampering_prevents_next_stage(env):
    e=env;row=create(e);service(e).consume(message(e).id,now=NOW);e.db.commit()
    first=service(e).stages(row)[0]
    first.checkpoint_json={**first.checkpoint_json,'result_hash':'tampered'};e.db.commit()
    with pytest.raises(WorkflowDenied):service(e).consume(message(e).id,now=NOW)
    e.db.rollback()
    assert service(e).detail(1,row.id)['stages'][1]['attempts']==0

def test_calendar_closure_and_timezone_receipt_are_inspectable(env):
    e=env
    rt=__import__('dataclasses').replace(e.runtime,calendar=lambda p,d,n:{'timezone':'America/New_York','calendar_version':'synthetic-closed','market_open':False,'max_lateness_seconds':30,'missed_policy':'skip'})
    row=service(e,rt).create(1,'indmoney_us','closed-tick',scheduled_at=NOW,schedule_id='synthetic-schedule',now=NOW);e.db.commit()
    assert row.status=='skipped' and message(e) is None
    assert row.execution_json['calendar']['timezone']=='America/New_York'

def test_lost_or_unbound_job_result_cannot_complete_stage(env):
    e=env;row=create(e);rt=__import__('dataclasses').replace(e.runtime,adapter=QueuedAI())
    service(e,rt).consume(message(e).id,now=NOW);e.db.commit()
    service(e,rt).consume(message(e).id,now=NOW);e.db.commit()
    stage=service(e).stages(row)[1];job=e.db.get(Job,stage.job_id)
    job.request_context_json={**job.request_context_json,'source_hash':'wrong'};job.status=JobStatus.COMPLETED;e.db.commit()
    assert service(e,rt).consume(message(e,NOW+timedelta(seconds=6)).id,now=NOW+timedelta(seconds=6))=='failed';e.db.commit()
    assert service(e).detail(1,row.id)['status']=='partial'

def test_http_default_off_owner_scope_controls_and_validation(env):
    import asyncio,httpx
    from fastapi import FastAPI
    from app.domains.runs.analysis_router import router,optional_analysis_runtime
    from app.domains.auth.dependencies import get_current_user
    from app.infrastructure.database.session import get_async_db
    from app.shared.exceptions import AppException
    from fastapi.responses import JSONResponse
    app=FastAPI();app.include_router(router)
    @app.exception_handler(AppException)
    async def error(request,exc):return JSONResponse({'detail':exc.message},status_code=exc.status_code)
    class AsyncFacade:
        async def run_sync(self,fn):return fn(env.db)
        async def commit(self):env.db.commit()
        async def rollback(self):env.db.rollback()
    async def db():yield AsyncFacade()
    identity={'id':1}
    app.dependency_overrides[get_async_db]=db
    app.dependency_overrides[get_current_user]=lambda:SimpleNamespace(id=identity['id'])
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://synthetic') as c:
            assert (await c.get('/runs/analysis-workflows/config')).json()['enabled'] is False
            assert (await c.post('/runs/analysis-workflows',json={'portfolio':'indmoney_us','key':'http-start-key'})).status_code==503
            app.dependency_overrides[optional_analysis_runtime]=lambda:env.runtime
            response=await c.post('/runs/analysis-workflows',json={'portfolio':'indmoney_us','key':'http-start-key'})
            assert response.status_code==200,response.text
            assert response.headers['cache-control']=='private, no-store'
            row=response.json();identity['id']=2
            assert (await c.get('/runs/analysis-workflows/'+str(row['id']))).status_code==404
            assert (await c.post('/runs/analysis-workflows/'+str(row['id'])+'/controls',json={'portfolio':'indmoney_us','action':'cancel','version':0})).status_code==404
            identity['id']=1
            assert (await c.post('/runs/analysis-workflows',json={'portfolio':'indmoney_us','key':'http-start-key','scheduled_at':'2026-10-21T10:00:00'})).status_code==422
            assert (await c.post('/runs/analysis-workflows/'+str(row['id'])+'/controls',json={'portfolio':'indmoney_us','action':'cancel','version':99})).status_code==409
            # Cancellation is a safety action and remains available after disable.
            module=env.db.scalar(select(UserModule).where(UserModule.user_id==1));module.enabled=False;env.db.commit()
            result=await c.post('/runs/analysis-workflows/'+str(row['id'])+'/controls',json={'portfolio':'indmoney_us','action':'cancel','version':0})
            assert result.status_code==200,result.text
            assert result.json()['status']=='cancelled'
    asyncio.run(run())

@pytest.mark.parametrize('mutation',['source','plan','pause','cancel','module','binding'])
def test_provider_effect_rechecks_current_persisted_binding(env,monkeypatch,mutation):
    from app.domains.runs.analysis_workflows.effects import job_scope,validate_effect
    from app.domains.runs.analysis_workflows import runtime as composition
    e=env;row=create(e);rt=__import__('dataclasses').replace(e.runtime,adapter=QueuedAI())
    service(e,rt).consume(message(e).id,now=NOW);e.db.commit()
    service(e,rt).consume(message(e).id,now=NOW);e.db.commit()
    stage=service(e).stages(row)[1];job=e.db.get(Job,stage.job_id)
    monkeypatch.setattr(composition,'_registered',rt)
    with job_scope(job.id):validate_effect(e.db)
    e.db.commit()
    if mutation=='source':e.states[1]['version']=99
    elif mutation=='plan':e.plan['version']='changed'
    elif mutation in {'pause','cancel'}:service(e).control(1,row.id,mutation,0,now=NOW);e.db.commit()
    elif mutation=='module':
        module=e.db.scalar(select(UserModule).where(UserModule.user_id==1));module.enabled=False;e.db.commit()
    else:job.request_context_json={**job.request_context_json,'source_hash':'wrong'};e.db.commit()
    with job_scope(job.id),pytest.raises(PermissionError):validate_effect(e.db)
    e.db.rollback()

def test_celery_transport_uses_existing_owned_workflow_outbox_binding(env):
    from app.domains.modules.tasks import task_identity
    from app.domains.modules.lifecycle import ModuleLifecycleDenied
    e=env;row=create(e)
    identity=task_identity(e.db,'app.domains.runs.tasks.advance_analysis_workflow',[str(message(e).id)],{})
    assert (identity.owner_id,identity.module_id,identity.version)==(1,'indmoney_us',1)
    with pytest.raises(ModuleLifecycleDenied):task_identity(e.db,'app.domains.runs.tasks.advance_analysis_workflow',['invalid'],{})

@pytest.mark.parametrize('result',[None,[],{'cost_usd':'not-money'},{'cost_usd':'NaN'},{'cost_usd':'-1'},{'data':float('inf')}])
def test_malformed_stage_output_fails_inspectably_or_waits_bounded(env,result):
    e=env;row=create(e)
    def adapter(db,w,s,deps,now):
        return result if not isinstance(result,dict) else {'owner_id':w.user_id,'source_hash':w.execution_json['source_hash'],'plan_hash':w.execution_json['plan_hash'],**result}
    rt=__import__('dataclasses').replace(e.runtime,adapter=adapter)
    outcome=service(e,rt).consume(message(e).id,now=NOW);e.db.commit()
    if result is None:
        assert outcome=='waiting'
        later=NOW+timedelta(seconds=301)
        assert service(e,rt).consume(message(e,later).id,now=later)=='failed';e.db.commit()
    else:assert outcome=='failed'
    assert service(e).detail(1,row.id)['status']=='failed'


def test_http_aware_scheduled_instant_is_accepted_without_relaxing_other_fields():
    from app.domains.runs.analysis_router import Create
    body=Create.model_validate({'portfolio':'indmoney_us','key':'scheduled-json-key','scheduled_at':'2026-10-22T10:00:00+05:30','schedule_id':'synthetic-market'})
    assert body.scheduled_at.utcoffset().total_seconds()==19800
    with pytest.raises(ValueError):Create.model_validate({'portfolio':'indmoney_us','key':'scheduled-json-key','scheduled_at':42})

def test_missing_cost_is_visible_as_unknown_not_free(env):
    e=env;row=create(e)
    def adapter(db,w,s,deps,now):return {'owner_id':w.user_id,'source_hash':w.execution_json['source_hash'],'plan_hash':w.execution_json['plan_hash'],'data':{'synthetic':True},'cost_usd':None}
    rt=__import__('dataclasses').replace(e.runtime,adapter=adapter)
    service(e,rt).consume(message(e).id,now=NOW);e.db.commit()
    receipt=service(e).detail(1,row.id)['stages'][0]['checkpoint']['attempts'][0]
    assert receipt['cost_usd'] is None

@pytest.mark.asyncio
async def test_workspace_readiness_read_never_dispatches_or_changes_frozen_work(env,monkeypatch):
    from app.domains.runs.analysis_router import list_analysis_workflows
    from unittest.mock import AsyncMock
    monkeypatch.setattr('app.domains.modules.visibility.visible_module_ids',AsyncMock(return_value=['indmoney_us']))
    row=create(env,'readonly-workspace-readiness')
    original=deepcopy(row.execution_json)
    before=len(list(env.db.scalars(select(OutboxMessage))))
    async def run_sync(fn):return fn(env.db)
    result=await list_analysis_workflows(selected_only=True,portfolio='indmoney_us',include_readiness=True,db=SimpleNamespace(run_sync=run_sync),user=SimpleNamespace(id=1),runtime=env.runtime)
    assert result['items'][0]['input_readiness']['current'] is True
    env.states[1]['version']=2
    stale=await list_analysis_workflows(selected_only=True,portfolio='indmoney_us',include_readiness=True,db=SimpleNamespace(run_sync=run_sync),user=SimpleNamespace(id=1),runtime=env.runtime)
    assert stale['items'][0]['input_readiness']['current'] is False
    assert len(list(env.db.scalars(select(OutboxMessage))))==before
    assert row.execution_json==original and row.status=='queued'
    assert not env.db.new and not env.db.dirty

def test_reviewed_setup_hashes_are_checked_before_new_work_or_outbox(env):
    source_hash=digest(env.states[1]);plan_hash=digest(env.plan)
    for source,plan in [('0'*64,plan_hash),(source_hash,'0'*64),(digest(env.states[2]),plan_hash)]:
        with pytest.raises(ConflictException):service(env).create(1,'indmoney_us','reviewed-hash-start',expected_source_hash=source,expected_plan_hash=plan,now=NOW)
        assert not list(env.db.scalars(select(Workflow)))
        assert not list(env.db.scalars(select(OutboxMessage)))
    row=service(env).create(1,'indmoney_us','reviewed-hash-start',expected_source_hash=source_hash,expected_plan_hash=plan_hash,now=NOW)
    assert row.execution_json['source_hash']==source_hash and row.execution_json['plan_hash']==plan_hash
    assert row.execution_json['orders_authorized'] is False

@pytest.mark.asyncio
async def test_setup_context_is_owned_read_only_and_does_not_invent_candidate_support(env):
    from app.domains.runs.analysis_router import setup_context
    from fastapi import HTTPException
    env.states[1]={'owner_id':1,'snapshot_id':12,'captured_at':NOW.isoformat(),'connection':None,'holdings':[]}
    async def run_sync(fn):return fn(env.db)
    context=await setup_context(portfolio='indmoney_us',db=SimpleNamespace(run_sync=run_sync),user=SimpleNamespace(id=1),runtime=env.runtime)
    assert context['source_hash']==digest(env.states[1])
    assert context['plan_hash']==digest(env.plan) and context['orders_authorized'] is False
    assert context['candidate_preview_available'] is False
    assert context['usage']['estimated_cost_usd'] is None
    assert all(not value['editable'] for value in context['constraints'].values())
    assert not list(env.db.scalars(select(Workflow))) and not list(env.db.scalars(select(OutboxMessage)))
    env.states[1]['owner_id']=2
    with pytest.raises(HTTPException) as denied:await setup_context(portfolio='indmoney_us',db=SimpleNamespace(run_sync=run_sync),user=SimpleNamespace(id=1),runtime=env.runtime)
    assert denied.value.status_code==409
