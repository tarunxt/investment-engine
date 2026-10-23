"""Prepared real PG/Redis/child-worker guards; never run on operator services."""
import os,asyncio,multiprocessing
from pathlib import Path
from datetime import datetime,timezone,timedelta
from uuid import uuid4
import pytest
from celery import signals
from sqlalchemy import select,func
from sqlalchemy.orm import Session
from app.domains.auth.models import User,UserProfile
from app.domains.modules.models import UserModule
from app.domains.order_intents.models import OrderIntent
from app.domains.connections.models import IntegrationConnection
from app.domains.order_intents.execution_fake import FakeVenueOrder
from app.domains.public_service.residency import SyntheticResidencyProducer
from app.domains.public_service.dispatch import SyntheticWorkBindings,TOPIC
from app.infrastructure.database.outbox.models import OutboxMessage
from test_stage09_connections_postgres import database
from test_stage17_real_services import redis_app
from test_stage15_postgres import prepared,worker
from stage17_disposable_worker_fixture import configured_worker

pytestmark=pytest.mark.skipif(os.getenv('CREDX_STAGE09_DATABASE_ACK')!='disposable-docker-only',
    reason='Acknowledged disposable PG/Redis services required; CI rejects every skip')


@pytest.mark.parametrize('mutation',['foreign','module','connection','approval'])
def test_actual_authenticated_admission_and_child_worker_reject_changed_authority(database,tmp_path,redis_app,monkeypatch,mutation):
    engine,owner,event,intent,broker,source=prepared(database,tmp_path)
    now=datetime.now(timezone.utc);producer=SyntheticResidencyProducer(database[4])
    app=redis_app;app.conf.worker_enable_remote_control=False
    def builder(db):return SyntheticWorkBindings(db,residency=producer,execution=worker(db,broker,source))
    binding,composition,tasks,admit=configured_worker(database,builder,app,monkeypatch,now)
    ctx=multiprocessing.get_context('fork');ready=ctx.Event();done=ctx.Event();outcome=ctx.Queue();process=None
    expected=str(uuid4())
    def child():
        engine.dispose(close=False);broker.engine.dispose(close=False)
        def signal_ready(**kw):ready.set()
        def completed(task_id=None,retval=None,**kw):
            if task_id==expected:
                outcome.put(retval);done.set()
        signals.worker_ready.connect(signal_ready,weak=False)
        signals.task_postrun.connect(completed,weak=False)
        app.Worker(pool='solo',concurrency=1,queues=['financial_execution'],
            hostname='stage17-'+uuid4().hex,loglevel='WARNING',without_gossip=True,
            without_mingle=True,without_heartbeat=True).start()
    try:
        with Session(engine) as db:
            producer.record(db,owner,country='IN',evidence_reference='synthetic:document',reviewer='synthetic:operator',now=now,expires=now+timedelta(hours=1))
            if mutation=='foreign':
                other=User(email='worker-foreign@example.invalid',username='worker_foreign',password_hash='unusable',is_active=True,is_verified=True,profile=UserProfile())
                db.add(other);db.flush();identity=other.id
            else:identity=owner
            db.commit()
        response=asyncio.run(admit(identity,event))
        if mutation=='foreign':
            assert response.status_code==409
            with Session(engine) as db:assert db.scalar(select(func.count()).select_from(OutboxMessage).where(OutboxMessage.topic==TOPIC))==0
        else:
            assert response.status_code==200,response.text
            with Session(engine) as db:
                row=db.get(OrderIntent,intent)
                if mutation=='module':db.scalar(select(UserModule).where(UserModule.user_id==owner)).enabled=False
                elif mutation=='connection':db.get(IntegrationConnection,row.connection_id).version+=1
                else:row.expires_at=now-timedelta(seconds=1)
                db.commit()
            process=ctx.Process(target=child);process.start();assert ready.wait(10)
            tasks['public_service.consume.execution'].apply_async(task_id=expected)
            assert done.wait(10),'Owned worker did not finish guarded task'
            assert outcome.get(timeout=2)['state'] in {'blocked','uncertain'}
        # Durable fake venue, not an inherited process-local calls list.
        with Session(broker.engine) as venue:assert venue.scalar(select(func.count()).select_from(FakeVenueOrder))==0
    finally:
        if process is not None:
            if process.is_alive():process.terminate()
            process.join(5)
            if process.is_alive():process.kill();process.join(5)
        outcome.close();outcome.join_thread();broker.engine.dispose()
