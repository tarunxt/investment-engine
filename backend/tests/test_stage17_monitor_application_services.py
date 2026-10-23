"""Prepared signed HTTP -> actual PG/Redis child worker; no live services."""
import os,json,time,multiprocessing
from dataclasses import replace
from datetime import datetime,timezone
from pathlib import Path
from uuid import uuid4,UUID
import pytest
import pytest_asyncio
from celery import signals
from fastapi import FastAPI
from httpx import ASGITransport,AsyncClient
from sqlalchemy.orm import Session
from app.domains.ai_limits.contracts import digest
from app.domains.ai_limits.private_effects import LocalSink
from app.domains.public_service.application_bindings import install_disposable_bindings
from app.domains.public_service.disposable_monitoring import DisposableMonitoringFactory,QUEUE
from app.domains.public_service.monitor_dispatch import MonitorDispatchPolicy
from app.domains.public_service.router import router
from app.domains.modules.transports import install_route_policy
from app.infrastructure.database.outbox.models import OutboxMessage
from test_stage17_application_composition_postgres import configured_app
from test_stage09_connections_postgres import database
from test_stage17_real_services import redis_app

pytestmark=pytest.mark.skipif(os.getenv('CREDX_STAGE09_DATABASE_ACK')!='disposable-docker-only',
    reason='Acknowledged disposable PG/Redis required; exact CI rejects every skip')
PATH='/account/operations/disposable/monitor'

@pytest_asyncio.fixture
async def monitor_services(configured_app,redis_app):
    _,base,engine,owner,other,actor,headers=configured_app
    sink=LocalSink()
    with Session(engine) as db:
        factory=DisposableMonitoringFactory.from_session(db,base.scope,
            MonitorDispatchPolicy('synthetic:ci-appointed-operator',frozenset({actor}),30),sink)
    now=datetime.now(timezone.utc);factory=replace(factory,clock=lambda:now)
    binding=replace(base,monitor_factory=factory)
    app=FastAPI();app.include_router(router);install_route_policy(app);install_disposable_bindings(app,binding)
    redis_app.conf.worker_enable_remote_control=False
    redis_app.conf.broker_transport_options={**redis_app.conf.broker_transport_options,
        'visibility_timeout':2,'polling_interval':.2}
    task=factory.register(redis_app)
    return app,redis_app,task,factory,engine,owner,other,actor,headers,sink


def restore_original_expired_delivery(app,expected_id):
    """Normal Kombu recovery, observed expiry, no republish/score rewrite."""
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
                assert time.monotonic()<deadline
                time.sleep(.05)
            assert client.hget(channel.unacked_key,tag) is not None
        channel.qos.restore_visible(interval=1)
        with channel.conn_or_acquire() as client:assert client.hget(channel.unacked_key,tag) is None
        channel.close()


