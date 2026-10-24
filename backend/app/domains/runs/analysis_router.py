"""Authenticated controls for server-owned analysis. Default composition is off."""
from datetime import datetime
from typing import Literal,Annotated
from fastapi import APIRouter,Depends,HTTPException,Response,Request,Query
from pydantic import BaseModel,ConfigDict,Field,field_validator,model_validator
from sqlalchemy import select
from app.domains.auth.dependencies import get_current_user
from app.infrastructure.database.session import get_async_db
from app.domains.runs.models import AutoRebalanceWorkflow
from app.domains.runs.analysis_workflows.runtime import configured_runtime
from app.domains.runs.analysis_workflows.service import Workflows
from app.domains.runs.analysis_workflows.contracts import WorkflowDenied

router=APIRouter(prefix='/runs/analysis-workflows',tags=['analysis-workflows'])
class ShortlistInput(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True)
    raw_text:str=Field(min_length=1,max_length=100000)
    format:Literal['paste','csv']
    preview_hash:str=Field(pattern=r'^[a-f0-9]{64}$')
    setup_hash:str=Field(pattern=r'^[a-f0-9]{64}$')

class ResearchConstraints(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True)
    horizon_days:int=Field(ge=1,le=3650)
    minimum_cash:str=Field(min_length=1,max_length=40)
    maximum_position_percent:str=Field(min_length=1,max_length=40)
    maximum_turnover_percent:str=Field(min_length=1,max_length=40)

class ResearchOptionsInput(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True)
    schema_version:Literal[2]
    mode:Literal['holdings_only','llm_discovery','shortlist_only','combined']
    raw_text:str=Field(default='',max_length=100000)
    format:Literal['paste','csv']='paste'
    constraints:ResearchConstraints
    accepted_universe_limit:Literal[200]

class AcceptedResearchOptions(ResearchOptionsInput):
    preview_hash:str=Field(pattern=r'^[a-f0-9]{64}$')
    setup_hash:str=Field(pattern=r'^[a-f0-9]{64}$')

class ResearchOptionsPreview(ResearchOptionsInput):
    portfolio:Literal['india','indmoney_us']

class Create(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True)
    portfolio:Literal['indmoney_us','india']
    key:str=Field(min_length=8,max_length=96)
    snapshot_id:int|None=Field(default=None,gt=0)
    expected_source_hash:str|None=Field(default=None,pattern=r'^[a-f0-9]{64}$')
    expected_plan_hash:str|None=Field(default=None,pattern=r'^[a-f0-9]{64}$')
    expected_module_version:int|None=Field(default=None,gt=0)
    setup_schema_version:Literal[1,2]|None=None
    research_setup:ShortlistInput|AcceptedResearchOptions|None=None
    @model_validator(mode='after')
    def reviewed_pair(self):
        if (self.expected_source_hash is None)!=(self.expected_plan_hash is None) or self.setup_schema_version is not None and self.expected_source_hash is None:raise ValueError('Both reviewed hashes required')
        if self.setup_schema_version==2 and self.expected_module_version is None:raise ValueError('Reviewed module version required')
        if self.research_setup is not None and (self.setup_schema_version!=2 or self.expected_module_version is None or self.expected_source_hash is None):raise ValueError('Shortlist needs reviewed versioned source, plan and module')
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
            'shortlist_only':{'available':synthetic_setup(runtime),'reason':'Explicit reviewed synthetic shortlist only; holdings remain required'},
            'combined':{'available':False,'reason':'No approved combined-universe/batch contract is installed'}}}

@router.get('/setup-context')
async def setup_context(portfolio:Literal['india','indmoney_us'],db=Depends(get_async_db),user=Depends(get_current_user),runtime=Depends(analysis_runtime)):
    from .analysis_workflows.contracts import digest
    def read(session):
        identity=runtime.policy(session,user.id,portfolio,version=None,scheduled=False)
        source=runtime.source(session,user.id,portfolio,None);plan=runtime.plan(portfolio)
        if source.get('owner_id')!=user.id:raise WorkflowDenied('Owned source required')
        connection=source.get('connection')
        try:
            stamp=datetime.fromisoformat(source['captured_at'])
            if stamp.tzinfo is None:raise ValueError('Aware source time required')
        except (KeyError,TypeError,ValueError):raise WorkflowDenied('Verified source time required') from None
        if connection is not None and (portfolio!='india' or not isinstance(connection,dict) or not isinstance(connection.get('id'),str) or type(connection.get('version')) is not int or connection['version']<1 or connection.get('mode') not in {'user_owned','platform_managed'}):raise WorkflowDenied('Verified account binding required')
        if portfolio=='india' and connection is None:raise WorkflowDenied('Verified India connection required')
        return {'schema_version':1,'owner_id':user.id,'portfolio':portfolio,'module_version':identity.version,'source_hash':digest(source),'plan_hash':digest(plan),'plan_version':plan['version'],
            'snapshot_id':source.get('snapshot_id'),'captured_at':source.get('captured_at'),'connection':{'id':connection['id'],'version':connection['version'],'mode':connection['mode'],'account_label':('***'+str(connection['account'])[-4:]) if connection.get('account') else None} if connection else None,
            'usage':{'estimated_cost_usd':'0' if synthetic_setup(runtime) else None,'simulation_only':synthetic_setup(runtime),'notice':'Zero-cost fake analysis' if synthetic_setup(runtime) else 'No cost estimate is available; configured server limits remain authoritative'},
            'constraints':{key:{'editable':False,'value':None,'reason':'No approved configurable constraint contract is installed'} for key in ['horizon','cash','exposure','turnover']},
            'candidate_preview_available':synthetic_setup(runtime),'shortlist_analysis_available':synthetic_setup(runtime),
            'research_options_available':synthetic_setup(runtime),'live_discovery_available':False,'orders_authorized':False}
    try:return await db.run_sync(read)
    except WorkflowDenied:raise HTTPException(409,'Current owned source, connection and approved plan required; no work started') from None

