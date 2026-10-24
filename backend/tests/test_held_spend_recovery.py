from datetime import timedelta
from decimal import Decimal
import pytest
from sqlalchemy import MetaData,select
from test_stage17_canonical_owner_mapping import mapping,residency_setup,NOW
from app.domains.public_service.spend_privacy_recovery import HeldSpendFixturePrivacy,REFERENCE,LEDGER
from app.domains.public_service.sql_privacy_workflow import DisposablePrivacyScope
from app.domains.public_service.sql_privacy_plan import RetentionSchedule
from app.domains.public_service.sql_account import AccountInventory,AccountTableRule,OwnerHop,SQLAccountReader,schema_digest,_credential_column
from app.domains.public_service.privacy import PrivacyRequests
from app.domains.modules.models import UserModulePreferences,UserModule
from app.domains.recommendation_audit.models import SpendAccount,SpendAttempt,VerificationRecord
from app.domains.connections.crypto import ConnectionKeyring
from cryptography.fernet import Fernet
from app.domains.ai_limits.contracts import BoundaryDenied


@pytest.fixture
def spend(mapping):
    db,reader=mapping
    for model in (UserModulePreferences,UserModule):model.__table__.create(db.get_bind())
    for subject in (1,3):
        db.add(UserModulePreferences(user_id=subject,version=1))
        db.add(UserModule(user_id=subject,module_id='ai_studio',enabled=True,version=1,schedules_paused=False,config={'schema_version':1}))
        account=db.get(SpendAccount,f'sa-{subject}');account.reserved_usd=Decimal('0.25');account.spent_usd=Decimal('0.10')
        attempt=db.get(SpendAttempt,f'at-{subject}');attempt.status='started';attempt.upper_bound_usd=Decimal('0.25');attempt.module_version=7
        db.get(VerificationRecord,f'v-{subject}').status='processing'
    db.commit()
    metadata=MetaData();metadata.reflect(db.get_bind());rules=[]
    for rule in reader.inventory.rules:
        if rule.table in {'recommendation_evidence','recommendation_decisions'}:
            rules.append(AccountTableRule(rule.table,(),excluded_reason='fixture retained immutable evidence'));continue
        rules.append(rule)
    rules.extend([AccountTableRule('user_module_preferences',tuple(metadata.tables['user_module_preferences'].c.keys())),
        AccountTableRule('user_modules',tuple(metadata.tables['user_modules'].c.keys()),path=(OwnerHop('user_module_preferences',('user_id',),('user_id',)),))])
    inventory=AccountInventory('synthetic:held-spend',schema_digest(metadata),tuple(rules))
    retention=RetentionSchedule('synthetic:retention',NOW+timedelta(days=1),retain_until=tuple((name,None) for name in metadata.tables))
    request=PrivacyRequests(db).request(1,'held-spend-recovery','delete',confirmed=True,now=NOW);db.commit()
    return db,HeldSpendFixturePrivacy(db,SQLAccountReader(db,metadata,inventory),ConnectionKeyring({1:Fernet.generate_key().decode()}),
        retention=retention,scope=DisposablePrivacyScope(REFERENCE)),request.id


def test_spend_restore_preserves_amounts_and_retires_old_dispatch(spend):
    db,workflow,request=spend
    workflow.execute(1,request,now=NOW);db.commit()
    result=workflow.restore(1,request,now=NOW);db.commit();db.expire_all()
    assert db.get(SpendAccount,'sa-1').reserved_usd==Decimal('0.25')
    assert db.get(SpendAccount,'sa-1').spent_usd==Decimal('0.10')
    assert db.get(SpendAttempt,'at-1').status=='cancelled_uncertain'
    assert db.get(VerificationRecord,'v-1').status=='cancelled'
    assert db.get(VerificationRecord,'v-1').dispatch_pending is False
    assert db.get(SpendAttempt,'at-3').status=='started'
    assert result['restore_controls']['uncertain_reservations_released'] is False
    assert db.scalar(select(UserModulePreferences.version).where(UserModulePreferences.user_id==1))>7


def test_foreign_spend_account_is_held_before_deletion(spend):
    db,workflow,request=spend
    db.get(SpendAttempt,'at-1').account_id='sa-3';db.commit()
    with pytest.raises(BoundaryDenied):workflow.execute(1,request,now=NOW)
    db.rollback();assert db.get(SpendAccount,'sa-1').spent_usd==Decimal('0.10')


def test_restored_queued_attempt_stays_cancelled_without_refund(spend):
    db,workflow,request=spend
    db.get(SpendAttempt,'at-1').status='queued';db.commit()
    workflow.execute(1,request,now=NOW);db.commit()
    workflow.restore(1,request,now=NOW);db.commit();db.expire_all()
    assert db.get(SpendAttempt,'at-1').status=='cancelled'
    assert db.get(SpendAccount,'sa-1').reserved_usd==Decimal('0.25')
    assert db.get(SpendAccount,'platform-sentinel') is not None


def test_spend_restore_audit_failure_is_atomic(spend):
    from sqlalchemy import event
    from app.domains.auth.models import ActivityLog
    db,workflow,request=spend
    workflow.execute(1,request,now=NOW);db.commit()
    def fail(session,ctx,instances):
        if any(isinstance(row,ActivityLog) and row.action=='privacy_fixture_restored' for row in session.new):raise RuntimeError('fixture audit failure')
    event.listen(db,'before_flush',fail)
    try:
        with pytest.raises(RuntimeError):workflow.restore(1,request,now=NOW)
        db.commit()
    finally:event.remove(db,'before_flush',fail)
    db.expire_all();assert db.get(SpendAccount,'sa-1') is None
    assert db.get(SpendAccount,'sa-3').reserved_usd==Decimal('0.25')
