"""Private fake venue / application databases; no listener, Redis or network."""
from copy import deepcopy
from datetime import timedelta
from dataclasses import replace
from types import SimpleNamespace
import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified
from test_stage14_order_intents import env, approve, order, NOW
from app.domains.order_intents.contracts import OrderDenied, digest
from app.domains.order_intents.execution import ExecutionWorker, venue_binding
from app.domains.order_intents.execution_fake import VenueBase, FakeVenueOrder, ExecutionBrokerFake, MarketDataFake
from app.domains.order_intents.execution_models import ExecutionFence, ExecutionRun, ExecutionAttempt
from app.domains.order_intents.execution_risk import ExecutionLimits
from app.domains.order_intents.service import Orders
from app.domains.modules.models import UserModule
from app.domains.connections.models import IntegrationConnection


def market(row, now=NOW):
    return dict(owner_id=row.owner_id, account_id=row.account_id, connection_id=row.connection_id,
                connection_version=row.connection_version, app_mode=row.app_mode,
                source='synthetic_authoritative', as_of=now, funds='100000.00', exposure='0.00',
                instruments={leg['exchange']+':'+leg['symbol']: dict(tradable=True, market_open=True,
                              product='CNC', quote='100.00', tick='0.05', lot=1,
                              lower='90.00', upper='110.00', holdings=100) for leg in row.payload_json['legs']})


@pytest.fixture
def setup(env, tmp_path):
    for model in (ExecutionFence, ExecutionRun, ExecutionAttempt):
        model.__table__.create(env.engine)
    venue = create_engine('sqlite:///' + str(tmp_path/'venue.sqlite'))
    VenueBase.metadata.create_all(venue)
    def build(outcomes=(), **kwargs):
        row, event = approve(env, **kwargs)
        broker = ExecutionBrokerFake(venue, venue_binding(row), outcomes)
        source = MarketDataFake(market(row))
        return SimpleNamespace(row=row, event=event, broker=broker, source=source,
                               worker=ExecutionWorker(env.service, broker, source), env=env, venue=venue)
    yield build
    venue.dispose()


def test_durable_complete_and_duplicate_no_submit(setup):
    e = setup()
    assert e.worker.dispatch(e.event.id).state == 'filled'
    with pytest.raises(OrderDenied): e.worker.dispatch(e.event.id)
    e.env.db.rollback()
    assert len(e.broker.calls) == 1
    assert e.worker.reconcile(e.row.owner_id, e.row.id).state == 'filled'


@pytest.mark.parametrize('fault', ['before_acceptance', 'after_acceptance', 'rate_limit'])
def test_unknown_restart_never_resubmits(setup, fault):
    e = setup([fault])
    with pytest.raises(TimeoutError): e.worker.dispatch(e.event.id)
    assert e.row.state == 'unknown'
    event_id, owner, intent = e.event.id, e.row.owner_id, e.row.id
    e.env.db.close()
    db = Session(e.env.engine, expire_on_commit=False)
    service = Orders(db, policy=e.env.policy, risk=e.env.risk, clock=lambda:NOW)
    broker = ExecutionBrokerFake(e.venue, e.broker.binding)
    worker = ExecutionWorker(service, broker, e.source)
    result = worker.reconcile(owner, intent)
    assert result.state == ('filled' if fault == 'after_acceptance' else 'unknown')
    with pytest.raises(OrderDenied): worker.dispatch(event_id)
    db.rollback()
    worker.resume(owner, intent)
    assert not broker.calls and len(e.broker.calls) == 1
    db.close()


def test_crash_after_claim_before_fake_call_is_unresolved(setup):
    e = setup()
    def crash(): raise SystemExit('synthetic process loss')
    with pytest.raises(SystemExit): e.worker.dispatch(e.event.id, before_effect=crash)
    assert not e.broker.calls
    assert e.worker.reconcile(e.row.owner_id, e.row.id).state == 'unknown'
    e.worker.resume(e.row.owner_id, e.row.id)
    assert not e.broker.calls


