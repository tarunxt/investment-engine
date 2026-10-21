"""Explicit user confirmation APIs; no normal-runtime activation endpoint."""
from fastapi import APIRouter,Depends,HTTPException,Response
from pydantic import BaseModel,ConfigDict,Field
from app.domains.auth.dependencies import get_current_user
from app.infrastructure.database.session import get_async_db
from .service import Orders
from .contracts import OrderDenied

router=APIRouter(prefix='/order-intents',tags=['confirmed-orders'])

def get_runtime():
    # No configuration flag or registration API installs a financial runtime.
    raise HTTPException(503,'Order preparation is unavailable; financial runtime remains disabled')

def get_read_runtime():
    # Deliberately absent in the real application. Only a separately composed,
    # network-denied synthetic preview overrides this dependency in-process.
    return None

class Draft(BaseModel):
    model_config=ConfigDict(extra='forbid')
    operation_key:str=Field(min_length=1,max_length=128)
    connection_id:str
    module_version:int=Field(gt=0)
    order:dict

class Confirmation(BaseModel):
    model_config=ConfigDict(extra='forbid')
    displayed_digest:str=Field(pattern='^[0-9a-f]{64}$')
    action:str

async def invoke(db,user,runtime,method,*args,**kwargs):
    try:
        def work(session):
            result=getattr(Orders(session,policy=runtime.policy,risk=runtime.risk),method)(user.id,*args,**kwargs)
            if isinstance(result,dict):return result
            return {'id':result.id,'state':result.state,'review_digest':result.review_digest,'approval_expires_at':result.expires_at.isoformat() if result.expires_at else None,'simulation_only':True}
        result=await db.run_sync(work);await db.commit();return result
    except (OrderDenied,PermissionError):
        await db.rollback();raise HTTPException(409,'Current owned order, policy and explicit review required') from None

@router.get('/status')
async def status(user=Depends(get_current_user)):
    return {'runtime_enabled':False,'real_financial_execution':False,'simulation_only':True,'approval_policy':'Exact authenticated order or basket confirmation; no standing consent'}

@router.get('/positions')
async def positions(response:Response,user=Depends(get_current_user),db=Depends(get_async_db)):
    from .positions_view import owned_positions
    response.headers['Cache-Control']='private, no-store'
    return await db.run_sync(lambda session:owned_positions(session,user.id))

@router.get('/reviews')
async def reviews(response:Response,user=Depends(get_current_user),db=Depends(get_async_db),runtime=Depends(get_read_runtime)):
    from .presentation import owned_reviews
    response.headers['Cache-Control']='private, no-store'
    return await db.run_sync(lambda session:owned_reviews(session,user.id,runtime=runtime))

@router.get('/reviews/{id}')
async def review_record(id:str,response:Response,user=Depends(get_current_user),db=Depends(get_async_db),runtime=Depends(get_read_runtime)):
    from .presentation import owned_reviews
    response.headers['Cache-Control']='private, no-store'
    result=await db.run_sync(lambda session:owned_reviews(session,user.id,intent_id=id,runtime=runtime))
    if not result['intents']:raise HTTPException(404,'Order record unavailable',headers={'Cache-Control':'private, no-store'})
    return result

@router.post('')
async def create(body:Draft,user=Depends(get_current_user),db=Depends(get_async_db),runtime=Depends(get_runtime)):
    from app.domains.modules.lifecycle import WorkIdentity
    try:
        def work(session):
            row=Orders(session,policy=runtime.policy,risk=runtime.risk).create(WorkIdentity(user.id,'zerodha_rebalance',body.module_version),body.operation_key,body.connection_id,body.order)
            return {'id':row.id,'state':row.state,'simulation_only':True}
        result=await db.run_sync(work);await db.commit();return result
    except (OrderDenied,PermissionError):
        await db.rollback();raise HTTPException(409,'Current owned connection and module policy required') from None

@router.post('/{id}/validate')
async def validate(id:str,user=Depends(get_current_user),db=Depends(get_async_db),runtime=Depends(get_runtime)):
    return await invoke(db,user,runtime,'validate',id)

@router.post('/{id}/review')
async def review(id:str,user=Depends(get_current_user),db=Depends(get_async_db),runtime=Depends(get_runtime)):
    return await invoke(db,user,runtime,'review',id)

@router.post('/{id}/approve')
async def approve(id:str,body:Confirmation,user=Depends(get_current_user),db=Depends(get_async_db),runtime=Depends(get_runtime)):
    from .authority import authenticated_confirmation
    if user.is_active is not True or user.is_verified is not True:raise HTTPException(403,'Verified active identity required')
    with authenticated_confirmation(user,id,body.displayed_digest):
        return await invoke(db,user,runtime,'approve',id,body.displayed_digest,action=body.action)

@router.post('/{id}/revoke')
async def revoke(id:str,user=Depends(get_current_user),db=Depends(get_async_db),runtime=Depends(get_runtime)):
    return await invoke(db,user,runtime,'revoke',id)
