"""Synthetic accounts and fake orders only. No transport credentials/network."""
from copy import deepcopy
from datetime import datetime,timezone,timedelta
from types import SimpleNamespace
from uuid import uuid4
import pytest
from sqlalchemy import create_engine,select,update
from sqlalchemy.orm import Session
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.dialects.postgresql import JSONB
from app.infrastructure.database.base import Base
import app.models
from app.domains.auth.models import User
from app.domains.modules.models import UserModulePreferences,UserModule
from app.domains.connections.models import IntegrationConnection
from app.infrastructure.database.outbox.models import OutboxMessage
from app.domains.modules.lifecycle import WorkIdentity
from app.domains.order_intents.models import OrderIntent,OrderLeg
from app.domains.order_intents.service import Orders,TOPIC,MODULE
from app.domains.order_intents.contracts import OrderDenied,payload,digest
from app.domains.order_intents.fake import FakeBroker

@compiles(JSONB,'sqlite')
def compile_json(type,compiler,**kwargs):return 'JSON'
NOW=datetime(2026,10,21,8,tzinfo=timezone.utc)

def order(n=1):
    return {'sequencing':'listed','legs':[{'exchange':'NSE','symbol':f'TEST{i}','side':'BUY','quantity':10,'limit_price':'100.00','product':'CNC','order_type':'LIMIT'} for i in range(n)]}

@pytest.fixture
def env(tmp_path):
    engine=create_engine('sqlite:///'+str(tmp_path/'orders.sqlite'),connect_args={'timeout':10})
    Base.metadata.create_all(engine,tables=[m.__table__ for m in [User,UserModulePreferences,UserModule,IntegrationConnection,OrderIntent,OrderLeg,OutboxMessage]])
    db=Session(engine,expire_on_commit=False);ids=[]
    for n in (1,2):
        u=User(email=f'owner{n}@stage14.invalid',username=f'owner{n}',password_hash='unusable-synthetic',is_active=True,is_verified=True);db.add(u);db.flush();ids.append(u.id)
        db.add(UserModulePreferences(user_id=u.id,version=1));db.flush();db.add(UserModule(user_id=u.id,module_id=MODULE,enabled=True,version=1,config={}))
        db.add(IntegrationConnection(id=f'connection{n}',owner_id=u.id,provider='zerodha',app_ownership_mode='user_owned',provider_account_id=f'FAKE{n}',status='active',is_current=True,version=1,token_expires_at=NOW+timedelta(hours=1)))
    db.commit();conditions={'version':1,'allowed':True};clock=[NOW]
    def policy(db,i):
        m=db.scalar(select(UserModule).where(UserModule.user_id==i.owner_id,UserModule.module_id==i.module_id).execution_options(populate_existing=True))
        if not m or not m.enabled or m.version!=i.version:raise OrderDenied('SYNTHETIC_MODULE_DENIED')
    def risk(db,i,p,c,now):return {'allowed':conditions['allowed'],'version':conditions['version'],'owner':i.owner_id,'account':c.provider_account_id,'payload_hash':digest(p),'max_order_quantity':1000000}
    service=Orders(db,policy=policy,risk=risk,clock=lambda:clock[0]);e=SimpleNamespace(db=db,engine=engine,service=service,policy=policy,risk=risk,conditions=conditions,clock=clock,owners=ids)
    yield e
    db.close();engine.dispose()

def confirm(service,owner,id,displayed_digest,**kwargs):
    from app.domains.order_intents.authority import authenticated_confirmation
    with authenticated_confirmation(SimpleNamespace(id=owner,is_active=True,is_verified=True),id,displayed_digest):
        return service.approve(owner,id,displayed_digest,**kwargs)


def prepare(e,*,owner=None,key='test',o=None):
    owner=owner or e.owners[0];connection='connection1' if owner==e.owners[0] else 'connection2'
    r=e.service.create(WorkIdentity(owner,MODULE,1),key,connection,o or order(),now=NOW);e.db.commit();e.service.validate(owner,r.id,now=NOW);e.db.commit();review=e.service.review(owner,r.id,now=NOW);e.db.commit();return r,review

def approve(e,**kw):
    row,review=prepare(e,**kw);confirm(e.service,row.owner_id,row.id,review['review_digest'],action='confirm_exact_order_or_basket',now=NOW);e.db.commit();event=e.db.scalar(select(OutboxMessage).where(OutboxMessage.topic==TOPIC,OutboxMessage.payload['intent_id'].as_string()==row.id));return row,event

def test_full_durable_fake_order_and_duplicate_delivery(env):
    row,event=approve(env);broker=FakeBroker();env.service.dispatch(event.id,broker)
    assert row.state=='acknowledged' and len(broker.calls)==1
    leg=env.service.legs(row)[0];assert leg.broker_order_id.startswith('fake-') and leg.filled_quantity==0 and leg.reconciliation_json['simulation']
    with pytest.raises(OrderDenied):env.service.dispatch(event.id,broker)
    assert len(broker.calls)==1

