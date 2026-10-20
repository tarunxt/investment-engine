"""Real authenticated HTTP/SQL boundary checks; all adapters are forbidden fakes."""
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
import importlib

import pytest
from fastapi import Depends, HTTPException, Request
from fastapi.routing import APIRoute
from sqlalchemy import select

from test_private_api_ownership import private_api
from app.domains.auth.models import UserRole
from app.domains.auth.admin_roles import AdministrativeRoleGrant, require_cost_dashboard_admin
from app.domains.polymarket import access

FAMILIES = ('polymarket', 'polymarket_direct', 'polymarket_auto_live', 'bullpen008',
            'bullpen_trade_analysis', 'bullpen_run_audit', 'trading_bots')


@pytest.fixture
def boundary(private_api, monkeypatch):
    a = private_api
    AdministrativeRoleGrant.__table__.create(a.session.get_bind())
    def forbidden(*_args, **_kwargs):
        raise AssertionError('Runtime/cache/queue/provider must not be reached')
    for family in FAMILIES:
        module = importlib.import_module(f'app.domains.{family}.router')
        a.app.include_router(module.router)
        if hasattr(module, 'get_bullpen_runtime_broker'):
            monkeypatch.setattr(module, 'get_bullpen_runtime_broker', forbidden)
    from app.domains.sports_rankings import router as sports
    from app.domains.cost_drivers import router as cost
    a.app.include_router(sports.router)
    a.app.include_router(cost.router)
    monkeypatch.setattr(cost, 'get_dashboard', forbidden)
    a.forbidden = forbidden
    return a


def runtime_routes(a):
    return [r for r in a.app.routes if isinstance(r, APIRoute) and any(
        d.call is access.require_singleton_bullpen_runtime_access for d in r.dependant.dependencies)]


@pytest.mark.parametrize('identity', ['anonymous', 'regular', 'cost_only', 'inactive', 'viewer'])
def test_every_runtime_route_denies_before_adapter(boundary, identity):
    a = boundary
    if identity == 'viewer':
        a.users[0].role = UserRole.VIEWER; a.session.commit()
    if identity == 'cost_only':
        a.session.add(AdministrativeRoleGrant(user_id=a.users[0].id,
            role='cost_dashboard_admin', source='synthetic-test'))
        a.session.commit()
    routes = runtime_routes(a)
    assert len(routes) >= 126
    for route in routes:
        path = route.path
        for name in route.param_convertors: path = path.replace('{'+name+'}', '1')
        for method in route.methods - {'HEAD', 'OPTIONS'}:
            response = a.client.request(method, path, json={},
                headers={} if identity == 'anonymous' else a.headers[2 if identity == 'inactive' else 0])
            assert response.status_code == (401 if identity == 'anonymous' else 403), (method, path, response.text)


def test_cost_scope_explicit_no_email_bypass_and_no_global_admin(boundary, monkeypatch):
    a = boundary
    @a.app.get('/test/cost-admission')
    async def cost_admission(user=Depends(require_cost_dashboard_admin)):
        return {'id': user.id}
    user = a.users[0]
    user.email = 'tarun.singh6893@gmail.com'
    a.session.commit()
    monkeypatch.setenv('COST_DASHBOARD_ADMIN_EMAILS', user.email)
    assert a.client.get('/test/cost-admission', headers=a.headers[0]).status_code == 403
    grant = AdministrativeRoleGrant(user_id=user.id, role='cost_dashboard_admin', source='synthetic-test')
    a.session.add(grant); a.session.commit()
    assert a.client.get('/test/cost-admission', headers=a.headers[0]).status_code == 200
    assert user.role == UserRole.USER
    assert not access.user_can_access_singleton_bullpen_runtime(user)
    from app.domains.auth.dependencies import require_admin
    @a.app.get('/test/global-admin')
    async def global_admin(_user=Depends(require_admin)): return {'ok': True}
    assert a.client.get('/test/global-admin', headers=a.headers[0]).status_code == 403
    a.session.delete(grant); a.session.commit()
    assert a.client.get('/test/cost-admission', headers=a.headers[0]).status_code == 403


def test_global_maintenance_and_admin_data_denied(boundary):
    a = boundary
    paths = [(r, m) for r in a.app.routes if isinstance(r, APIRoute) for m in r.methods
             if (r.path.startswith('/api/sports-rankings') and m == 'POST' and any(
                 word in r.path for word in ('classify', 'refresh', 'reconcile')))
             or r.path.startswith('/api/admin/cost-drivers')]
    assert len(paths) >= 8
    for route, method in paths:
        response = a.client.request(method, route.path, headers=a.headers[0], json={})
        assert response.status_code == 403, (route.path, response.text)


