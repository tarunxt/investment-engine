"""Read-only synthetic UI projections; no provider transport or runtime."""
from datetime import timedelta
import pytest
from test_stage14_order_intents import env, prepare, NOW
from app.domains.order_intents.presentation import owned_reviews
from app.domains.modules.models import UserModule
from sqlalchemy import select


def test_owned_masked_view_and_exact_notional(env):
    row, _ = prepare(env)
    result = owned_reviews(env.db, row.owner_id, now=NOW)
    view = result['intents'][0]
    assert result['owner_id'] == row.owner_id and result['runtime_enabled'] is False
    assert view['account_label'] == '••••E1' and view['estimated_gross_notional'] == '1000.00'
    assert view['integrity_checked'] and len(view['legs']) == 1
    assert not any(view['actions'].values())
    assert 'risk_json' not in view and 'account_id' not in view
    assert owned_reviews(env.db, env.owners[1], intent_id=row.id, now=NOW)['intents'] == []


def test_disable_does_not_hide_safety_record(env):
    row, _ = prepare(env)
    module = env.db.scalar(select(UserModule).where(UserModule.user_id == row.owner_id))
    module.enabled = False
    env.db.commit()
    assert owned_reviews(env.db, row.owner_id, now=NOW)['intents'][0]['id'] == row.id


@pytest.mark.parametrize('state', ['unknown', 'partial', 'submitting', 'acknowledged'])
def test_uncertain_is_never_retryable(env, state):
    row, _ = prepare(env)
    row.state = state
    row.expires_at = NOW - timedelta(seconds=1)
    view = owned_reviews(env.db, row.owner_id, now=NOW)['intents'][0]
    assert view['unresolved'] and view['approval_stale']
    assert any('not a safe failure' in warning for warning in view['warnings'])
    assert not any(view['actions'].values())


@pytest.mark.parametrize('mutation', ['payload', 'hash', 'leg', 'quantity'])
def test_mutated_instruction_is_not_displayed_as_verified(env, mutation):
    row, _ = prepare(env)
    leg = env.service.legs(row)[0]
    if mutation == 'payload':row.payload_json = {'legs': []}
    if mutation == 'hash':row.request_digest = '0'*64
    if mutation == 'leg':leg.payload_digest = '0'*64
    if mutation == 'quantity':leg.filled_quantity = 11
    env.db.flush()
    view = owned_reviews(env.db, row.owner_id, now=NOW)['intents'][0]
    assert not view['integrity_checked'] and view['legs'] == []
    assert view['estimated_gross_notional'] is None


def test_only_private_runtime_can_offer_bound_confirmation(env):
    from types import SimpleNamespace
    row, review = prepare(env)
    runtime = SimpleNamespace(policy=env.policy, risk=env.risk)
    view = owned_reviews(env.db, row.owner_id, now=NOW, runtime=runtime)['intents'][0]
    assert view['actions']['confirm'] and view['review_digest'] == review['review_digest']
    assert owned_reviews(env.db, row.owner_id, now=NOW)['intents'][0]['review_digest'] is None
    env.conditions['allowed'] = False
    view = owned_reviews(env.db, row.owner_id, now=NOW, runtime=runtime)['intents'][0]
    assert not view['actions']['confirm'] and view['review_digest'] is None


def test_normal_runtime_cannot_be_enabled_by_reads():
    from app.domains.order_intents.router import get_read_runtime, get_runtime
    from fastapi import HTTPException
    assert get_read_runtime() is None
    with pytest.raises(HTTPException) as error:get_runtime()
    assert error.value.status_code == 503


def test_false_completion_and_changed_approval_are_not_trusted(env):
    from test_stage14_order_intents import approve
    row, _ = approve(env)
    row.approved_by = env.owners[1]
    view = owned_reviews(env.db, row.owner_id, now=NOW)['intents'][0]
    assert not view['integrity_checked'] and view['state'] == 'unverified' and view['unresolved']
    row.state = 'filled'
    assert not owned_reviews(env.db, row.owner_id, now=NOW)['intents'][0]['integrity_checked']


def test_receipt_changes_are_not_verified(env):
    from test_stage14_order_intents import approve
    from app.domains.order_intents.fake import FakeBroker
    row, event = approve(env)
    env.service.dispatch(event.id, FakeBroker(['filled']), now=NOW)
    assert owned_reviews(env.db, row.owner_id, now=NOW)['intents'][0]['state'] == 'filled'
    leg = env.service.legs(row)[0]
    leg.filled_quantity = 0
    assert not owned_reviews(env.db, row.owner_id, now=NOW)['intents'][0]['integrity_checked']


