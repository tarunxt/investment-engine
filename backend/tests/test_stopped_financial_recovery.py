"""Disposable exact SQL recovery; never a broker or actual account erasure."""
from datetime import timedelta
import pytest
from sqlalchemy import MetaData,select
from test_quarantined_privacy import quarantined,plan_setup,residency_setup,NOW
from app.domains.connections.models import IntegrationConnection
from app.domains.order_intents.models import OrderIntent,OrderLeg
from app.domains.order_intents.execution_models import ExecutionRun,ExecutionAttempt,ExecutionFence
from app.domains.public_service.sql_account import SQLAccountReader,AccountInventory,AccountTableRule,OwnerHop,schema_digest,_credential_column
from app.domains.public_service.sql_privacy_plan import RetentionSchedule
from app.domains.public_service.sql_privacy_workflow import DisposablePrivacyScope
from app.domains.public_service.financial_privacy_recovery import StoppedFinancialFixturePrivacy,REFERENCE
from app.domains.ai_limits.contracts import BoundaryDenied


@pytest.fixture
def financial(quarantined):
    db,old,request=quarantined
    for model in (IntegrationConnection,OrderIntent,OrderLeg,ExecutionRun,ExecutionAttempt,ExecutionFence):
        model.__table__.create(db.get_bind())
    for subject in (1,2):
        conn=f'00000000-0000-0000-0000-00000000000{subject}'
        db.add(IntegrationConnection(id=conn,owner_id=subject,app_ownership_mode='user_owned',status='active'))
        db.flush()
        db.add(OrderIntent(id=f'intent-{subject}',owner_id=subject,operation_key_digest='a'*64,request_digest='b'*64,
            connection_id=conn,connection_version=1,account_id=f'FAKE{subject}',app_mode='user_owned',
            module_id='zerodha_rebalance',module_version=1,payload_json={'synthetic':True},state='unknown',
            approval_digest='c'*64,approval_nonce='fixture',approved_by=subject,created_at=NOW))
        db.flush()
        db.add(OrderLeg(id=f'leg-{subject}',intent_id=f'intent-{subject}',position=0,payload_digest='d'*64,
            client_reference=str(subject)*64,state='unknown',filled_quantity=1,
            reconciliation_json={'synthetic_evidence':'preserve'}))
        db.add(ExecutionRun(intent_id=f'intent-{subject}',outbox_id=f'event-{subject}',binding_digest='b'*64,
            approval_digest='c'*64,started_at=NOW,limits_json={'fixture':True}))
        db.flush()
        db.add(ExecutionAttempt(leg_id=f'leg-{subject}',intent_id=f'intent-{subject}',binding_digest='e'*64,
            state='unknown',claimed_at=NOW,polls=1,next_poll_at=NOW,evidence_json={'quantity':1}))
    db.add(ExecutionFence(key='platform',stopped=False));db.commit()
    metadata=MetaData();metadata.reflect(db.get_bind());rules=list(old.reader.inventory.rules)
    paths={'confirmed_order_legs':(OwnerHop('confirmed_order_intents',('intent_id',),('id',)),),
        'order_execution_runs':(OwnerHop('confirmed_order_intents',('intent_id',),('id',)),),
        'order_execution_attempts':(OwnerHop('order_execution_runs',('intent_id',),('intent_id',)),OwnerHop('confirmed_order_intents',('intent_id',),('id',)))}
    for name in ('integration_connections','order_execution_fences','confirmed_order_intents',
                 'confirmed_order_legs','order_execution_runs','order_execution_attempts'):
        table=metadata.tables[name]
        if name in {'integration_connections','order_execution_fences'}:
            rules.append(AccountTableRule(name,(),excluded_reason='fixture retained connection/control anchors'));continue
        fields=tuple(c for c in table.c.keys() if not _credential_column(c))
        rules.append(AccountTableRule(name,fields,tuple(c for c in table.c.keys() if _credential_column(c)),
            path=paths.get(name,()),owner_column='owner_id'))
    reader=SQLAccountReader(db,metadata,AccountInventory('synthetic:financial-review',schema_digest(metadata),tuple(rules)))
    retention=RetentionSchedule('synthetic:retention-review',NOW+timedelta(days=1),
        retain_until=tuple((name,None) for name in metadata.tables))
    return db,StoppedFinancialFixturePrivacy(db,reader,old.keyring,retention=retention,
        scope=DisposablePrivacyScope(REFERENCE)),request


