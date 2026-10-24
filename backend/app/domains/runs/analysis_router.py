"""Authenticated controls for server-owned analysis. Default composition is off."""
from datetime import datetime
from typing import Literal
from fastapi import APIRouter,Depends,HTTPException,Response,Request
from pydantic import BaseModel,ConfigDict,Field,field_validator,model_validator
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
    expected_source_hash:str|None=Field(default=None,pattern=r'^[a-f0-9]{64}$')
    expected_plan_hash:str|None=Field(default=None,pattern=r'^[a-f0-9]{64}$')
    setup_schema_version:Literal[1]|None=None
    @model_validator(mode='after')
    def reviewed_pair(self):
        if (self.expected_source_hash is None)!=(self.expected_plan_hash is None) or self.setup_schema_version is not None and self.expected_source_hash is None:raise ValueError('Both reviewed hashes required')
        return self
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

def synthetic_setup(runtime):
    from .analysis_workflows.synthetic_composition import SyntheticAnalysis
    return type(getattr(runtime.source,'__self__',None)) is SyntheticAnalysis if runtime is not None else False

@router.get('/config')
async def analysis_config(user=Depends(get_current_user),runtime=Depends(optional_analysis_runtime)):
    return {'enabled':runtime is not None,'analysis_only':True,'orders_authorized':False,
        'candidate_preview_available':synthetic_setup(runtime),'candidate_modes':{
            'llm_discovery':{'available':False,'reason':'No approved candidate-discovery contract is installed'},
            'shortlist_only':{'available':False,'reason':'Candidate preview is not an accepted analysis universe'},
            'combined':{'available':False,'reason':'No approved combined-universe/batch contract is installed'}}}

@router.get('/setup-context')
async def setup_context(portfolio:Literal['india','indmoney_us'],db=Depends(get_async_db),user=Depends(get_current_user),runtime=Depends(analysis_runtime)):
    from .analysis_workflows.contracts import digest
    def read(session):
        runtime.policy(session,user.id,portfolio,version=None,scheduled=False)
        source=runtime.source(session,user.id,portfolio,None);plan=runtime.plan(portfolio)
        if source.get('owner_id')!=user.id:raise WorkflowDenied('Owned source required')
        connection=source.get('connection')
        try:
            stamp=datetime.fromisoformat(source['captured_at'])
            if stamp.tzinfo is None:raise ValueError('Aware source time required')
        except (KeyError,TypeError,ValueError):raise WorkflowDenied('Verified source time required') from None
        if connection is not None and (portfolio!='india' or not isinstance(connection,dict) or not isinstance(connection.get('id'),str) or type(connection.get('version')) is not int or connection['version']<1 or connection.get('mode') not in {'user_owned','platform_managed'}):raise WorkflowDenied('Verified account binding required')
        if portfolio=='india' and connection is None:raise WorkflowDenied('Verified India connection required')
        return {'schema_version':1,'owner_id':user.id,'portfolio':portfolio,'source_hash':digest(source),'plan_hash':digest(plan),'plan_version':plan['version'],
            'snapshot_id':source.get('snapshot_id'),'captured_at':source.get('captured_at'),'connection':{'id':connection['id'],'version':connection['version'],'mode':connection['mode'],'account_label':('***'+str(connection['account'])[-4:]) if connection.get('account') else None} if connection else None,
            'usage':{'estimated_cost_usd':'0' if synthetic_setup(runtime) else None,'simulation_only':synthetic_setup(runtime),'notice':'Zero-cost fake analysis' if synthetic_setup(runtime) else 'No cost estimate is available; configured server limits remain authoritative'},
            'constraints':{key:{'editable':False,'value':None,'reason':'No approved configurable constraint contract is installed'} for key in ['horizon','cash','exposure','turnover']},
            'candidate_preview_available':synthetic_setup(runtime),'orders_authorized':False}
    try:return await db.run_sync(read)
    except WorkflowDenied:raise HTTPException(409,'Current owned source, connection and approved plan required; no work started') from None