@pytest.mark.asyncio
async def test_authenticated_http_owner_scope_and_no_store(env):
    import httpx
    from fastapi import FastAPI
    from app.domains.order_intents.router import router
    from app.domains.auth.dependencies import get_current_user
    from app.infrastructure.database.session import get_async_db
    from app.domains.auth.models import User
    row, _ = prepare(env)
    class Bridge:
        async def run_sync(self, fn):return fn(env.db)
    app = FastAPI();app.include_router(router)
    app.dependency_overrides[get_async_db] = lambda: Bridge()
    app.dependency_overrides[get_current_user] = lambda: env.db.get(User, env.owners[0])
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://synthetic.invalid') as client:
        response = await client.get('/order-intents/reviews')
        assert response.status_code == 200 and response.headers['cache-control'] == 'private, no-store'
        assert response.json()['intents'][0]['id'] == row.id
        assert (await client.post('/order-intents/'+row.id+'/approve',json={'displayed_digest':'a'*64,'action':'confirm_exact_order_or_basket'})).status_code == 503
        app.dependency_overrides[get_current_user] = lambda: env.db.get(User, env.owners[1])
        response = await client.get('/order-intents/reviews/'+row.id)
        assert response.status_code == 404 and response.headers['cache-control'] == 'private, no-store'
        assert (await client.get('/order-intents/reviews')).json()['intents'] == []
        app.dependency_overrides.pop(get_current_user)
        assert (await client.get('/order-intents/reviews')).status_code in (401,403)


@pytest.mark.asyncio
async def test_private_preview_seed_never_approves_or_changes_selection(env, monkeypatch):
    from pathlib import Path
    from datetime import datetime, timezone
    from app.domains.auth.models import User
    from app.domains.connections.models import IntegrationConnection
    from app.domains.order_intents.models import OrderIntent
    monkeypatch.setenv('STAGE01_PREVIEW', 'synthetic-only')
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2]))
    from scripts.public_launch import preview_stage16 as preview
    for table in preview.TABLES: table.create(env.engine, checkfirst=True)
    users = [env.db.get(User, id) for id in env.owners]
    for i, user in enumerate(users):
        user.username = ('usera', 'userb')[i]
        env.db.get(IntegrationConnection, 'connection'+str(i+1)).token_expires_at = datetime.now(timezone.utc)+timedelta(hours=1)
    disabled = env.db.scalar(select(UserModule).where(UserModule.user_id == users[1].id))
    disabled.enabled = False
    env.db.commit()
    class Bridge:
        async def run_sync(self, fn): return fn(env.db)
        async def commit(self): env.db.commit()
    await preview.seed(Bridge(), users)
    await preview.seed(Bridge(), users)
    assert len(list(env.db.scalars(select(preview.ZerodhaPortfolioSnapshot)))) == 2
    assert list(env.db.scalars(select(OrderIntent))) == []
    assert disabled.enabled is False


@pytest.mark.asyncio
@pytest.mark.parametrize('case', ['valid', 'foreign', 'disabled', 'digest', 'connection', 'unverified', 'facts', 'runtime', 'action', 'expired', 'risk', 'old_mapping', 'noauth', 'execution_policy'])
async def test_confirmation_through_installed_module_middleware(env, monkeypatch, case):
    """The prior router-only tests omitted the dependency producing browser403."""
    from datetime import datetime, timezone
    from types import SimpleNamespace
    import httpx
    from fastapi import FastAPI
    from app.domains.auth.models import User
    from app.domains.connections.models import IntegrationConnection
    from app.domains.order_intents.router import router, get_runtime
    from app.domains.auth.dependencies import get_current_user
    from app.infrastructure.database.session import get_async_db
    from app.infrastructure.database.outbox.models import OutboxMessage
    from app.domains.modules.policy import DefaultFactsResolver, ModuleFacts
    from app.domains.modules.transports import install_route_policy
    row, review=prepare(env)
    user=env.db.get(User, env.owners[1] if case=='foreign' else row.owner_id)
    connection=env.db.get(IntegrationConnection, row.connection_id)
    connection.token_expires_at=datetime.now(timezone.utc)+timedelta(hours=1)
    if case=='connection':connection.version+=1
    if case=='expired':connection.token_expires_at=datetime.now(timezone.utc)-timedelta(seconds=1)
    if case=='risk':env.conditions['allowed']=False
    if case=='disabled':env.db.scalar(select(UserModule).where(UserModule.user_id==row.owner_id)).enabled=False
    if case=='unverified':user.is_verified=False
    env.db.commit()
    class Bridge:
        async def run_sync(self, fn):return fn(env.db)
        async def commit(self):env.db.commit()
        async def rollback(self):env.db.rollback()
        async def scalar(self, query):return env.db.scalar(query)
        async def execute(self, query):return env.db.execute(query)
        def get_bind(self):return env.db.get_bind()
    monkeypatch.setattr(DefaultFactsResolver, 'resolve_sync', lambda *_: ModuleFacts() if case=='facts' else ModuleFacts(
        jurisdiction='allowed', plan='allowed', connection='ready', execution_capability=case!='execution_policy'))
    app=FastAPI();app.include_router(router)
    app.dependency_overrides[get_async_db]=lambda:Bridge()
    app.dependency_overrides[get_current_user]=lambda:user
    if case=='noauth':app.dependency_overrides.pop(get_current_user)
    def denied_execution_policy(*args):raise PermissionError('Synthetic execution capability unavailable')
    if case!='runtime':app.dependency_overrides[get_runtime]=lambda:SimpleNamespace(
        policy=denied_execution_policy if case=='execution_policy' else env.policy,risk=env.risk)
    if case=='old_mapping':
        from app.domains.modules import transports
        classify=transports.classify_route
        monkeypatch.setattr(transports, 'classify_route', lambda domain, endpoint, path, methods, source='':
            ('unknown','view') if domain=='order_intents' and endpoint=='approve' else classify(domain,endpoint,path,methods,source))
    install_route_policy(app)
    body={'displayed_digest':'0'*64 if case=='digest' else review['review_digest'], 'action':'confirm_exact_order_or_basket'}
    if case=='action':body['action']='standing_consent'
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://synthetic.invalid') as client:
        response=await client.post('/order-intents/'+row.id+'/approve',json=body)
        expected={'valid':200,'foreign':409,'disabled':403,'digest':409,'connection':409,'unverified':403,'facts':403,'runtime':503,
                  'action':409,'expired':409,'risk':409,'old_mapping':403,'noauth':401,'execution_policy':409}[case]
        assert response.status_code==expected, response.text
        if case=='old_mapping':assert 'UNKNOWN_MODULE' in response.text
        if case=='valid':assert (await client.post('/order-intents/'+row.id+'/approve',json=body)).status_code==409
    assert len(list(env.db.scalars(select(OutboxMessage))))==(1 if case=='valid' else 0)


