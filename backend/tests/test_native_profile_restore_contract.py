"""Actual source-model SQLite fixtures; never a native pg_restore qualification."""
from copy import deepcopy
from dataclasses import replace
from datetime import datetime,timezone
from uuid import uuid5,NAMESPACE_URL
import pytest
from sqlalchemy import create_engine,select,update,inspect,event
from sqlalchemy.orm import Session
import app.infrastructure.database.all_models
from app.domains.auth.models import User,UserProfile,UserRole
from app.domains.ai_limits.contracts import BoundaryDenied,digest
from app.domains.public_service.native_profile_restore_contract import (
    Principal,Tombstone,Ledger,SyntheticIndependentHead,FixtureCheckpoint,FIELDS,
    PROFILE_SCHEMA,STORES,plan_profile_restore,inspect_fixture_recovery,native_activation_status)


def uid(label):return str(uuid5(NAMESPACE_URL,'synthetic-native-profile:'+label))
def serial(row):return {k:v.isoformat() if isinstance(v,datetime) else v for k,v in row.items()}


def capture(db,head):
    # Deliberately reject additional physical stores: no fabricated whole-DB scope.
    if set(inspect(db.get_bind()).get_table_names())!=set(STORES):raise BoundaryDenied('FIXTURE_STORE_COVERAGE_REQUIRED')
    refs={p.owner_id:p.subject_ref for p in head.principals};users=[]
    for row in db.execute(select(User.__table__).order_by(User.id)).mappings():
        identity=serial(dict(row))
        users.append({'owner_id':row['id'],'subject_ref':refs.get(row['id']), 'identity_hash':digest(identity)})
    profiles=[serial(dict(r)) for r in db.execute(select(UserProfile.__table__).order_by(UserProfile.user_id)).mappings()]
    return {'lineage':head.lineage,'schema_hash':PROFILE_SCHEMA,'stores':sorted(STORES),'users':users,'user_profiles':profiles}


@pytest.fixture
def fixture(tmp_path):
    engine=create_engine('sqlite:///'+str(tmp_path/'synthetic-restored.sqlite'))
    User.__table__.create(engine);UserProfile.__table__.create(engine)
    db=Session(engine,expire_on_commit=False)
    for i in (1,2):
        db.add(User(id=i,email=f'fixture-{i}@example.invalid',username=f'fixture-{i}',password_hash='synthetic-unusable',role=UserRole.USER,is_active=True,is_verified=True))
        db.add(UserProfile(user_id=i,avatar_url='synthetic-avatar-'+str(i),bio='synthetic-bio-'+str(i),google_sheets_master_url='synthetic-link-'+str(i)))
    db.commit()
    principals=tuple(Principal(r['id'],uid('subject-'+str(r['id'])),digest(serial(dict(r)))) for r in db.execute(select(User.__table__).order_by(User.id)).mappings())
    ledger=Ledger(uid('lineage'),2,(Tombstone(uid('request'),1,principals[0].subject_ref,FIELDS),),True,frozenset({'user_profiles'}))
    head=SyntheticIndependentHead(ledger.lineage,ledger.sequence,digest(ledger.claims()),principals)
    raw=capture(db,head)
    try:yield db,raw,ledger,head
    finally:db.close();engine.dispose()


def plan(raw,ledger,head):
    return plan_profile_restore(raw,backup_fingerprint=digest(raw),raw_verified_fingerprint=digest(raw),ledger=ledger,head=head)


def apply_fixture(db,p):
    # Side effects exist ONLY in this test file, under its pytest-created database.
    # Keep nonprojected timestamps/settings and all user/credential anchors intact.
    for row in p.projected_fixture()['user_profiles']:
        current=db.execute(select(UserProfile.__table__).where(UserProfile.user_id==row['user_id'])).mappings().one()
        if all(current[k]==row[k] for k in FIELDS):continue
        db.execute(update(UserProfile).where(UserProfile.user_id==row['user_id']).values(
            **{k:row[k] for k in FIELDS},updated_at=UserProfile.updated_at))


def recover(db,raw,ledger,head,marker):
    return inspect_fixture_recovery(raw,capture(db,head),backup_fingerprint=digest(raw),ledger=ledger,head=head,checkpoint=marker)


