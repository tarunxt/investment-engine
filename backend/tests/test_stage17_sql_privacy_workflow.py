"""Actual SQL effects on disposable fixtures only, never real account deletion."""
from dataclasses import replace
from datetime import timedelta
from uuid import uuid5,NAMESPACE_URL
import pytest
from sqlalchemy import select,func,event
from app.domains.auth.models import User,ActivityLog
from app.infrastructure.database.outbox.models import OutboxMessage
from app.domains.ai_limits.contracts import BoundaryDenied
from app.domains.public_service.privacy import PrivacyRequests
from app.domains.public_service.sql_account import SQLAccountReader
from app.domains.public_service.sql_privacy_plan import SQLPrivacyPlanner,RetentionSchedule
from app.domains.public_service.sql_privacy_workflow import DisposableSQLPrivacyWorkflow,DisposablePrivacyScope,TOPIC
from test_stage17_sql_privacy_plan import setup as plan_setup,residency_setup,NOW

@pytest.fixture
def setup(plan_setup):
    db,planner,key=plan_setup
    service=DisposableSQLPrivacyWorkflow(db,planner.reader,planner.keyring,retention=planner.retention,
        scope=DisposablePrivacyScope('synthetic:disposable-sql-review'))
    return db,service,key

def counts(db,w):
    return {name:db.scalar(select(func.count()).select_from(w.reader.metadata.tables[name]))
        for name in ('fixture_holdings','fixture_portfolios','users')}

def test_real_sql_child_first_delete_retains_other_owner_anchors_and_replays_once(setup):
    db,w,key=setup;before=counts(db,w);result=w.execute(1,key,now=NOW);db.commit()
    assert result['removed_counts']=={'fixture_holdings':1,'fixture_portfolios':1}
    assert counts(db,w)=={**before,'fixture_holdings':1,'fixture_portfolios':1}
    for name in ('fixture_holdings','fixture_portfolios'):
        row=db.execute(select(w.reader.metadata.tables[name])).mappings().one()
        assert row['id']==2
    assert result['identity_erased'] is result['backup_erased'] is result['complete_account_erasure'] is False
    assert result['status']=='partial_retained'
    assert result['synthetic'] is True and result['legal_approval'] is False
    assert w.execute(1,key,now=NOW)==result
    assert w.result(1,key,now=NOW)==result
    assert db.scalar(select(func.count()).select_from(ActivityLog).where(ActivityLog.action=='privacy_sql_fixture_complete'))==1
    assert db.scalar(select(func.count()).select_from(OutboxMessage).where(OutboxMessage.topic==TOPIC))==1

def test_encrypted_sql_export_is_owned_and_complete_for_declared_fixture(setup):
    db,w,_=setup;row=PrivacyRequests(db).request(1,'actual-sql-fixture-export','export',confirmed=True,now=NOW);db.commit()
    result=w.execute(1,row.id,now=NOW);db.commit()
    assert result['datasets']['fixture_holdings']==[{'id':1,'portfolio_id':1,'label':'private-holding-1'}]
    assert set(result['datasets'])|set(result['excluded_tables'])==set(w.reader.metadata.tables)
    receipt=db.scalar(select(OutboxMessage).where(OutboxMessage.topic==TOPIC))
    assert 'private-holding-1' not in str(receipt.payload)
    assert w.result(1,row.id,now=NOW)==result
    with pytest.raises(BoundaryDenied):w.result(2,row.id,now=NOW)
    with pytest.raises(BoundaryDenied):w.result(True,row.id,now=NOW)

def test_held_child_protects_parent_no_cascade_or_claim_of_identity_erasure(setup):
    db,w,key=setup;before=counts(db,w)
    w.retention=replace(w.retention,legal_holds=frozenset({'fixture_holdings'}))
    result=w.execute(1,key,now=NOW);db.commit()
    assert result['removed_counts']=={} and counts(db,w)==before
    assert result['retained']['fixture_holdings']['disposition']=='LEGAL_HOLD'
    assert result['retained']['fixture_portfolios']['disposition']=='HELD_DEPENDENT_RELATIONSHIP'

@pytest.mark.parametrize('mode',['cancel','expiry','unverified','unbound','production','retention'])
def test_denied_request_or_scope_never_deletes_even_if_caller_commits(setup,monkeypatch,mode):
    db,w,key=setup;before=counts(db,w);when=NOW
    if mode=='cancel':PrivacyRequests(db).cancel(1,key);db.commit()
    elif mode=='expiry':when=NOW+timedelta(days=8)
    elif mode=='unverified':db.get(User,1).is_verified=False;db.commit()
    elif mode=='unbound':w.scope=None
    elif mode=='production':monkeypatch.setenv('ENVIRONMENT','production')
    else:w.retention=RetentionSchedule()
    with pytest.raises(BoundaryDenied):w.execute(1,key,now=when)
    db.commit();assert counts(db,w)==before
    assert db.scalar(select(func.count()).select_from(OutboxMessage).where(OutboxMessage.topic==TOPIC))==0

