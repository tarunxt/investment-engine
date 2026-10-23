"""Prepared disposable CI-only PG/Redis gates; collection is not execution.

Redis exercises actual Celery/Kombu publication, acknowledgement and redelivery,
not by themselves a worker restart. A separate disposable child-worker crash
case is prepared below. PostgreSQL owns financial dedup; no real provider.
"""
import os
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime,timezone,timedelta
from uuid import uuid4
import pytest
from celery import Celery
from sqlalchemy.orm import Session
from sqlalchemy import event as sql_event, text
import threading,time
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

def overlap_probe(engine):
    second=threading.Event();pids=[];roles=threading.local()
    def before(conn,cursor,statement,parameters,context,executemany):
        if getattr(roles,'value',None)=='second' and statement.lstrip().startswith('INSERT INTO outbox'):
            pids.append(conn.connection.driver_connection.get_backend_pid());second.set()
    def require_lock():
        assert second.wait(2),'Competitor never attempted the held control row'
        deadline=time.monotonic()+2
        while time.monotonic()<deadline:
            with Session(engine) as observer:
                waiting=observer.scalar(text("SELECT wait_event_type FROM pg_stat_activity WHERE pid=:pid"),{'pid':pids[0]})
            if waiting=='Lock':return
            time.sleep(.02)
        raise AssertionError('PostgreSQL did not observe actual coordinated lock overlap')
    sql_event.listen(engine,'before_cursor_execute',before)
    return roles,require_lock,lambda:sql_event.remove(engine,'before_cursor_execute',before)


def test_actual_pg_concurrent_challenge_consumption_one_admission(database):
    from test_stage17_signup_perimeter import FixtureVerifier,NOW
    engine=database[0]
    policy=SignupPerimeterPolicy('synthetic-pg-policy','signup.example.invalid',2,120,b'x'*32)
    roles,require_lock,remove_probe=overlap_probe(engine);first_ready=threading.Event()
    def attempt(index):
        roles.value='first' if index==1 else 'second'
        with Session(engine) as db:
            try:
                SignupPerimeter(policy=policy,verifier=FixtureVerifier()).admit(db,
                    f'fixture{index}@example.invalid','fixture-same-proof',peer='192.0.2.1',now=NOW)
                if index==1:first_ready.set();require_lock()
                db.commit();return True
            except BoundaryDenied:db.rollback();return False
    try:
        with ThreadPoolExecutor(2) as pool:
            first=pool.submit(attempt,1);assert first_ready.wait(2)
            second=pool.submit(attempt,2);assert sum((first.result(timeout=5),second.result(timeout=5)))==1
    finally:remove_probe()

def test_actual_pg_concurrent_monitor_dispatch_one_local_effect(database):
    engine,_,owner,_,_=database;now=datetime.now(timezone.utc);sink=LocalSink()
    policy=MonitorDispatchPolicy('synthetic-pg-monitor',frozenset({owner}))
    roles,require_lock,remove_probe=overlap_probe(engine);first_ready=threading.Event()
    calls=[];original=sink.deliver
    def counted(*args):
        calls.append(args[0]);first_ready.set();require_lock();return original(*args)
    sink.deliver=counted
    report=dict(owner_id=owner,correlation_id=str(uuid4()),stale_data=True,unknown_orders=False,
        cost_spike=False,action='pause_and_review',source_unavailable=True,scope='owned_database_observation')
    with Session(engine) as db:
        key=MonitorDispatch(db,policy=policy,sink=sink).enqueue(owner,report,now=now).id;db.commit()
    def attempt(index):
        roles.value='first' if index==1 else 'second'
        with Session(engine) as db:return MonitorDispatch(db,policy=policy,sink=sink).dispatch(owner,key,now=now)
    try:
        with ThreadPoolExecutor(2) as pool:
            first=pool.submit(attempt,1);assert first_ready.wait(2)
            second=pool.submit(attempt,2);states=[first.result(timeout=5),second.result(timeout=5)]
    finally:remove_probe()
    assert set(states)<={'recorded','dispatching'} and 'recorded' in states
    assert len(calls)==len(sink.receipts)==1