def test_old_profile_snapshot_suppressed_foreign_and_other_fields_unchanged(fixture):
    db,raw,ledger,head=fixture;p=plan(raw,ledger,head)
    updates=[]
    def observe(connection,cursor,statement,parameters,context,executemany):
        if statement.startswith('UPDATE user_profiles'):updates.append(parameters[-1])
    event.listen(db.get_bind(),'before_cursor_execute',observe)
    try:
        with db.begin_nested():apply_fixture(db,p)
        db.commit()
    finally:event.remove(db.get_bind(),'before_cursor_execute',observe)
    assert updates==[1]
    observed=capture(db,head)
    expected=deepcopy(raw)
    for field in FIELDS:expected['user_profiles'][0][field]=None
    assert observed==expected and raw['user_profiles'][0]['bio']=='synthetic-bio-1'
    result=recover(db,raw,ledger,head,FixtureCheckpoint(p.plan_hash,'committed'))
    assert result['state']=='synthetic_projection_verified'
    assert result['native_activation'] is result['real_deletion_enabled'] is result['complete_account_erasure'] is False
    assert 'synthetic-bio' not in str(result)


@pytest.mark.parametrize('point',['before_apply','inside_transaction','after_commit','after_receipt'])
def test_crash_boundaries_and_verification_only_recovery(fixture,point):
    db,raw,ledger,head=fixture;p=plan(raw,ledger,head)
    independent_journal={'checkpoint':FixtureCheckpoint(p.plan_hash,'raw_verified')}
    if point!='before_apply':
        independent_journal['checkpoint']=FixtureCheckpoint(p.plan_hash,'applying')
        if point=='inside_transaction':
            with pytest.raises(RuntimeError):
                with db.begin_nested():
                    apply_fixture(db,p)
                    raise RuntimeError('synthetic interruption before commit')
            db.commit()
        else:
            with db.begin_nested():apply_fixture(db,p)
            db.commit()
            if point=='after_receipt':independent_journal['checkpoint']=FixtureCheckpoint(p.plan_hash,'committed')
    before=capture(db,head)
    if point=='inside_transaction':
        with pytest.raises(BoundaryDenied,match='AMBIGUOUS'):recover(db,raw,ledger,head,independent_journal['checkpoint'])
        assert before==raw
    else:
        result=recover(db,raw,ledger,head,independent_journal['checkpoint'])
        assert result['state']==('blocked_projection_not_started' if point=='before_apply' else 'synthetic_projection_verified')
        assert result['replayed_effects'] is False
        assert recover(db,raw,ledger,head,independent_journal['checkpoint'])==result
    assert capture(db,head)==before  # Recreating inspection never executes a write.


@pytest.mark.parametrize('case',['missing','old_sequence','old_empty','incomplete','coverage','wrong_lineage','tampered_entries','duplicate_event'])
def test_independent_head_cannot_be_rolled_back_with_snapshot(fixture,case):
    db,raw,ledger,head=fixture
    if case=='missing':ledger=None
    if case=='old_sequence':ledger=replace(ledger,sequence=1)
    if case=='old_empty':ledger=replace(ledger,sequence=1,entries=())
    if case=='incomplete':ledger=replace(ledger,complete=False)
    if case=='coverage':ledger=replace(ledger,coverage=frozenset())
    if case=='wrong_lineage':ledger=replace(ledger,lineage=uid('foreign-lineage'))
    if case=='tampered_entries':ledger=replace(ledger,entries=())
    if case=='duplicate_event':ledger=replace(ledger,entries=ledger.entries+ledger.entries)
    with pytest.raises(BoundaryDenied):plan(raw,ledger,head)
    assert capture(db,head)==raw


