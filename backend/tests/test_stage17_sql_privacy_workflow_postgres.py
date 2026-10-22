"""Prepared real PostgreSQL SQL-erasure gates; not local acceptance evidence."""
import os,json
from datetime import datetime,timezone,timedelta
from concurrent.futures import ThreadPoolExecutor
import threading,time
import pytest
from sqlalchemy import select,func,event,text,inspect
from sqlalchemy.orm import Session
from app.infrastructure.database.base import Base
from app.infrastructure.database.outbox.models import OutboxMessage
from app.domains.auth.models import User,UserProfile,APIKey,ActivityLog
from app.domains.ai_limits.contracts import BoundaryDenied
from app.domains.public_service.privacy import PrivacyRequests
from app.domains.public_service.sql_account import SQLAccountReader,AccountInventory,AccountTableRule,schema_digest,_credential_column,_physical_uniques_match,_physical_primary_timing
from app.domains.public_service.sql_privacy_plan import RetentionSchedule
from app.domains.public_service.sql_privacy_workflow import DisposablePrivacyScope,DisposableSQLPrivacyWorkflow,TOPIC
from test_stage09_connections_postgres import database
pytestmark=pytest.mark.skipif(os.getenv('CREDX_STAGE09_DATABASE_ACK')!='disposable-docker-only',reason='Acknowledged disposable real PostgreSQL required; CI must reject skips')

def schema_only_unique_diagnostics(connection, metadata):
    """Read schema names/definitions only, never row values, URLs or keys."""
    inspector=inspect(connection);differences=[]
    for name,table in sorted(metadata.tables.items()):
        expected=sorted(tuple(c.name for c in constraint.columns) for constraint in table.constraints
            if constraint.__class__.__name__=='UniqueConstraint')
        observed=inspector.get_unique_constraints(name)
        actual=sorted(tuple(item['column_names']) for item in observed)
        if not _physical_uniques_match(table,actual,inspector.get_pk_constraint(name)['constrained_columns'],connection.dialect,
            physical_timing=_physical_primary_timing(connection,name)):
            differences.append({'table':name,'expected_unique_columns':expected,
                'actual_unique_columns':actual,
                'expected_primary_columns':tuple(c.name for c in table.primary_key),
                'actual_primary_columns':inspector.get_pk_constraint(name)['constrained_columns'],
                'actual_primary_timing':_physical_primary_timing(connection,name),
                'unique_constraint_names':[item['name'] for item in observed],
                'indexes':[{'name':item['name'],'columns':item['column_names'],
                    'unique':item.get('unique'), 'duplicates_constraint':item.get('duplicates_constraint')}
                    for item in inspector.get_indexes(name)]})
    return differences


@pytest.fixture
def pg_workflow(database):
    original,_,owner,_,ring=database;engine=original.execution_options(isolation_level='SERIALIZABLE');now=datetime.now(timezone.utc)
    with engine.connect() as connection:
        differences=schema_only_unique_diagnostics(connection,Base.metadata)
    assert not differences,'Disposable PostgreSQL uniqueness diagnostic: '+json.dumps(differences,sort_keys=True)
    with Session(engine) as db:
        foreign=User(email='foreign-privacy@example.invalid',username='foreign_privacy',password_hash='synthetic-unusable',is_active=True,is_verified=True,profile=UserProfile())
        db.add(foreign);db.flush();other=foreign.id
        for id in (owner,other):db.add(APIKey(user_id=id,key=f'synthetic-never-export-{id}',key_hash='synthetic-hash',name='fixture'))
        db.commit();request=PrivacyRequests(db).request(owner,'synthetic-sql-delete','delete',confirmed=True,now=now);db.commit();key=request.id
    metadata=Base.metadata;rules=[]
    for name,table in metadata.tables.items():
        if name not in {'users','user_profiles','api_keys'}:
            rules.append(AccountTableRule(name,(),excluded_reason='fixture-selected categories; unrelated/operational rows retained'))
        else:rules.append(AccountTableRule(name,tuple(c for c in table.c.keys() if not _credential_column(c)),
            tuple(c for c in table.c.keys() if _credential_column(c)),owner_column='id' if name=='users' else 'user_id'))
    inventory=AccountInventory('synthetic-canonical-pg-selected-category-review',schema_digest(metadata),tuple(rules))
    retention=RetentionSchedule('synthetic-retention-not-legal-approval',now+timedelta(days=1),retain_until=tuple((name,None) for name in metadata.tables))
    def service(db):return DisposableSQLPrivacyWorkflow(db,SQLAccountReader(db,metadata,inventory),ring,retention=retention,
        scope=DisposablePrivacyScope('synthetic:actual-pg-fixture'))
    return engine,owner,other,key,now,service