@pytest.mark.parametrize('scope', ['owner', 'connection', 'platform'])
def test_emergency_stop_prevents_effect_but_allows_reconcile(setup, scope):
    e = setup(['after_acceptance'])
    with pytest.raises(TimeoutError): e.worker.dispatch(e.event.id)
    args = {} if scope=='platform' else {'owner_id': e.row.owner_id}
    if scope=='connection': args['connection_id']=e.row.connection_id
    e.worker.set_stop(scope, True, **args)
    assert e.worker.reconcile(e.row.owner_id, e.row.id).state == 'filled'
    assert len(e.broker.calls)==1
    with pytest.raises(OrderDenied): e.worker.dispatch(e.event.id)


@pytest.mark.parametrize('point', ['before_dispatch', 'after_claim'])
@pytest.mark.parametrize('fault', ['disabled', 'token', 'account', 'mode', 'version', 'stop', 'risk'])
def test_fresh_boundary_revocations_no_effect(setup, point, fault):
    e=setup()
    def mutate():
        conn=e.env.db.get(IntegrationConnection,e.row.connection_id)
        if fault=='disabled':e.env.db.scalar(select(UserModule).where(UserModule.user_id==e.row.owner_id)).enabled=False
        elif fault=='token':conn.token_expires_at=NOW-timedelta(seconds=1)
        elif fault=='account':conn.provider_account_id='OTHER'
        elif fault=='mode':conn.app_ownership_mode='platform_managed'
        elif fault=='version':conn.version+=1
        elif fault=='stop':e.worker.set_stop('owner',True,owner_id=e.row.owner_id)
        elif fault=='risk':e.env.conditions['allowed']=False
        e.env.db.commit()
    if point=='before_dispatch':mutate()
    with pytest.raises(OrderDenied):e.worker.dispatch(e.event.id,before_effect=mutate if point=='after_claim' else lambda:None)
    e.env.db.rollback()
    assert not e.broker.calls


@pytest.mark.parametrize('mutation', ['stale','future','fallback','owner','account','version','mode','funds','exposure','lot','tick','circuit','protected','holdings','closed','product','nan','boolean_quantity'])
def test_fresh_risk_matrix(setup, mutation):
    o=order();o['legs'][0]['side']='SELL' if mutation=='holdings' else 'BUY'
    e=setup(o=o);s=e.source.snapshot;item=next(iter(s['instruments'].values()))
    if mutation=='stale':s['as_of']=NOW-timedelta(seconds=6)
    elif mutation=='future':s['as_of']=NOW+timedelta(seconds=1)
    elif mutation=='fallback':s['source']='user_fallback'
    elif mutation=='owner':s['owner_id']+=1
    elif mutation=='account':s['account_id']='OTHER'
    elif mutation=='version':s['connection_version']+=1
    elif mutation=='mode':s['app_mode']='platform_managed'
    elif mutation=='funds':s['funds']='0.00'
    elif mutation=='exposure':s['exposure']='1000000.00'
    elif mutation=='lot':item['lot']=3
    elif mutation=='tick':item['tick']='0.03'
    elif mutation=='circuit':item['upper']='99.00'
    elif mutation=='protected':item['quote']='90.00'
    elif mutation=='holdings':item['holdings']=0
    elif mutation=='closed':item['market_open']=False
    elif mutation=='product':item['product']='MIS'
    elif mutation=='nan':s['funds']='NaN'
    elif mutation=='boolean_quantity':item['holdings']=True
    with pytest.raises(OrderDenied):e.worker.dispatch(e.event.id)
    e.env.db.rollback();assert not e.broker.calls