def test_audit_failure_rolls_back_sql_request_plan_and_effect_despite_outer_commit(setup):
    db,w,key=setup;before=counts(db,w)
    def fail(session,ctx,instances):
        if any(isinstance(row,ActivityLog) and row.action=='privacy_sql_fixture_complete' for row in session.new):
            raise RuntimeError('synthetic audit failure')
    event.listen(db,'before_flush',fail)
    try:
        with pytest.raises(RuntimeError):w.execute(1,key,now=NOW)
        db.commit()
    finally:event.remove(db,'before_flush',fail)
    assert counts(db,w)==before
    assert PrivacyRequests(db).owned(1,key).payload['state']=='retention_review_required'
    assert db.scalar(select(func.count()).select_from(OutboxMessage).where(OutboxMessage.topic==TOPIC))==0

def test_existing_plan_change_denies_without_effect(setup):
    db,w,key=setup;planner=SQLPrivacyPlanner(db,w.reader,w.keyring,w.retention);planner.draft(1,key,now=NOW);db.commit()
    table=w.reader.metadata.tables['fixture_holdings']
    db.execute(table.update().where(table.c.id==1).values(label='changed owned data'));db.commit();before=counts(db,w)
    with pytest.raises(BoundaryDenied,match='CHANGED'):w.execute(1,key,now=NOW)
    db.commit();assert counts(db,w)==before

@pytest.mark.parametrize('mode',['ciphertext','receipt_id','unverified'])
def test_completed_receipt_cannot_be_tampered_or_read_after_verification_revoked(setup,mode):
    db,w,key=setup;w.execute(1,key,now=NOW);db.commit()
    if mode=='ciphertext':
        row=db.scalar(select(OutboxMessage).where(OutboxMessage.topic==TOPIC));row.payload={**row.payload,'ciphertext':'forged'}
    elif mode=='receipt_id':
        row=PrivacyRequests(db).owned(1,key);row.payload={**row.payload,'result':{'receipt_id':'foreign'}}
    else:db.get(User,1).is_verified=False
    db.commit()
    with pytest.raises(BoundaryDenied):w.result(1,key,now=NOW)

def test_scope_is_bound_to_disposable_database_identity_and_rejects_other_locations(setup,tmp_path):
    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session
    db,w,_=setup;original=w.scope.validate(db)
    other=create_engine('sqlite:///'+str(tmp_path/'other-disposable.sqlite'))
    try:
        with Session(other) as foreign:assert w.scope.validate(foreign)!=original
    finally:other.dispose()
    memory=create_engine('sqlite:///:memory:')
    try:
        with Session(memory) as unsupported:
            with pytest.raises(BoundaryDenied):w.scope.validate(unsupported)
    finally:memory.dispose()

def add_foreign_dependent(db,w,other=2):
    from sqlalchemy import Table,Column,Integer,ForeignKey
    from app.domains.public_service.sql_account import AccountTableRule,schema_digest
    metadata=w.reader.metadata
    links=Table('fixture_cross_owner_links',metadata,Column('id',Integer,primary_key=True),
        Column('user_id',ForeignKey('users.id'),nullable=False),
        Column('portfolio_id',ForeignKey('fixture_portfolios.id',ondelete='CASCADE'),nullable=False))
    links.create(db.get_bind());db.execute(links.insert().values(id=1,user_id=other,portfolio_id=1));db.commit()
    w.reader.inventory=replace(w.reader.inventory,schema_digest=schema_digest(metadata),
        rules=w.reader.inventory.rules+(AccountTableRule(links.name,tuple(links.c.keys())),))
    w.retention=replace(w.retention,retain_until=w.retention.retain_until+((links.name,None),))
    return links

def test_foreign_dependent_cannot_be_cascade_erased_and_all_prior_deletes_rollback(setup):
    db,w,key=setup;links=add_foreign_dependent(db,w);before=counts(db,w)
    with pytest.raises(BoundaryDenied,match='RETAINED_DEPENDENT'):w.execute(1,key,now=NOW)
    db.commit()
    assert counts(db,w)==before and db.scalar(select(func.count()).select_from(links))==1
    assert PrivacyRequests(db).owned(1,key).payload['state']=='retention_review_required'

def test_sqlite_writer_fence_does_not_mutate_retained_user_snapshot(setup):
    db,w,key=setup;person=db.get(User,1);before=person.updated_at
    planner=SQLPrivacyPlanner(db,w.reader,w.keyring,w.retention);planner.draft(1,key,now=NOW);db.commit()
    w.execute(1,key,now=NOW);db.commit();db.refresh(person)
    assert person.updated_at==before
    assert w.result(1,key,now=NOW)['owner_id']==1
    db.commit();db.refresh(person);assert person.updated_at==before


def test_nested_engine_option_isolation_requires_effective_connection_override():
    from sqlalchemy import create_engine
    root=create_engine('sqlite://')
    try:
        nested=root.execution_options(isolation_level='SERIALIZABLE').execution_options(isolation_level='READ UNCOMMITTED')
        with nested.connect() as connection:
            # Requested option is not proof of effective driver state.
            assert connection.get_execution_options()['isolation_level']=='READ UNCOMMITTED'
            effective=connection.execution_options(isolation_level='READ UNCOMMITTED')
            assert effective.get_isolation_level()=='READ UNCOMMITTED'
    finally:root.dispose()
