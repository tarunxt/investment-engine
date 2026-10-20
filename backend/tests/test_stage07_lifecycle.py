"""Synthetic lifecycle tests exercising real SQL/API and controlled fake effects."""
from contextlib import contextmanager
import json
import pytest
from sqlalchemy import select,func,update,delete
from sqlalchemy.orm import sessionmaker
from fastapi import APIRouter
from test_stage06_modules import private_api,modules,payload
from app.domains.modules import lifecycle
from app.domains.modules.lifecycle import WorkIdentity,ModuleLifecycleDenied,current_sync,apply_selection_event
from app.domains.modules.execution import execution_scope,guarded_effect,checkpoint
from app.domains.modules.policy import DefaultFactsResolver,ModuleFacts
from app.domains.modules.models import UserModule,UserModulePreferences
from app.domains.jobs.models import Job
from app.domains.runs.models import Run
from app.infrastructure.database.outbox.models import OutboxMessage
from app.shared.types import JobStatus

@pytest.fixture
def eligible(modules,monkeypatch):
    a=modules
    monkeypatch.setattr(DefaultFactsResolver,'resolve_sync',lambda *_:ModuleFacts(jurisdiction='allowed',plan='allowed',connection='ready',execution_capability=True))
    response=a.client.patch('/me/modules',headers=a.headers[0],json=payload(0,('ai_studio',True)))
    assert response.status_code==200
    return a


def owned_job(a,status=JobStatus.PENDING,owner=0):
    job=Job(user_id=a.users[owner].id,prompt='Synthetic controlled work',provider='synthetic',model='offline',
        status=status,module_id='ai_studio',module_version=1)
    a.session.add(job);a.session.commit();return job


def test_disable_atomic_outbox_cancel_running_and_foreign_owner(eligible):
    a=eligible;queued=owned_job(a);running=owned_job(a,JobStatus.PROCESSING);foreign=owned_job(a,owner=1)
    r=a.client.patch('/me/modules',headers=a.headers[0],json=payload(1,('ai_studio',False)));assert r.status_code==200
    a.session.expire_all()
    assert a.session.get(Job,queued.id).status==JobStatus.FAILED
    assert a.session.get(Job,queued.id).module_cancel_requested
    assert a.session.get(Job,running.id).status==JobStatus.PROCESSING
    assert a.session.get(Job,running.id).module_cancel_requested
    assert not a.session.get(Job,foreign.id).module_cancel_requested
    events=a.session.scalars(select(OutboxMessage).where(OutboxMessage.topic==lifecycle.TOPIC)).all()
    assert len(events)==2 and events[-1].payload['disabled']==['ai_studio']


def test_fresh_checkpoints_stop_running_fake_work_and_never_reenable_old_work(eligible):
    a=eligible;factory=sessionmaker(a.session.get_bind(),expire_on_commit=False);identity=WorkIdentity(a.users[0].id,'ai_studio',1)
    job=owned_job(a,JobStatus.PROCESSING)
    effects=[]
    fake=guarded_effect(lambda:effects.append('accepted-before-disable'))
    with pytest.raises(ModuleLifecycleDenied),execution_scope(identity,factory):
        fake()
        assert effects==['accepted-before-disable']
        assert a.client.patch('/me/modules',headers=a.headers[0],json=payload(1,('ai_studio',False))).status_code==200
        with pytest.raises(ModuleLifecycleDenied):checkpoint()
        with pytest.raises(ModuleLifecycleDenied):fake()
        assert a.client.patch('/me/modules',headers=a.headers[0],json=payload(2,('ai_studio',True))).status_code==200
        with pytest.raises(ModuleLifecycleDenied):checkpoint()
        # Prevent the scope's final check from hiding the explicit assertions.
        with pytest.raises(ModuleLifecycleDenied):fake()
        # Scope intentionally also rejects its completion below.
    assert effects==['accepted-before-disable']
    a.session.expire_all();assert a.session.get(Job,job.id).module_cancel_requested
    row=a.session.scalar(select(UserModule).where(UserModule.user_id==identity.owner_id))
    assert row.enabled and row.schedules_paused


