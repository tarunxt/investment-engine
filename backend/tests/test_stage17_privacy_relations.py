"""Physical and application ownership dependencies share retention/effect rules."""
from dataclasses import replace
from datetime import timedelta
from uuid import uuid4
import pytest
from sqlalchemy import select,func,MetaData,Table,Column,Integer,String,ForeignKey
from app.domains.ai_limits.contracts import BoundaryDenied
from app.domains.public_service.privacy import PrivacyRequests
from app.domains.public_service.privacy_relations import relationships
from app.domains.public_service.sql_account import AccountTableRule,schema_digest
from app.domains.public_service.sql_privacy_plan import SQLPrivacyPlanner,RetentionSchedule
from app.domains.public_service.sql_privacy_workflow import DisposableSQLPrivacyWorkflow,DisposablePrivacyScope,TOPIC
from app.infrastructure.database.outbox.models import OutboxMessage
from app.domains.recommendation_audit.models import VerificationRecord
from test_stage17_canonical_owner_mapping import mapping,residency_setup,NOW,MODELS

def service(mapping,residency_setup,*,holds=frozenset(),kind='delete'):
    db,reader=mapping
    retention=RetentionSchedule('synthetic:relationship-retention',NOW+timedelta(days=1),legal_holds=holds,
        retain_until=tuple((name,None) for name in reader.metadata.tables))
    row=PrivacyRequests(db).request(1,'synthetic-edge-'+uuid4().hex,kind,confirmed=True,now=NOW);db.commit()
    w=DisposableSQLPrivacyWorkflow(db,reader,residency_setup[1].keyring,retention=retention,
        scope=DisposablePrivacyScope('synthetic:relationship-database'))
    return db,w,row.id

@pytest.mark.parametrize('child,parent',[
    ('recommendation_verifications','recommendation_decisions'),
    ('recommendation_spend_attempts','recommendation_spend_accounts'),
    ('recommendation_spend_attempts','recommendation_verifications'),
])
def test_application_hold_propagates_to_referenced_parent(mapping,residency_setup,child,parent):
    db,w,key=service(mapping,residency_setup,holds=frozenset({child}))
    result=w.execute(1,key,now=NOW);db.commit()
    assert result['retained'][parent]['disposition']=='HELD_DEPENDENT_RELATIONSHIP'
    table=w.reader.metadata.tables[parent]
    assert db.scalar(select(func.count()).select_from(table).where(table.c.user_id==1))==1

def test_optional_previous_decision_is_retained_with_current_decision(mapping,residency_setup):
    db,reader=mapping;decisions=reader.metadata.tables['recommendation_decisions'];verification=reader.metadata.tables['recommendation_verifications']
    db.execute(decisions.insert().values(id='d-prev-1',user_id=1,run_id=8,market='fixture',symbol='FAKE',exchange='FAKE',
        decision_at=NOW-timedelta(hours=1),captured_at=NOW,provenance='fixture',content_hash='c'*64,payload={}))
    db.execute(verification.update().where(verification.c.user_id==1).values(previous_id='d-prev-1'));db.commit()
    holds=frozenset(set(reader.metadata.tables)-{'recommendation_decisions'})
    db,w,key=service(mapping,residency_setup,holds=holds);result=w.execute(1,key,now=NOW);db.commit()
    assert result['removed_counts']=={}
    assert set(db.scalars(select(decisions.c.id).where(decisions.c.user_id==1)))=={'d-1','d-prev-1'}

def test_application_children_delete_before_all_supported_parents(mapping,residency_setup):
    db,w,key=service(mapping,residency_setup);planner=SQLPrivacyPlanner(db,w.reader,w.keyring,w.retention)
    planner.draft(1,key,now=NOW);plan=planner.inspect(1,key,now=NOW)
    db.commit()
    order=plan['child_first_order']
    assert order.index('recommendation_spend_attempts')<order.index('recommendation_spend_accounts')
    assert order.index('recommendation_spend_attempts')<order.index('recommendation_verifications')<order.index('recommendation_decisions')
    result=w.execute(1,key,now=NOW);db.commit()
    assert result['relationship_hash']==plan['relationship_hash']
    for model in MODELS:assert result['removed_counts'][model.__tablename__]==1

@pytest.mark.parametrize('child,column,value',[
    ('recommendation_verifications','current_id','d-1'),
    ('recommendation_verifications','previous_id','d-1'),
    ('recommendation_spend_attempts','account_id','sa-1'),
    ('recommendation_spend_attempts','verification_id','v-1'),
])
def test_foreign_remaining_application_dependent_blocks_all_effects(mapping,residency_setup,child,column,value):
    db,reader=mapping;table=reader.metadata.tables[child]
    db.execute(table.update().where(table.c.user_id==3).values({column:value}));db.commit()
    db,w,key=service(mapping,residency_setup)
    before={model.__tablename__:db.scalar(select(func.count()).select_from(model.__table__)) for model in MODELS}
    with pytest.raises(BoundaryDenied,match='RETAINED_DEPENDENT'):w.execute(1,key,now=NOW)
    db.commit()
    for model in MODELS:assert db.scalar(select(func.count()).select_from(model.__table__))==before[model.__tablename__]
    assert PrivacyRequests(db).owned(1,key).payload['state']=='retention_review_required'
    assert db.scalar(select(func.count()).select_from(OutboxMessage).where(OutboxMessage.topic==TOPIC))==0

@pytest.mark.parametrize('kind',['delete','export'])
def test_unknown_reference_schema_rejected_before_effect_or_export(mapping,residency_setup,kind):
    db,reader=mapping;metadata=reader.metadata
    unknown=Table('fixture_unreviewed_reference',metadata,Column('id',Integer,primary_key=True),
        Column('user_id',ForeignKey('users.id'),nullable=False),Column('current_id',String,nullable=False))
    unknown.create(db.get_bind());db.execute(unknown.insert().values(id=1,user_id=1,current_id='d-1'));db.commit()
    reader.inventory=replace(reader.inventory,schema_digest=schema_digest(metadata),
        rules=reader.inventory.rules+(AccountTableRule(unknown.name,tuple(unknown.c.keys())),))
    db,w,key=service(mapping,residency_setup,kind=kind)
    with pytest.raises(BoundaryDenied,match='RELATIONSHIP_UNSUPPORTED'):w.execute(1,key,now=NOW)
    db.commit()
    assert db.scalar(select(func.count()).select_from(OutboxMessage).where(OutboxMessage.topic==TOPIC))==0
    assert db.scalar(select(func.count()).select_from(unknown))==1

def test_supported_reference_requires_its_canonical_parent_schema():
    metadata=MetaData();VerificationRecord.__table__.to_metadata(metadata)
    with pytest.raises(BoundaryDenied,match='RELATIONSHIP_SCHEMA_REQUIRED'):relationships(metadata)