def test_sell_reconciliation_requires_actual_funds_before_buy(setup):
    o=order(2);o['sequencing']='sell_then_buy';o['legs'][0]['side']='SELL'
    e=setup(['partial','filled'],o=o)
    assert e.worker.dispatch(e.event.id).state=='partial' and len(e.broker.calls)==1
    with Session(e.venue) as db:
        venue=db.get(FakeVenueOrder,e.broker.calls[0]);value=deepcopy(venue.receipt)
        value.update(state='filled',filled_quantity=10);venue.receipt=value
        trades=deepcopy(venue.trades);trades[0]['quantity']=10;venue.trades=trades;db.commit()
    assert e.worker.reconcile(e.row.owner_id,e.row.id).state=='submitting'
    assert len(e.broker.calls)==1 # reconciliation never resumes implicitly
    e.source.snapshot['funds']='0.00'
    with pytest.raises(OrderDenied,match='FUNDS'):e.worker.resume(e.row.owner_id,e.row.id)
    e.env.db.rollback();assert len(e.broker.calls)==1
    e.source.snapshot['funds']='10000.00'
    e.env.clock[0]=NOW+timedelta(seconds=1)
    e.source.snapshot['as_of']=e.env.clock[0]
    assert e.worker.resume(e.row.owner_id,e.row.id).state=='filled'
    assert len(e.broker.calls)==2


@pytest.mark.parametrize('fault', ['ambiguous','timeout','missing'])
def test_bounded_reconciliation_never_resubmits(setup, fault):
    e=setup(['before_acceptance'])
    with pytest.raises(TimeoutError):e.worker.dispatch(e.event.id)
    e.broker.read_fault=None if fault=='missing' else fault
    for i in range(5):
        e.env.clock[0]=NOW+timedelta(seconds=i*31)
        assert e.worker.reconcile(e.row.owner_id,e.row.id).state=='unknown'
    with pytest.raises(OrderDenied,match='EXHAUSTED'):e.worker.reconcile(e.row.owner_id,e.row.id)
    e.env.db.rollback();assert len(e.broker.calls)==1
    assert e.env.db.scalar(select(ExecutionAttempt)).polls==5


def test_reconcile_does_not_require_live_module_or_current_token(setup):
    e=setup(['after_acceptance'])
    with pytest.raises(TimeoutError):e.worker.dispatch(e.event.id)
    e.env.db.get(IntegrationConnection,e.row.connection_id).status='disconnected'
    e.env.db.scalar(select(UserModule).where(UserModule.user_id==e.row.owner_id)).enabled=False
    e.env.clock[0]=NOW+timedelta(minutes=6);e.env.db.commit()
    assert e.worker.reconcile(e.row.owner_id,e.row.id).state=='filled'
    assert len(e.broker.calls)==1


def test_readback_rejects_wrong_owner_and_fake_account(setup):
    e=setup(['after_acceptance'])
    with pytest.raises(TimeoutError):e.worker.dispatch(e.event.id)
    with pytest.raises(OrderDenied):e.worker.reconcile(e.env.owners[1],e.row.id)
    e.env.db.rollback();e.broker.binding='other-account'
    with pytest.raises(OrderDenied):e.worker.reconcile(e.row.owner_id,e.row.id)
    e.env.db.rollback();assert len(e.broker.calls)==1


def test_no_real_transport_or_activation_flag(setup):
    e=setup()
    with pytest.raises(OrderDenied):ExecutionWorker(e.env.service,object(),e.source)
    from app.domains.order_intents.router import get_runtime
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as exc:get_runtime()
    assert exc.value.status_code==503


@pytest.mark.parametrize('field,value', [('state','filled'),('filled_quantity',0),('filled_quantity',11),('filled_quantity',True),('broker_order_id',''),('payload_digest','forged'),('client_reference','other')])
def test_reconciliation_invalid_receipt_never_unblocks_buy(setup,field,value):
    o=order(2);o['sequencing']='sell_then_buy';o['legs'][0]['side']='SELL'
    e=setup(['partial'],o=o)
    e.worker.dispatch(e.event.id)
    with Session(e.venue) as db:
        r=db.get(FakeVenueOrder,e.broker.calls[0]);v=deepcopy(r.receipt);v[field]=value;r.receipt=v;flag_modified(r,'receipt');db.commit()
    assert e.worker.reconcile(e.row.owner_id,e.row.id).state=='unknown'
    e.worker.resume(e.row.owner_id,e.row.id)
    assert len(e.broker.calls)==1


