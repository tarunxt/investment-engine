"""Prepared disposable CI-only PG/Redis gates; collection is not execution.

Redis exercises actual Celery/Kombu publication, acknowledgement and redelivery,
not a running worker process or real provider. PostgreSQL owns financial dedup.
"""
import os
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime,timezone,timedelta
from uuid import uuid4
import pytest
from celery import Celery
from sqlalchemy.orm import Session
from app.domains.ai_limits.contracts import BoundaryDenied
from app.domains.ai_limits.private_effects import LocalSink
from app.domains.public_service.monitor_dispatch import MonitorDispatch,MonitorDispatchPolicy
from app.domains.public_service.signup_perimeter import SignupPerimeter,SignupPerimeterPolicy
from app.domains.public_service.composition import IsolatedConsumerComposition
from test_stage09_connections_postgres import database

pytestmark=pytest.mark.skipif(os.getenv('CREDX_STAGE09_DATABASE_ACK')!='disposable-docker-only',
    reason='Actual acknowledged disposable CI services required; zero-skip CI assertion mandatory')

@pytest.fixture
def redis_app():
    url='redis://redis:6379/14'
    assert Path('/.dockerenv').is_file()
    assert os.environ.get('CREDX_STAGE17_REDIS_ACK')=='disposable-ci-only'
    assert os.environ.get('CREDX_STAGE17_REDIS_URL')==url
    assert not Path('.env').exists() and not Path('backend/.env').exists()
    prefix='stage17_'+uuid4().hex+':'
    app=Celery('stage17_'+uuid4().hex,broker=url,set_as_current=False)
    app.conf.update(broker_transport_options={'global_keyprefix':prefix,'visibility_timeout':5},
                    task_serializer='json',accept_content=['json'],task_ignore_result=True,
                    task_publish_retry=False,broker_connection_timeout=3)
    try:yield app
    finally:
        app.close()
        import redis
        client=redis.Redis.from_url(url,socket_connect_timeout=3,socket_timeout=3)
        # Delete only keys created under this test's unpredictable private prefix.
        for key in client.scan_iter(match=prefix+'*',count=100):client.delete(key)
        client.close()

def receive(app,queue):
    connection=app.connection_for_read();connection.connect()
    simple=connection.SimpleQueue(queue)
    return connection,simple,simple.get(block=True,timeout=3)

def test_actual_redis_disabled_consumer_redelivery_stays_disabled(redis_app):
    app=redis_app;composition=IsolatedConsumerComposition();tasks=composition.register(app)
    task=tasks['public_service.consume.analysis'];sent=task.apply_async()
    connection,simple,message=receive(app,'ai')
    try:
        assert message.headers['id']==sent.id and message.headers['task']==task.name
        assert message.payload[0]==[] and message.payload[1]=={}
        assert task.run()['state']=='disabled'
        message.reject(requeue=True)
        duplicate=simple.get(block=True,timeout=3)
        assert duplicate.headers['id']==sent.id
        assert task.run()['state']=='disabled'
        duplicate.ack()
    finally:simple.close();connection.release()

def test_actual_pg_concurrent_challenge_consumption_one_admission(database):
    from test_stage17_signup_perimeter import FixtureVerifier,NOW
    engine=database[0]
    policy=SignupPerimeterPolicy('synthetic-pg-policy','signup.example.invalid',2,120,b'x'*32)
    def attempt(index):
        with Session(engine) as db:
            try:
                SignupPerimeter(policy=policy,verifier=FixtureVerifier()).admit(db,
                    f'fixture{index}@example.invalid','fixture-same-proof',peer='192.0.2.1',now=NOW)
                db.commit();return True
            except BoundaryDenied:db.rollback();return False
    with ThreadPoolExecutor(2) as pool:assert sum(pool.map(attempt,(1,2)))==1

def test_actual_pg_concurrent_monitor_dispatch_one_local_effect(database):
    engine,_,owner,_,_=database;now=datetime.now(timezone.utc);sink=LocalSink()
    policy=MonitorDispatchPolicy('synthetic-pg-monitor',frozenset({owner}))
    calls=[];original=sink.deliver
    def counted(*args):calls.append(args[0]);return original(*args)
    sink.deliver=counted
    report=dict(owner_id=owner,correlation_id=str(uuid4()),stale_data=True,unknown_orders=False,
        cost_spike=False,action='pause_and_review',source_unavailable=True,scope='owned_database_observation')
    with Session(engine) as db:
        key=MonitorDispatch(db,policy=policy,sink=sink).enqueue(owner,report,now=now).id;db.commit()
    def attempt(_):
        with Session(engine) as db:return MonitorDispatch(db,policy=policy,sink=sink).dispatch(owner,key,now=now)
    with ThreadPoolExecutor(2) as pool:states=list(pool.map(attempt,(1,2)))
    assert set(states)<={'recorded','dispatching'} and 'recorded' in states
    assert len(calls)==len(sink.receipts)==1

def test_actual_redis_pg_financial_redelivery_one_fake_effect(database,tmp_path,redis_app):
    from app.domains.public_service.residency import SyntheticResidencyProducer
    from app.domains.public_service.dispatch import SyntheticWorkBindings,OperationalQueues
    from test_stage15_postgres import prepared,worker
    engine,owner,event,intent,broker,source=prepared(database,tmp_path)
    now=datetime.now(timezone.utc);producer=SyntheticResidencyProducer(database[4])
    def bindings(db):return SyntheticWorkBindings(db,residency=producer,execution=worker(db,broker,source))
    try:
        with Session(engine) as db:
            producer.record(db,owner,country='IN',evidence_reference='synthetic:document',reviewer='synthetic:operator',now=now,expires=now+timedelta(hours=1))
            OperationalQueues(db,bindings(db)).enqueue(owner,'execution',str(event),now=now);db.commit()
        app=redis_app;composition=IsolatedConsumerComposition(session_factory=lambda:Session(engine),bindings_factory=bindings,clock=lambda:now)
        task=composition.register(app)['public_service.consume.execution'];sent=task.apply_async()
        connection,simple,message=receive(app,'financial_execution')
        try:
            assert message.headers['id']==sent.id and message.headers['task']==task.name
            assert task.run()['state']=='filled'
            message.reject(requeue=True)
            duplicate=simple.get(block=True,timeout=3)
            assert duplicate.headers['id']==sent.id
            assert task.run()['state']=='idle'
            duplicate.ack()
            assert len(broker.calls)==1
        finally:simple.close();connection.release()
    finally:broker.engine.dispose()
