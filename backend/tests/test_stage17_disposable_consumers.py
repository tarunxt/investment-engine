"""No listener: authenticated ASGI admission and typed fake consumer composition."""
from dataclasses import replace
from datetime import datetime,timedelta,timezone
from types import SimpleNamespace
from uuid import uuid4
import pytest
from celery import Celery
from fastapi import FastAPI
from httpx import ASGITransport,AsyncClient
from sqlalchemy import select
from sqlalchemy.orm import Session
from sqlalchemy.ext.asyncio import create_async_engine,async_sessionmaker
from app.domains.ai_limits.contracts import BoundaryDenied
from app.domains.auth.dependencies import get_current_user
from app.domains.modules.models import UserModule
from app.domains.connections.models import IntegrationConnection
from app.domains.order_intents.service import Orders
from app.domains.order_intents.execution import ExecutionWorker
from app.domains.public_service.disposable_consumers import DisposableConsumerFactory
from app.domains.public_service.dispatch import SyntheticWorkBindings,TOPIC
from app.domains.public_service.application_bindings import DisposableApplicationBindings,install_disposable_bindings
from app.domains.public_service.composition import PublicServiceServer,ServerBindings
from app.domains.public_service.safe_privacy_projection import safe_canonical_inventory
from app.domains.public_service.sql_privacy_plan import RetentionSchedule
from app.domains.public_service.sql_privacy_workflow import DisposablePrivacyScope
from app.domains.public_service.router import router
from app.domains.modules.transports import install_route_policy
from app.domains.modules.coverage import classify_route
from app.infrastructure.database import session as sessions
from app.infrastructure.database.base import Base
from app.infrastructure.database.outbox.models import OutboxMessage
from test_stage15_execution import setup,env,NOW
from test_stage17_dispatch import queue


def configured(e):
    _,producer,_=queue(e)
    scope=DisposablePrivacyScope('synthetic:typed-consumers')
    def build(db):
        worker=ExecutionWorker(Orders(db,policy=e.env.policy,risk=e.env.risk,clock=lambda:e.env.clock[0]),e.broker,e.source)
        return SyntheticWorkBindings(db,residency=producer,execution=worker)
    factory=replace(DisposableConsumerFactory.from_session(e.env.db,scope,build),clock=lambda:NOW)
    server=PublicServiceServer(keyring=producer.keyring,bindings=ServerBindings(
        account_inventory=safe_canonical_inventory(Base.metadata,reference=scope.reference),
        retention_schedule=RetentionSchedule(scope.reference,NOW+timedelta(days=1))))
    return DisposableApplicationBindings(scope.reference,server,scope,consumer_factory=factory)


@pytest.mark.asyncio
async def test_authenticated_admission_durable_commit_then_registered_fake_consumer(setup,monkeypatch):
    e=setup();binding=configured(e);app=FastAPI();app.include_router(router);install_route_policy(app)
    from app.domains.auth.models import UserProfile,ActivityLog
    from app.core.security import JWTUtils
    for model in (UserProfile,ActivityLog):model.__table__.create(e.env.engine,checkfirst=True)
    monkeypatch.setenv('JWT_SIGNING_KEY','synthetic-stage17-local-consumer-'+('x'*48))
    install_disposable_bindings(app,binding)
    engine=create_async_engine('sqlite+aiosqlite:///'+e.env.engine.url.database)
    monkeypatch.setattr(sessions,'AsyncSessionLocal',async_sessionmaker(engine,expire_on_commit=False))
    from app.core.config import settings
    monkeypatch.setattr(settings,'auth_disabled',False)
    worker=Celery('typed_'+uuid4().hex,broker='memory://',set_as_current=False)
    try:
        tasks=binding.register_consumers(worker)
        assert binding.register_consumers(worker)==tasks and not worker.conf.beat_schedule
        path='/account/operations/disposable/operational-queue'
        async with AsyncClient(transport=ASGITransport(app=app),base_url='http://synthetic.invalid') as client:
            body={'lane':'execution','resource':str(e.event.id),'confirmed':True}
            assert (await client.post(path,json=body)).status_code==401
            client.headers['Authorization']='Bearer invalid-synthetic-token'
            assert (await client.post(path,json=body)).status_code==401
            client.headers['Authorization']='Bearer '+JWTUtils.create_access_token(e.env.owners[1],'synthetic@example.invalid','user')
            assert (await client.post(path,json=body)).status_code==409
            client.headers['Authorization']='Bearer '+JWTUtils.create_access_token(e.row.owner_id,'synthetic@example.invalid','user')
            assert (await client.post(path,json={**body,'confirmed':False})).status_code==409
            assert (await client.post(path,json={**body,'owner_id':e.row.owner_id})).status_code==422
            result=await client.post(path,json=body);assert result.status_code==200,result.text
            assert result.json()['state']=='queued' and not e.broker.calls
            assert result.headers['cache-control']=='private, no-store'
            from uuid import UUID
            with Session(e.env.engine) as db:assert db.get(OutboxMessage,UUID(result.json()['id'])).payload['state']=='queued'
            assert (await client.post(path,json=body)).json()==result.json()
        assert tasks['public_service.consume.execution'].run()['result']['status']=='filled'
        assert tasks['public_service.consume.execution'].run()['state']=='idle'
        assert len(e.broker.calls)==1
        # Only the exact new method/path/endpoint is an account boundary.
        route=next(r for r in app.routes if getattr(r,'path',None)==path)
        assert classify_route('public_service',route.endpoint.__name__,path,{'POST'},route.endpoint.__module__) is None
        assert classify_route('public_service',route.endpoint.__name__,path+'/other',{'POST'},route.endpoint.__module__) is not None
    finally:worker.close();await engine.dispose()