def test_intent_before_any_call_and_explicit_review_states(env):
    r=env.service.create(WorkIdentity(env.owners[0],MODULE,1),'key','connection1',order(),now=NOW);assert r.state=='draft'
    with pytest.raises(OrderDenied):confirm(env.service,r.owner_id,r.id,'0'*64,action='confirm_exact_order_or_basket',now=NOW)
    env.db.rollback()
    r,v=prepare(env);assert r.state=='awaiting_approval' and len(env.service.legs(r))==1
    assert env.db.scalar(select(OutboxMessage)) is None

@pytest.mark.parametrize('action',['standing_consent','module_enabled','scheduled','worker',''])
def test_no_standing_or_worker_confirmation(env,action):
    r,v=prepare(env)
    with pytest.raises(OrderDenied):confirm(env.service,r.owner_id,r.id,v['review_digest'],action=action,now=NOW)
    assert env.db.scalar(select(OutboxMessage)) is None

@pytest.mark.parametrize('mode',['foreign','forged','replayed','expired'])
def test_approval_attacks(env,mode):
    r,v=prepare(env)
    if mode=='foreign':
        with pytest.raises(OrderDenied):confirm(env.service,env.owners[1],r.id,v['review_digest'],action='confirm_exact_order_or_basket',now=NOW)
        return
    if mode=='forged':
        with pytest.raises(OrderDenied):confirm(env.service,r.owner_id,r.id,'0'*64,action='confirm_exact_order_or_basket',now=NOW)
        return
    confirm(env.service,r.owner_id,r.id,v['review_digest'],action='confirm_exact_order_or_basket',now=NOW);env.db.commit()
    if mode=='replayed':
        with pytest.raises(OrderDenied):confirm(env.service,r.owner_id,r.id,v['review_digest'],action='confirm_exact_order_or_basket',now=NOW)
    else:
        event=env.db.scalar(select(OutboxMessage));env.clock[0]+=timedelta(minutes=6);broker=FakeBroker()
        with pytest.raises(OrderDenied):env.service.dispatch(event.id,broker)
        assert not broker.calls

@pytest.mark.parametrize('field,value',[('quantity',11),('limit_price','100.01'),('side','SELL'),('symbol','OTHER'),('exchange','BSE')])
def test_immutable_order_mutation_cannot_dispatch(env,field,value):
    r,event=approve(env);p=deepcopy(r.payload_json);p['legs'][0][field]=value;r.payload_json=p;env.db.commit();broker=FakeBroker()
    with pytest.raises(OrderDenied):env.service.dispatch(event.id,broker)
    assert broker.calls==[]

@pytest.mark.parametrize('field,value',[('provider_account_id','OTHER'),('version',2),('app_ownership_mode','platform_managed'),('status','revoked'),('is_current',False),('token_expires_at',NOW-timedelta(seconds=1))])
def test_account_mode_or_connection_change_invalidates(env,field,value):
    _,event=approve(env);c=env.db.get(IntegrationConnection,'connection1');setattr(c,field,value);env.db.commit();broker=FakeBroker()
    with pytest.raises(OrderDenied):env.service.dispatch(event.id,broker)
    assert not broker.calls

@pytest.mark.parametrize('point',['before_approval','before_dispatch','after_claim'])
def test_changed_risk_is_rechecked(env,point):
    if point=='before_approval':
        r,v=prepare(env);env.conditions['version']=2
        with pytest.raises(OrderDenied):confirm(env.service,r.owner_id,r.id,v['review_digest'],action='confirm_exact_order_or_basket',now=NOW)
    else:
        r,event=approve(env);broker=FakeBroker()
        if point=='before_dispatch':env.conditions['version']=2
        def change():env.conditions['version']=2
        with pytest.raises(OrderDenied):env.service.dispatch(event.id,broker,before_effect=change if point=='after_claim' else lambda:None)
        assert not broker.calls

@pytest.mark.parametrize('point',['before_approval','before_dispatch','after_claim'])
def test_module_disable_fences_every_boundary(env,point):
    def disable():env.db.execute(update(UserModule).where(UserModule.user_id==env.owners[0]).values(enabled=False,version=2));env.db.commit()
    if point=='before_approval':
        r,v=prepare(env);disable()
        with pytest.raises(OrderDenied):confirm(env.service,r.owner_id,r.id,v['review_digest'],action='confirm_exact_order_or_basket',now=NOW)
    else:
        _,event=approve(env);broker=FakeBroker()
        if point=='before_dispatch':disable()
        with pytest.raises(OrderDenied):env.service.dispatch(event.id,broker,before_effect=disable if point=='after_claim' else lambda:None)
        assert not broker.calls

def test_expiry_after_claim_blocks_call(env):
    _,event=approve(env);b=FakeBroker()
    def expire():env.clock[0]+=timedelta(minutes=6)
    with pytest.raises(OrderDenied):env.service.dispatch(event.id,b,before_effect=expire)
    assert not b.calls

def test_owner_scoped_uniqueness_and_conflicts(env):
    i=WorkIdentity(env.owners[0],MODULE,1);a=env.service.create(i,'same','connection1',order(),now=NOW);env.db.commit()
    assert env.service.create(i,'same','connection1',order(),now=NOW).id==a.id
    changed=order();changed['legs'][0]['quantity']=11
    with pytest.raises(OrderDenied):env.service.create(i,'same','connection1',changed,now=NOW)
    other=env.service.create(WorkIdentity(env.owners[1],MODULE,1),'same','connection2',order(),now=NOW);assert other.id!=a.id

