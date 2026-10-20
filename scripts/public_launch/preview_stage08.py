"""Explicit local-only, no-network adapters for real Stage08 UI walkthroughs."""
import os
if os.environ.get('STAGE01_PREVIEW')!='synthetic-only':raise RuntimeError('Local synthetic preview only')
from fastapi import APIRouter,Depends,HTTPException
from app.domains.auth.dependencies import get_current_user
from app.infrastructure.database.session import get_async_db
from app.domains.modules.policy import ModulePolicy
from app.domains.modules.visibility import visible_module_ids
from app.uat2 import router as fake
from app.domains.indmoney_us.router import router as us_router
from app.domains.indmoney_us.models import IndMoneyUsPortfolioSnapshot
from app.uat2.adapters import STAMP
TABLES=(IndMoneyUsPortfolioSnapshot.__table__,)
READS={'/providers','/zerodha/portfolio','/zerodha/status','/zerodha/login-url','/zerodha/orders','/dashboard/summary','/indmoney-us/portfolio','/zerodha/threats/latest','/indmoney-us/threats/latest'}

def install(app):
    async def india(user=Depends(get_current_user),db=Depends(get_async_db)):
        decision=await ModulePolicy(db).authorize(owner_id=user.id,resource_owner_id=user.id,module_id='zerodha_rebalance',capability='view',boundary='http')
        if not decision.allowed:raise HTTPException(403,'Synthetic India module disabled')
    for route in fake.router.routes:
        if route.path in {'/zerodha/portfolio','/zerodha/status','/zerodha/login-url'} and route.methods=={'GET'}:
            app.include_router(APIRouter(routes=[route]),dependencies=[Depends(india)])
    for route in us_router.routes:
        if route.path in {'/indmoney-us/portfolio','/indmoney-us/portfolio/{snapshot_id}'} and route.methods=={'GET'}:app.include_router(APIRouter(routes=[route]))
    @app.get('/providers')
    async def fake_provider_metadata(user=Depends(get_current_user),db=Depends(get_async_db)):
        from app.domains.modules.registry import INTERNAL_ANALYSIS_CONSUMERS
        if not set(await visible_module_ids(db,user.id))&{m.value for m in INTERNAL_ANALYSIS_CONSUMERS}:raise HTTPException(403,'Eligible synthetic analysis consumer required')
        return [{'name':'synthetic','models':['offline'],'configured':True,'model_compatibility':{'offline':{'compatible':True,'reason':'Offline synthetic preview only'}},'model_estimated_cost_usd':{'offline':0},'model_estimated_cost_inr':{'offline':0}}]
    @app.get('/zerodha/orders',dependencies=[Depends(india)])
    async def no_orders():return {'data':[],'synthetic':True,'direct_market_orders_enabled':False}
    @app.get('/dashboard/summary')
    async def summary(user=Depends(get_current_user),db=Depends(get_async_db)):
        ids=await visible_module_ids(db,user.id)
        data=await fake.dashboard()
        if 'zerodha_rebalance' not in ids:data['zerodha']=None
        if 'indmoney_us' in ids:
            data['indmoney_us']={'snapshot':{'id':user.id,'snapshot_date':STAMP[:10],'captured_at':STAMP,'source':'synthetic-local','parse_status':'parsed','parse_warnings':['Synthetic local preview'],'holdings_count':2,'current_value':1050,'invested_value':1000,'wallet_balance':100,'total_return_value':50,'total_return_percent':5,'day_return_value':5,'day_return_percent':.48,'top_holdings':[],'history':[]}}
        else:data['indmoney_us']=None
        data['bullpen']=None
        for name,module in [('zerodha','zerodha_rebalance'),('indmoney_us','indmoney_us')]:
            if module not in ids:data['sections'][name]={'status':'unavailable','duration_ms':0,'error':'Module disabled'}
        return data
    @app.get('/zerodha/threats/latest',dependencies=[Depends(india)])
    async def no_india_threats():return {'analysis':None,'synthetic':True}
    @app.get('/indmoney-us/threats/latest')
    async def no_us_threats(user=Depends(get_current_user),db=Depends(get_async_db)):
        if 'indmoney_us' not in await visible_module_ids(db,user.id):raise HTTPException(403,'Synthetic US module disabled')
        return {'analysis':None,'synthetic':True}