@pytest.mark.parametrize('mutation',['module','connection','approval','residency'])
def test_admitted_work_rechecks_current_fences_before_fake_effect(setup,mutation):
    e=setup();binding=configured(e)
    binding.queues(e.env.db).enqueue(e.row.owner_id,'execution',str(e.event.id),now=NOW);e.env.db.commit()
    clock=[NOW]
    if mutation=='module':e.env.db.scalar(select(UserModule).where(UserModule.user_id==e.row.owner_id)).enabled=False
    elif mutation=='connection':e.env.db.get(IntegrationConnection,e.row.connection_id).version+=1
    elif mutation=='approval':clock[0]=NOW+timedelta(minutes=6);e.env.clock[0]=clock[0]
    else:
        from app.domains.public_service.residency import TOPIC as RESIDENCY
        row=e.env.db.scalar(select(OutboxMessage).where(OutboxMessage.topic==RESIDENCY));row.payload={**row.payload,'revoked':True}
    e.env.db.commit()
    result=binding.consumer_factory.composition(clock=lambda:clock[0]).consume('execution')
    assert result['state'] in {'blocked','uncertain'} and not e.broker.calls


def test_typed_factory_loss_after_acceptance_never_resubmits(setup):
    e=setup(['after_acceptance']);binding=configured(e)
    binding.queues(e.env.db).enqueue(e.row.owner_id,'execution',str(e.event.id),now=NOW);e.env.db.commit()
    consumer=binding.consumer_factory.composition()
    assert consumer.consume('execution')['state']=='uncertain'
    assert consumer.consume('execution')['state']=='idle' and len(e.broker.calls)==1


def test_factory_rejects_scope_substitution_before_builder_and_production(setup,monkeypatch):
    e=setup();binding=configured(e);factory=binding.consumer_factory;calls=[]
    altered=replace(factory,scope_hash='0'*64,builder=lambda db:calls.append(db))
    with pytest.raises(BoundaryDenied,match='DATABASE_CHANGED'):
        with altered.session():pass
    assert not calls
    with pytest.raises(BoundaryDenied):replace(binding,reference='synthetic:foreign').validate()
    monkeypatch.setenv('ENVIRONMENT','production')
    with pytest.raises(BoundaryDenied):binding.validate()
    with pytest.raises(BoundaryDenied):
        with factory.session():pass
    assert not e.broker.calls


def test_factory_rejects_untyped_builder_result_without_claim(setup):
    e=setup();binding=configured(e)
    factory=replace(binding.consumer_factory,builder=lambda db:object())
    with pytest.raises(BoundaryDenied,match='FINANCIAL_BINDING'):
        factory.composition().consume('execution')
    assert not e.broker.calls


@pytest.mark.parametrize('broker,backend',[('redis://example.invalid:6379/14',None),('memory://','redis://example.invalid:6379/0')])
def test_factory_rejects_network_transport_or_result_backend_before_registration(setup,broker,backend):
    e=setup();binding=configured(e)
    app=Celery('rejected_'+uuid4().hex,broker=broker,backend=backend,set_as_current=False)
    try:
        with pytest.raises(BoundaryDenied,match='TRANSPORT_REQUIRED'):binding.register_consumers(app)
        assert not any(name.startswith('public_service.consume.') for name in app.tasks)
        assert not app.conf.beat_schedule and not e.broker.calls
    finally:app.close()