def test_confirmation_classification_is_exact_not_a_financial_route_exemption():
    from app.domains.modules.coverage import classify_route
    assert classify_route('order_intents','approve','/order-intents/{id}/approve',{'POST'})==('zerodha_rebalance','analyze')
    for endpoint,path,methods in [('create','/order-intents',{'POST'}),('future','/order-intents/{id}/approve',{'POST'}),
                                  ('approve','/order-intents/{id}/approve',{'GET'}),('approve','/order-intents/{id}/submit',{'POST'})]:
        assert classify_route('order_intents',endpoint,path,methods)==('unknown','view')


def test_only_exact_owned_read_paths_are_core_and_uat_has_no_writes():
    from app.domains.modules.coverage import classify_route
    from app.uat2.main import app
    for path in ('/order-intents/reviews','/order-intents/reviews/{id}','/order-intents/positions'):
        assert classify_route('order_intents','read',path,{'GET'}) is None
        assert any(getattr(r,'path',None)==path and getattr(r,'methods',None)=={'GET'} for r in app.routes)
    assert classify_route('order_intents','approve','/order-intents/{id}/approve',{'POST'}) is not None
    assert classify_route('order_intents','future','/order-intents/other',{'GET'}) is not None
    assert not any(getattr(r,'path','').startswith('/order-intents') and 'POST' in (getattr(r,'methods',None) or set()) for r in app.routes)


def test_positions_are_owner_scoped_whitelisted_and_not_live(env):
    from app.domains.order_intents.positions_view import owned_positions
    from app.domains.zerodha.models import ZerodhaPortfolioSnapshot as India
    from app.domains.indmoney_us.models import IndMoneyUsPortfolioSnapshot as US
    India.__table__.create(env.engine);US.__table__.create(env.engine)
    a=India(user_id=env.owners[0],snapshot_date=NOW.date(),captured_at=NOW,holdings=[{'tradingsymbol':'OWN','quantity':3,'access_token':'never-forward'}],net_positions=[{'tradingsymbol':'SHORT','quantity':-2}],day_positions=[])
    b=India(user_id=env.owners[1],snapshot_date=NOW.date(),captured_at=NOW,holdings=[{'tradingsymbol':'FOREIGN','quantity':99}],net_positions=[],day_positions=[])
    env.db.add_all([a,b]);env.db.commit()
    result=owned_positions(env.db,env.owners[0])
    assert not result['complete_live_positions']
    assert result['sources'][0]['groups'][0]['items']==[{'symbol':'OWN','quantity':'3'}]
    assert result['sources'][0]['groups'][1]['items']==[{'symbol':'SHORT','quantity':'-2'}]
    assert 'FOREIGN' not in str(result) and 'access_token' not in str(result)


@pytest.mark.parametrize('quantity',[float('nan'),float('inf'),True,'x',10**100,'1e-1000000','0'*101])
def test_invalid_recorded_position_values_omitted(quantity):
    from app.domains.order_intents.positions_view import items
    assert items([{'symbol':'X','quantity':quantity}])==([],True)