def test_backoff_window_and_no_redis_dependency(setup,monkeypatch):
    # No Redis interaction is needed for durable delivery/reconciliation.
    import redis
    monkeypatch.setattr(redis.Redis,'execute_command',lambda *a,**k:(_ for _ in ()).throw(ConnectionError('Synthetic Redis unavailable')))
    e=setup(['before_acceptance'])
    with pytest.raises(TimeoutError):e.worker.dispatch(e.event.id)
    e.worker.reconcile(e.row.owner_id,e.row.id)
    with pytest.raises(OrderDenied,match='BACKOFF'):e.worker.reconcile(e.row.owner_id,e.row.id)
    e.env.db.rollback();e.env.clock[0]=NOW+timedelta(minutes=11)
    with pytest.raises(OrderDenied,match='EXHAUSTED'):e.worker.reconcile(e.row.owner_id,e.row.id)
    e.env.db.rollback();assert len(e.broker.calls)==1


@pytest.mark.parametrize('mutation', ['request','risk','approval','attempt','outbox','limits','leg'])
def test_frozen_execution_mutations_fail_closed(setup,mutation):
    e=setup(['after_acceptance'])
    with pytest.raises(TimeoutError):e.worker.dispatch(e.event.id)
    if mutation=='request':
        p=deepcopy(e.row.payload_json);p['legs'][0]['quantity']=999;e.row.payload_json=p
    elif mutation=='risk':e.row.risk_json=None
    elif mutation=='approval':e.row.approval_digest='forged'
    elif mutation=='attempt':e.env.db.scalar(select(ExecutionAttempt)).binding_digest='forged'
    elif mutation=='outbox':e.env.db.get(type(e.event),e.event.id).payload={'owner_id':e.row.owner_id}
    elif mutation=='limits':e.env.db.get(ExecutionRun,e.row.id).limits_json={}
    elif mutation=='leg':e.env.service.legs(e.row)[0].payload_digest='forged'
    e.env.db.commit()
    if mutation=='limits':
        # Reads stay scoped without granting new submissions under changed limits.
        assert e.worker.reconcile(e.row.owner_id,e.row.id).state=='filled'
    else:
        with pytest.raises(OrderDenied):e.worker.reconcile(e.row.owner_id,e.row.id)
    e.env.db.rollback();assert len(e.broker.calls)==1


def test_material_edit_requires_new_review_no_substitution(setup):
    e=setup(['partial'],o=order(2));e.worker.dispatch(e.event.id)
    changed=deepcopy(e.row.payload_json);changed['legs'][1]['quantity']=1;e.row.payload_json=changed;e.env.db.commit()
    with pytest.raises(OrderDenied):e.worker.resume(e.row.owner_id,e.row.id)
    e.env.db.rollback();assert len(e.broker.calls)==1


def test_new_observation_and_account_rate_limit(setup):
    e=setup();e.worker.limits=ExecutionLimits(max_submissions_per_minute=1)
    e.worker.dispatch(e.event.id)
    f=setup(key='next');f.worker.limits=e.worker.limits
    with pytest.raises(OrderDenied,match='OBSERVATION'):f.worker.dispatch(f.event.id)
    f.env.db.rollback();f.env.clock[0]=NOW+timedelta(seconds=1);f.source.snapshot['as_of']=f.env.clock[0]
    with pytest.raises(OrderDenied,match='RATE_LIMIT'):f.worker.resume(f.row.owner_id,f.row.id)
    f.env.db.rollback();assert not f.broker.calls


def test_partial_order_blocks_other_intent_same_account(setup):
    e=setup(['partial']);e.worker.dispatch(e.event.id)
    f=setup(key='next');f.env.clock[0]=NOW+timedelta(seconds=1);f.source.snapshot['as_of']=f.env.clock[0]
    with pytest.raises(OrderDenied,match='RECONCILIATION'):f.worker.dispatch(f.event.id)
    f.env.db.rollback();assert not f.broker.calls


