"""Owner-selected targets with source/duty holds; no real deletion or schedules."""
from dataclasses import replace
from datetime import timedelta
from uuid import uuid4
import pytest
from sqlalchemy import MetaData, select, event
from test_stage17_reviewed_residency import setup as residency_setup, NOW
from app.domains.ai_limits.contracts import BoundaryDenied, digest
from app.domains.auth.models import User, UserProfile
from app.infrastructure.database.outbox.models import OutboxMessage
from app.domains.public_service.sql_account import SQLAccountReader, AccountInventory, AccountTableRule, schema_digest, _credential_column
from app.domains.public_service.sql_privacy_workflow import DisposablePrivacyScope
from app.domains.public_service.privacy import PrivacyRequests
from app.domains.public_service.retention_policy import (assess, PolicyReview, StoreReview, SOURCE_CATEGORIES,
    source_mapping_hash, synthetic_schedule)
from app.domains.public_service.privacy_policy_fixture import CategoryPolicyFixture, REFERENCE, TOPIC, backup_expiry_plan

NAMES={'users','user_profiles','jobs','indmoney_us_portfolio_snapshots','unknown_store'}
INVENTORY=digest('synthetic-inventory')
REQUEST=str(uuid4())


def review(names=NAMES, inventory=INVENTORY, request=REQUEST, age=30):
    return PolicyReview(inventory,source_mapping_hash(names),digest('synthetic-duty-review-not-legal-approval'),
        NOW+timedelta(days=2),tuple(StoreReview(n,SOURCE_CATEGORIES.get(n,'unmapped'),True,True) for n in sorted(names)),
        owner_id=1,request_id=request,eligible_at=NOW-timedelta(days=age),eligibility_reference_hash=digest('synthetic-purpose-end-evidence'))


def proposal(*, names=NAMES, inventory=INVENTORY, request=REQUEST, policy=None, age=30):
    return assess(owner_id=1,request_id=request,names=set(names),inventory_hash=inventory,
        eligible_at=NOW-timedelta(days=age),now=NOW,review=policy if policy is not None else review(names,inventory,request=request,age=age))


def test_complete_category_plan_holds_unknown_and_special_anchors():
    p=proposal()
    assert p['stores']['user_profiles']['reason']=='SYNTHETIC_CANDIDATE_ONLY'
    assert p['stores']['jobs']['reason']=='SYNTHETIC_CANDIDATE_ONLY'
    assert p['stores']['users']['reason']=='RESTRICTED_ANCHOR_OR_SPECIAL_ADAPTER'
    assert p['stores']['unknown_store']['reason']=='UNMAPPED_STORE'
    assert p['real_deletion_enabled'] is p['legal_approval'] is p['target_is_law'] is False
    schedule=synthetic_schedule(p,expires_at=NOW+timedelta(days=1),review=review(),now=NOW)
    assert {'users','unknown_store'} <= schedule.legal_holds
    assert 'user_profiles' not in schedule.legal_holds


@pytest.mark.parametrize('mode',['missing','ownership','duties','hold','future','conflict','earlier'])
def test_duties_hold_precedence_and_earlier_deadlines(mode):
    r=review(age=1 if mode=='earlier' else 30);age=30
    if mode=='missing':
        p=assess(owner_id=1,request_id=REQUEST,names=NAMES,inventory_hash=INVENTORY,eligible_at=NOW,now=NOW)
        assert p['stores']['user_profiles']['reason']=='APPLICABLE_DUTIES_AND_OWNERSHIP_UNVERIFIED';return
    changes={'ownership':{'ownership_verified':False},'duties':{'applicable_duties_verified':False},
        'hold':{'legal_hold':True},'future':{'retain_until':NOW+timedelta(days=10)},
        'conflict':{'retain_until':NOW+timedelta(days=10),'erase_by':NOW},
        'earlier':{'erase_by':NOW}}[mode]
    r=replace(r,stores=tuple(replace(s,**changes) if s.store=='user_profiles' else s for s in r.stores))
    p=proposal(policy=r,age=1 if mode=='earlier' else age)
    assert p['stores']['user_profiles']['reason']=={'ownership':'APPLICABLE_DUTIES_AND_OWNERSHIP_UNVERIFIED',
        'duties':'APPLICABLE_DUTIES_AND_OWNERSHIP_UNVERIFIED','hold':'LEGAL_HOLD','future':'RETAIN_UNTIL',
        'conflict':'CONFLICTING_REVIEWED_DUTIES','earlier':'SYNTHETIC_CANDIDATE_ONLY'}[mode]