def test_actual_redis_pg_financial_redelivery_one_fake_effect(database,tmp_path,redis_app,monkeypatch):
    from app.domains.public_service.residency import SyntheticResidencyProducer
    from app.domains.public_service.dispatch import SyntheticWorkBindings,OperationalQueues
    from test_stage15_postgres import prepared,worker
    engine,owner,event,intent,broker,source=prepared(database,tmp_path)
    now=datetime.now(timezone.utc);producer=SyntheticResidencyProducer(database[4])
    def bindings(db):return SyntheticWorkBindings(db,residency=producer,execution=worker(db,broker,source))
    try:
        with Session(engine) as db:
            producer.record(db,owner,country='IN',evidence_reference='synthetic:document',reviewer='synthetic:operator',now=now,expires=now+timedelta(hours=1))
            db.commit()
        import asyncio
        from stage17_disposable_worker_fixture import configured_worker
        app=redis_app;binding,composition,tasks,admit=configured_worker(database,bindings,app,monkeypatch,now)
        response=asyncio.run(admit(owner,event));assert response.status_code==200,response.text
        assert response.json()['state']=='queued' and not broker.calls
        task=tasks['public_service.consume.execution'];sent=task.apply_async()
        connection,simple,message=receive(app,'financial_execution')
        try:
            assert message.headers['id']==sent.id and message.headers['task']==task.name
            outcome=task.run()
            assert outcome['state']=='completed'
            assert outcome['result']['status']=='filled'
            message.reject(requeue=True)
            duplicate=simple.get(block=True,timeout=3)
            assert duplicate.headers['id']==sent.id
            assert task.run()['state']=='idle'
            duplicate.ack()
            assert len(broker.calls)==1
        finally:simple.close();connection.release()
    finally:broker.engine.dispose()