def test_multi_buy_funds_are_not_reused(setup):
    e=setup(o=order(2));e.source.snapshot['funds']='1000.00'
    with pytest.raises(OrderDenied,match='FUNDS'):e.worker.dispatch(e.event.id)
    e.env.db.rollback();assert not e.broker.calls


def test_cross_owner_stop_rejected(setup):
    e=setup()
    with pytest.raises(OrderDenied):e.worker.set_stop('connection',True,owner_id=e.env.owners[1],connection_id=e.row.connection_id)
    e.env.db.rollback();assert not e.broker.calls


@pytest.mark.parametrize('mutation',['missing','duplicate','quantity','order','reference','payload','boolean'])
def test_reconciled_fills_need_exact_bound_trade_evidence(setup,mutation):
    e=setup(['after_acceptance'])
    with pytest.raises(TimeoutError):e.worker.dispatch(e.event.id)
    with Session(e.venue) as db:
        row=db.get(FakeVenueOrder,e.broker.calls[0]);trades=deepcopy(row.trades)
        if mutation=='missing':trades=[]
        elif mutation=='duplicate':trades=trades*2
        elif mutation=='quantity':trades[0]['quantity']=1
        elif mutation=='order':trades[0]['broker_order_id']='other'
        elif mutation=='reference':trades[0]['client_reference']='other'
        elif mutation=='payload':trades[0]['payload_digest']='other'
        elif mutation=='boolean':trades[0]['quantity']=True
        row.trades=trades;flag_modified(row,'trades');db.commit()
    assert e.worker.reconcile(e.row.owner_id,e.row.id).state=='unknown'
    assert len(e.broker.calls)==1


@pytest.mark.parametrize('values',[{'max_notional':'0'},{'max_exposure':'NaN'},{'max_submissions_per_minute':True},{'quote_max_age_seconds':0},{'quote_max_age_seconds':31}])
def test_invalid_execution_limits_cannot_construct_worker(setup,values):
    e=setup()
    with pytest.raises(OrderDenied):ExecutionWorker(e.env.service,e.broker,e.source,limits=ExecutionLimits(**values))
    assert not e.broker.calls


def test_whole_basket_notional_limit(setup):
    e=setup(o=order(2));e.worker.limits=ExecutionLimits(max_notional='1500.00')
    with pytest.raises(OrderDenied,match='NOTIONAL'):e.worker.dispatch(e.event.id)
    e.env.db.rollback();assert not e.broker.calls


@pytest.mark.parametrize('fault',['receipt','attempt','trades','missing_attempt'])
def test_stored_filled_evidence_cannot_be_changed_before_buy(setup,fault):
    e=setup(['filled'])
    # Single-leg original completes with bound order/trade evidence.
    e.worker.dispatch(e.event.id)
    leg=e.env.service.legs(e.row)[0];attempt=e.env.db.get(ExecutionAttempt,leg.id)
    if fault=='receipt':leg.filled_quantity=0
    elif fault=='attempt':attempt.state='unknown'
    elif fault=='trades':
        v=deepcopy(attempt.evidence_json);v['trades']=[];attempt.evidence_json=v
    elif fault=='missing_attempt':e.env.db.delete(attempt)
    e.env.db.commit()
    with pytest.raises(OrderDenied):e.worker.reconcile(e.row.owner_id,e.row.id)
    e.env.db.rollback();assert len(e.broker.calls)==1


@pytest.mark.parametrize('mode',['user_owned','platform_managed'])
def test_supported_app_modes_keep_distinct_frozen_binding(setup,env,mode):
    connection=env.db.get(IntegrationConnection,'connection1');connection.app_ownership_mode=mode;connection.version=3;env.db.commit()
    e=setup()
    assert e.row.app_mode==mode and e.row.connection_version==3
    assert e.worker.dispatch(e.event.id).state=='filled'


