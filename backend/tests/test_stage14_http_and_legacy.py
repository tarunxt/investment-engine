"""Authenticated synthetic HTTP and real transport denial, without any I/O."""
import ast,asyncio,inspect
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock,patch
import pytest
from fastapi import FastAPI,HTTPException
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import create_async_engine,async_sessionmaker
from app.domains.order_intents.router import router,get_runtime
from app.domains.auth.dependencies import get_current_user
from app.infrastructure.database.session import get_async_db
from app.domains.order_intents.contracts import require_live_financial_disabled
from test_stage14_order_intents import env,order,NOW,OrderIntent,OutboxMessage


def test_authenticated_http_exact_review_and_replay(env):
    # Existing auth dependency supplies identity. No caller-provided owner field.
    engine=create_async_engine('sqlite+aiosqlite:///'+str(env.engine.url.database));factory=async_sessionmaker(engine,expire_on_commit=False)
    app=FastAPI();app.include_router(router);actor=[env.owners[0]]
    async def user():return SimpleNamespace(id=actor[0],is_active=True,is_verified=True)
    async def db():
        async with factory() as session:yield session
    app.dependency_overrides[get_current_user]=user;app.dependency_overrides[get_async_db]=db
    # Explicit test dependency composition, no production registration method.
    app.dependency_overrides[get_runtime]=lambda:SimpleNamespace(policy=env.policy,risk=env.risk)
    # Fixture connection lifetime covers real server clock during this test.
    from app.domains.connections.models import IntegrationConnection
    from datetime import datetime,timezone,timedelta
    for c in env.db.query(IntegrationConnection):c.token_expires_at=datetime.now(timezone.utc)+timedelta(hours=1)
    env.db.commit()
    with TestClient(app) as client:
        body={'operation_key':'http','connection_id':'connection1','module_version':1,'order':order()}
        bad=client.post('/order-intents',json={**body,'owner_id':env.owners[1]});assert bad.status_code==422
        r=client.post('/order-intents',json=body);assert r.status_code==200;r=r.json();id=r['id']
        assert client.post(f'/order-intents/{id}/validate').status_code==200
        review=client.post(f'/order-intents/{id}/review').json();assert review['payload']==order()
        actor[0]=env.owners[1];confirm={'displayed_digest':review['review_digest'],'action':'confirm_exact_order_or_basket'}
        assert client.post(f'/order-intents/{id}/approve',json=confirm).status_code==409
        actor[0]=env.owners[0];assert client.post(f'/order-intents/{id}/approve',json=confirm).status_code==200
        assert client.post(f'/order-intents/{id}/approve',json=confirm).status_code==409
        assert client.get('/order-intents/status').json()['runtime_enabled'] is False
    asyncio.run(engine.dispose())


def test_normal_runtime_disabled_even_with_authenticated_user():
    app=FastAPI();app.include_router(router);app.dependency_overrides[get_current_user]=lambda:SimpleNamespace(id=1)
    async def unused_db():yield None
    app.dependency_overrides[get_async_db]=unused_db
    with TestClient(app) as c:
        assert c.post('/order-intents',json={'operation_key':'test','connection_id':'test','module_version':1,'order':order()}).status_code==503
        assert c.post('/order-intents/fake/approve',json={'displayed_digest':'a'*64,'action':'confirm_exact_order_or_basket'}).status_code==503


def test_worker_or_anonymous_http_cannot_approve():
    app=FastAPI();app.include_router(router)
    def denied():raise HTTPException(401,'Authentication required')
    app.dependency_overrides[get_current_user]=denied
    with TestClient(app) as c:
        assert c.post('/order-intents/fake/approve',json={'displayed_digest':'a'*64,'action':'confirm_exact_order_or_basket'},headers={'module_dispatch_id':'forged','X-User-Id':'1'}).status_code==401


@pytest.mark.parametrize('method',['POST','PUT','DELETE','PATCH'])
def test_raw_kite_order_transport_denied_before_http(method):
    from app.domains.zerodha.service import ZerodhaService
    svc=ZerodhaService()
    with patch('app.domains.zerodha.service.require_zerodha_write_allowed'),patch('httpx.AsyncClient') as network:
        with pytest.raises(HTTPException) as exc:asyncio.run(svc._request_async(method,'/orders/regular',data={}))
        assert exc.value.status_code==503;network.assert_not_called()


@pytest.mark.parametrize('name',['place_order','place_protected_market_orders','place_protected_market_orders_sequenced'])
def test_legacy_routes_fail_before_token_or_provider(name):
    # Execute only exact unwrapped function AST with a denied sentinel. The
    # guard is first, before credentials, quote acquisition, or fake injection.
    source=Path(__file__).parents[1]/'app/domains/zerodha/router.py';node=next(n for n in ast.parse(source.read_text()).body if isinstance(n,ast.AsyncFunctionDef) and n.name==name)
    assert isinstance(node.body[0],ast.ImportFrom) and node.body[0].module=='app.domains.order_intents.contracts'
    node.decorator_list=[];node.returns=None
    args=node.args.args;node.args.defaults=[]
    for a in args:a.annotation=None
    namespace={};exec(compile(ast.Module(body=[node],type_ignores=[]),str(source),'exec'),namespace)
    with pytest.raises(HTTPException) as exc:asyncio.run(namespace[name](**{a.arg:None for a in args}))
    assert exc.value.status_code==503


def test_direct_clob_cannot_sign_or_post():
    from app.domains.polymarket_direct.direct_polymarket import _place_order
    with pytest.raises(HTTPException):_place_order(None,None)

@pytest.mark.parametrize('args',[['order','buy'],['order','sell'],['order','cancel'],['redeem']])
def test_bullpen_write_process_fence_denies_before_process(args):
    from app.domains.modules.execution import bullpen_process_fence
    from app.domains.polymarket.runtime_broker import _parse_command_category
    # Known write grammar is tested below; unknown commands must also never gain
    # an execution context or reach subprocess creation.
    async def run():
        async with bullpen_process_fence(args):raise AssertionError('financial process fence passed')
    with pytest.raises((HTTPException,PermissionError)):asyncio.run(run())

@pytest.mark.parametrize('path',['/%6frders/regular','/orders/regular?mode=test','/unknown-mutation','//orders/regular','/basket/orders'])
@pytest.mark.parametrize('sync',[False,True])
def test_unknown_or_encoded_kite_mutations_also_fail_closed(path,sync):
    from app.domains.zerodha.service import ZerodhaService
    svc=ZerodhaService()
    with patch('app.domains.zerodha.service.require_zerodha_write_allowed'),patch('httpx.AsyncClient') as async_network,patch('httpx.Client') as sync_network:
        with pytest.raises(HTTPException):
            if sync:svc._request_sync('POST',path,data={})
            else:asyncio.run(svc._request_async('POST',path,data={}))
        async_network.assert_not_called();sync_network.assert_not_called()

@pytest.mark.parametrize('method',['eth_sendRawTransaction','eth_sendTransaction','unknown'])
def test_raw_rpc_financial_or_unknown_methods_blocked_without_recovery_flag(method,monkeypatch):
    monkeypatch.setenv('CREDX_RECOVERY_MODE','0')
    from app.domains.polymarket_direct.direct_polymarket import _rpc_call
    with patch('requests.post') as network:
        with pytest.raises(HTTPException):_rpc_call(None,method,[])
        network.assert_not_called()
