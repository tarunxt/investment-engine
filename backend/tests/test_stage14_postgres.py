"""Prepared PostgreSQL gates, permitted only in acknowledged disposable Docker."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime,timezone,timedelta
from pathlib import Path
import os,subprocess,sys
import pytest
from sqlalchemy import select,inspect
from sqlalchemy.orm import Session
from test_stage09_connections_postgres import database
from app.domains.auth.models import User
from app.domains.modules.models import UserModulePreferences,UserModule
from app.domains.connections.models import IntegrationConnection
from app.domains.modules.lifecycle import WorkIdentity
from app.domains.order_intents.service import Orders,MODULE,TOPIC
from app.domains.order_intents.models import OrderIntent,OrderLeg
from app.domains.order_intents.contracts import OrderDenied,digest
from app.domains.order_intents.fake import FakeBroker
from app.infrastructure.database.outbox.models import OutboxMessage
from test_stage14_order_intents import order,confirm
pytestmark=pytest.mark.skipif(os.getenv('CREDX_STAGE09_DATABASE_ACK')!='disposable-docker-only',reason='Mandatory disposable Docker PostgreSQL; exact CI rejects skips')

def policy(db,i):
    m=db.scalar(select(UserModule).where(UserModule.user_id==i.owner_id,UserModule.module_id==i.module_id).execution_options(populate_existing=True))
    if not m or not m.enabled or m.version!=i.version:raise OrderDenied('SYNTHETIC_POLICY_DENIED')
def risk(db,i,p,c,now):return {'allowed':True,'account':c.provider_account_id,'payload':digest(p),'version':1}
def setup(database):
    engine,_,owner,_,_=database;now=datetime.now(timezone.utc)
    with Session(engine) as db:
        db.add(UserModulePreferences(user_id=owner,version=1));db.flush();db.add(UserModule(user_id=owner,module_id=MODULE,version=1,enabled=True,config={}))
        db.add(IntegrationConnection(id='fake',owner_id=owner,provider='zerodha',provider_account_id='FAKE',app_ownership_mode='user_owned',version=1,is_current=True,status='active',token_expires_at=now+timedelta(hours=1)));db.commit()
    return engine,owner

def create(engine,owner,key='same'):
    with Session(engine,expire_on_commit=False) as db:
        row=Orders(db,policy=policy,risk=risk).create(WorkIdentity(owner,MODULE,1),key,'fake',order());db.commit();return row.id

def prepared(engine,owner):
    id=create(engine,owner)
    with Session(engine) as db:
        s=Orders(db,policy=policy,risk=risk);s.validate(owner,id);v=s.review(owner,id);db.commit();return id,v

def approved(engine,owner):
    id,v=prepared(engine,owner)
    with Session(engine) as db:
        confirm(Orders(db,policy=policy,risk=risk),owner,id,v['review_digest'],action='confirm_exact_order_or_basket');db.commit();return db.scalar(select(OutboxMessage.id).where(OutboxMessage.topic==TOPIC))

def test_same_owner_parallel_create_has_one_durable_intent(database):
    engine,owner=setup(database)
    with ThreadPoolExecutor(2) as pool:ids=list(pool.map(lambda _:create(engine,owner),range(2)))
    assert ids[0]==ids[1]
    with Session(engine) as db:assert len(db.scalars(select(OrderIntent)).all())==1 and len(db.scalars(select(OrderLeg)).all())==1

def test_simultaneous_confirmation_clicks_make_one_outbox(database):
    engine,owner=setup(database);id,v=prepared(engine,owner)
    def click(_):
        with Session(engine) as db:
            try:confirm(Orders(db,policy=policy,risk=risk),owner,id,v['review_digest'],action='confirm_exact_order_or_basket');db.commit();return True
            except OrderDenied:db.rollback();return False
    with ThreadPoolExecutor(2) as pool:assert sum(pool.map(click,range(2)))==1
    with Session(engine) as db:assert len(db.scalars(select(OutboxMessage).where(OutboxMessage.topic==TOPIC)).all())==1

def test_duplicate_actual_pg_delivery_one_fake_call(database):
    engine,owner=setup(database);event=approved(engine,owner);broker=FakeBroker()
    def run(_):
        with Session(engine) as db:
            try:Orders(db,policy=policy,risk=risk).dispatch(event,broker);return True
            except OrderDenied:db.rollback();return False
    with ThreadPoolExecutor(2) as pool:assert sum(pool.map(run,range(2)))==1
    assert len(broker.calls)==1

def test_disable_commit_between_claim_and_effect_prevents_io(database):
    engine,owner=setup(database);event=approved(engine,owner);broker=FakeBroker()
    def disable():
        with Session(engine) as db:
            db.scalar(select(UserModulePreferences).where(UserModulePreferences.user_id==owner).with_for_update());m=db.scalar(select(UserModule).where(UserModule.user_id==owner));m.enabled=False;m.version+=1;db.commit()
    with Session(engine) as db:
        with pytest.raises(OrderDenied):Orders(db,policy=policy,risk=risk).dispatch(event,broker,before_effect=disable)
    assert not broker.calls

def test_connection_switch_between_claim_and_effect_prevents_io(database):
    engine,owner=setup(database);event=approved(engine,owner);broker=FakeBroker()
    def switch():
        with Session(engine) as db:
            db.scalar(select(User).where(User.id==owner).with_for_update());c=db.scalar(select(IntegrationConnection).where(IntegrationConnection.id=='fake').with_for_update());c.provider_account_id='OTHER';c.version+=1;db.commit()
    with Session(engine) as db:
        with pytest.raises(OrderDenied):Orders(db,policy=policy,risk=risk).dispatch(event,broker,before_effect=switch)
    assert not broker.calls

def test_revoke_commit_before_claim_blocks_dispatch(database):
    engine,owner=setup(database);event=approved(engine,owner)
    with Session(engine) as db:
        row=db.scalar(select(OrderIntent));Orders(db,policy=policy,risk=risk).revoke(owner,row.id);db.commit()
    with Session(engine) as db:
        b=FakeBroker()
        with pytest.raises(OrderDenied):Orders(db,policy=policy,risk=risk).dispatch(event,b)
        assert not b.calls

def test_actual_additive_order_migration_roundtrip(database):
    engine,_,_,schema,_=database
    from app.infrastructure.database.base import Base
    from app.domains.auth.models import UserProfile
    Base.metadata.drop_all(engine)
    env={**os.environ,'PGOPTIONS':f'-csearch_path={schema}'};backend=Path(__file__).resolve().parents[1]
    def migrate(direction,target):subprocess.run([sys.executable,'-m','alembic',direction,target],cwd=backend,env=env,check=True,capture_output=True,text=True,timeout=90)
    migrate('upgrade','ai_limits_001')
    sys.path.insert(0,str(backend/'scripts'));from verify_api_attempt_migration import baseline_snapshot
    before=baseline_snapshot(engine,exclude_tables=frozenset())
    migrate('upgrade','order_intents_001')
    assert baseline_snapshot(engine,exclude_tables=frozenset({'confirmed_order_intents','confirmed_order_legs'}))==before
    for model in (OrderIntent,OrderLeg):assert set(model.__table__.columns.keys())=={c['name'] for c in inspect(engine).get_columns(model.__tablename__)}
    migrate('downgrade','ai_limits_001');assert baseline_snapshot(engine,exclude_tables=frozenset())==before
    migrate('upgrade','order_intents_001')

def test_actual_pg_state_constraint_decompilation_equivalence_and_negative_drift(database):
    """Verify exact PG16 expressions, not a general cast-stripping waiver."""
    import importlib.util
    from sqlalchemy import Table,MetaData,CheckConstraint,text
    from sqlalchemy.schema import DropConstraint,AddConstraint
    helper_path=Path(__file__).resolve().parents[2]/'deploy/uat2/native/schema_service.py'
    spec=importlib.util.spec_from_file_location('stage14_exact_state_helper',helper_path);helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
    engine,_,_,_,_=database
    with engine.begin() as connection:
        table=Table('confirmed_order_intents',MetaData(),autoload_with=connection)
        constraint=next(c for c in table.constraints if c.name=='ck_confirmed_order_state')
        original=helper.canonical_checks('confirmed_order_intents',inspect(connection).get_check_constraints('confirmed_order_intents'))
        for expression in helper.ORDER_STATE_CHECK_FORMS:
            connection.execute(DropConstraint(constraint))
            constraint=CheckConstraint(expression,name='ck_confirmed_order_state');table.append_constraint(constraint);connection.execute(AddConstraint(constraint))
            actual=inspect(connection).get_check_constraints('confirmed_order_intents')
            assert helper.canonical_checks('confirmed_order_intents',actual)==original
            for state,expected in [('draft',True),('filled',True),('invalidated',True),('unapproved-new-state',False),('FILLED',False)]:
                value=connection.scalar(text('SELECT ('+expression+') FROM (VALUES (CAST(:value AS varchar(24)))) AS candidate(state)'),{'value':state})
                assert value is expected
        changed=helper.ORDER_STATE_CHECK_FORMS[0].replace("'draft'","'unauthorized'::text, 'draft'")
        connection.execute(DropConstraint(constraint));constraint=CheckConstraint(changed,name='ck_confirmed_order_state');table.append_constraint(constraint);connection.execute(AddConstraint(constraint))
        assert helper.canonical_checks('confirmed_order_intents',inspect(connection).get_check_constraints('confirmed_order_intents'))!=original