def test_active_operator_read_preserves_admission_and_revocation(boundary):
    a = boundary
    # A real role row, never a JWT role claim, controls the shared read route.
    @a.app.get('/test/operator-read', dependencies=[Depends(access.require_singleton_bullpen_runtime_access)])
    async def read(): return {'snapshot_version': 'preserved', 'historical': True}
    a.users[0].role = UserRole.ADMIN; a.session.commit()
    assert a.client.get('/test/operator-read', headers=a.headers[0]).json() == {
        'snapshot_version': 'preserved', 'historical': True}
    a.users[0].role = UserRole.USER; a.session.commit()
    assert a.client.get('/test/operator-read', headers=a.headers[0]).status_code == 403


@pytest.mark.asyncio
async def test_managers_and_cache_recheck_current_owner_before_objects(boundary, monkeypatch):
    a = boundary
    from app.infrastructure.database import session as database
    @asynccontextmanager
    async def scoped(): yield a.db
    monkeypatch.setattr(database, 'AsyncSessionLocal', scoped)
    from app.domains.polymarket.service import PolymarketBotManager
    from app.domains.polymarket_direct.service import PolymarketDirectBotManager
    from app.domains.polymarket_auto_live.service import BullpenAutoLiveBotManager
    from app.domains.trading_bots.service import build_trading_bots_summary
    from app.domains.dashboard.service import build_dashboard_summary
    manager = PolymarketBotManager()
    # Poison a warm cache: denied users must not read its historical wallet data.
    manager._bots[a.users[0].id] = object()
    calls = [lambda: manager.read_state(a.users[0].id),
        lambda: manager.read_history(a.users[0].id, 10),
        lambda: manager.get_bot(a.users[0].id),
        lambda: PolymarketDirectBotManager().get_bot(a.users[0].id),
        lambda: BullpenAutoLiveBotManager().get_bot(a.users[0].id),
        lambda: build_trading_bots_summary(a.users[0].id),
        lambda: build_dashboard_summary(a.users[0].id, include_singleton_bullpen=True)]
    for call in calls:
        with pytest.raises(HTTPException) as exc: await call()
        assert exc.value.status_code == 403
    a.users[0].role = UserRole.ADMIN; a.session.commit()
    await access.require_operator_user_id(a.users[0].id)
    a.users[0].is_active = False; a.session.commit()
    with pytest.raises(HTTPException) as exc: await access.require_operator_user_id(a.users[0].id)
    assert exc.value.status_code == 403


def test_sync_workers_recheck_roles_before_broker(boundary, monkeypatch):
    a = boundary
    from app.infrastructure.database import sync_session
    class SessionView:
        def __enter__(self): return a.session
        def __exit__(self, *_): pass
    monkeypatch.setattr(sync_session, 'SyncSessionLocal', SessionView)
    from app.domains.trading_bots import tasks as scans
    from app.domains.bullpen_trade_analysis import tasks as history
    from app.domains.polymarket_auto_live import tasks as auto
    from app.domains.bullpen008 import tasks as workflow
    calls = [lambda: scans.prepare_universal_scan(a.users[0].id, triggered_by='test'),
        lambda: scans.execute_universal_polymarket_scan.run(a.users[0].id, 'fake'),
        lambda: history.request_bullpen_trade_analysis_history_sync(a.users[0].id),
        lambda: history.refresh_bullpen_trade_analysis_history.run(user_id=a.users[0].id, request_token='fake'),
        lambda: auto.execute_polymarket_auto_live_run.run(a.users[0].id, 'fake'),
        lambda: auto.queue_bullpen_workflow_trigger_batch(user_id=a.users[0].id, triggered_by='test', batch_id='fake'),
        lambda: workflow._create_scheduled_run(a.users[0].id)]
    for call in calls:
        with pytest.raises(PermissionError): call()


