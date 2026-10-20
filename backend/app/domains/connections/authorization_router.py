"""Authenticated management routes; provider composition is explicitly closed by default."""
import json
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from app.core.security import JWTUtils
from app.domains.auth.dependencies import get_current_user
from app.domains.auth.session_revocation import authentication_time
from app.infrastructure.database.session import get_async_db
from .authorization import ConnectionAuthorization
from .crypto import ConnectionFault
from .service import ConnectionStore

router=APIRouter(prefix='/me/connection-authorization',tags=['connection-authorization'])


def authorization_runtime():
    # No environment flag can accidentally select a live adapter. A deployment
    # composition needs separately reviewed provider+secret+callback wiring.
    raise HTTPException(503,detail={'code':'CONNECTION_AUTHORIZATION_NOT_CONFIGURED'})


async def context(request:Request,response:Response,user=Depends(get_current_user),db=Depends(get_async_db),runtime=Depends(authorization_runtime)):
    response.headers['Cache-Control']='no-store'
    token=request.headers.get('authorization','').removeprefix('Bearer ')
    claims=JWTUtils.verify_token(token)
    authenticated=authentication_time(claims or {})
    if authenticated is None:raise HTTPException(401,'Authenticated session required')
    session=json.dumps([user.id,authenticated],separators=(',',':'))
    service=ConnectionAuthorization(ConnectionStore(db),runtime['provider'],
        callback_url=runtime['callback_url'],allowed_callbacks=runtime['allowed_callbacks'])
    return service,user.id,session,runtime


class Setup(BaseModel):
    mode:str=Field(pattern='^(user_owned|platform_managed)$')
    # Credentials are never accepted in browser JSON. The local synthetic
    # composition provisions known fakes; real tooling remains separately gated.


class Start(BaseModel):
    connection_id:str=Field(min_length=1,max_length=36)
    version:int=Field(gt=0)


class Callback(BaseModel):
    attempt_id:str=Field(min_length=1,max_length=36)
    state:str=Field(min_length=16,max_length=128)
    request_token:str=Field(min_length=1,max_length=512,repr=False)


class Review(BaseModel):
    attempt_id:str=Field(min_length=1,max_length=36)
    version:int=Field(gt=0)
    previous_id:str|None=Field(default=None,max_length=36)
    previous_version:int|None=Field(default=None,gt=0)


async def call(operation,db):
    try:return await operation
    except ConnectionFault as exc:
        await db.rollback()
        raise HTTPException(exc.status_code,detail={'code':exc.code}) from None


@router.get('/config')
async def config(response:Response,user=Depends(get_current_user),runtime=Depends(authorization_runtime)):
    response.headers['Cache-Control']='no-store'
    # Default is disabled. Private preview overrides this exact dependency.
    return {'enabled':True,'simulation':bool(runtime['provider'].simulation),'credential_entry_enabled':False}


@router.post('/synthetic-setup')
async def setup(body:Setup,ctx=Depends(context)):
    service,owner,_session,runtime=ctx
    if not runtime.get('synthetic_setup') or not service.provider.simulation:
        raise HTTPException(403,'Synthetic setup unavailable')
    args={'app_key':'synthetic-stage10-key','app_secret':'synthetic-stage10-secret'} if body.mode=='user_owned' else {'platform_ref':runtime.get('synthetic_platform_ref','synthetic-approved-platform')}
    row=await call(service.store.provision(owner,mode=body.mode,is_current=False,**args),service.db)
    return {'connection_id':row.id,'version':row.version,'simulation':True}


@router.post('/start')
async def start(body:Start,ctx=Depends(context)):
    s,o,session,_=ctx
    return await call(s.start(o,body.connection_id,body.version,session),s.db)


@router.post('/callback')
async def callback(body:Callback,ctx=Depends(context)):
    s,o,session,_=ctx
    return await call(s.callback(o,body.attempt_id,session,state=body.state,request_token=body.request_token),s.db)


@router.post('/confirm')
async def confirm(body:Review,ctx=Depends(context)):
    s,o,session,_=ctx
    return await call(s.confirm(o,body.attempt_id,session,version=body.version,previous_id=body.previous_id,previous_version=body.previous_version),s.db)


@router.post('/disconnect')
async def disconnect(body:Start,ctx=Depends(context)):
    s,o,_session,_=ctx
    return await call(s.disconnect(o,body.connection_id,body.version),s.db)
