"""Read-only private metadata. No credentials or mutating setup endpoints."""
from fastapi import APIRouter,Depends,HTTPException,Response
from sqlalchemy import select
from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import User
from app.infrastructure.database.session import get_async_db
from app.core.uat2 import uat2_mode
from .models import IntegrationConnection
from .service import ConnectionStore,utc
from .crypto import ConnectionFault
from datetime import datetime,timezone
router=APIRouter(prefix='/me/connections',tags=['connections'])

async def describe_connection(store,row):
    reason=None;ready=False;key_version=None;platform_approved=False
    try:
        secret,payload=await store.material(row);key_version=secret.key_version
        platform_approved=store.platform.approval_verified(payload.get("platform_ref"),payload.get("app_version"))
        token=await store.resolve_token(row.owner_id,row.id);ready=token is not None
    except ConnectionFault as exc:reason=exc.code
    # Storage readiness is not a module/financial permission; UAT2 never enables
    # its real adapter even if test data accidentally contains a valid binding.
    if uat2_mode():ready=False;reason='UAT2_SIMULATION_ONLY'
    account=row.provider_account_id
    return {'id':row.id,'provider':row.provider,'app_ownership_mode':row.app_ownership_mode,
        'is_current':row.is_current,'account_label':('***'+account[-4:]) if account else None,'version':row.version,'status':row.status,
        'token_expires_at':row.token_expires_at,'encryption_key_version':key_version,
        'credential_storage':'encrypted_per_connection' if row.app_ownership_mode=='user_owned' else 'platform_app_service_and_encrypted_per_connection_token',
        'readiness':{'ready_for_adapter':ready,'reason':reason,'platform_approval_verified':platform_approved if row.app_ownership_mode=='platform_managed' else None,
            'module_access_granted':False,'financial_execution_granted':False,'authorization_flow':'stage10_pending'}}

@router.get('')
async def list_connections(response:Response,db=Depends(get_async_db),current_user:User=Depends(get_current_user)):
    response.headers['Cache-Control']='no-store'
    store=ConnectionStore(db)
    rows=(await db.execute(select(IntegrationConnection).where(IntegrationConnection.owner_id==current_user.id).order_by(IntegrationConnection.created_at.desc()).limit(50))).scalars().all()
    return {'schema_version':1,'owner_id':current_user.id,'one_current_account_per_provider':True,
        'modes':[{'mode':'user_owned','supported':True,'activation':'authorization_required','secrets_in_browser':False},
                 {'mode':'platform_managed','supported':True,'activation':'verified_provider_approval_and_authorization_required','secrets_in_browser':False}],
        'connections':[await describe_connection(store,row) for row in rows]}

@router.get('/{connection_id}')
async def get_connection(connection_id:str,response:Response,db=Depends(get_async_db),current_user:User=Depends(get_current_user)):
    response.headers['Cache-Control']='no-store';store=ConnectionStore(db)
    try:row=await store.get(current_user.id,connection_id)
    except ConnectionFault as exc:raise HTTPException(exc.status_code,{'code':exc.code}) from None
    return {'owner_id':current_user.id,'connection':await describe_connection(store,row)}
