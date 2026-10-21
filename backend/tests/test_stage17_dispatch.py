"""Existing governed jobs and confirmed fake orders through durable separate lanes."""
from datetime import timedelta
from uuid import uuid4
import pytest
from sqlalchemy import select
from cryptography.fernet import Fernet
from app.domains.connections.crypto import ConnectionKeyring
from app.domains.public_service.residency import SyntheticResidencyProducer
from app.domains.public_service.dispatch import OperationalQueues,SyntheticWorkBindings,TOPIC
from app.domains.ai_limits.contracts import BoundaryDenied
from app.infrastructure.database.outbox.models import OutboxMessage
from app.domains.recommendation_audit.models import SpendAccount
from app.domains.order_intents.models import OrderIntent,OrderLeg
from app.domains.connections.models import IntegrationConnection
from app.domains.zerodha.models import ZerodhaPortfolioSnapshot
from app.domains.modules.models import UserModule
from test_stage15_execution import setup,env,NOW

def proof(db,id,at):
    p=SyntheticResidencyProducer(ConnectionKeyring({1:Fernet.generate_key().decode()}));r=p.record(db,id,country='IN',evidence_reference='synthetic:document',reviewer='synthetic:operator',now=at,expires=at+timedelta(hours=1));db.commit();return p,r

def monitors(db,engine,id,at):
    for m in (SpendAccount,ZerodhaPortfolioSnapshot):m.__table__.create(engine,checkfirst=True)
    if not db.scalar(select(ZerodhaPortfolioSnapshot).where(ZerodhaPortfolioSnapshot.user_id==id)):
        db.add(ZerodhaPortfolioSnapshot(user_id=id,snapshot_date=at.date(),captured_at=at,source='synthetic'));db.commit()

def queue(e):
    db=e.env.db;monitors(db,e.env.engine,e.row.owner_id,NOW);p,r=proof(db,e.row.owner_id,NOW)
    q=OperationalQueues(db,SyntheticWorkBindings(db,residency=p,execution=e.worker));return q,p,r

def test_actual_confirmed_fake_execution_and_duplicate_delivery(setup):
    e=setup();q,p,r=queue(e);item=q.enqueue(e.row.owner_id,'execution',str(e.event.id),now=NOW);e.env.db.commit()
    result=q.work_once('execution',now=NOW);assert result['result']['status']=='filled' and len(e.broker.calls)==1
    assert q.enqueue(e.row.owner_id,'execution',str(e.event.id),now=NOW).id==item.id;e.env.db.commit()
    assert q.work_once('execution',now=NOW)is None and len(e.broker.calls)==1
    from app.domains.public_service.monitoring import TOPIC as ALERT
    assert list(e.env.db.scalars(select(OutboxMessage).where(OutboxMessage.topic==ALERT)))

@pytest.mark.parametrize('mutation',['module','connection','payload','residency','foreign'])
def test_queue_rechecks_fences_before_fake_effect(setup,mutation):
    e=setup();q,p,r=queue(e);id=e.row.owner_id
    if mutation=='foreign':
        with pytest.raises(BoundaryDenied):q.enqueue(e.env.owners[1],'execution',str(e.event.id),now=NOW)
        assert not e.broker.calls;return
    q.enqueue(id,'execution',str(e.event.id),now=NOW);e.env.db.commit()
    if mutation=='module':e.env.db.scalar(select(UserModule).where(UserModule.user_id==id)).enabled=False
    if mutation=='connection':e.env.db.get(IntegrationConnection,e.row.connection_id).version+=1
    if mutation=='payload':e.row.request_digest='0'*64
    if mutation=='residency':p.revoke(e.env.db,id,r.id)
    e.env.db.commit();result=q.work_once('execution',now=NOW)
    assert result['state']in {'blocked','uncertain'} and not e.broker.calls

def test_process_loss_after_claim_cannot_repeat_execution(setup):
    e=setup();q,p,r=queue(e);item=q.enqueue(e.row.owner_id,'execution',str(e.event.id),now=NOW);e.env.db.commit()
    def crash():raise SystemExit('synthetic process loss')
    with pytest.raises(SystemExit):q.work_once('execution',now=NOW,after_claim=crash)
    assert not e.broker.calls
    assert q.work_once('execution',now=NOW+timedelta(minutes=1))is None
    assert e.env.db.get(OutboxMessage,item.id).payload['state']=='uncertain'
    with pytest.raises(BoundaryDenied):q.retry(item.id,e.row.owner_id,now=NOW+timedelta(minutes=1))

