"""Owner-only request receipts. No external export, erasure or approval route."""
from fastapi import APIRouter,Depends,HTTPException,Request
from fastapi.responses import JSONResponse
from sqlalchemy.exc import DBAPIError
from .transaction_outcomes import serialization_conflict
from pydantic import BaseModel,Field,ConfigDict,StrictBool
from app.domains.auth.dependencies import get_current_user
from app.infrastructure.database.session import get_async_db
from app.domains.ai_limits.contracts import BoundaryDenied
from .privacy import PrivacyRequests,public_receipt
from .eligibility import eligibility_status,declare
router=APIRouter(prefix='/account/operations',tags=['account'])
class PrivacyBody(BaseModel):
    model_config=ConfigDict(extra='forbid')
    key:str=Field(min_length=1,max_length=100)
    kind:str
    confirmed:StrictBool=False
class ResidencyBody(BaseModel):
    model_config=ConfigDict(extra='forbid')
    country:str=Field(max_length=2)
def response(value):return JSONResponse(value,headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'})
@router.get('/privacy-requests')
async def privacy_history(user=Depends(get_current_user),db=Depends(get_async_db)):
    try:return response(await db.run_sync(lambda s:PrivacyRequests(s).history(user.id)))
    except BoundaryDenied:raise HTTPException(409,'Current owned request history unavailable') from None

@router.get('/private-account-download')
async def private_account_download(request:Request,user=Depends(get_current_user)):
    from app.uat2.http_bindings import request_binding,attach_request_binding
    from app.infrastructure.database.session import AsyncSessionLocal
    from .account_download import snapshot
    binding=request_binding(request)
    if binding is None:raise HTTPException(503,'Account export runtime inventory is not admitted')
    async with AsyncSessionLocal() as db:
        try:
            if db.bind.dialect.name=='postgresql':await db.connection(execution_options={'isolation_level':'REPEATABLE READ'})
            attach_request_binding(request,db)
            value=await db.run_sync(lambda s:snapshot(s,user.id,binding.scope))
            return JSONResponse(value,headers={'Cache-Control':'private, no-store','Content-Disposition':'attachment; filename="credx-private-account-snapshot.json"','X-Content-Type-Options':'nosniff','X-Credx-Scope':'partial-owned-account'})
        except (BoundaryDenied,PermissionError):
            raise HTTPException(409,'Owned export inventory or integrity could not be verified; no partial response released') from None
        except DBAPIError:
            raise HTTPException(503,'Account export storage unavailable; no snapshot released') from None
        finally:
            from app.uat2.policy_bindings import SESSION
            db.sync_session.info.pop(SESSION,None)

@router.post('/privacy-requests')
async def privacy_request(body:PrivacyBody,user=Depends(get_current_user),db=Depends(get_async_db)):
    try:
        value=await db.run_sync(lambda s:public_receipt(PrivacyRequests(s).request(user.id,body.key,body.kind,confirmed=body.confirmed)))
        await db.commit();return response(value)
    except BoundaryDenied:
        await db.rollback();raise HTTPException(409,'Owned exact privacy request required') from None
@router.get('/privacy-requests/{id}')
async def privacy_status(id:str,user=Depends(get_current_user),db=Depends(get_async_db)):
    try:return response(await db.run_sync(lambda s:public_receipt(PrivacyRequests(s).owned(user.id,id))))
    except BoundaryDenied:raise HTTPException(404,'Owned request required') from None
@router.post('/privacy-requests/{id}/cancel')
async def privacy_cancel(id:str,user=Depends(get_current_user),db=Depends(get_async_db)):
    try:
        value=await db.run_sync(lambda s:public_receipt(PrivacyRequests(s).cancel(user.id,id)));await db.commit();return response(value)
    except BoundaryDenied:
        await db.rollback();raise HTTPException(404,'Owned pending request required') from None
    except DBAPIError as exc:
        await db.rollback()
        if serialization_conflict(exc):raise HTTPException(409,'Concurrent privacy change; retry in a fresh request',headers={'Retry-After':'1'}) from None
        raise
@router.get('/eligibility')
async def eligibility(user=Depends(get_current_user),db=Depends(get_async_db)):
    return response(await eligibility_status(db,user.id))
@router.post('/eligibility')
async def residency(body:ResidencyBody,user=Depends(get_current_user),db=Depends(get_async_db)):
    try:
        value=await declare(db,user.id,body.country);await db.commit();return response(value)
    except BoundaryDenied:
        await db.rollback();raise HTTPException(409,'India-resident declaration required') from None


@router.get('/privacy-requests/{id}/export')
async def privacy_export(id:str,user=Depends(get_current_user),db=Depends(get_async_db)):
    try:
        value=await db.run_sync(lambda s:PrivacyRequests(s).export(user.id,id))
        return JSONResponse(value,headers={'Cache-Control':'private, no-store','Content-Disposition':'attachment; filename="synthetic-account.json"','X-Content-Type-Options':'nosniff','X-Credx-Scope':'synthetic-only'})
    except BoundaryDenied:raise HTTPException(404,'Owned completed export required') from None


@router.get('/diagnostics')
async def own_diagnostics(request:Request,user=Depends(get_current_user),db=Depends(get_async_db)):
    from .monitoring import OperationalMonitor
    from app.uat2.http_bindings import request_binding
    binding=request_binding(request)
    return response(await db.run_sync(lambda s:binding.operations.snapshot(s,user.id) if binding is not None else OperationalMonitor(s).snapshot(user.id)))

class ConsentBody(BaseModel):
    model_config=ConfigDict(extra='forbid')
    actor_id:int=Field(gt=0,strict=True)
    scopes:list[str]=Field(min_length=1,max_length=2)
    ticket:str=Field(min_length=3,max_length=100)
    confirmed:StrictBool=False

@router.post('/support-consents')
async def support_consent(body:ConsentBody,user=Depends(get_current_user),db=Depends(get_async_db)):
    from .support import SupportAccess
    try:
        value=await db.run_sync(lambda s:SupportAccess(s).consent(user.id,body.actor_id,body.scopes,body.ticket,confirmed=body.confirmed));await db.commit()
        return response({'id':str(value.id),'owner_id':user.id,'state':'granted','expires_at':value.payload['expires_at']})
    except BoundaryDenied:
        await db.rollback();raise HTTPException(409,'Exact owned support consent required') from None

@router.post('/support-consents/{id}/revoke')
async def support_revoke(id:str,user=Depends(get_current_user),db=Depends(get_async_db)):
    from .support import SupportAccess
    try:
        await db.run_sync(lambda s:SupportAccess(s).revoke(user.id,id));await db.commit();return response({'state':'revoked'})
    except BoundaryDenied:
        await db.rollback();raise HTTPException(404,'Owned consent required') from None

@router.get('/support-consents/{id}/access')
async def support_read(id:str,scope:str,request:Request,user=Depends(get_current_user),db=Depends(get_async_db)):
    from .support import SupportAccess
    from app.uat2.http_bindings import request_binding
    binding=request_binding(request)
    diagnostics=binding.operations.snapshot if binding is not None else None
    try:return response(await db.run_sync(lambda s:SupportAccess(s,diagnostics=diagnostics).read(user.id,id,scope)))
    except BoundaryDenied:
        await db.rollback();raise HTTPException(403,'Support access denied') from None


# No default binding: these authenticated routes return unavailable until an
# explicit disposable application configuration is independently installed.
from .application_router import router as disposable_router
router.include_router(disposable_router)