def test_actual_pg_export_erasure_replay_preserves_foreign_owner_and_anchors(pg_workflow):
    engine,owner,other,key,now,service=pg_workflow
    with Session(engine) as db:
        export=PrivacyRequests(db).request(owner,'synthetic-sql-export','export',confirmed=True,now=now);db.commit()
        result=service(db).execute(owner,export.id,now=now);db.commit()
        assert len(result['datasets']['api_keys'])==1 and 'key' not in result['datasets']['api_keys'][0]
        erased=service(db).execute(owner,key,now=now);db.commit()
        assert erased['removed_counts']=={'api_keys':1,'user_profiles':1}
    with Session(engine) as db:
        assert service(db).execute(owner,key,now=now)==erased
        assert db.scalar(select(func.count()).select_from(APIKey).where(APIKey.user_id==other))==1
        assert db.scalar(select(func.count()).select_from(UserProfile).where(UserProfile.user_id==other))==1
        assert db.get(User,owner).is_active and erased['identity_erased'] is False
        assert db.scalar(select(func.count()).select_from(OutboxMessage).where(OutboxMessage.topic==TOPIC))==2

def test_actual_pg_audit_failure_rolls_back_data_receipt_and_request(pg_workflow):
    engine,owner,other,key,now,service=pg_workflow
    with Session(engine) as db:
        def fail(session,ctx,instances):
            if any(isinstance(row,ActivityLog) and row.action=='privacy_sql_fixture_complete' for row in session.new):raise RuntimeError('synthetic audit failure')
        event.listen(db,'before_flush',fail)
        try:
            with pytest.raises(RuntimeError):service(db).execute(owner,key,now=now)
            db.commit()
        finally:event.remove(db,'before_flush',fail)
        assert db.scalar(select(func.count()).select_from(APIKey).where(APIKey.user_id==owner))==1
        assert PrivacyRequests(db).owned(owner,key).payload['state']=='retention_review_required'
        assert db.scalar(select(func.count()).select_from(OutboxMessage).where(OutboxMessage.topic==TOPIC))==0