def test_provider_catalogue_costs_and_web_metadata_are_owned(private_api, monkeypatch):
    a = private_api
    from app.domains.ai_providers import router as providers
    a.app.include_router(providers.router)
    monkeypatch.setattr(providers.ProviderFactory, 'list_providers', lambda: [
        {'name':'fake','models':['fake-model','unpriced-model'],'configured':True}])
    monkeypatch.setattr(providers.ProviderFactory, 'model_compatibility', lambda *_: (True,None))
    monkeypatch.setattr(providers, 'load_persisted_usd_inr_rate',
        AsyncMock(return_value=SimpleNamespace(valid_value=80, source="synthetic", as_of=None, age_seconds=0, stale_after_seconds=3600, status="valid")))
    from app.shared.types import JobStatus
    for user, cost, label in [(a.users[0], .1, 'owned'), (a.users[1], 99, 'foreign-secret')]:
        row = a.jobs[(user.id-1)*3]
        row.status=JobStatus.COMPLETED; row.provider='fake'; row.model='fake-model'
        row.estimated_cost=cost; row.response='Synthetic valid response'
        row.web_search_used=True; row.web_search_queries=[label]; row.web_sources=[label]
    a.session.commit()
    response=a.client.get('/providers', headers=a.headers[0])
    assert response.status_code==200, response.text
    assert 'foreign-secret' not in response.text
    item=response.json()[0]
    assert item['model_estimated_cost_usd']['fake-model']==.1
    assert item['model_estimated_cost_usd']['unpriced-model']==.1
    assert item['model_last_run_web_search_queries']['fake-model']==['owned']


def test_operator_actual_passive_state_and_shared_sports_reads(boundary, monkeypatch, tmp_path):
    a=boundary
    from app.domains.polymarket import router as runtime
    from app.domains.polymarket.schemas import PolymarketBotState
    from app.domains.sports_rankings import router as sports
    from app.domains.polymarket.passive_projection import read_persisted_state
    monkeypatch.setenv("POLYMARKET_DATA_DIR", str(tmp_path))
    state=read_persisted_state(a.users[0].id)
    read=AsyncMock(return_value=state)
    monkeypatch.setattr(runtime.polymarket_bot_manager, 'read_state', read)
    a.users[0].role=UserRole.ADMIN; a.session.commit()
    response=a.client.get('/polymarket/state',headers=a.headers[0])
    assert response.status_code==200, response.text
    read.assert_awaited_once_with(a.users[0].id)
    a.users[0].role=UserRole.USER; a.session.commit()
    assert a.client.get('/polymarket/state',headers=a.headers[0]).status_code==403
    assert read.await_count==1
    # Pure shared classification catalogue remains an ordinary authenticated read.
    monkeypatch.setattr(sports, 'CATALOGUE', [])
    monkeypatch.setattr(sports, 'load_participant_index', lambda _user_id: {})
    from app.domains.sports_rankings.models import SportsRankingSnapshot
    SportsRankingSnapshot.__table__.create(a.session.get_bind())
    shared = a.client.get('/api/sports-rankings', headers=a.headers[0])
    assert shared.status_code == 200, shared.text
    assert shared.json()['competitions'] == []
    assert shared.headers['cache-control'] == 'private, no-store'


@pytest.mark.asyncio
async def test_real_operator_warm_objects_preserved_then_revoked(boundary, monkeypatch):
    import asyncio
    from app.infrastructure.database import session as database
    from app.domains.polymarket.service import PolymarketBotManager, _LoopBoundBot
    from app.domains.polymarket_direct.service import PolymarketDirectBotManager
    a=boundary
    @asynccontextmanager
    async def scoped():yield a.db
    monkeypatch.setattr(database,'AsyncSessionLocal',scoped)
    a.users[0].role=UserRole.ADMIN;a.session.commit()
    cached=object()
    copy=PolymarketBotManager();direct=PolymarketDirectBotManager()
    copy._bots[a.users[0].id]=_LoopBoundBot(cached,asyncio.get_running_loop())
    direct._bots[a.users[0].id]=cached
    assert await copy.get_bot(a.users[0].id) is cached
    assert await direct.get_bot(a.users[0].id) is cached
    a.users[0].role=UserRole.USER;a.session.commit()
    for manager in (copy,direct):
        with pytest.raises(HTTPException) as exc:await manager.get_bot(a.users[0].id)
        assert exc.value.status_code==403
    # Revocation denies without deleting/relabeling the frozen operator object.
    assert copy._bots[a.users[0].id].bot is cached
    assert direct._bots[a.users[0].id] is cached


@pytest.mark.asyncio
async def test_operator_authorization_outage_is_closed_and_sanitized(monkeypatch):
    from app.infrastructure.database import session as database
    @asynccontextmanager
    async def unavailable():
        raise RuntimeError('PRIVATE DATABASE PARAMETERS')
        yield
    monkeypatch.setattr(database,'AsyncSessionLocal',unavailable)
    with pytest.raises(HTTPException) as exc:await access.require_operator_user_id(123)
    assert exc.value.status_code==503
    assert 'PRIVATE' not in exc.value.detail