def test_missed_event_and_reordered_duplicate_events_use_current_state(eligible):
    a=eligible;owner=a.users[0].id;job=owned_job(a)
    old=a.session.scalar(select(OutboxMessage).where(OutboxMessage.topic==lifecycle.TOPIC))
    # Simulate a missed delivery: committed SQL is authoritative before relay.
    assert a.client.patch('/me/modules',headers=a.headers[0],json=payload(1,('ai_studio',False))).status_code==200
    with pytest.raises(ModuleLifecycleDenied):current_sync(a.session,WorkIdentity(owner,'ai_studio',1))
    assert apply_selection_event(a.session,old)
    assert apply_selection_event(a.session,old)
    a.session.commit();a.session.expire_all()
    assert a.session.get(Job,job.id).status==JobStatus.FAILED
    assert a.client.patch('/me/modules',headers=a.headers[0],json=payload(2,('ai_studio',True))).status_code==200
    assert apply_selection_event(a.session,old)
    a.session.commit();a.session.expire_all()
    assert a.session.get(Job,job.id).status==JobStatus.FAILED


def test_unrelated_module_toggle_does_not_invalidate_current_analysis(eligible):
    a=eligible;owner=a.users[0].id
    assert a.client.patch('/me/modules',headers=a.headers[0],json=payload(1,('sports_rankings',True))).status_code==200
    current_sync(a.session,WorkIdentity(owner,'ai_studio',1))


def test_no_context_recovery_override_or_stale_payload_can_authorize_effect(eligible,monkeypatch):
    a=eligible;monkeypatch.setenv('CREDX_RECOVERY_MODE','1')
    fake=guarded_effect(lambda:pytest.fail('Unbound fake effect executed'))
    with pytest.raises(ModuleLifecycleDenied):fake()
    from app.domains.modules.tasks import task_scope
    with pytest.raises(ModuleLifecycleDenied):
        with task_scope('app.domains.jobs.tasks.execute_ai_job',[999999],{'user_id':a.users[0].id,'enabled':True},factory=sessionmaker(a.session.get_bind())):pass


def test_routes_have_explicit_core_history_and_new_work_classification(eligible):
    from app.domains.modules.transports import install_route_policy,route_policy
    a=eligible;install_route_policy(a.app)
    routes={r.path:r for r in a.app.routes if hasattr(r,'endpoint') and hasattr(r,'methods')}
    assert route_policy(routes['/jobs/{job_id}']) is None
    # Existing create route is now guarded before provider validation/dispatch.
    r=a.client.post('/jobs',headers=a.headers[1],json={'prompt':'Synthetic','provider':'synthetic','model':'offline'})
    assert r.status_code==403 and r.json()['detail']['code']=='MODULE_POLICY_DENIED'
    assert a.client.get('/jobs',headers=a.headers[1]).status_code==200


def test_reenable_does_not_resume_schedules_but_explicit_resume_dispatches_nothing(eligible):
    a=eligible;owner=a.users[0].id
    assert a.client.patch('/me/modules',headers=a.headers[0],json=payload(1,('ai_studio',False))).status_code==200
    assert a.client.patch('/me/modules',headers=a.headers[0],json=payload(2,('ai_studio',True))).status_code==200
    a.session.expire_all();assert a.session.scalar(select(UserModule.schedules_paused).where(UserModule.user_id==owner))
    r=a.client.post('/me/modules/ai_studio/resume-schedules',headers=a.headers[0],json={'expected_version':3})
    assert r.status_code==200 and r.json()['work_dispatched'] is False
    a.session.expire_all();assert not a.session.scalar(select(UserModule.schedules_paused).where(UserModule.user_id==owner))
    stale=a.client.post('/me/modules/ai_studio/resume-schedules',headers=a.headers[0],json={'expected_version':2})
    assert stale.status_code==409
    denied=a.client.post('/me/modules/bullpen_live/resume-schedules',headers=a.headers[0],json={'expected_version':3})
    assert denied.status_code==403


def test_global_financial_override_cannot_turn_analysis_context_into_order_permission(eligible,monkeypatch):
    a=eligible;monkeypatch.setenv('CREDX_RECOVERY_MODE','0')
    from app.core.recovery import require_financial_writes_allowed
    with pytest.raises(ModuleLifecycleDenied):require_financial_writes_allowed()
    factory=sessionmaker(a.session.get_bind(),expire_on_commit=False)
    with execution_scope(WorkIdentity(a.users[0].id,'ai_studio',1),factory):
        with pytest.raises(ModuleLifecycleDenied):require_financial_writes_allowed()


