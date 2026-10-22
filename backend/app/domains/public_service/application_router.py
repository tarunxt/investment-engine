"""Authenticated disposable privacy/evidence routes, denied without binding."""
from fastapi import APIRouter,Depends,HTTPException
from pydantic import BaseModel,ConfigDict,StrictBool
from sqlalchemy.exc import DBAPIError
from .transaction_outcomes import serialization_conflict
from app.domains.auth.dependencies import get_current_user
from app.infrastructure.database.session import get_async_db
from app.domains.ai_limits.contracts import BoundaryDenied
from .application_bindings import request_bindings
from fastapi.responses import JSONResponse

def response(value):
    return JSONResponse(value,headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','X-Credx-Scope':'disposable-synthetic-only'})

router=APIRouter(prefix='/disposable',tags=['account'])

class ExecuteBody(BaseModel):
    model_config=ConfigDict(extra='forbid')
    confirmed:StrictBool=False

@router.get('/reviewed-eligibility')
async def reviewed_eligibility(user=Depends(get_current_user),binding=Depends(request_bindings),db=Depends(get_async_db)):
    def read(s):
        binding.scope.validate(s)
        return binding.server.onboarding(s,user.id)
    try:return response(await db.run_sync(read))
    except BoundaryDenied:raise HTTPException(409,'Owned reviewed evidence required') from None

@router.post('/privacy-requests/{id}/execute')
async def execute_privacy(id:str,body:ExecuteBody,user=Depends(get_current_user),binding=Depends(request_bindings),db=Depends(get_async_db)):
    if body.confirmed is not True:raise HTTPException(409,'Exact disposable execution confirmation required')
    try:
        result=await db.run_sync(lambda s:binding.privacy(s,user.id).execute(user.id,id))
        await db.commit();return response(result)
    except BoundaryDenied:
        await db.rollback();raise HTTPException(409,'Owned current disposable privacy request required') from None
    except DBAPIError as exc:
        await db.rollback()
        if serialization_conflict(exc):raise HTTPException(409,'Concurrent privacy change; retry in a fresh request',headers={'Retry-After':'1'}) from None
        raise
    except BaseException:
        await db.rollback();raise

@router.get('/privacy-requests/{id}/result')
async def privacy_result(id:str,user=Depends(get_current_user),binding=Depends(request_bindings),db=Depends(get_async_db)):
    try:return response(await db.run_sync(lambda s:binding.privacy(s,user.id).result(user.id,id)))
    except BoundaryDenied:raise HTTPException(404,'Owned completed disposable result required') from None