@pytest.mark.parametrize('mode',['expired','incomplete','duplicate','mapping','inventory','naive','foreign_category'])
def test_incomplete_expired_or_forged_source_reviews_rejected(mode):
    r=review()
    if mode=='expired':r=replace(r,expires_at=NOW)
    if mode=='incomplete':r=replace(r,stores=r.stores[:-1])
    if mode=='duplicate':r=replace(r,stores=r.stores+(r.stores[0],))
    if mode=='mapping':r=replace(r,source_mapping_hash=digest('different'))
    if mode=='inventory':r=replace(r,inventory_hash=digest('different'))
    if mode=='naive':r=replace(r,expires_at=NOW.replace(tzinfo=None))
    if mode=='foreign_category':r=replace(r,stores=tuple(replace(s,category='profile') if s.store=='users' else s for s in r.stores))
    with pytest.raises(BoundaryDenied):proposal(policy=r)


@pytest.fixture
def fixture(residency_setup):
    db,producer=residency_setup;UserProfile.__table__.create(db.get_bind())
    for owner in (1,2):db.add(UserProfile(user_id=owner,avatar_url='synthetic-avatar',bio='synthetic-private-text',google_sheets_master_url='synthetic-private-link'))
    db.commit();metadata=MetaData();metadata.reflect(db.get_bind());rules=[]
    for n,t in metadata.tables.items():
        if n in {'outbox','activity_logs'}:rules.append(AccountTableRule(n,(),excluded_reason='synthetic audit anchor'))
        else:rules.append(AccountTableRule(n,tuple(c.name for c in t.c if not _credential_column(c.name)),
            tuple(c.name for c in t.c if _credential_column(c.name)),owner_column='id' if n=='users' else 'user_id'))
    reader=SQLAccountReader(db,metadata,AccountInventory('synthetic-category-review',schema_digest(metadata),tuple(rules)))
    request=PrivacyRequests(db).request(1,'synthetic-category-delete','delete',confirmed=True,now=NOW);db.commit()
    def service():return CategoryPolicyFixture(db,producer.keyring,reader=reader,scope=DisposablePrivacyScope(REFERENCE),policy_review=review(set(metadata.tables),reader.inventory.schema_digest,request=str(request.id)))
    p=proposal(names=set(metadata.tables),inventory=reader.inventory.schema_digest,request=str(request.id))
    return db,reader,request,p,service


def test_minimal_encrypted_audit_owned_unlink_and_restart_suppression(fixture):
    db,reader,request,p,service=fixture
    result=service().unlink_profile(1,request.id,p,now=NOW);db.commit()
    assert result['identity_anchor_retained'] and not result['complete_erasure']
    db.expire_all();assert db.get(UserProfile,1).bio is None
    assert db.get(UserProfile,2).bio=='synthetic-private-text'
    assert db.get(User,1).is_active  # no identity/credential/security mutation
    row=db.scalar(select(OutboxMessage).where(OutboxMessage.topic==TOPIC))
    assert 'synthetic-private' not in str(row.payload) and 'bio' not in str(row.payload)
    assert service().unlink_profile(1,request.id,p,now=NOW)==result
    restored=service().restore_profile(1,request.id,{'user_id':1,'bio':'old','avatar_url':'old','google_sheets_master_url':'old'})
    assert restored=={'user_id':1,'bio':None,'avatar_url':None,'google_sheets_master_url':None}
    with pytest.raises(BoundaryDenied):service().restore_profile(2,request.id,{'user_id':1})