def test_actual_optional_route_matrix_only_narrow_stops_reconciliation_are_safety():
    from app.domains.modules.transports import route_policy
    from app.domains.polymarket_auto_live.router import router
    routes={r.path:r for r in router.routes}
    assert route_policy(routes['/polymarket/auto-live/stop'])[0]=='__safety__'
    assert route_policy(routes['/polymarket/auto-live/pause'])[0]=='__safety__'
    assert route_policy(routes['/polymarket/auto-live/runs/{run_id}/reconcile'])[0]=='__safety__'
    assert route_policy(routes['/polymarket/auto-live/orders/{intent_id}/cancel'])[0]=='__safety__'
    assert route_policy(routes['/polymarket/auto-live/start'])[0]=='bullpen_live'
    assert route_policy(routes['/polymarket/auto-live/resume'])[0]=='bullpen_live'
    assert route_policy(routes['/polymarket/auto-live/clear-emergency-stop'])[0]=='bullpen_live'
    assert route_policy(routes['/polymarket/auto-live/orders/{intent_id}/retry'])[0]=='bullpen_live'


def test_real_provider_and_sheet_adapters_deny_unbound_calls_before_clients(monkeypatch):
    from app.domains.ai_providers.base import BaseAIProvider
    from app.domains.google_sheets.service import GoogleSheetsService
    calls=[]
    class FakeProvider(BaseAIProvider):
        @classmethod
        def is_configured(cls):return True
        def generate(self,**kwargs):calls.append('provider')
    with pytest.raises(ModuleLifecycleDenied):FakeProvider().generate(prompt='fake',model='offline')
    service=GoogleSheetsService()
    monkeypatch.setattr(service,'_build_service',lambda *_:pytest.fail('Unbound Sheets client constructed'))
    with pytest.raises(ModuleLifecycleDenied):service.append_sheet('synthetic',None,'offline',[],[])
    assert calls==[]


def test_accepted_order_reconciliation_marker_never_allows_submit_or_liquidation():
    from app.domains.modules.tasks import task_scope
    from app.domains.modules.execution import require_bullpen_context
    with task_scope('app.domains.polymarket_auto_live.tasks.reconcile_auto_live_order_intent',['synthetic-id']):
        require_bullpen_context(['polymarket','orders'])
        for command in (['polymarket','buy'],['polymarket','sell'],['polymarket','redeem'],['polymarket','orders','--cancel-all'],['doctor','auth','--refresh'],['unknown']):
            with pytest.raises(ModuleLifecycleDenied):require_bullpen_context(command)


def test_disable_cancels_owned_parent_workflow_without_rewriting_completed_history(eligible):
    from app.domains.runs.models import AutoRebalanceWorkflow
    a=eligible
    rows=[AutoRebalanceWorkflow(user_id=a.users[0].id,portfolio='india',sequence=i,label=f'Synthetic{i}',status=status,module_id='ai_studio',module_version=1)
          for i,status in [(1,'queued'),(2,'completed')]]
    a.session.add_all(rows);a.session.commit()
    assert a.client.patch('/me/modules',headers=a.headers[0],json=payload(1,('ai_studio',False))).status_code==200
    a.session.expire_all()
    assert a.session.get(AutoRebalanceWorkflow,rows[0].id).status=='cancelled'
    assert a.session.get(AutoRebalanceWorkflow,rows[1].id).status=='completed'
    assert not a.session.get(AutoRebalanceWorkflow,rows[1].id).module_cancel_requested


def test_generic_dispatch_locator_is_persisted_versioned_and_not_payload_authority(eligible):
    from app.domains.modules.dispatch import prepare_dispatch,HEADER,TOPIC
    from app.domains.modules.tasks import task_scope
    a=eligible;owner=a.users[0].id;factory=sessionmaker(a.session.get_bind(),expire_on_commit=False)
    assert a.client.patch('/me/modules',headers=a.headers[0],json=payload(1,('zerodha_rebalance',True))).status_code==200
    name='app.domains.zerodha.tasks.sync_portfolio_snapshot_task'
    bound=prepare_dispatch(name,[owner],{}, {},factory=factory);locator=bound['headers'][HEADER]
    retry=prepare_dispatch(name,[owner],{},bound,factory=factory);assert retry==bound
    assert a.session.scalar(select(func.count()).select_from(OutboxMessage).where(OutboxMessage.topic==TOPIC))==1
    with pytest.raises(ModuleLifecycleDenied):
        with task_scope(name,[owner],{},factory=factory):pytest.fail('Unbound legacy packet')
    with pytest.raises(ModuleLifecycleDenied):
        with task_scope(name,[a.users[1].id],{},factory=factory,dispatch_id=locator):pytest.fail('Forged owner packet')
    with task_scope(name,[owner],{},factory=factory,dispatch_id=locator):checkpoint()
    with pytest.raises(ModuleLifecycleDenied):
        with task_scope(name,[owner],{},factory=factory,dispatch_id=locator):pytest.fail('Completed packet replay')