@pytest.mark.parametrize('change',['expiry','limits','valid'])
def test_remaining_leg_needs_fresh_observation_and_unchanged_approval(setup,change):
    e=setup(o=order(2))
    with pytest.raises(OrderDenied,match='OBSERVATION'):e.worker.dispatch(e.event.id)
    e.env.db.rollback();assert len(e.broker.calls)==1
    e.env.clock[0]=NOW+timedelta(seconds=301 if change=='expiry' else 1)
    e.source.snapshot['as_of']=e.env.clock[0]
    if change=='limits':e.worker.limits=ExecutionLimits(max_notional='1000000.00')
    if change=='valid':
        assert e.worker.resume(e.row.owner_id,e.row.id).state=='filled' and len(e.broker.calls)==2
    else:
        with pytest.raises(OrderDenied):e.worker.resume(e.row.owner_id,e.row.id)
        e.env.db.rollback();assert len(e.broker.calls)==1


@pytest.mark.parametrize('point',['before_acceptance','after_acceptance'])
def test_actual_process_exit_has_no_cleanup_handler_and_no_replay(setup,point):
    import os,subprocess,sys
    from pathlib import Path
    e=setup();owner,intent,event=e.row.owner_id,e.row.id,str(e.event.id)
    app_path=e.env.engine.url.database;venue_path=e.venue.url.database;e.env.db.close()
    code='''
import os,sys
from sqlalchemy import create_engine,select
from sqlalchemy.orm import Session
from test_stage15_execution import market,NOW
from app.domains.order_intents.models import OrderIntent
from app.domains.order_intents.service import Orders
from app.domains.order_intents.execution import ExecutionWorker,venue_binding
from app.domains.order_intents.execution_fake import ExecutionBrokerFake,MarketDataFake
from app.domains.order_intents.contracts import digest,OrderDenied
from app.domains.modules.models import UserModule
app=create_engine('sqlite:///'+sys.argv[1]);venue=create_engine('sqlite:///'+sys.argv[2])
with Session(app) as db:
    row=db.get(OrderIntent,sys.argv[3]);broker=ExecutionBrokerFake(venue,venue_binding(row))
    def policy(db,i):
        module=db.scalar(select(UserModule).where(UserModule.user_id==i.owner_id))
        if not module.enabled or module.version!=i.version:raise OrderDenied('SYNTHETIC_MODULE_DENIED')
    def risk(db,i,p,c,now):return {'allowed':True,'version':1,'owner':i.owner_id,'account':c.provider_account_id,'payload_hash':digest(p),'max_order_quantity':1000000}
    service=Orders(db,policy=policy,risk=risk,clock=lambda:NOW)
    worker=ExecutionWorker(service,broker,MarketDataFake(market(row)))
    if sys.argv[5]=='after_acceptance':
        original=broker.submit
        def lost(*args):original(*args);os._exit(72)
        broker.submit=lost
        worker.dispatch(sys.argv[4])
    else:worker.dispatch(sys.argv[4],before_effect=lambda:os._exit(71))
'''
    backend=Path(__file__).resolve().parents[1]
    environment={'PATH':os.defpath,'PYTHONPATH':str(backend)+os.pathsep+str(backend/'tests'),'DATABASE_URL':'postgresql+asyncpg://synthetic:synthetic@127.0.0.1:1/unused','REDIS_URL':'redis://127.0.0.1:1/15','ENVIRONMENT':'test','AUTH_DISABLED':'false','PYTHONDONTWRITEBYTECODE':'1'}
    result=subprocess.run([sys.executable,'-c',code,app_path,venue_path,intent,event,point],env=environment,cwd=backend,capture_output=True,text=True,timeout=20)
    assert result.returncode==(72 if point=='after_acceptance' else 71),result.stderr
    e.env.db=Session(e.env.engine,expire_on_commit=False)
    e.env.service=Orders(e.env.db,policy=e.env.policy,risk=e.env.risk,clock=lambda:NOW)
    assert e.env.db.scalar(select(ExecutionAttempt)).state=='claimed' # no exception cleanup ran
    broker=ExecutionBrokerFake(e.venue,e.broker.binding)
    reader=ExecutionWorker(e.env.service,broker,e.source)
    assert reader.reconcile(owner,intent).state==('filled' if point=='after_acceptance' else 'unknown')
    reader.resume(owner,intent)
    assert not broker.calls
