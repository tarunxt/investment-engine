"""Synthetic signed-JWT ASGI -> durable monitor -> registered local consumer."""
from dataclasses import replace
from datetime import timedelta
from uuid import uuid4,UUID
import pytest
from celery import Celery
from httpx import ASGITransport,AsyncClient
from sqlalchemy import select,event
from sqlalchemy.orm import Session
from app.core.security import JWTUtils
from app.domains.auth.models import User,UserRole,ActivityLog
from app.domains.ai_limits.contracts import BoundaryDenied,digest
from app.domains.ai_limits.private_effects import LocalSink
from app.domains.public_service.application_bindings import install_disposable_bindings
from app.domains.public_service.disposable_monitoring import DisposableMonitoringFactory,TASK,QUEUE
from app.domains.public_service.monitor_dispatch import MonitorDispatchPolicy,TOPIC
from app.domains.order_intents.models import OrderIntent
from app.domains.recommendation_audit.models import SpendAccount
from app.domains.zerodha.models import ZerodhaPortfolioSnapshot
from app.infrastructure.database.outbox.models import OutboxMessage
from test_stage17_application_composition import application,residency_setup
from test_stage17_reviewed_residency import NOW

PATH='/account/operations/disposable/monitor'

@pytest.fixture
def monitoring(application,monkeypatch):
    app,binding,db,producer,engine=application
    for model in (OrderIntent,SpendAccount,ZerodhaPortfolioSnapshot):model.__table__.create(db.get_bind(),checkfirst=True)
    clock=[NOW];sink=LocalSink()
    factory=DisposableMonitoringFactory.from_session(db,binding.scope,
        MonitorDispatchPolicy('synthetic:appointed-fixture',frozenset({2}),30),sink)
    factory=replace(factory,clock=lambda:clock[0]);binding=replace(binding,monitor_factory=factory)
    install_disposable_bindings(app,binding)
    monkeypatch.setenv('JWT_SIGNING_KEY','synthetic-monitor-http-'+('x'*48))
    def headers(owner):return {'Authorization':'Bearer '+JWTUtils.create_access_token(owner,'synthetic@example.invalid','user')}
    return app,binding,db,engine,clock,sink,headers


@pytest.mark.asyncio
async def test_owned_observation_worker_ack_and_escalation_use_current_authority(monitoring):
    app,binding,db,engine,clock,sink,headers=monitoring
    worker=Celery('monitor_'+uuid4().hex,broker='memory://',set_as_current=False)
    worker.conf.beat_schedule={'untouched':{'task':'existing','schedule':60}}
    factory=binding.monitoring();task=factory.register(worker)
    try:
        assert factory.register(worker)is task
        assert worker.conf.task_routes[TASK]=={'queue':QUEUE}
        assert worker.conf.beat_schedule=={'untouched':{'task':'existing','schedule':60}}
        assert task.max_retries==0 and task.acks_late and task.reject_on_worker_lost
        async with AsyncClient(transport=ASGITransport(app=app),base_url='http://synthetic.invalid') as client:
            body={'confirmed':True}
            assert (await client.post(PATH+'/observations',json=body)).status_code==401
            assert (await client.post(PATH+'/observations',headers=headers(1),json={**body,'owner_id':3})).status_code==422
            assert (await client.post(PATH+'/observations',headers=headers(1),json={**body,'correlation_id':str(uuid4())})).status_code==422
            assert (await client.post(PATH+'/observations',headers=headers(1),json={**body,'confirmed':False})).status_code==409
            response=await client.post(PATH+'/observations',headers=headers(1),json=body)
            assert response.status_code==200,response.text
            value=response.json();key=value['id'];assert value['state']=='queued' and not sink.receipts
            assert response.headers['cache-control']=='private, no-store'
            assert task.run()['state']=='recorded' and len(sink.receipts)==1
            assert task.run()['state']=='idle' and len(sink.receipts)==1
            assert (await client.get(PATH+'/alerts/'+key,headers=headers(3))).status_code==409
            assert (await client.get(PATH+'/alerts/'+key,headers=headers(1))).json()['state']=='recorded'
            assert (await client.post(PATH+'/observations',headers=headers(1),json=body)).json()['id']==key
            clock[0]+=timedelta(seconds=31)
            operator=PATH+'/owners/1/alerts/'+key
            for actor in (1,4):
                assert (await client.post(operator+'/escalate',headers=headers(actor),json={'confirmed':True})).status_code==409
                assert (await client.post(operator+'/acknowledge',headers=headers(actor),json={'confirmed':True})).status_code==409
            assert (await client.post(operator+'/escalate',headers=headers(2),json={'confirmed':True})).json()['state']=='escalated'
            assert (await client.post(operator+'/acknowledge',headers=headers(2),json={'confirmed':True})).json()['state']=='acknowledged'
            db.get(User,2).role=UserRole.USER;db.commit()
            assert (await client.post(operator+'/acknowledge',headers=headers(2),json={'confirmed':True})).status_code==409
        assert len(sink.receipts)==1
    finally:worker.close();await engine.dispose()