def test_unknown_execution_uses_separate_reconciliation_without_resubmit(setup):
    e=setup(['after_acceptance']);q,p,r=queue(e);item=q.enqueue(e.row.owner_id,'execution',str(e.event.id),now=NOW);e.env.db.commit()
    assert q.work_once('execution',now=NOW)['state']=='uncertain' and len(e.broker.calls)==1
    # Observation remains available after module disable and is never resume.
    e.env.db.scalar(select(UserModule).where(UserModule.user_id==e.row.owner_id)).enabled=False;e.env.db.commit()
    q.enqueue(e.row.owner_id,'reconciliation',e.row.id,now=NOW);e.env.db.commit()
    result=q.work_once('reconciliation',now=NOW)
    assert result['result']['status']=='filled' and len(e.broker.calls)==1
    assert e.env.db.get(OutboxMessage,item.id).payload['state']=='reconciled'

def test_queue_runtime_not_constructible_with_unreviewed_or_real_bindings(setup):
    e=setup()
    with pytest.raises(BoundaryDenied):SyntheticWorkBindings(e.env.db,residency=None,execution=e.worker)
    with pytest.raises(BoundaryDenied):OperationalQueues(e.env.db,object())

def test_two_owned_accounts_use_exact_registered_workers(setup):
    e=setup();other=setup(owner=e.env.owners[1],key='other-owner')
    monitors(e.env.db,e.env.engine,e.row.owner_id,NOW);monitors(e.env.db,e.env.engine,other.row.owner_id,NOW)
    p,r=proof(e.env.db,e.row.owner_id,NOW)
    p.record(e.env.db,other.row.owner_id,country='IN',evidence_reference='synthetic:other',reviewer='synthetic:operator',now=NOW,expires=NOW+timedelta(hours=1));e.env.db.commit()
    q=OperationalQueues(e.env.db,SyntheticWorkBindings(e.env.db,residency=p,execution=(e.worker,other.worker)))
    q.enqueue(e.row.owner_id,'execution',str(e.event.id),now=NOW);q.enqueue(other.row.owner_id,'execution',str(other.event.id),now=NOW+timedelta(microseconds=1));e.env.db.commit()
    assert q.work_once('execution',now=NOW+timedelta(seconds=1))['result']['intent_id']==e.row.id
    assert q.work_once('execution',now=NOW+timedelta(seconds=1))['result']['intent_id']==other.row.id
    assert len(e.broker.calls)==len(other.broker.calls)==1

def test_readonly_reconciliation_retries_are_bounded_with_durable_deadlines(setup):
    e=setup();q,p,r=queue(e);item=q.enqueue(e.row.owner_id,'reconciliation',e.row.id,now=NOW);e.env.db.commit()
    at=NOW
    for attempt in range(1,4):
        claimed=q.claim('reconciliation',now=at);assert claimed and e.env.db.get(OutboxMessage,item.id).payload['attempts']==attempt
        at+=timedelta(seconds=31);assert q.claim('reconciliation',now=at)is None
        if attempt<3:
            with pytest.raises(BoundaryDenied):q.retry(item.id,e.env.owners[1],now=at)
            e.env.db.rollback();q.retry(item.id,e.row.owner_id,now=at)
            assert q.claim('reconciliation',now=at)is None
            at+=timedelta(seconds=10)
        else:
            with pytest.raises(BoundaryDenied):q.retry(item.id,e.row.owner_id,now=at)
    assert not e.broker.calls

@pytest.mark.parametrize('field,value',[('owner_id',999),('resource','forged'),('binding','0'*64)])
def test_queue_immutable_seal_tamper_never_reaches_adapter(setup,field,value):
    e=setup();q,p,r=queue(e);item=q.enqueue(e.row.owner_id,'execution',str(e.event.id),now=NOW);e.env.db.commit()
    item.payload={**item.payload,field:value};e.env.db.commit()
    with pytest.raises(BoundaryDenied):q.work_once('execution',now=NOW)
    assert not e.broker.calls


def test_expired_claimant_rejected_before_any_fake_effect(setup):
    e=setup();q,p,r=queue(e)
    item=q.enqueue(e.row.owner_id,'execution',str(e.event.id),now=NOW);e.env.db.commit()
    def expire():assert q.claim('execution',now=NOW+timedelta(seconds=31))is None
    with pytest.raises(BoundaryDenied,match='QUEUE_LEASE_CHANGED'):
        q.work_once('execution',now=NOW,after_claim=expire)
    assert not e.broker.calls
    assert e.env.db.get(OutboxMessage,item.id).payload['state']=='uncertain'

