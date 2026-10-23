"""Authenticated controls for server-owned analysis. Default composition is off."""
from datetime import datetime
from typing import Literal
from fastapi import APIRouter,Depends,HTTPException,Response,Request
from pydantic import BaseModel,ConfigDict,Field,field_validator
from sqlalchemy import select
from app.domains.auth.dependencies import get_current_user
from app.infrastructure.database.session import get_async_db
from app.domains.runs.models import AutoRebalanceWorkflow
from app.domains.runs.analysis_workflows.runtime import configured_runtime
from app.domains.runs.analysis_workflows.service import Workflows
from app.domains.runs.analysis_workflows.contracts import WorkflowDenied

router=APIRouter(prefix='/runs/analysis-workflows',tags=['analysis-workflows'])
class Create(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True)
    portfolio:Literal['indmoney_us','india']
    key:str=Field(min_length=8,max_length=96)
    snapshot_id:int|None=Field(default=None,gt=0)
    scheduled_at:datetime|None=None
    schedule_id:str|None=Field(default=None,min_length=1,max_length=80)
    @field_validator('scheduled_at',mode='before')
    @classmethod
    def aware(cls,v):
        if isinstance(v,str):v=datetime.fromisoformat(v.replace('Z','+00:00'))
        if v is not None and (not isinstance(v,datetime) or v.tzinfo is None):raise ValueError('Timezone required')
        return v
class Control(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True)
    portfolio:Literal['indmoney_us','india']
    version:int=Field(ge=0)
    action:Literal['pause','cancel','resume','retry']

class SyntheticSource(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True)
    portfolio:Literal['india']
    key:str|None=Field(default=None,min_length=8,max_length=96)

async def optional_analysis_runtime(request:Request,user=Depends(get_current_user),db=Depends(get_async_db)):
    from app.uat2.http_bindings import request_binding, analysis_runtime as scoped_runtime
    if request_binding(request) is not None:
        return await scoped_runtime(request,db,user.id)
    return configured_runtime()

def analysis_runtime(value=Depends(optional_analysis_runtime)):

    if value is None:raise HTTPException(503,{'code':'DURABLE_ANALYSIS_UNAVAILABLE','detail':'Approved runtime/plan/calendar binding unavailable; no jobs started'})
    return value

async def private(response:Response):response.headers['Cache-Control']='private, no-store'
router.dependencies.append(Depends(private))

@router.get('/config')
async def analysis_config(user=Depends(get_current_user),runtime=Depends(optional_analysis_runtime)):
    return {'enabled':runtime is not None,'analysis_only':True,'orders_authorized':False}

@router.get('')
async def list_analysis_workflows(db=Depends(get_async_db),user=Depends(get_current_user),runtime=Depends(analysis_runtime)):
    def read(s):
        rows=s.scalars(select(AutoRebalanceWorkflow).where(AutoRebalanceWorkflow.user_id==user.id,AutoRebalanceWorkflow.orchestration_kind=='analysis_v1').order_by(AutoRebalanceWorkflow.id.desc()).limit(30)).all()
        return [Workflows(s,runtime).detail(user.id,row.id) for row in rows]
    return {'owner_id':user.id,'items':await db.run_sync(read)}

@router.get('/{workflow_id}')
async def get_analysis_workflow(workflow_id:int,db=Depends(get_async_db),user=Depends(get_current_user),runtime=Depends(analysis_runtime)):
    return await db.run_sync(lambda s:Workflows(s,runtime).detail(user.id,workflow_id))

@router.post('')
async def create_analysis_workflow(body:Create,db=Depends(get_async_db),user=Depends(get_current_user),runtime=Depends(analysis_runtime)):
    try:
        row=await db.run_sync(lambda s:Workflows(s,runtime).create(user.id,**body.model_dump()))
        result=await db.run_sync(lambda s:Workflows(s,runtime).detail(user.id,row.id));await db.commit();return result
    except WorkflowDenied:await db.rollback();raise HTTPException(403,'Current analysis policy or inputs denied') from None

@router.post('/synthetic-source')
async def acquire_synthetic_source(body:SyntheticSource,db=Depends(get_async_db),user=Depends(get_current_user),runtime=Depends(analysis_runtime)):
    from app.domains.runs.analysis_workflows.synthetic_composition import SyntheticAnalysis
    composition=getattr(runtime.policy,'__self__',None)
    if type(composition) is not SyntheticAnalysis:
        raise HTTPException(503,'Explicit synthetic acquisition binding unavailable')
    try:
        result=await db.run_sync(lambda session:composition.acquire(session,user.id,key=body.key))
        await db.commit();return result
    except WorkflowDenied:
        await db.rollback();raise HTTPException(403,'Current owned synthetic source policy required') from None

@router.post('/{workflow_id}/controls')
async def control_analysis_workflow(workflow_id:int,body:Control,db=Depends(get_async_db),user=Depends(get_current_user),runtime=Depends(analysis_runtime)):
    try:
        # The persisted portfolio remains authoritative, irrespective of body.
        row=await db.run_sync(lambda s:Workflows(s,runtime).control(user.id,workflow_id,body.action,body.version))
        result=await db.run_sync(lambda s:Workflows(s,runtime).detail(user.id,row.id));await db.commit();return result
    except WorkflowDenied:await db.rollback();raise HTTPException(403,'Current analysis policy or inputs denied') from None