class CandidatePreview(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True)
    portfolio:Literal['india','indmoney_us']
    raw_text:str=Field(min_length=1,max_length=100000)
    format:Literal['paste','csv']
    snapshot_id:int|None=Field(default=None,gt=0)

@router.post('/candidate-preview')
async def preview_candidates(body:CandidatePreview,db=Depends(get_async_db),user=Depends(get_current_user),runtime=Depends(analysis_runtime)):
    if not synthetic_setup(runtime):raise HTTPException(503,'Trusted canonical catalogue unavailable; no candidate research is enabled')
    from .analysis_workflows.candidate_preview import preview,CandidateInputError
    from .analysis_workflows.synthetic_composition import CATALOGUE
    from app.domains.ai_limits.projection import projection
    from .analysis_workflows.contracts import digest
    def read(session):
        runtime.policy(session,user.id,body.portfolio,version=None,scheduled=False)
        source=runtime.source(session,user.id,body.portfolio,body.snapshot_id)
        facts=projection(source,owner=user.id,module='zerodha_rebalance' if body.portfolio=='india' else 'indmoney_us')
        return preview(body.raw_text,body.format,body.portfolio,catalogue=CATALOGUE,holdings=facts['holdings'],owner=user.id,source_hash=digest(source))
    try:return await db.run_sync(read)
    except CandidateInputError as exc:raise HTTPException(422,str(exc)) from None
    except WorkflowDenied:raise HTTPException(409,'Candidate preview rejected: current owned source and bounded canonical input required; nothing was accepted or truncated') from None

@router.get('')
async def list_analysis_workflows(selected_only:bool=False,portfolio:Literal['india','indmoney_us']|None=None,include_readiness:bool=False,db=Depends(get_async_db),user=Depends(get_current_user),runtime=Depends(analysis_runtime)):
    # Dashboard requests exclude disabled/unavailable modules before the SQL read.
    # Core historical activity keeps its existing explicit all-owned semantics.
    portfolios=None
    if selected_only:
        from app.domains.modules.visibility import visible_module_ids
        selected=set(await visible_module_ids(db,user.id))
        portfolios=[market for module,market in [('zerodha_rebalance','india'),('indmoney_us','indmoney_us')] if module in selected]
        if portfolio is not None:portfolios=[value for value in portfolios if value==portfolio]
        if not portfolios:return {'owner_id':user.id,'items':[]}
    def read(s):
        query=select(AutoRebalanceWorkflow).where(AutoRebalanceWorkflow.user_id==user.id,AutoRebalanceWorkflow.orchestration_kind=='analysis_v1')
        if portfolios is not None:query=query.where(AutoRebalanceWorkflow.portfolio.in_(portfolios))
        elif portfolio is not None:query=query.where(AutoRebalanceWorkflow.portfolio==portfolio)
        rows=s.scalars(query.order_by(AutoRebalanceWorkflow.id.desc()).limit(30)).all()
        service=Workflows(s,runtime)
        items=[]
        for row in rows:
            item=service.detail(user.id,row.id)
            if include_readiness:
                current=True
                try:service.validate_current(row)
                except WorkflowDenied:current=False
                item['input_readiness']={'current':current,'version':item['version'],
                    'source_hash':item['inputs']['source_hash'],'plan_hash':item['inputs']['plan_hash'],
                    'checked_at':datetime.now().astimezone().isoformat(),'orders_authorized':False}
            items.append(item)
        return items
    return {'owner_id':user.id,'items':await db.run_sync(read)}

@router.get('/{workflow_id}')
async def get_analysis_workflow(workflow_id:int,db=Depends(get_async_db),user=Depends(get_current_user),runtime=Depends(analysis_runtime)):
    return await db.run_sync(lambda s:Workflows(s,runtime).detail(user.id,workflow_id))

@router.post('')
async def create_analysis_workflow(body:Create,db=Depends(get_async_db),user=Depends(get_current_user),runtime=Depends(analysis_runtime)):
    try:
        row=await db.run_sync(lambda s:Workflows(s,runtime).create(user.id,**body.model_dump(exclude={'setup_schema_version'})))
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