@pytest.mark.parametrize('change',['state','lease'])
def test_invalidated_claimant_never_dispatches(setup,change):
    e=setup();q,p,r=queue(e);item=q.enqueue(e.row.owner_id,'execution',str(e.event.id),now=NOW);e.env.db.commit()
    def invalidate():
        row=e.env.db.get(OutboxMessage,item.id);row.payload={**row.payload,change:'uncertain' if change=='state' else str(uuid4())};e.env.db.commit()
    with pytest.raises(BoundaryDenied,match='QUEUE_LEASE_CHANGED'):
        q.work_once('execution',now=NOW,after_claim=invalidate)
    assert not e.broker.calls


def test_elapsed_preparation_rechecks_deadline_at_execution_effect(setup,monkeypatch):
    import app.domains.public_service.dispatch as dispatch
    e=setup();q,p,r=queue(e);item=q.enqueue(e.row.owner_id,'execution',str(e.event.id),now=NOW);e.env.db.commit()
    elapsed=[0.0];monkeypatch.setattr(dispatch,'monotonic',lambda:elapsed[0])
    read=e.source.read
    def delayed_read():elapsed[0]=31.0;return read()
    monkeypatch.setattr(e.source,'read',delayed_read)
    result=q.work_once('execution',now=NOW)
    assert result['state']=='uncertain' and not e.broker.calls


def test_deadline_elapsing_in_final_risk_read_still_prevents_broker_submit(setup,monkeypatch):
    import app.domains.public_service.dispatch as dispatch
    e=setup();q,p,r=queue(e);q.enqueue(e.row.owner_id,'execution',str(e.event.id),now=NOW);e.env.db.commit()
    elapsed=[0.0];reads=[0];monkeypatch.setattr(dispatch,'monotonic',lambda:elapsed[0]);read=e.source.read
    def final_read():
        reads[0]+=1
        if reads[0]==2:elapsed[0]=31.0
        return read()
    monkeypatch.setattr(e.source,'read',final_read)
    result=q.work_once('execution',now=NOW)
    assert reads[0]==2 and result['state']=='uncertain' and not e.broker.calls


def test_effect_row_fence_blocks_competing_expiry_until_transaction_finishes(setup):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    from sqlalchemy.orm import Session
    from app.domains.order_intents.service import Orders
    from app.domains.order_intents.execution import ExecutionWorker
    e=setup();q,p,r=queue(e);item=q.enqueue(e.row.owner_id,'execution',str(e.event.id),now=NOW);e.env.db.commit()
    id,lease=q.claim('execution',now=NOW);q.fence(id,lease,now=NOW)
    entered=Event()
    def expire():
        with Session(e.env.engine) as db:
            worker=ExecutionWorker(Orders(db,policy=e.env.policy,risk=e.env.risk,clock=lambda:NOW),e.broker,e.source)
            other=OperationalQueues(db,SyntheticWorkBindings(db,residency=p,execution=worker));entered.set()
            return other.claim('execution',now=NOW+timedelta(seconds=31))
    with ThreadPoolExecutor(1) as pool:
        pending=pool.submit(expire);assert entered.wait(2)
        try:assert not pending.done()
        finally:e.env.db.commit()
        assert pending.result(timeout=3)is None
    with pytest.raises(BoundaryDenied,match='QUEUE_LEASE_CHANGED'):q.fence(id,lease,now=NOW)
    e.env.db.rollback();assert not e.broker.calls


def test_deadline_clock_is_evaluated_after_queue_row_lock_wait(setup,monkeypatch):
    e=setup();q,p,r=queue(e);q.enqueue(e.row.owner_id,'execution',str(e.event.id),now=NOW);e.env.db.commit()
    id,lease=q.claim('execution',now=NOW);elapsed=[0];scalar=e.env.db.scalar
    def waited(*args,**kwargs):
        row=scalar(*args,**kwargs);elapsed[0]=31;return row
    monkeypatch.setattr(e.env.db,'scalar',waited)
    with pytest.raises(BoundaryDenied,match='QUEUE_LEASE_CHANGED'):
        q.fence(id,lease,now=lambda:NOW+timedelta(seconds=elapsed[0]))
    e.env.db.rollback();assert not e.broker.calls
