"""Authenticated read-only receipts; no quota edits, sends or execution APIs."""
from datetime import datetime,timezone
from fastapi import APIRouter,Depends,HTTPException
from fastapi.responses import JSONResponse
from sqlalchemy import select
from app.domains.auth.dependencies import get_current_user
from app.infrastructure.database.session import get_async_db
from app.domains.recommendation_audit.models import SpendAccount,SpendAttempt
from .contracts import BoundaryDenied
from .private_effects import PrivateEffects,current_policy

router=APIRouter(prefix='/api-usage/limits',tags=['api-usage'])
NOTICES={
    'quota_blocked':'This partial analysis stopped before another provider call because a configured budget ceiling would be exceeded.',
    'uncertain':'The provider outcome is unknown. Its reservation remains held; automatic paid retry is blocked.',
    'cancelled_uncertain':'Cancellation is recorded, but the provider outcome is unknown. Funds stay reserved and no result can be consumed.',
    'cancelled_settled':'Cancellation remains recorded and the actual call cost is settled. Its result cannot continue the analysis.',
    'cancelled':'This work was cancelled or its module policy changed; it will not dispatch.',
    'expired':'This queued request belongs to an earlier budget day and must not start.',
    'queued':'Waiting for fair bounded worker admission.',
    'started':'Worst-case cost reserved before the provider call.',
    'settled':'Actual cost settled once against the original reservation.',
    'tariff_breach':'Actual cost exceeded the estimate. The full actual cost remains recorded; review tariff configuration before more work.',
}


@router.get('')
async def quota_receipts(user=Depends(get_current_user),db=Depends(get_async_db)):
    day=datetime.now(timezone.utc).date().isoformat()
    account=(await db.execute(select(SpendAccount).where(SpendAccount.user_id==user.id,SpendAccount.day==day))).scalar_one_or_none()
    rows=(await db.execute(select(SpendAttempt).where(SpendAttempt.user_id==user.id,SpendAttempt.operation_key.is_not(None)).order_by(SpendAttempt.created_at.desc(),SpendAttempt.id).limit(50))).scalars().all()
    result={'owner_id':user.id,'runtime_enabled':False,'pricing_status':'Production pricing and customer limits require external product approval; synthetic defaults are not a customer commitment.',
            'day_utc':day,'account':None if account is None else {k:str(getattr(account,k)) for k in ['spent_usd','reserved_usd','cap_usd']},
            'attempts':[{'id':r.id,'module_id':r.module_id,'status':r.status,'notice':NOTICES.get(r.status,'Receipt unavailable'),'reserved_upper_usd':str(r.upper_bound_usd),'actual_usd':str(r.actual_usd) if r.actual_usd is not None else None} for r in rows]}
    return JSONResponse(result,headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'})


@router.get('/private-artifacts/{artifact_id}')
async def download_private_artifact(artifact_id:str,user=Depends(get_current_user),db=Depends(get_async_db)):
    try:result=await db.run_sync(lambda session:PrivateEffects(session,current_policy).download(user.id,artifact_id))
    except (BoundaryDenied,PermissionError):raise HTTPException(404,'Owned available artifact required') from None
    return JSONResponse(result['content'],headers={'Cache-Control':'no-store','Content-Disposition':result['content_disposition'],'X-Content-Type-Options':'nosniff'})
