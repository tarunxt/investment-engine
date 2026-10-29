"""UAT2 adapters on existing application URL/schema contracts."""
import os
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from app.domains.auth.dependencies import get_current_user
from app.domains.zerodha.schemas import ZerodhaPlaceOrderRequest, ZerodhaPlaceOrderResponse, ZerodhaPortfolioOverviewResponse
from app.domains.dashboard.schemas import DashboardSummaryResponse
from app.uat2.adapters import FakeBroker, STAMP
from app.infrastructure.database.session import get_async_db

router = APIRouter(dependencies=[Depends(get_current_user)])
broker = FakeBroker()


@router.get('/uat2/status')
async def status():
    return {'simulation': True, 'commit': os.getenv('UAT2_SOURCE_COMMIT', 'unbuilt'),
            'available': ['dashboard', 'profile/preferences', 'synthetic India portfolio',
                          'accepted US imports', 'six-stage durable fake analysis',
                          'exact fake basket approval', 'durable fake execution and reconciliation'],
            'unavailable': ['live brokers', 'live AI', 'Sheets', 'external sends',
                            'sports/Bullpen workflows', 'public activation']}


@router.get('/zerodha/portfolio', response_model=ZerodhaPortfolioOverviewResponse)
async def portfolio():
    return broker.portfolio(os.getenv('UAT2_FIXTURE_STATE', 'populated') == 'empty')


@router.get('/zerodha/status')
async def broker_status():
    return {'connected': True, 'login_time': STAMP, 'expires_at': None,
            'direct_market_orders_enabled': False,
            'order_submission_blocked_reason': 'UAT2 simulated broker; no live account connected',
            'last_portfolio_sync_at': STAMP, 'last_portfolio_snapshot_date': STAMP[:10]}


@router.get('/zerodha/login-url')
async def broker_login_metadata():
    # The real portfolio screen loads this alongside status. No live login URL.
    return {'login_url': '', 'configured': False, 'simulation': True,
            'direct_market_orders_enabled': False,
            'order_submission_blocked_reason': 'Live broker connection unavailable in UAT2 simulation'}


@router.get('/zerodha/orders')
async def fake_order_history():
    return {'status': 'success', 'data': [], 'simulation': True}


@router.post('/zerodha/orders', response_model=ZerodhaPlaceOrderResponse)
async def fake_order(order: ZerodhaPlaceOrderRequest):
    return broker.place(order.model_dump())


@router.get('/dashboard/summary', response_model=DashboardSummaryResponse)
async def dashboard(current_user=Depends(get_current_user), db=Depends(get_async_db)):
    from app.domains.modules.visibility import visible_module_ids
    from app.domains.dashboard.service import _load_indmoney_with_session
    selected = set(await visible_module_ids(db, current_user.id))
    india_allowed = 'zerodha_rebalance' in selected
    us_allowed = 'indmoney_us' in selected
    empty = os.getenv('UAT2_FIXTURE_STATE', 'populated') == 'empty'
    portfolio = broker.portfolio(empty)['latest'] if india_allowed else None
    india = None if empty or not india_allowed else {
        **{k: v for k, v in portfolio.items() if k not in {'holdings', 'positions'}},
        'top_holdings': [dict(symbol=h['tradingsymbol'], company_name='Synthetic '+h['tradingsymbol'],
                             current_value=h['quantity']*h['last_price'],
                             invested_value=h['quantity']*h['average_price'], pnl=h['pnl'])
                         for h in portfolio['holdings']], 'history': []}
    us = (await _load_indmoney_with_session(db, current_user.id)).model_dump(mode='json') if us_allowed else None
    from datetime import datetime, timezone
    from app.domains.fx_rates.cost_read import read_cost_fx
    from app.domains.fx_rates.service import USD_INR_STALE_AFTER
    now = datetime.now(timezone.utc)
    fx = (await read_cost_fx(db, current_user.id, now=now))['fx'] if us_allowed else {
        'pair': 'USD/INR', 'value': None, 'source': None, 'as_of': None,
        'age_seconds': None, 'stale_after_seconds': int(USD_INR_STALE_AFTER.total_seconds()), 'status': 'unavailable'}
    return {'generated_at': now.isoformat(), 'fx': fx,
            'usd_inr_rate': fx['value'] if fx['status']=='valid' else None,
            'usd_inr_status': fx['status'], 'usd_inr_source': fx['source'],
            'usd_inr_as_of': fx['as_of'], 'usd_inr_age_seconds': fx['age_seconds'],
            'zerodha': {'connected': True, 'snapshot': india} if india_allowed else None,
            'indmoney_us': us,
            'sections': {name: {'status': 'ok', 'duration_ms': 0, 'error': None}
                         for name, allowed in [('zerodha', india_allowed), ('indmoney_us', us_allowed), ('fx', us_allowed)] if allowed}}



class SimulationRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=2000)


@router.post('/uat2/ai')
async def queue_fake_ai(request: SimulationRequest):
    from app.uat2.worker import fake_ai
    task = fake_ai.delay(request.prompt)
    return {'task_id': task.id, 'status': 'pending', 'simulation': True}


@router.get('/uat2/ai/{task_id}')
async def read_fake_ai(task_id: str):
    from app.uat2.worker import celery
    if len(task_id) != 36:
        raise HTTPException(400, 'Invalid task ID')
    result = celery.AsyncResult(task_id)
    return {'status': result.state, 'result': result.result if result.successful() else None,
            'simulation': True}


class SinkRequest(BaseModel):
    subject: str = Field(min_length=1, max_length=100)
    body: str = Field(min_length=1, max_length=2000)


@router.post('/uat2/email')
async def capture_email(request: SinkRequest):
    from app.uat2.adapters import EmailSink
    from app.core.uat2 import artifact_directory
    return EmailSink(artifact_directory() + '/email-sink').send(request.subject, request.body)


@router.get('/uat2/export')
async def local_export():
    from fastapi.responses import Response
    return Response('symbol,quantity,simulation\nUATTECH,10,true\nUATBANK,20,true\n',
                    media_type='text/csv',
                    headers={'Content-Disposition': 'attachment; filename="uat2-synthetic.csv"'})
