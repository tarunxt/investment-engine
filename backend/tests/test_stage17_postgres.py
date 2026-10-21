"""Prepared exact-head gates: only existing acknowledged disposable PostgreSQL."""
import os
from concurrent.futures import ThreadPoolExecutor
import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session
from test_stage09_connections_postgres import database
from test_stage14_postgres import setup
from app.domains.public_service.privacy import PrivacyRequests,TOPIC
from app.domains.auth.models import User,ActivityLog
from app.infrastructure.database.outbox.models import OutboxMessage
from app.domains.ai_limits.contracts import BoundaryDenied
pytestmark=pytest.mark.skipif(os.getenv('CREDX_STAGE09_DATABASE_ACK')!='disposable-docker-only',reason='Only acknowledged disposable Docker PostgreSQL; exact CI must reject skips')
def test_pg_parallel_privacy_request_one_receipt(database):
    engine,owner=setup(database)
    def request(_):
        with Session(engine) as s:
            r=PrivacyRequests(s).request(owner,'same','delete',confirmed=True);id=r.id;s.commit();return id
    with ThreadPoolExecutor(2) as pool:ids=list(pool.map(request,range(2)))
    assert ids[0]==ids[1]
    with Session(engine) as s:
        assert len(list(s.scalars(select(OutboxMessage).where(OutboxMessage.topic==TOPIC))))==1
        assert len(list(s.scalars(select(ActivityLog).where(ActivityLog.action=='privacy_requested'))))==1

def test_pg_conflicting_privacy_request_has_one_binding(database):
    engine,owner=setup(database)
    def request(kind):
        with Session(engine) as s:
            try:PrivacyRequests(s).request(owner,'same',kind,confirmed=True);s.commit();return True
            except BoundaryDenied:s.rollback();return False
    with ThreadPoolExecutor(2) as pool:assert sum(pool.map(request,['export','delete']))==1

def test_pg_inactive_owner_fails_without_request(database):
    engine,owner=setup(database)
    with Session(engine) as s:s.get(User,owner).is_active=False;s.commit()
    with Session(engine) as s:
        with pytest.raises(BoundaryDenied):PrivacyRequests(s).request(owner,'same','delete',confirmed=True)
        s.rollback();assert not list(s.scalars(select(OutboxMessage).where(OutboxMessage.topic==TOPIC)))


def test_pg_signup_global_quota_serializes_different_identities(database):
    from app.domains.public_service.signup import admit,SignupLimits
    engine=database[0]
    def signup(i):
        with Session(engine) as db:
            try:admit(db,f'synthetic{i}@invalid.test',limits=SignupLimits(1,1));db.commit();return True
            except BoundaryDenied:db.rollback();return False
    with ThreadPoolExecutor(2) as pool:assert sum(pool.map(signup,(1,2)))==1


def test_pg_claim_race_one_durable_execution_lease(database,tmp_path):
    from datetime import datetime,timezone,timedelta
    from cryptography.fernet import Fernet
    from app.domains.connections.crypto import ConnectionKeyring
    from app.domains.public_service.residency import SyntheticResidencyProducer
    from app.domains.public_service.dispatch import SyntheticWorkBindings,OperationalQueues,TOPIC as QUEUE_TOPIC
    from test_stage15_postgres import prepared,worker
    engine,owner,event,intent,broker,source=prepared(database,tmp_path)
    producer=SyntheticResidencyProducer(ConnectionKeyring({1:Fernet.generate_key().decode()}));now=datetime.now(timezone.utc)
    try:
        with Session(engine) as db:
            db.get(User,owner).is_verified=True
            producer.record(db,owner,country='IN',evidence_reference='synthetic:document',reviewer='synthetic:operator',now=now,expires=now+timedelta(hours=1))
            q=OperationalQueues(db,SyntheticWorkBindings(db,residency=producer,execution=worker(db,broker,source)))
            q.enqueue(owner,'execution',str(event),now=now);db.commit()
        def claim(_):
            with Session(engine) as db:return OperationalQueues(db,SyntheticWorkBindings(db,residency=producer,execution=worker(db,broker,source))).claim('execution',now=now)
        with ThreadPoolExecutor(2) as pool:results=list(pool.map(claim,(1,2)))
        assert sum(r is not None for r in results)==1 and not broker.calls
        with Session(engine) as db:
            rows=list(db.scalars(select(OutboxMessage).where(OutboxMessage.topic==QUEUE_TOPIC)))
            assert len(rows)==1 and rows[0].payload['attempts']==1 and rows[0].payload['state']=='running'
    finally:broker.engine.dispose()