@pytest.mark.parametrize('isolation',['READ COMMITTED','SERIALIZABLE'])
def test_actual_pg_cancel_waits_on_execution_owner_fence_without_partial_erasure(pg_workflow,isolation):
    engine,owner,other,key,now,service=pg_workflow;first_done=threading.Event();second_waiting=threading.Event();pids=[]
    roles=threading.local()
    def before(conn,cursor,statement,parameters,context,executemany):
        if getattr(roles,'value',None)=='cancel' and 'users' in statement and 'FOR UPDATE' in statement:
            pids.append(conn.connection.driver_connection.get_backend_pid());second_waiting.set()
    event.listen(engine,'before_cursor_execute',before)
    def execute():
        with Session(engine) as db:
            result=service(db).execute(owner,key,now=now);first_done.set();assert second_waiting.wait(2)
            deadline=time.monotonic()+2;blocked=False
            while time.monotonic()<deadline:
                with Session(engine) as observer:
                    blocked=observer.scalar(text('SELECT wait_event_type FROM pg_stat_activity WHERE pid=:pid'),{'pid':pids[0]})=='Lock'
                if blocked:break
                time.sleep(.02)
            assert blocked,'Actual PostgreSQL owner lock overlap not observed';db.commit();return result
    def cancel():
        roles.value='cancel'
        from sqlalchemy.exc import DBAPIError
        retries=0
        # Nested OptionEngine listeners can overwrite a requested isolation.
        # Set it on the actual connection and prove effective driver isolation.
        with engine.connect() as connection:
            connection=connection.execution_options(isolation_level=isolation)
            assert connection.get_isolation_level()==isolation
            with Session(bind=connection) as db:
                try:
                    row=PrivacyRequests(db).cancel(owner,key);db.commit()
                    return row.payload['state'],retries
                except DBAPIError as exc:
                    assert isolation=='SERIALIZABLE'
                    assert getattr(exc.orig,'pgcode',None)=='40001'
                    db.rollback();assert not db.in_transaction();retries+=1
        # Retry only cancellation, once, after full rollback in a NEW transaction.
        # Never execute the SQL disposal/effect again or reuse an aborted snapshot.
        with engine.connect() as connection:
            connection=connection.execution_options(isolation_level='READ COMMITTED')
            assert connection.get_isolation_level()=='READ COMMITTED'
            with Session(bind=connection) as db:
                row=PrivacyRequests(db).cancel(owner,key);db.commit()
                return row.payload['state'],retries
    try:
        with ThreadPoolExecutor(2) as pool:
            first=pool.submit(execute);assert first_done.wait(10)
            second=pool.submit(cancel);assert first.result(timeout=8)['removed_counts']=={'api_keys':1,'user_profiles':1}
            state,retries=second.result(timeout=8)
            assert state=='synthetic_sql_complete'
            assert retries==(1 if isolation=='SERIALIZABLE' else 0)
        with Session(engine) as db:
            assert db.scalar(select(func.count()).select_from(APIKey).where(APIKey.user_id==owner))==0
            assert db.scalar(select(func.count()).select_from(APIKey).where(APIKey.user_id==other))==1
            assert db.get(UserProfile,owner) is None and db.get(UserProfile,other) is not None
            assert db.scalar(select(func.count()).select_from(OutboxMessage).where(OutboxMessage.topic==TOPIC))==1
            assert db.scalar(select(func.count()).select_from(ActivityLog).where(ActivityLog.user_id==owner,ActivityLog.action=='privacy_sql_fixture_complete'))==1
    finally:event.remove(engine,'before_cursor_execute',before)


def test_actual_pg_foreign_dependent_is_not_cascade_erased(pg_workflow):
    from dataclasses import replace
    from sqlalchemy import MetaData,Table,Column,Integer,ForeignKey
    engine,owner,other,key,now,service=pg_workflow
    with Session(engine) as db:
        original=service(db);metadata=MetaData()
        for table in original.reader.metadata.tables.values():table.to_metadata(metadata)
        links=Table('fixture_privacy_foreign_links',metadata,Column('id',Integer,primary_key=True),
            Column('user_id',ForeignKey('users.id'),nullable=False),
            Column('profile_id',ForeignKey('user_profiles.user_id',ondelete='CASCADE'),nullable=False))
        links.create(engine);db.execute(links.insert().values(id=1,user_id=other,profile_id=owner));db.commit()
        inventory=replace(original.reader.inventory,schema_digest=schema_digest(metadata),
            rules=original.reader.inventory.rules+(AccountTableRule(links.name,tuple(links.c.keys())),))
        retention=replace(original.retention,retain_until=original.retention.retain_until+((links.name,None),))
        guarded=DisposableSQLPrivacyWorkflow(db,SQLAccountReader(db,metadata,inventory),original.keyring,
            retention=retention,scope=original.scope)
        with pytest.raises(BoundaryDenied,match='RETAINED_DEPENDENT'):guarded.execute(owner,key,now=now)
        db.commit()
        assert db.scalar(select(func.count()).select_from(links))==1
        assert db.scalar(select(func.count()).select_from(UserProfile).where(UserProfile.user_id==owner))==1
        assert db.scalar(select(func.count()).select_from(APIKey).where(APIKey.user_id==owner))==1