@router.post('/options-preview')
async def preview_research_options(body:ResearchOptionsPreview,db=Depends(get_async_db),user=Depends(get_current_user),runtime=Depends(analysis_runtime)):
    from .analysis_workflows.research_options import build
    from .analysis_workflows.contracts import digest
    if not synthetic_setup(runtime):raise HTTPException(503,'Only the offline test discovery/constraint composition is installed')
    def work(session):
        runtime.policy(session,user.id,body.portfolio,version=None,scheduled=False)
        source=runtime.source(session,user.id,body.portfolio,None)
        options=build(user.id,body.portfolio,source,body.model_dump(exclude={'portfolio'}))
        return {'owner_id':user.id,'portfolio':body.portfolio,'source_hash':digest(source),'preview_hash':digest(options),'setup_hash':digest(options),'options':options,'simulation_only':True,'orders_authorized':False}
    try:return await db.run_sync(work)
    except (PermissionError,ValueError):raise HTTPException(409,'Owned current source and valid complete research options required; no work started') from None

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
        document=preview(body.raw_text,body.format,body.portfolio,catalogue=CATALOGUE,holdings=facts['holdings'],owner=user.id,source_hash=digest(source))
        from .analysis_workflows.shortlist import from_preview,MAX_UNIVERSE
        try:_,hash=from_preview(document,holdings=facts['holdings']);reason=None
        except WorkflowDenied as error:hash=None;reason=str(error)
        return {**document,'shortlist_contract_hash':hash,'shortlist_unavailable_reason':reason,'max_analysis_universe':MAX_UNIVERSE}
    try:return await db.run_sync(read)
    except CandidateInputError as exc:raise HTTPException(422,str(exc)) from None
    except WorkflowDenied:raise HTTPException(409,'Candidate preview rejected: current owned source and bounded canonical input required; nothing was accepted or truncated') from None

@router.get('')
async def list_analysis_workflows(selected_only:bool=False,portfolio:Literal['india','indmoney_us']|None=None,include_readiness:bool=False,db=Depends(get_async_db),user=Depends(get_current_user),runtime=Depends(analysis_runtime),request_key:Annotated[str|None,Query(min_length=8,max_length=128)]=None,source_hash:Annotated[str|None,Query(pattern=r'^[a-f0-9]{64}$')]=None,plan_hash:Annotated[str|None,Query(pattern=r'^[a-f0-9]{64}$')]=None,module_version:Annotated[int|None,Query(gt=0)]=None,manual_only:bool=False,research_setup_hash:Annotated[str|None,Query(pattern=r'^[a-f0-9]{64}$')]=None,holdings_only:bool=False):
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
        if request_key is not None:query=query.where(AutoRebalanceWorkflow.request_key==request_key)
        if source_hash is not None:query=query.where(AutoRebalanceWorkflow.execution_json['source_hash'].as_string()==source_hash)
        if plan_hash is not None:query=query.where(AutoRebalanceWorkflow.execution_json['plan_hash'].as_string()==plan_hash)
        if module_version is not None:query=query.where(AutoRebalanceWorkflow.module_version==module_version)
        if research_setup_hash is not None:query=query.where(AutoRebalanceWorkflow.execution_json['research_setup_hash'].as_string()==research_setup_hash)
        if holdings_only:query=query.where(AutoRebalanceWorkflow.execution_json['research_setup_hash'].as_string().is_(None))
        if manual_only:query=query.where(AutoRebalanceWorkflow.execution_json['scheduled'].as_boolean().is_(False))
        rows=s.scalars(query.order_by(AutoRebalanceWorkflow.id.desc()).limit(30)).all()
        service=Workflows(s,runtime)
        items=[]
        for row in rows:
            item=service.detail(user.id,row.id)
            if include_readiness:
                current=True
                try:service.validate_current(row)
                except (WorkflowDenied,PermissionError):current=False
                item['input_readiness']={'current':current,'version':item['version'],
                    'source_hash':item['inputs']['source_hash'],'plan_hash':item['inputs']['plan_hash'],
                    'checked_at':datetime.now().astimezone().isoformat(),'orders_authorized':False}
            items.append(item)
        return items
    return {'owner_id':user.id,'items':await db.run_sync(read)}