@pytest.mark.parametrize('case',['foreign_subject','foreign_owner','reused_id','duplicate_principal','bool_owner'])
def test_cross_owner_or_ambiguous_lineage_fails_before_projection(fixture,case):
    db,raw,ledger,head=fixture
    if case in {'foreign_subject','foreign_owner','bool_owner'}:
        t=ledger.entries[0]
        t=replace(t,**({'subject_ref':head.principals[1].subject_ref} if case=='foreign_subject' else {'owner_id':99 if case=='foreign_owner' else True}))
        ledger=replace(ledger,entries=(t,));head=replace(head,ledger_hash=digest(ledger.claims())) if case!='bool_owner' else head
    if case=='reused_id':raw=deepcopy(raw);raw['users'][0]['identity_hash']=digest('different-account-with-reused-numeric-id')
    if case=='duplicate_principal':head=replace(head,principals=head.principals+(head.principals[0],))
    with pytest.raises(BoundaryDenied):plan(raw,ledger,head)


@pytest.mark.parametrize('store',['outbox','api_keys','confirmed_order_intents','redis','email_sink','opaque_blob'])
def test_uncovered_native_stores_never_silently_skipped(fixture,store):
    db,raw,ledger,head=fixture;raw=deepcopy(raw);raw['stores'].append(store)
    with pytest.raises(BoundaryDenied,match='SCOPE_REQUIRED'):plan(raw,ledger,head)
    assert native_activation_status()['allowed'] is False


@pytest.mark.parametrize('field',['email','password_hash','is_active','module_version'])
def test_tombstone_cannot_mutate_identity_credentials_or_work_authority(fixture,field):
    db,raw,ledger,head=fixture;ledger=replace(ledger,entries=(replace(ledger.entries[0],fields=frozenset({field})),))
    with pytest.raises(BoundaryDenied):plan(raw,ledger,head)


@pytest.mark.parametrize('case',['backup_hash','raw_verified_hash','schema','partial_post','foreign_change','checkpoint'])
def test_raw_integrity_and_indeterminate_post_state_remain_blocked(fixture,case):
    db,raw,ledger,head=fixture;p=plan(raw,ledger,head)
    if case in {'backup_hash','raw_verified_hash','schema'}:
        changed=deepcopy(raw)
        if case=='schema':changed['schema_hash']=digest('unsupported-schema')
        with pytest.raises(BoundaryDenied):plan_profile_restore(changed,backup_fingerprint=digest('wrong') if case=='backup_hash' else digest(raw),raw_verified_fingerprint=digest('wrong') if case=='raw_verified_hash' else digest(raw),ledger=ledger,head=head)
    else:
        marker=FixtureCheckpoint(digest('wrong-plan') if case=='checkpoint' else p.plan_hash,'applying')
        if case=='partial_post':db.execute(update(UserProfile).where(UserProfile.user_id==1).values(avatar_url=None,updated_at=UserProfile.updated_at));db.commit()
        if case=='foreign_change':db.execute(update(UserProfile).where(UserProfile.user_id==2).values(bio='foreign-change',updated_at=UserProfile.updated_at));db.commit()
        with pytest.raises(BoundaryDenied):recover(db,raw,ledger,head,marker)


def test_authoritative_empty_fixture_is_explicit_and_still_not_native_permission(fixture):
    db,raw,ledger,head=fixture;empty=replace(ledger,entries=());head=replace(head,ledger_hash=digest(empty.claims()))
    p=plan(raw,empty,head);assert p.raw_fingerprint==p.post_fingerprint
    assert p.receipt()['native_activation'] is False
    with pytest.raises(BoundaryDenied,match='AUTHORITY_ADAPTER'):plan(raw,empty,None)


@pytest.mark.parametrize('field,value',[('is_active',False),('role',UserRole.ADMIN),('password_hash','different-synthetic-hash')])
def test_user_security_anchor_changes_block_verification(fixture,field,value):
    db,raw,ledger,head=fixture;p=plan(raw,ledger,head)
    db.execute(update(User).where(User.id==2).values(**{field:value}));db.commit()
    with pytest.raises(BoundaryDenied,match='IDENTITY_LINEAGE'):recover(db,raw,ledger,head,FixtureCheckpoint(p.plan_hash,'applying'))


def test_bool_identity_alias_is_not_a_principal(fixture):
    db,raw,ledger,head=fixture;raw=deepcopy(raw);raw['users'][0]['owner_id']=True
    with pytest.raises(BoundaryDenied):plan(raw,ledger,head)