def test_actual_worker_crash_after_fake_acceptance_restart_never_resubmits(database,tmp_path,redis_app,monkeypatch):
    """Child crash + explicit expired-reservation recovery + real replacement.

    This does not certify the default unattended transport polling deadline.
    """
    import multiprocessing
    from celery import signals
    from sqlalchemy import select,func
    from app.infrastructure.database.outbox.models import OutboxMessage
    from app.domains.public_service.residency import SyntheticResidencyProducer
    from app.domains.public_service.dispatch import SyntheticWorkBindings,OperationalQueues,TOPIC
    from app.domains.order_intents.execution_fake import FakeVenueOrder
    from test_stage15_postgres import prepared,worker
    assert Path('/.dockerenv').is_file()
    engine,owner,event,intent,broker,source=prepared(database,tmp_path)
    now=datetime.now(timezone.utc);producer=SyntheticResidencyProducer(database[4]);ctx=multiprocessing.get_context('fork')
    accepted=ctx.Event();redelivered=ctx.Event();finished=ctx.Event();calls=ctx.Value('i',0);processes=[]
    expected_id=str(uuid4())
    def bindings(db):return SyntheticWorkBindings(db,residency=producer,execution=worker(db,broker,source))
    app=redis_app;app.conf.worker_enable_remote_control=False
    app.conf.broker_transport_options={**app.conf.broker_transport_options,'visibility_timeout':2,'polling_interval':.2}
    from stage17_disposable_worker_fixture import configured_worker
    binding,composition,tasks,admit=configured_worker(database,bindings,app,monkeypatch,now)
    task=tasks['public_service.consume.execution']
    def start_worker(crash,clock,ready):
        # Only child-owned engines/connections; never share a PostgreSQL socket
        # across fork. No module runtime registration or real adapter is used.
        engine.dispose(close=False);broker.engine.dispose(close=False);composition.clock=lambda:clock
        original=broker.submit
        def submit(*args,**kwargs):
            with calls.get_lock():calls.value+=1
            result=original(*args,**kwargs)
            if crash:accepted.set();os._exit(73)
            return result
        broker.submit=submit
        def signal_ready(**kwargs):ready.set()
        signals.worker_ready.connect(signal_ready,weak=False)
        def saw_task(sender=None,task_id=None,**kwargs):
            if not crash and task_id==expected_id and sender.request.delivery_info.get('redelivered') is True:
                redelivered.set()
        def completed_task(task_id=None,retval=None,state=None,**kwargs):
            if not crash and task_id==expected_id and state=='SUCCESS' and isinstance(retval,dict) and retval.get('state')=='idle':
                finished.set()
        signals.task_prerun.connect(saw_task,weak=False)
        signals.task_postrun.connect(completed_task,weak=False)
        app.Worker(pool='solo',concurrency=1,queues=['financial_execution'],
            hostname='stage17-'+uuid4().hex,loglevel='WARNING',without_gossip=True,
            without_mingle=True,without_heartbeat=True).start()
    try:
        with Session(engine) as db:
            producer.record(db,owner,country='IN',evidence_reference='synthetic:document',reviewer='synthetic:operator',now=now,expires=now+timedelta(hours=1))
            db.commit()
        import asyncio
        from uuid import UUID
        response=asyncio.run(admit(owner,event));assert response.status_code==200,response.text
        assert response.json()['state']=='queued' and not broker.calls
        key=UUID(response.json()['id'])
        ready=ctx.Event();first=ctx.Process(target=start_worker,args=(True,now,ready));processes.append(first);first.start()
        assert ready.wait(10),'First owned worker did not become ready'
        task.apply_async(task_id=expected_id);assert accepted.wait(10),'Fake acceptance/crash boundary not reached'
        first.join(5);assert first.exitcode==73
        with Session(broker.engine) as venue:assert venue.scalar(select(func.count()).select_from(FakeVenueOrder))==1
        # SQL uses the explicit fixture clock; Redis visibility uses wall time.
        # Do not conflate visibility_timeout with Kombu's amortized poll cadence.
        # Observe the actual reservation and expiry, then invoke the normal
        # expired-reservation restoration API, never republish or edit a score.
        import json
        with app.connection_for_read() as recovery:
            channel=recovery.channel()
            with channel.conn_or_acquire() as client:
                reservations=client.zrevrangebyscore(channel.unacked_index_key,'+inf','-inf',withscores=True)
                assert len(reservations)==1
                tag,score=reservations[0]
                body=json.loads(client.hget(channel.unacked_key,tag))
                assert body[0]['headers']['id']==expected_id
                deadline=time.monotonic()+5
                while True:
                    seconds,micros=client.time();server_time=seconds+micros/1_000_000
                    if server_time>score+channel.visibility_timeout+.05:break
                    assert time.monotonic()<deadline,'Redis reservation did not expire in bounded time'
                    time.sleep(.05)
                assert abs(server_time-time.time())<1,'Redis/container wall clocks disagree'
                assert client.hget(channel.unacked_key,tag) is not None
            channel.qos.restore_visible(interval=1)
            with channel.conn_or_acquire() as client:assert client.hget(channel.unacked_key,tag) is None
            channel.close()
        ready=ctx.Event();second=ctx.Process(target=start_worker,args=(False,now+timedelta(seconds=31),ready));processes.append(second);second.start()
        assert ready.wait(10),'Replacement owned worker did not become ready'
        assert redelivered.wait(10),'Replacement did not receive original restored delivery'
        assert finished.wait(10),'Replacement did not complete safely without a new effect'
        deadline=time.monotonic()+5;state=None
        while time.monotonic()<deadline:
            with Session(engine) as db:
                row=db.scalar(select(OutboxMessage).where(OutboxMessage.id==key,OutboxMessage.topic==TOPIC));state=row.payload['state']
            if state=='uncertain':break
            time.sleep(.1)
        # These assertions are separate so state failure cannot hide the final
        # post-replacement effect count as it did in the preserved original run.
        assert calls.value==1
        with Session(broker.engine) as venue:assert venue.scalar(select(func.count()).select_from(FakeVenueOrder))==1
        assert state=='uncertain'
    finally:
        # Stop only worker processes created and recorded by this disposable test.
        for process in processes:
            if process.is_alive():process.terminate()
            process.join(5)
            if process.is_alive():process.kill();process.join(5)
        broker.engine.dispose()
