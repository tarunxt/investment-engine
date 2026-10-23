from datetime import timedelta
from uuid import uuid4
import pytest
from sqlalchemy import event
from app.domains.ai_limits.contracts import BoundaryDenied
from app.domains.ai_limits.private_effects import LocalSink
from app.domains.auth.models import User, UserRole, ActivityLog
from app.domains.public_service.monitor_dispatch import MonitorDispatch, MonitorDispatchPolicy
from test_stage17_reviewed_residency import setup, NOW

def monitor(db):
    sink = LocalSink()
    return MonitorDispatch(db, policy=MonitorDispatchPolicy('synthetic-roster-not-real-approval', frozenset({2}), 30), sink=sink)

def report():
    return dict(owner_id=1, correlation_id=str(uuid4()), stale_data=True, unknown_orders=False,
                cost_spike=False, action='pause_and_review', source_unavailable=True, scope='owned_database_observation')

def test_disabled_without_explicit_policy_sink(setup):
    db, _ = setup
    with pytest.raises(BoundaryDenied, match='BINDING'): MonitorDispatch(db).enqueue(1, report(), now=NOW)

def test_delivery_idempotence_escalation_and_acknowledgement(setup):
    db, _ = setup; m = monitor(db); r = report(); row = m.enqueue(1, r, now=NOW); db.commit()
    assert m.enqueue(1, r, now=NOW).id == row.id
    assert m.dispatch(1, row.id, now=NOW) == 'recorded'
    assert m.dispatch(1, row.id, now=NOW) == 'recorded'
    assert len(m.sink.receipts) == 1
    assert m.escalate(1, row.id, now=NOW+timedelta(seconds=29)) == 'recorded'
    assert m.escalate(1, row.id, now=NOW+timedelta(seconds=30)) == 'escalated'
    db.commit()
    assert m.acknowledge(1, row.id, 2, now=NOW+timedelta(seconds=31)) == 'acknowledged'
    db.commit()
    assert m.escalate(1, row.id, now=NOW+timedelta(hours=1)) == 'acknowledged'

@pytest.mark.parametrize('actor', [1, 3, 4, True])
def test_ack_requires_current_appointed_active_admin(setup, actor):
    db, _ = setup; m = monitor(db); row = m.enqueue(1, report(), now=NOW); db.commit(); m.dispatch(1, row.id, now=NOW)
    with pytest.raises(BoundaryDenied, match='OPERATOR'): m.acknowledge(1, row.id, actor, now=NOW)

def test_owner_fence_role_demotion_and_raw_secret_projection(setup):
    db, _ = setup; m = monitor(db)
    with pytest.raises(BoundaryDenied): m.enqueue(1, {**report(), 'password':'synthetic-secret'}, now=NOW)
    row = m.enqueue(1, report(), now=NOW); db.commit()
    with pytest.raises(BoundaryDenied): m.dispatch(3, row.id, now=NOW)
    assert not m.sink.receipts
    m.dispatch(1, row.id, now=NOW); db.get(User,2).role=UserRole.USER; db.commit()
    with pytest.raises(BoundaryDenied): m.acknowledge(1,row.id,2,now=NOW)

def test_response_loss_no_replay_and_no_ack_of_uncertain(setup, monkeypatch):
    db, _ = setup; m = monitor(db); row = m.enqueue(1, report(), now=NOW); db.commit(); original=m.sink.deliver
    calls=[]
    def lost(*args): calls.append(args[0]); original(*args); raise RuntimeError('synthetic response loss')
    monkeypatch.setattr(m.sink,'deliver',lost)
    with pytest.raises(BoundaryDenied,match='UNCERTAIN'): m.dispatch(1,row.id,now=NOW)
    assert m.dispatch(1,row.id,now=NOW)=='uncertain'
    assert len(calls)==len(m.sink.receipts)==1
    with pytest.raises(BoundaryDenied): m.acknowledge(1,row.id,2,now=NOW)

def test_crash_marker_blocks_redelivery_after_new_composition(setup):
    db,_=setup; m=monitor(db); row=m.enqueue(1,report(),now=NOW); db.commit()
    row.payload={**row.payload,'state':'dispatching','dispatched_at':NOW.isoformat()};db.commit()
    fresh=monitor(db)
    assert fresh.dispatch(1,row.id,now=NOW)=='dispatching' and not fresh.sink.receipts

def test_audit_failure_prevents_effect(setup):
    db,_=setup;m=monitor(db);row=m.enqueue(1,report(),now=NOW);db.commit()
    def fail(session,ctx,instances):
        if any(isinstance(obj,ActivityLog) and obj.action=='monitor_dispatching' for obj in session.new):raise RuntimeError('synthetic audit failure')
    event.listen(db,'before_flush',fail)
    try:
        with pytest.raises(RuntimeError):m.dispatch(1,row.id,now=NOW)
        assert not m.sink.receipts
        db.rollback()
    finally:event.remove(db,'before_flush',fail)
    assert m.dispatch(1,row.id,now=NOW)=='recorded'

@pytest.mark.parametrize('change', [
    {'owner_id':3}, {'owner_id':True}, {'password':'SYNTHETIC_DO_NOT_DELIVER'},
    {'stale_data':False}, {'correlation_id':str(uuid4())}, {'unknown_orders':'yes'},
])
def test_persisted_report_tamper_never_reaches_sink(setup, change):
    db,_=setup;m=monitor(db);row=m.enqueue(1,report(),now=NOW);db.commit()
    row.payload={**row.payload,'report':{**row.payload['report'],**change}}
    from sqlalchemy.orm.attributes import flag_modified
    flag_modified(row,'payload')  # bool True == int 1 must still reach physical JSON for this probe.
    db.commit()
    with pytest.raises(BoundaryDenied):m.dispatch(1,row.id,now=NOW)
    assert not m.sink.receipts

def test_recomputed_report_digest_still_cannot_change_original_identity(setup):
    from app.domains.ai_limits.contracts import digest
    db,_=setup;m=monitor(db);row=m.enqueue(1,report(),now=NOW);db.commit()
    altered={**row.payload['report'],'cost_spike':True}
    row.payload={**row.payload,'report':altered,'report_hash':digest(altered)};db.commit()
    with pytest.raises(BoundaryDenied,match='CHANGED'):m.dispatch(1,row.id,now=NOW)
    assert not m.sink.receipts

def test_post_claim_committed_report_mutation_is_rechecked_before_effect(setup):
    db,_=setup;m=monitor(db);row=m.enqueue(1,report(),now=NOW);db.commit();armed=[True]
    key=row.id
    def tamper(session):
        if armed[0]:
            armed[0]=False
            from sqlalchemy.orm import Session
            from app.infrastructure.database.outbox.models import OutboxMessage
            with Session(db.get_bind()) as separate:
                stored=separate.get(OutboxMessage,key)
                stored.payload={**stored.payload,'report':{**stored.payload['report'],'password':'SYNTHETIC_DO_NOT_DELIVER'}}
                separate.commit()
    event.listen(db,'after_commit',tamper)
    try:
        with pytest.raises(BoundaryDenied):m.dispatch(1,row.id,now=NOW)
        assert not m.sink.receipts
    finally:event.remove(db,'after_commit',tamper)