def test_unbound_and_neighbor_routes_stay_denied_and_expired_claim_never_replays(setup):
    e=setup();binding=configured(e)
    with pytest.raises(BoundaryDenied,match='UNAVAILABLE'):replace(binding,consumer_factory=None).queues(e.env.db)
    item=binding.queues(e.env.db).enqueue(e.row.owner_id,'execution',str(e.event.id),now=NOW);e.env.db.commit()
    assert binding.queues(e.env.db).claim('execution',now=NOW)
    consumer=binding.consumer_factory.composition(clock=lambda:NOW+timedelta(seconds=31))
    assert consumer.consume('execution')['state']=='idle'
    assert consumer.consume('execution')['state']=='idle' and not e.broker.calls
    with Session(e.env.engine) as db:assert db.get(OutboxMessage,item.id).payload['state']=='uncertain'


@pytest.mark.parametrize('override',[
    {'broker_write_url':'redis://example.invalid:6379/14'},
    {'broker_read_url':'redis://example.invalid:6379/14'},
    {'broker_write_url':['memory://','redis://example.invalid:6379/14']},
    {'broker_write_url':'memory://;redis://example.invalid:6379/14'},
    {'broker_transport':'redis'},
    {'broker_transport':object()},
    {'broker_port':6380},
    {'broker_vhost':'other'},
    {'broker_transport_options':{'host':'example.invalid'}},
    {'broker_failover_strategy':lambda servers:iter(servers)},
])
def test_effective_endpoint_and_transport_override_rejected_without_connection(setup,override,monkeypatch):
    e=setup();binding=configured(e)
    app=Celery('override_'+uuid4().hex,broker='memory://',set_as_current=False)
    app.conf.update(**override)
    def forbidden(*args,**kwargs):raise AssertionError('Guard must not construct a connection or register tasks')
    monkeypatch.setattr(app,'connection_for_write',forbidden)
    monkeypatch.setattr(app,'connection_for_read',forbidden)
    monkeypatch.setattr(app,'task',forbidden)
    try:
        with pytest.raises(BoundaryDenied,match='TRANSPORT_REQUIRED'):binding.register_consumers(app)
        assert not hasattr(app,'_credx_disposable_composition')
        assert not e.broker.calls
    finally:app.close()


def test_effective_write_environment_override_rejected_without_connection(setup,monkeypatch):
    e=setup();binding=configured(e)
    app=Celery('environment_'+uuid4().hex,broker='memory://',set_as_current=False)
    monkeypatch.setenv('CELERY_BROKER_WRITE_URL','redis://example.invalid:6379/14')
    try:
        assert app.conf.broker_write_url=='redis://example.invalid:6379/14'
        with pytest.raises(BoundaryDenied,match='TRANSPORT_REQUIRED'):binding.register_consumers(app)
        assert not hasattr(app,'_credx_disposable_composition')
    finally:app.close()


@pytest.mark.parametrize('extra,allowed',[
    ({'visibility_timeout':2,'polling_interval':.2},True),
    ({},True),
    ({'sentinel_kwargs':{'host':'example.invalid'}},False),
    ({'connection_class':object()},False),
    ({'visibility_timeout':True},False),
    ({'polling_interval':float('nan')},False),
])
def test_acknowledged_ci_redis_has_closed_transport_options_without_connecting(setup,monkeypatch,extra,allowed):
    from pathlib import Path
    e=setup();factory=configured(e).consumer_factory
    app=Celery('redis_guard_'+uuid4().hex,broker='redis://redis:6379/14',set_as_current=False)
    app.conf.broker_transport_options={'global_keyprefix':'stage17_'+uuid4().hex+':',**extra}
    monkeypatch.setenv('CREDX_STAGE17_REDIS_ACK','disposable-ci-only')
    monkeypatch.setenv('CREDX_STAGE17_REDIS_URL','redis://redis:6379/14')
    original=Path.is_file
    monkeypatch.setattr(Path,'is_file',lambda path:True if str(path)=='/.dockerenv' else original(path))
    def forbidden(*args,**kwargs):raise AssertionError('No connection may be constructed')
    monkeypatch.setattr(app,'connection_for_write',forbidden);monkeypatch.setattr(app,'connection_for_read',forbidden)
    try:
        if allowed:factory.check_transport(app)
        else:
            with pytest.raises(BoundaryDenied,match='TRANSPORT_REQUIRED'):factory.check_transport(app)
    finally:app.close()