@router.get('/{workflow_id}')
async def get_analysis_workflow(workflow_id:int,db=Depends(get_async_db),user=Depends(get_current_user),runtime=Depends(analysis_runtime),include_readiness:bool=False):
    def read(session):
        service=Workflows(session,runtime);item=service.detail(user.id,workflow_id)
        if include_readiness:
            row=service.owned(user.id,workflow_id);current=True
            try:service.validate_current(row)
            except (WorkflowDenied,PermissionError):current=False
            item['input_readiness']={'current':current,'version':item['version'],'source_hash':item['inputs']['source_hash'],'plan_hash':item['inputs']['plan_hash'],'checked_at':datetime.now().astimezone().isoformat(),'orders_authorized':False}
        return item
    return await db.run_sync(read)

@router.get('/{workflow_id}/action-plan')
async def get_action_plan(workflow_id:int,db=Depends(get_async_db),user=Depends(get_current_user),runtime=Depends(analysis_runtime),version:Annotated[str|None,Query(pattern=r'^[a-f0-9]{64}$')]=None):
    from .analysis_workflows.synthetic_composition import SyntheticAnalysis
    from .analysis_workflows.action_plan import project
    from app.domains.ai_limits.contracts import BoundaryDenied
    composition=getattr(runtime.source,'__self__',None)
    if type(composition) is not SyntheticAnalysis:raise HTTPException(503,'Verified advisory plan projection unavailable')
    def read(session):
        from app.domains.modules.lifecycle import sync_owner_fence
        from .analysis_workflows.plan_revisions import select_plan
        sync_owner_fence(session,user.id)
        service=Workflows(session,runtime);row=service.owned(user.id,workflow_id)
        receipt=composition.completed_analysis(session,user.id,workflow_id)
        original=project(receipt,workflow=row,source=row.execution_json['source'])
        from app.uat2.revision_baskets import annotate
        return annotate(session,composition,select_plan(service.stages(row)[-1],original,version))
    try:return await db.run_sync(read)
    except (WorkflowDenied,PermissionError,BoundaryDenied):raise HTTPException(409,'Current owned governed result could not be verified; retained research evidence remains available, no new review authorized') from None

class AdvisoryTarget(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True)
    instrument:str=Field(min_length=3,max_length=80)
    final_units:str=Field(min_length=1,max_length=40)

class AdvisoryRevision(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True)
    expected_version:str=Field(pattern=r'^[a-f0-9]{64}$')
    targets:list[AdvisoryTarget]=Field(min_length=1,max_length=200)

@router.post('/{workflow_id}/action-plan/revisions')
async def revise_action_plan(workflow_id:int,body:AdvisoryRevision,db=Depends(get_async_db),user=Depends(get_current_user),runtime=Depends(analysis_runtime)):
    from .analysis_workflows.synthetic_composition import SyntheticAnalysis
    from .analysis_workflows.action_plan import project
    from .analysis_workflows.plan_revisions import revise
    from app.domains.ai_limits.contracts import BoundaryDenied
    from app.domains.order_intents.contracts import OrderDenied
    from app.domains.modules.lifecycle import sync_owner_fence
    composition=getattr(runtime.source,'__self__',None)
    if type(composition) is not SyntheticAnalysis:raise HTTPException(503,'Explicit synthetic advisory revisions unavailable')
    def work(session):
        sync_owner_fence(session,user.id)
        service=Workflows(session,runtime);row=service.owned(user.id,workflow_id)
        receipt=composition.completed_analysis(session,user.id,workflow_id)
        original=project(receipt,workflow=row,source=row.execution_json['source'])
        from app.uat2.revision_baskets import annotate
        result=revise(service.stages(row)[-1],original,body.expected_version,[item.model_dump() for item in body.targets])
        return annotate(session,composition,result)
    try:result=await db.run_sync(work);await db.commit();return result
    except (WorkflowDenied,PermissionError,BoundaryDenied,OrderDenied):
        await db.rollback();raise HTTPException(409,'Advisory revision rejected: current owned evidence and exact finite targets required; no approval or execution available') from None

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