def test_restore_stops_owner_preserves_unknown_receipts_and_other_owner(financial):
    db,workflow,request=financial
    before=db.get(ExecutionAttempt,'leg-1').evidence_json.copy()
    workflow.execute(1,request,now=NOW);db.commit();db.expire_all()
    assert db.get(OrderIntent,'intent-1') is None
    result=workflow.restore(1,request,now=NOW);db.commit();db.expire_all()
    assert db.get(OrderIntent,'intent-1').state=='unknown'
    assert db.get(OrderIntent,'intent-1').approval_digest=='c'*64
    assert db.get(ExecutionAttempt,'leg-1').evidence_json==before
    assert db.get(OrderLeg,'leg-1').filled_quantity==1
    assert db.get(ExecutionFence,'owner:1').stopped is True
    assert db.get(ExecutionFence,'owner:2') is None
    assert db.get(ExecutionFence,'platform').stopped is False
    assert result['restore_controls']['financial_authority_restored'] is False
    assert result['restore_controls']['reservations_restored'] is False
    assert workflow.restore(1,request,now=NOW)['state']=='already_restored'


def test_financial_restore_requires_explicit_scope_before_deletion(financial):
    db,workflow,request=financial
    workflow.scope=DisposablePrivacyScope('synthetic:other-scope')
    with pytest.raises(BoundaryDenied):workflow.execute(1,request,now=NOW)
    db.rollback();assert db.get(OrderIntent,'intent-1') is not None


@pytest.mark.parametrize('corruption',['connection','leg'])
def test_foreign_relationship_blocks_before_archive_or_deletion(financial,corruption):
    db,workflow,request=financial
    if corruption=='connection':
        row=db.get(OrderIntent,'intent-1');row.connection_id=db.get(OrderIntent,'intent-2').connection_id
    else:
        db.add(OrderLeg(id='foreign-extra',intent_id='intent-2',position=1,payload_digest='f'*64,client_reference='f'*64))
        db.flush();db.get(ExecutionAttempt,'leg-1').leg_id='foreign-extra'
    db.commit()
    with pytest.raises(BoundaryDenied,match='RELATIONSHIP_HELD'):
        workflow.execute(1,request,now=NOW)
    db.rollback()
    assert db.get(OrderIntent,'intent-1') is not None
    assert db.get(ExecutionFence,'owner:1') is None


def test_unused_approval_is_invalidated_without_clearing_frozen_evidence(financial):
    db,workflow,request=financial
    db.get(OrderIntent,'intent-1').state='approved';db.commit()
    workflow.execute(1,request,now=NOW);db.commit()
    workflow.restore(1,request,now=NOW);db.commit();db.expire_all()
    assert db.get(OrderIntent,'intent-1').state=='invalidated'
    assert db.get(OrderIntent,'intent-1').approval_digest=='c'*64
    assert db.get(ExecutionAttempt,'leg-1').polls==1


def test_final_audit_failure_rolls_back_financial_rows_and_stops(financial):
    from sqlalchemy import event
    from app.domains.auth.models import ActivityLog
    db,workflow,request=financial
    workflow.execute(1,request,now=NOW);db.commit()
    def fail(session,ctx,instances):
        if any(isinstance(row,ActivityLog) and row.action=='privacy_fixture_restored' for row in session.new):
            raise RuntimeError('synthetic final audit failure')
    event.listen(db,'before_flush',fail)
    try:
        with pytest.raises(RuntimeError):workflow.restore(1,request,now=NOW)
        db.commit()
    finally:event.remove(db,'before_flush',fail)
    db.expire_all()
    assert db.get(OrderIntent,'intent-1') is None
    assert db.get(ExecutionFence,'owner:1') is None
    assert db.get(OrderIntent,'intent-2').state=='unknown'