def test_deployment_preflight_is_read_only_and_never_equates_cost_with_runtime(private_api):
    from app.uat2.stage05_role_preflight import role_preflight
    a=private_api
    a.users[0].email='tarun.singh6893@gmail.com';a.session.commit()
    report=role_preflight(a.session)
    assert report['proposed_cost_only_grant_ids']==[a.users[0].id]
    assert report['specific_security_approval_required'] is True
    assert report['migration_without_role_change_safe'] is False
    assert a.users[0].role==UserRole.USER
    a.users[0].role=UserRole.ADMIN;a.session.commit()
    report=role_preflight(a.session)
    assert report['proposed_cost_only_grant_ids']==[]
    assert report['migration_without_role_change_safe'] is True
    assert report['global_admin_promotions']==[]


def test_persisted_intent_owner_blocks_legacy_execution_and_keeps_history(boundary, monkeypatch):
    from datetime import datetime, timezone
    from app.domains.polymarket_auto_live.models import (
        PolymarketAutoLiveRunRecord, PolymarketAutoLiveDecisionRecord, PolymarketAutoLiveOrderIntentRecord)
    from app.infrastructure.database import sync_session
    from app.domains.polymarket_auto_live import tasks, order_intent_service
    a=boundary
    for model in (PolymarketAutoLiveRunRecord,PolymarketAutoLiveDecisionRecord,PolymarketAutoLiveOrderIntentRecord):
        model.__table__.create(a.session.get_bind())
    run=PolymarketAutoLiveRunRecord(id='synthetic-run',user_id=a.users[0].id,status='completed',
        triggered_by='synthetic',started_at=datetime.now(timezone.utc),summary='Frozen synthetic audit',payload={})
    a.session.add(run);a.session.flush()
    intent=PolymarketAutoLiveOrderIntentRecord(id='synthetic-intent',user_id=a.users[0].id,
        run_id=run.id,action='BUY',market_id='synthetic',status='READY',idempotency_key='synthetic-intent')
    a.session.add(intent);a.session.commit()
    class SessionView:
        def __enter__(self):return a.session
        def __exit__(self,*_):pass
    monkeypatch.setattr(sync_session,'SyncSessionLocal',SessionView)
    for operation in (order_intent_service.execute_order_intent_sync,order_intent_service.reconcile_order_intent_sync):
        with pytest.raises(PermissionError):operation(intent.id)
    with pytest.raises(PermissionError):tasks._begin_order_intent_operation(None,
        intent_id=intent.id,operation='execute',lease_token=None,source='synthetic')
    assert intent.status=='READY' and run.summary=='Frozen synthetic audit'
    a.users[0].role=UserRole.ADMIN;a.session.commit()
    access.require_operator_intent_sync(intent.id)
    a.users[0].is_active=False;a.session.commit()
    with pytest.raises(PermissionError):access.require_operator_intent_sync(intent.id)


@pytest.mark.asyncio
async def test_regular_dashboard_cannot_read_historical_singleton_or_combined_totals(monkeypatch):
    from datetime import datetime, timezone
    from app.domains.dashboard import service
    from app.domains.dashboard.schemas import DashboardHistoryPoint,DashboardPortfolioHistory
    point=lambda value:DashboardHistoryPoint(captured_at=datetime.now(timezone.utc),value=value)
    frozen=DashboardPortfolioHistory(india=[point(10)],indmoney=[point(20)],
        bullpen=[point(987654321)],combined=[point(987654351)])
    for name in ('_load_zerodha','_load_indmoney','_load_fx'):
        monkeypatch.setattr(service,name,AsyncMock(return_value=None))
    monkeypatch.setattr(service,'_load_portfolio_history',AsyncMock(return_value=frozen))
    forbidden=AsyncMock(side_effect=AssertionError('Singleton loader must not be entered'))
    monkeypatch.setattr(service,'_load_bullpen',forbidden)
    summary=await service.build_dashboard_summary(7)
    assert summary.portfolio_history.bullpen==summary.portfolio_history.combined==[]
    assert summary.portfolio_history.india[0].value==10
    assert summary.portfolio_history.indmoney[0].value==20
    assert '9876543' not in summary.model_dump_json()
    assert frozen.bullpen[0].value==987654321 # No historical rewrite.
    forbidden.assert_not_awaited()