@pytest.mark.asyncio
@pytest.mark.parametrize('crash',[False,True])
async def test_actual_monitor_http_worker_redelivery_and_crash_never_resends(monitor_services,crash):
    app,celery,task,factory,engine,owner,other,actor,headers,sink=monitor_services
    assert Path('/.dockerenv').is_file()
    ctx=multiprocessing.get_context('fork');calls=ctx.Value('i',0)
    accepted=ctx.Event();redelivered=ctx.Event();finished=ctx.Event();results=ctx.Queue();processes=[]
    first_id,duplicate_id=str(uuid4()),str(uuid4())
    def child(lose_response,ready):
        engine.dispose(close=False)
        original=sink.deliver
        def deliver(*args):
            with calls.get_lock():calls.value+=1
            result=original(*args)
            if lose_response:accepted.set();os._exit(73)
            return result
        sink.deliver=deliver
        def ready_signal(**kwargs):ready.set()
        def before(sender=None,task_id=None,**kwargs):
            if not lose_response and task_id==first_id and sender.request.delivery_info.get('redelivered') is True:redelivered.set()
        def after(task_id=None,retval=None,state=None,**kwargs):
            if not lose_response and task_id in {first_id,duplicate_id}:
                results.put((task_id,state,retval));finished.set()
        signals.worker_ready.connect(ready_signal,weak=False)
        signals.task_prerun.connect(before,weak=False)
        signals.task_postrun.connect(after,weak=False)
        celery.Worker(pool='solo',concurrency=1,queues=[QUEUE],hostname='stage17-'+uuid4().hex,
            loglevel='WARNING',without_gossip=True,without_mingle=True,without_heartbeat=True).start()
    def start(lose_response):
        ready=ctx.Event();process=ctx.Process(target=child,args=(lose_response,ready));processes.append(process)
        process.start();assert ready.wait(10),'Owned monitoring worker did not become ready'
        return process
    try:
        async with AsyncClient(transport=ASGITransport(app=app),base_url='http://synthetic.invalid') as client:
            body={'confirmed':True}
            assert (await client.post(PATH+'/observations',json=body)).status_code==401
            assert (await client.post(PATH+'/observations',headers=headers(owner),json={**body,'owner_id':other})).status_code==422
            response=await client.post(PATH+'/observations',headers=headers(owner),json=body)
            assert response.status_code==200,response.text
            key=response.json()['id'];assert response.json()['state']=='queued'
            assert (await client.get(PATH+'/alerts/'+key,headers=headers(other))).status_code==409
            assert calls.value==0
            process=start(crash);task.apply_async(task_id=first_id)
            if crash:
                assert accepted.wait(10),'Local delivery/crash boundary was not reached'
                process.join(5);assert process.exitcode==73
                assert calls.value==1
                with Session(engine) as db:assert db.get(OutboxMessage,UUID(key)).payload['state']=='dispatching'
                restore_original_expired_delivery(celery,first_id)
                start(False)
                assert redelivered.wait(10),'Replacement did not receive the original restored delivery'
            assert finished.wait(10)
            task_id,state,result=results.get(timeout=2)
            assert task_id==first_id and state=='SUCCESS'
            if crash:
                assert result=={'state':'idle','uncertain_pending':True,'synthetic_only':True}
                status=await client.get(PATH+'/alerts/'+key,headers=headers(owner))
                assert status.json()['state']=='dispatching' and status.json()['uncertain'] is True
                assert (await client.post(PATH+f'/owners/{owner}/alerts/{key}/acknowledge',headers=headers(actor),json=body)).status_code==409
            else:
                assert result['state']=='recorded'
                with Session(engine) as db:
                    payload=db.get(OutboxMessage,UUID(key)).payload
                    assert payload['receipt']==digest(payload['report'])
                finished.clear();task.apply_async(task_id=duplicate_id)
                assert finished.wait(10)
                task_id,state,result=results.get(timeout=2)
                assert task_id==duplicate_id and state=='SUCCESS' and result['state']=='idle'
                assert (await client.post(PATH+f'/owners/{owner}/alerts/{key}/acknowledge',headers=headers(other),json=body)).status_code==409
                ack=await client.post(PATH+f'/owners/{owner}/alerts/{key}/acknowledge',headers=headers(actor),json=body)
                assert ack.status_code==200 and ack.json()['state']=='acknowledged'
            assert calls.value==1 # separate final post-replacement/post-duplicate effect count
    finally:
        for process in processes:
            if process.is_alive():process.terminate()
            process.join(5)
            if process.is_alive():process.kill();process.join(5)
        results.close();results.join_thread()


@pytest.mark.asyncio
async def test_actual_pg_intake_and_dispatch_overlap_on_control_without_deadlock(monitor_services,monkeypatch):
    """Observe a real control-row lock wait, not just simultaneous submission."""
    from concurrent.futures import ThreadPoolExecutor
    import threading
    from sqlalchemy import event,text
    from app.domains.public_service.monitoring import OperationalMonitor
    _,_,_,factory,engine,owner,_,_,_,sink=monitor_services
    with Session(engine) as db:
        key=factory.observe(db,owner)['id'];db.commit()
    roles=threading.local();first_ready=threading.Event();second_attempt=threading.Event();pids=[]
    original=OperationalMonitor.snapshot
    def before(conn,cursor,statement,parameters,context,executemany):
        if getattr(roles,'value',None)=='dispatch' and statement.lstrip().startswith('INSERT INTO outbox'):
            pids.append(conn.connection.driver_connection.get_backend_pid());second_attempt.set()
    def snapshot(self,*args,**kwargs):
        result=original(self,*args,**kwargs)
        if getattr(roles,'value',None)=='intake':
            first_ready.set();assert second_attempt.wait(2),'Dispatch never attempted monitor control'
            deadline=time.monotonic()+2
            while time.monotonic()<deadline:
                with Session(engine) as observer:
                    row=observer.execute(text('SELECT wait_event_type, query FROM pg_stat_activity WHERE pid=:pid'),{'pid':pids[0]}).one()
                if row.wait_event_type=='Lock':
                    assert row.query.lstrip().startswith('INSERT INTO outbox'),'Dispatch blocked on owner instead of shared control'
                    break
                time.sleep(.02)
            else:raise AssertionError('No actual PostgreSQL control lock overlap observed')
        return result
    def intake():
        roles.value='intake'
        with Session(engine) as db:
            result=factory.observe(db,owner);db.commit();return result
    def dispatch():
        roles.value='dispatch'
        with Session(engine) as db:return factory.service(db).dispatch(owner,key,now=factory.now())
    event.listen(engine,'before_cursor_execute',before);monkeypatch.setattr(OperationalMonitor,'snapshot',snapshot)
    try:
        with ThreadPoolExecutor(2) as pool:
            first=pool.submit(intake);assert first_ready.wait(2)
            second=pool.submit(dispatch)
            assert first.result(timeout=5)['id']==key
            assert second.result(timeout=5)=='recorded'
    finally:event.remove(engine,'before_cursor_execute',before)
    assert len(sink.receipts)==1
    with Session(engine) as db:assert factory.status(db,owner,key)['state']=='recorded'