def test_disable_cancels_queued_generic_binding_and_reenable_does_not_rebind(eligible):
    from app.domains.modules.dispatch import prepare_dispatch,HEADER
    from app.domains.modules.tasks import task_scope
    a=eligible;owner=a.users[0].id;factory=sessionmaker(a.session.get_bind(),expire_on_commit=False)
    assert a.client.patch('/me/modules',headers=a.headers[0],json=payload(1,('zerodha_rebalance',True))).status_code==200
    name='app.domains.zerodha.tasks.sync_portfolio_snapshot_task'
    bound=prepare_dispatch(name,[owner],{}, {},factory=factory)
    assert a.client.patch('/me/modules',headers=a.headers[0],json=payload(2,('zerodha_rebalance',False))).status_code==200
    assert a.client.patch('/me/modules',headers=a.headers[0],json=payload(3,('zerodha_rebalance',True))).status_code==200
    with pytest.raises(ModuleLifecycleDenied):prepare_dispatch(name,[owner],{},bound,factory=factory)
    with pytest.raises(ModuleLifecycleDenied):
        with task_scope(name,[owner],{},factory=factory,dispatch_id=bound['headers'][HEADER]):pytest.fail('Disabled packet revived')


@pytest.mark.parametrize('portfolio',[{},[],True,7])
def test_malformed_consumer_cannot_select_a_module(portfolio):
    with pytest.raises(ModuleLifecycleDenied):lifecycle.analysis_module(portfolio)


def test_financial_order_routes_require_execution_not_analysis():
    from app.domains.modules.coverage import classify_route
    for name in ('place_order','place_protected_market_orders','place_protected_market_orders_sequenced'):
        assert classify_route('zerodha',name,'/zerodha/orders',{'POST'})==('zerodha_rebalance','execute')
    assert classify_route('zerodha','prepare_basket_orders','/zerodha/orders/prepare-basket',{'POST'})==('zerodha_rebalance','analyze')

@pytest.mark.asyncio
async def test_actual_cli_spawn_waits_for_fresh_fence_and_holds_it_through_start(monkeypatch):
    """Fake executable only; production module availability remains closed."""
    import asyncio
    from contextlib import asynccontextmanager
    from app.domains.modules import execution
    from app.domains.polymarket import runtime_broker as runtime
    from test_bullpen_runtime_broker import _build_broker,_credential_artifact
    broker=_build_broker(monkeypatch)
    monkeypatch.setattr(runtime,'require_bullpen_command_allowed',lambda _:None)
    events=[];entered=asyncio.Event();release=asyncio.Event()
    @asynccontextmanager
    async def fence(args):
        events.append('fence-enter');entered.set();await release.wait()
        yield
        events.append('fence-exit')
    class FakeProcess:
        pid=123;returncode=0;stdout=None;stderr=None
        async def communicate(self):return b'{}',b''
    async def spawn(*a,**kw):
        assert events==['fence-enter'];events.append('spawn');return FakeProcess()
    monkeypatch.setattr(execution,'bullpen_process_fence',fence)
    monkeypatch.setattr(runtime.asyncio,'create_subprocess_exec',spawn)
    monkeypatch.setattr(runtime,'_stat_credential_artifact',lambda _:_credential_artifact())
    task=asyncio.create_task(broker._execute_process(['polymarket','positions','--output','json'],
        timeout_seconds=1,command_category='positions',is_write=False,requires_auth=False))
    await asyncio.wait_for(entered.wait(),1)
    assert events==['fence-enter']
    release.set();await task
    assert events==['fence-enter','spawn','fence-exit']

@pytest.mark.asyncio
async def test_actual_cli_spawn_denied_by_final_fence_never_creates_process(monkeypatch):
    from contextlib import asynccontextmanager
    from app.domains.modules import execution
    from app.domains.polymarket import runtime_broker as runtime
    from test_bullpen_runtime_broker import _build_broker,_credential_artifact
    broker=_build_broker(monkeypatch)
    monkeypatch.setattr(runtime,'require_bullpen_command_allowed',lambda _:None)
    @asynccontextmanager
    async def fence(args):
        raise ModuleLifecycleDenied('Disabled before process start')
        yield
    async def spawn(*a,**kw):pytest.fail('Denied CLI started')
    monkeypatch.setattr(execution,'bullpen_process_fence',fence)
    monkeypatch.setattr(runtime.asyncio,'create_subprocess_exec',spawn)
    monkeypatch.setattr(runtime,'_stat_credential_artifact',lambda _:_credential_artifact())
    with pytest.raises(ModuleLifecycleDenied):
        await broker._execute_process(['polymarket','positions','--output','json'],timeout_seconds=1,
            command_category='positions',is_write=False,requires_auth=False)