@pytest.mark.parametrize('mode',['no_ledger','tamper','cross_owner','credential','ledger_owner'])
def test_restore_fails_closed_without_authentic_owned_suppression(fixture,mode):
    db,reader,request,p,service=fixture
    if mode!='no_ledger':service().unlink_profile(1,request.id,p,now=NOW);db.commit()
    row=db.scalar(select(OutboxMessage).where(OutboxMessage.topic==TOPIC))
    candidate={'user_id':1,'bio':'old','avatar_url':'old','google_sheets_master_url':'old'}
    if mode=='tamper':row.payload={**row.payload,'ciphertext':'corrupt'};db.flush()
    if mode=='ledger_owner':row.payload={**row.payload,'owner_id':2};db.flush()
    if mode=='cross_owner':candidate['user_id']=2
    if mode=='credential':candidate['api_key']='must-never-restore'
    with pytest.raises(BoundaryDenied):service().restore_profile(1,request.id,candidate)


@pytest.mark.parametrize('mode',['owner','request','inventory','hold','expired','scope'])
def test_profile_effect_requires_matching_current_request_policy_and_scope(fixture,mode):
    db,reader,request,p,service=fixture
    if mode=='owner':p['owner_id']=2
    if mode=='request':p['request_id']=str(uuid4())
    if mode=='inventory':p['inventory_hash']=digest('wrong')
    if mode=='hold':p['stores']['user_profiles']['reason']='LEGAL_HOLD'
    if mode=='expired':p['review_expires_at']=NOW.isoformat()
    p['policy_hash']=digest({k:v for k,v in p.items() if k!='policy_hash'})
    adapter=service()
    if mode=='scope':adapter.scope=DisposablePrivacyScope('synthetic:other-policy-scope')
    with pytest.raises(BoundaryDenied):adapter.unlink_profile(1,request.id,p,now=NOW)
    assert db.get(UserProfile,1).bio=='synthetic-private-text'


def test_audit_failure_rolls_back_unlink_even_if_outer_transaction_commits(fixture):
    db,reader,request,p,service=fixture
    def fail(session,*args):
        if any(isinstance(r,OutboxMessage) and r.topic==TOPIC for r in session.new):raise RuntimeError('synthetic audit failure')
    event.listen(db,'before_flush',fail)
    try:
        with pytest.raises(RuntimeError):service().unlink_profile(1,request.id,p,now=NOW)
        db.commit()
    finally:event.remove(db,'before_flush',fail)
    db.expire_all();assert db.get(UserProfile,1).bio=='synthetic-private-text'
    assert db.scalar(select(OutboxMessage).where(OutboxMessage.topic==TOPIC)) is None


@pytest.mark.parametrize('mode',['unreviewed','incomplete','held','pending','due'])
def test_rolling_backup_target_is_conditional_and_never_purges(mode):
    args=dict(created_at=NOW-timedelta(days=31),now=NOW,inventory_hash=digest('fixture-copy-inventory'),
              copies=(digest('fixture-copy'),),applicable_duties_verified=True,copies_complete=True,legal_hold=False)
    if mode=='unreviewed':args['applicable_duties_verified']=False
    if mode=='incomplete':args['copies_complete']=False
    if mode=='held':args['legal_hold']=True
    if mode=='pending':args['created_at']=NOW
    p=backup_expiry_plan(**args)
    assert p['reason']=={'unreviewed':'INVENTORY_AND_APPLICABLE_DUTIES_UNVERIFIED','incomplete':'INVENTORY_AND_APPLICABLE_DUTIES_UNVERIFIED',
        'held':'LEGAL_HOLD','pending':'TARGET_PENDING','due':'SYNTHETIC_EXPIRY_CANDIDATE_ONLY'}[mode]
    assert p['restore_suppression_required'] and not any(p[k] for k in ['purge_executable','schedule_changed','keys_changed','legal_approval','complete_erasure'])


def test_sql_schedule_cannot_outlive_source_review():
    r=replace(review(),expires_at=NOW+timedelta(hours=1))
    p=proposal(policy=r)
    schedule=synthetic_schedule(p,expires_at=NOW+timedelta(days=5),review=r,now=NOW)
    assert schedule.expires_at==r.expires_at
    with pytest.raises(BoundaryDenied):schedule.fingerprint(NAMES,NOW+timedelta(hours=2))


