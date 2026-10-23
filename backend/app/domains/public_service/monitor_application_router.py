"""Authenticated disposable monitor intake/status and appointed operator actions."""
from fastapi import APIRouter,Depends,HTTPException
from sqlalchemy.exc import DBAPIError
from app.domains.auth.dependencies import get_current_user
from app.infrastructure.database.session import get_async_db
from app.domains.ai_limits.contracts import BoundaryDenied
from .application_bindings import request_bindings
from .application_router import ExecuteBody,response
from .transaction_outcomes import serialization_conflict

router=APIRouter(prefix='/monitor',tags=['account'])

async def transact(db,operation):
    try:
        result=await db.run_sync(operation);await db.commit();return response(result)
    except BoundaryDenied:
        await db.rollback();raise HTTPException(409,'Current owned disposable monitor authority required') from None
    except DBAPIError as exc:
        await db.rollback()
        if serialization_conflict(exc):raise HTTPException(409,'Concurrent monitor change; retry in a fresh request',headers={'Retry-After':'1'}) from None
        raise
    except BaseException:
        await db.rollback();raise

@router.post('/observations')
async def observe_monitor(body:ExecuteBody,user=Depends(get_current_user),binding=Depends(request_bindings),db=Depends(get_async_db)):
    if body.confirmed is not True:raise HTTPException(409,'Exact disposable observation confirmation required')
    return await transact(db,lambda s:binding.monitoring().observe(s,user.id))

@router.get('/alerts/{id}')
async def monitor_status(id:str,user=Depends(get_current_user),binding=Depends(request_bindings),db=Depends(get_async_db)):
    return await transact(db,lambda s:binding.monitoring().status(s,user.id,id))

@router.post('/owners/{owner_id}/alerts/{id}/acknowledge')
async def acknowledge_monitor(owner_id:int,id:str,body:ExecuteBody,user=Depends(get_current_user),binding=Depends(request_bindings),db=Depends(get_async_db)):
    if body.confirmed is not True:raise HTTPException(409,'Exact disposable acknowledgement required')
    return await transact(db,lambda s:binding.monitoring().acknowledge(s,owner_id,id,user.id))

@router.post('/owners/{owner_id}/alerts/{id}/escalate')
async def escalate_monitor(owner_id:int,id:str,body:ExecuteBody,user=Depends(get_current_user),binding=Depends(request_bindings),db=Depends(get_async_db)):
    if body.confirmed is not True:raise HTTPException(409,'Exact disposable escalation required')
    return await transact(db,lambda s:binding.monitoring().escalate(s,owner_id,id,user.id))