@pytest.fixture
def pg_application_workflow(pg_workflow):
    from dataclasses import replace
    from app.domains.recommendation_audit.models import EvidenceRecord,DecisionRecord,VerificationRecord,SpendAccount,SpendAttempt
    from app.domains.public_service.sql_account import APPLICATION_OWNER_SEMANTICS
    engine,owner,other,key,now,service=pg_workflow
    models=(EvidenceRecord,DecisionRecord,VerificationRecord,SpendAccount,SpendAttempt)
    with Session(engine) as db:
        for id in (owner,other):
            db.execute(EvidenceRecord.__table__.insert().values(id=f'e-{id}',user_id=id,kind='fixture',source_key=f's-{id}',content_hash='a'*64,payload={}))
            db.execute(DecisionRecord.__table__.insert().values(id=f'd-{id}',user_id=id,run_id=7,market='fixture',symbol='FAKE',exchange='FAKE',decision_at=now,provenance='fixture',content_hash='b'*64,payload={}))
            db.execute(VerificationRecord.__table__.insert().values(id=f'v-{id}',user_id=id,current_id=f'd-{id}',request_hash='c'*64,idempotency_key='fixture',request={}))
            db.execute(SpendAccount.__table__.insert().values(id=f'sa-{id}',user_id=id,day=now.date().isoformat()))
            db.execute(SpendAttempt.__table__.insert().values(id=f'at-{id}',user_id=id,account_id=f'sa-{id}',attempt_key='fixture',adapter='fake',tariff_version='fixture',upper_bound_usd=0))
        db.commit()
    def bound(db):
        w=service(db);names={model.__tablename__ for model in models}
        rules=tuple(AccountTableRule(rule.table,tuple(c.name for c in w.reader.metadata.tables[rule.table].columns if not _credential_column(c.name)),
            tuple(c.name for c in w.reader.metadata.tables[rule.table].columns if _credential_column(c.name)),
            owner_semantics=APPLICATION_OWNER_SEMANTICS) if rule.table in names else rule for rule in w.reader.inventory.rules)
        inventory=replace(w.reader.inventory,rules=rules)
        return DisposableSQLPrivacyWorkflow(db,SQLAccountReader(db,w.reader.metadata,inventory),w.keyring,
            retention=w.retention,scope=w.scope)
    return engine,owner,other,key,now,bound

def test_actual_pg_held_application_verification_retains_its_decision(pg_application_workflow):
    from dataclasses import replace
    from app.domains.recommendation_audit.models import DecisionRecord
    engine,owner,other,key,now,service=pg_application_workflow
    with Session(engine) as db:
        w=service(db);w.retention=replace(w.retention,legal_holds=frozenset(set(w.reader.metadata.tables)-{'recommendation_decisions'}))
        result=w.execute(owner,key,now=now);db.commit()
        assert result['removed_counts']=={}
        assert result['retained']['recommendation_decisions']['disposition']=='HELD_DEPENDENT_RELATIONSHIP'
        assert db.get(DecisionRecord,f'd-{owner}') is not None

@pytest.mark.parametrize('child,column,prefix',[
    ('recommendation_verifications','current_id','d'),
    ('recommendation_verifications','previous_id','d'),
    ('recommendation_spend_attempts','account_id','sa'),
    ('recommendation_spend_attempts','verification_id','v'),
])
def test_actual_pg_foreign_application_dependent_cannot_be_orphaned(pg_application_workflow,child,column,prefix):
    engine,owner,other,key,now,service=pg_application_workflow
    with Session(engine) as db:
        w=service(db);table=w.reader.metadata.tables[child]
        db.execute(table.update().where(table.c.user_id==other).values({column:f'{prefix}-{owner}'}));db.commit()
        before={name:db.scalar(select(func.count()).select_from(w.reader.metadata.tables[name]))
            for name in ('recommendation_decisions','recommendation_verifications','recommendation_spend_accounts','recommendation_spend_attempts')}
        with pytest.raises(BoundaryDenied,match='RETAINED_DEPENDENT'):w.execute(owner,key,now=now)
        db.commit()
        for name,count in before.items():assert db.scalar(select(func.count()).select_from(w.reader.metadata.tables[name]))==count
        assert PrivacyRequests(db).owned(owner,key).payload['state']=='retention_review_required'