@pytest.mark.parametrize('missing_ledger',[False,True])
def test_actual_recovery_consumer_suppresses_old_backup_or_rolls_back(fixture,missing_ledger):
    from app.domains.public_service.recoverable_privacy import RecoverableFixturePrivacy
    from app.domains.public_service.privacy_policy_fixture import SuppressedProfileFixtureRecovery
    db,reader,policy_request,p,service=fixture
    retention=synthetic_schedule(p,expires_at=NOW+timedelta(days=1),review=service().policy_review,now=NOW)
    scope=DisposablePrivacyScope('synthetic:category-backup-restore')
    request=PrivacyRequests(db).request(1,'synthetic-old-backup','delete',confirmed=True,now=NOW);db.commit()
    base=RecoverableFixturePrivacy(db,reader,service().keyring,retention=retention,scope=scope)
    base.execute(1,request.id,now=NOW);db.commit()  # encrypted old profile preimage
    # Model a current account and independent retained suppression ledger outside
    # the old snapshot. All rows are synthetic; no user database is accessed.
    db.add(UserProfile(user_id=1,avatar_url='current',bio='current',google_sheets_master_url='current'));db.commit()
    service().unlink_profile(1,policy_request.id,p,now=NOW);db.commit()
    db.delete(db.get(UserProfile,1));db.commit()
    if missing_ledger:
        db.delete(db.scalar(select(OutboxMessage).where(OutboxMessage.topic==TOPIC)));db.commit()
    consumer=SuppressedProfileFixtureRecovery(db,reader,service().keyring,retention=retention,scope=scope,policy_request_id=policy_request.id)
    if missing_ledger:
        with pytest.raises(BoundaryDenied):consumer.restore(1,request.id,now=NOW)
        db.commit();assert db.get(UserProfile,1) is None
    else:
        result=consumer.restore(1,request.id,now=NOW);db.commit();db.expire_all()
        assert db.get(UserProfile,1).bio is None and db.get(UserProfile,2).bio=='synthetic-private-text'
        assert result['restore_controls']['profile_suppression_applied']


def test_recomputed_hash_cannot_strip_legal_hold_from_typed_review(fixture):
    db,reader,request,p,service=fixture
    adapter=service()
    adapter.policy_review=replace(adapter.policy_review,stores=tuple(replace(s,legal_hold=True) if s.store=='user_profiles' else s for s in adapter.policy_review.stores))
    # A plain digest is integrity bookkeeping, not authorization. Revalidation
    # must still observe the retained typed review.
    with pytest.raises(BoundaryDenied):adapter.unlink_profile(1,request.id,p,now=NOW)
    assert db.get(UserProfile,1).bio=='synthetic-private-text'


def test_eligibility_clock_cannot_be_rebased_under_same_typed_review(fixture):
    db,reader,request,p,service=fixture
    adapter=service()
    adapter.policy_review=replace(adapter.policy_review,eligible_at=NOW)
    # Supplied proposal still claims purpose ended 30 days ago. Same immutable
    # review must reject that claim instead of accepting an earlier target.
    with pytest.raises(BoundaryDenied):adapter.unlink_profile(1,request.id,p,now=NOW)
    assert db.get(UserProfile,1).bio=='synthetic-private-text'


def test_sql_bridge_cannot_strip_reviewed_legal_hold_with_new_hash():
    r=review()
    r=replace(r,stores=tuple(replace(s,legal_hold=True) if s.store=='user_profiles' else s for s in r.stores))
    p=proposal(policy=r)
    p['stores']['user_profiles']['reason']='SYNTHETIC_CANDIDATE_ONLY'
    p['policy_hash']=digest({k:v for k,v in p.items() if k!='policy_hash'})
    with pytest.raises(BoundaryDenied):synthetic_schedule(p,expires_at=NOW+timedelta(days=1),review=r,now=NOW)