@pytest.mark.parametrize('change',[{'password':'SYNTHETIC_DO_NOT_DELIVER'},{'owner_id':3},{'cost_spike':True}])
def test_persisted_report_change_is_not_delivered(monitoring,change):
    _,binding,db,_,_,sink,_=monitoring;factory=binding.monitoring()
    value=factory.observe(db,1);db.commit();row=db.get(OutboxMessage,UUID(value['id']))
    modified={**row.payload['report'],**change}
    row.payload={**row.payload,'report':modified,'report_hash':digest(modified)};db.commit()
    with pytest.raises(BoundaryDenied,match='DISPATCH_REJECTED'):factory.consume()
    assert not sink.receipts


def test_response_loss_and_restart_leave_durable_uncertainty_without_resend(monitoring,monkeypatch):
    _,binding,db,_,_,sink,_=monitoring;factory=binding.monitoring()
    value=factory.observe(db,1);db.commit();calls=[];original=sink.deliver
    def lost(*args):calls.append(args[0]);original(*args);raise RuntimeError('SYNTHETIC_SECRET_FAILURE')
    monkeypatch.setattr(sink,'deliver',lost)
    with pytest.raises(BoundaryDenied) as caught:factory.consume()
    assert 'SYNTHETIC_SECRET_FAILURE' not in str(caught.value)
    assert factory.consume()=={'state':'idle','uncertain_pending':True,'synthetic_only':True}
    assert len(calls)==len(sink.receipts)==1
    with pytest.raises(BoundaryDenied):factory.acknowledge(db,1,value['id'],2)
    db.rollback()


def test_audit_failure_rolls_back_without_delivery(monitoring):
    _,binding,db,_,_,sink,_=monitoring;factory=binding.monitoring()
    value=factory.observe(db,1);db.commit()
    def fail(session,ctx,instances):
        if any(isinstance(row,ActivityLog) and row.action=='monitor_dispatching' for row in session.new):raise RuntimeError('SYNTHETIC_AUDIT_FAILURE')
    event.listen(Session,'before_flush',fail)
    try:
        with pytest.raises(BoundaryDenied):factory.consume()
        assert not sink.receipts
    finally:event.remove(Session,'before_flush',fail)
    assert factory.status(db,1,value['id'])['state']=='queued';db.rollback()


def test_factory_rejects_foreign_scope_production_and_network_transport(monitoring,monkeypatch):
    _,binding,db,_,_,sink,_=monitoring;factory=binding.monitoring()
    with pytest.raises(BoundaryDenied):replace(factory,scope_hash='0'*64).service(db)
    app=Celery('remote_'+uuid4().hex,broker='memory://',set_as_current=False)
    app.conf.broker_write_url='redis://example.invalid:6379/14'
    try:
        with pytest.raises(BoundaryDenied):factory.register(app)
        assert not hasattr(app,'_credx_disposable_monitor')
    finally:app.close()
    monkeypatch.setenv('ENVIRONMENT','production')
    with pytest.raises(BoundaryDenied):binding.validate()
    assert not sink.receipts


def test_monitor_task_does_not_leak_to_another_app(monitoring):
    _,binding,_,_,_,_,_=monitoring
    one=Celery('one_'+uuid4().hex,broker='memory://',set_as_current=False)
    other=Celery('other_'+uuid4().hex,broker='memory://',set_as_current=False)
    try:
        task=binding.monitoring().register(one)
        assert TASK not in other.tasks and task is one.tasks[TASK]
    finally:one.close();other.close()


def test_observation_takes_control_before_snapshot_owner_fence(monitoring,monkeypatch):
    import app.domains.public_service.monitoring as observations
    import app.domains.public_service.monitor_dispatch as dispatch
    _,binding,db,_,_,_,_=monitoring;trace=[]
    original_owner=observations.owner;original_control=dispatch.control
    def owner(*args,**kwargs):trace.append('owner');return original_owner(*args,**kwargs)
    def control(*args,**kwargs):trace.append('control');return original_control(*args,**kwargs)
    monkeypatch.setattr(observations,'owner',owner);monkeypatch.setattr(dispatch,'control',control)
    binding.monitoring().observe(db,1)
    assert trace[0]=='control' and 'owner' in trace