def test_pg_effect_lease_row_lock_and_expired_claimant_fence(database,tmp_path):
    from datetime import datetime,timezone,timedelta
    from cryptography.fernet import Fernet
    from sqlalchemy.exc import DBAPIError
    from app.domains.connections.crypto import ConnectionKeyring
    from app.domains.public_service.residency import SyntheticResidencyProducer
    from app.domains.public_service.dispatch import SyntheticWorkBindings,OperationalQueues
    from test_stage15_postgres import prepared,worker
    engine,owner,event,intent,broker,source=prepared(database,tmp_path);now=datetime.now(timezone.utc)
    producer=SyntheticResidencyProducer(ConnectionKeyring({1:Fernet.generate_key().decode()}))
    try:
        with Session(engine) as db:
            producer.record(db,owner,country='IN',evidence_reference='synthetic:document',reviewer='synthetic:operator',now=now,expires=now+timedelta(hours=1))
            q=OperationalQueues(db,SyntheticWorkBindings(db,residency=producer,execution=worker(db,broker,source)))
            q.enqueue(owner,'execution',str(event),now=now);db.commit();key,lease=q.claim('execution',now=now)
            q.fence(key,lease,now=now)
            with Session(engine) as competitor:
                with pytest.raises(DBAPIError) as blocked:
                    competitor.scalar(select(OutboxMessage).where(OutboxMessage.id==key).with_for_update(nowait=True))
                assert getattr(blocked.value.orig,'pgcode',None)=='55P03';competitor.rollback()
            db.commit() # effect transaction finished: expiry can now win
            with Session(engine) as competitor:
                other=OperationalQueues(competitor,SyntheticWorkBindings(competitor,residency=producer,execution=worker(competitor,broker,source)))
                assert other.claim('execution',now=now+timedelta(seconds=31))is None
            with pytest.raises(BoundaryDenied,match='QUEUE_LEASE_CHANGED'):q.fence(key,lease,now=now)
            db.rollback();assert not broker.calls
    finally:broker.engine.dispose()


def test_pg_concurrent_enqueue_and_dispatch_use_one_owner_queue_lock_order(database,tmp_path):
    """Force the reviewed interleaving, not merely a NOWAIT row-lock probe.

    Old queue-first worker + owner-first enqueuer form a deterministic cycle.
    Correct owner-first worker makes the enqueuer wait before taking an owner,
    so both transactions complete and the broker sees exactly one submission.
    """
    from datetime import datetime,timezone,timedelta
    from threading import Event
    from sqlalchemy import event as sql_event
    from cryptography.fernet import Fernet
    from app.domains.connections.crypto import ConnectionKeyring
    from app.domains.public_service.residency import SyntheticResidencyProducer
    from app.domains.public_service.dispatch import SyntheticWorkBindings,OperationalQueues,TOPIC as QUEUE_TOPIC
    from test_stage15_postgres import prepared,worker
    engine,owner,event,intent,broker,source=prepared(database,tmp_path);now=datetime.now(timezone.utc)
    producer=SyntheticResidencyProducer(ConnectionKeyring({1:Fernet.generate_key().decode()}))
    first=Event();release=Event();enqueue_owner_attempt=Event();enqueue_owner_acquired=Event();worker_owner_attempt=Event();kind=[]
    def lock_kind(statement):
        sql=' '.join(statement.upper().split())
        if not sql.startswith('SELECT') or 'FOR UPDATE' not in sql:return None
        if 'FROM USERS ' in sql:return 'owner'
        if 'FROM OUTBOX ' in sql:return 'queue'
        return None
    try:
        with Session(engine) as db:
            producer.record(db,owner,country='IN',evidence_reference='synthetic:document',reviewer='synthetic:operator',now=now,expires=now+timedelta(hours=1))
            OperationalQueues(db,SyntheticWorkBindings(db,residency=producer,execution=worker(db,broker,source))).enqueue(owner,'execution',str(event),now=now);db.commit()
        def dispatch():
            with Session(engine) as db:
                q=OperationalQueues(db,SyntheticWorkBindings(db,residency=producer,execution=worker(db,broker,source)))
                def after_claim():
                    connection=db.connection()
                    def before(conn,cursor,statement,params,context,many):
                        if first.is_set() and kind==['queue'] and lock_kind(statement)=='owner':worker_owner_attempt.set()
                    def after(conn,cursor,statement,params,context,many):
                        k=lock_kind(statement)
                        if k and not first.is_set():
                            kind.append(k);first.set();assert release.wait(5),'Interleaving release missing'
                    sql_event.listen(connection,'before_cursor_execute',before);sql_event.listen(connection,'after_cursor_execute',after)
                return q.work_once('execution',now=now,after_claim=after_claim)
        def enqueue():
            with Session(engine) as db:
                connection=db.connection()
                def before(conn,cursor,statement,params,context,many):
                    if lock_kind(statement)=='owner':enqueue_owner_attempt.set()
                def after(conn,cursor,statement,params,context,many):
                    if lock_kind(statement)=='owner':
                        enqueue_owner_acquired.set()
                        if kind==['queue']:assert worker_owner_attempt.wait(5),'Old worker did not reach inverted owner lock'
                sql_event.listen(connection,'before_cursor_execute',before);sql_event.listen(connection,'after_cursor_execute',after)
                row=OperationalQueues(db,SyntheticWorkBindings(db,residency=producer,execution=worker(db,broker,source))).enqueue(owner,'execution',str(event),now=now);key=row.id;db.commit();return key
        with ThreadPoolExecutor(2) as pool:
            executing=pool.submit(dispatch)
            try:
                assert first.wait(3),'Worker did not acquire an effect lock'
                enqueuing=pool.submit(enqueue);assert enqueue_owner_attempt.wait(3)
                if kind==['queue']:assert enqueue_owner_acquired.wait(3)
            finally:release.set()
            assert executing.result(timeout=8)['state']=='completed'
            assert enqueuing.result(timeout=8)
        assert kind==['owner'] and len(broker.calls)==1
        with Session(engine) as db:
            rows=list(db.scalars(select(OutboxMessage).where(OutboxMessage.topic==QUEUE_TOPIC)))
            assert len(rows)==1 and rows[0].payload['state']=='completed' and rows[0].payload['attempts']==1
    finally:release.set();broker.engine.dispose()