@pytest.mark.parametrize('fault',['position','payload_digest','client_reference','extra_leg','missing_leg'])
def test_leg_tracking_integrity(env,fault):
    r,event=approve(env);leg=env.service.legs(r)[0]
    if fault=='extra_leg':env.db.add(OrderLeg(intent_id=r.id,position=1,payload_digest=leg.payload_digest,client_reference='extra',state='draft',filled_quantity=0))
    elif fault=='missing_leg':env.db.delete(leg)
    else:setattr(leg,fault,3 if fault=='position' else 'forged')
    env.db.commit();b=FakeBroker()
    with pytest.raises(OrderDenied):env.service.dispatch(event.id,b)
    assert not b.calls

def test_exact_basket_and_no_quantity_substitution(env):
    o=order(3);o['sequencing']='sell_then_buy';o['legs'][0]['side']='SELL';r,event=approve(env,o=o);b=FakeBroker(['filled','filled','filled']);env.service.dispatch(event.id,b)
    assert r.state=='filled' and len(b.calls)==3 and [x[1] for x in b.calls]==o['legs']

def test_sell_ack_does_not_authorize_buy_before_reconciliation(env):
    o=order(2);o['sequencing']='sell_then_buy';o['legs'][0]['side']='SELL';r,event=approve(env,o=o);b=FakeBroker();env.service.dispatch(event.id,b)
    assert r.state=='acknowledged' and len(b.calls)==1 and env.service.legs(r)[1].state=='draft'

@pytest.mark.parametrize('outcome',['timeout','partial','rejected'])
def test_uncertain_partial_or_failure_stops_basket_and_no_retry(env,outcome):
    r,event=approve(env,o=order(2));b=FakeBroker([outcome])
    if outcome=='timeout':
        with pytest.raises(TimeoutError):env.service.dispatch(event.id,b)
        assert r.state=='unknown'
    else:env.service.dispatch(event.id,b);assert r.state==outcome
    with pytest.raises(OrderDenied):env.service.dispatch(event.id,b)
    assert len(b.calls)==1

def test_crash_after_durable_claim_is_not_replayed(env):
    r,event=approve(env);r.state='submitting';event.execution_attempts=1;env.db.commit();b=FakeBroker()
    with pytest.raises(OrderDenied):env.service.dispatch(event.id,b)
    assert not b.calls

def test_revoke_and_forged_outbox_fail_closed(env):
    r,event=approve(env);env.service.revoke(r.owner_id,r.id);env.db.commit();b=FakeBroker()
    with pytest.raises(OrderDenied):env.service.dispatch(event.id,b)
    assert not b.calls
    env.db.rollback();event.payload={**event.payload,'owner_id':env.owners[1]};env.db.commit()
    with pytest.raises(OrderDenied):env.service.dispatch(event.id,b)

def test_real_or_subclass_transport_is_rejected_before_claim(env):
    _,event=approve(env)
    class Impostor(FakeBroker):pass
    for b in [object(),Impostor()]:
        with pytest.raises(OrderDenied):env.service.dispatch(event.id,b)
    assert event.execution_attempts==0

@pytest.mark.parametrize('value',[True,0,-1,1.5,'10',1000001])
def test_quantity_strict_no_coercion(value):
    p=order();p['legs'][0]['quantity']=value
    with pytest.raises(OrderDenied):payload(p)

@pytest.mark.parametrize('value',['NaN','Infinity','-1','0','1e1000','100.001',True,100.0])
def test_exact_price_strict(value):
    p=order();p['legs'][0]['limit_price']=value
    with pytest.raises(OrderDenied):payload(p)

def test_worker_service_call_cannot_mint_human_approval(env):
    row,review=prepare(env)
    with pytest.raises(OrderDenied,match='HUMAN_ACTION'):
        env.service.approve(row.owner_id,row.id,review['review_digest'],action='confirm_exact_order_or_basket',now=NOW)
    assert row.state=='awaiting_approval' and env.db.scalar(select(OutboxMessage)) is None


def test_human_confirmation_capability_is_exact_one_use_and_not_inherited(env):
    from app.domains.order_intents.authority import authenticated_confirmation
    row,review=prepare(env)
    with authenticated_confirmation(SimpleNamespace(id=row.owner_id,is_active=True,is_verified=True),row.id,review['review_digest']):
        env.service.approve(row.owner_id,row.id,review['review_digest'],action='confirm_exact_order_or_basket',now=NOW)
        with pytest.raises(OrderDenied,match='HUMAN_ACTION'):env.service.approve(row.owner_id,row.id,review['review_digest'],action='confirm_exact_order_or_basket',now=NOW)
    with pytest.raises(OrderDenied,match='HUMAN_ACTION'):env.service.approve(row.owner_id,row.id,review['review_digest'],action='confirm_exact_order_or_basket',now=NOW)
