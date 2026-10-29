"""Read-only owned historical calendar projection. No scan/provider adapter is imported."""
from fastapi import APIRouter,Depends,HTTPException,Request,Response,Query
from typing import Literal
from sqlalchemy import select,or_
from app.domains.auth.dependencies import get_current_user
from app.domains.jobs.models import Job
from app.domains.modules.models import UserModule
from app.domains.modules.lifecycle import current_sync,WorkIdentity,ModuleLifecycleDenied
from app.domains.portfolio_events.common import parse_event_calendar_table
from app.domains.portfolio_events.job_projection import portfolio_analysis_job_projection
from app.infrastructure.database.session import get_async_db
from .http_bindings import request_binding
from app.domains.runs.analysis_workflows.contracts import WorkflowDenied,digest
from app.domains.ai_limits.contracts import BoundaryDenied
from .event_holding_targets import project_holdings

router=APIRouter(prefix='/uat2/simulation/event-history',tags=['owner-saved-events'])
MARKERS={'india':'[ZERODHA_EVENTS]','indmoney_us':'[INDMONEY_US_EVENTS]'}
MODULES={'india':'zerodha_rebalance','indmoney_us':'indmoney_us'}

def authorize(db,owner,portfolio,binding):
    binding.scope.validate(db,owner)
    row=db.scalar(select(UserModule).where(UserModule.user_id==owner,UserModule.module_id==MODULES[portfolio]))
    if row is None:raise PermissionError('Selected module required')
    current_sync(db,WorkIdentity(owner,MODULES[portfolio],row.version),capability='view',boundary='http')

def project(db,owner,portfolio,binding,job_id=None,limit=100,include_holdings=False):
    authorize(db,owner,portfolio,binding)
    other=MARKERS['indmoney_us' if portfolio=='india' else 'india']
    query=select(Job).options(portfolio_analysis_job_projection(include_details=job_id is not None)).where(
        Job.user_id==owner,Job.prompt.contains(MARKERS[portfolio]),~Job.prompt.contains(other),
        or_(Job.auto_rebalance_portfolio.is_(None),Job.auto_rebalance_portfolio==portfolio),
        or_(Job.module_id.is_(None),Job.module_id==MODULES[portfolio]))
    envelope={'schema_version':1,'owner_id':owner,'portfolio':portfolio,'simulation_only':True,'read_only':True,'live_calendar_verified':False,'scan_started':False}
    def metadata(row):return {'job_id':row.id,'status':row.status,'provider':row.provider,'model':row.model,'created_at':row.created_at,'updated_at':row.updated_at,'estimated_cost_usd':row.estimated_cost,'error_message':row.error_message}
    if job_id is None:
        rows=db.scalars(query.order_by(Job.id.desc()).limit(limit+1)).all()
        return {**envelope,'items':[metadata(row) for row in rows[:limit]],'has_more':len(rows)>limit}
    row=db.scalar(query.where(Job.id==job_id))
    if row is None:raise LookupError('Owned event job unavailable')
    if row.response is not None and len(row.response)>256000:raise OverflowError('Saved event response exceeds explicit preview bound')
    table=parse_event_calendar_table(row.response)
    state='missing_output' if not row.response else 'parsed_rows' if table and table['rows'] else 'unparsed_output'
    holding_match={'available':False,'row_indices':[],'source_hash':None,'captured_at':None,'notice':'Current accepted-source holding membership not requested; no held/empty result inferred.'}
    if include_holdings:
        try:
            source=binding.analysis.source(db,owner,portfolio,None)
            holding_match=project_holdings(source,owner,portfolio,table['rows'] if table else [])
        except (WorkflowDenied,PermissionError,BoundaryDenied,KeyError,TypeError):
            holding_match['notice']='Current accepted holdings could not be verified; no empty or non-held conclusion inferred.'
    return {**envelope,'item':{**metadata(row),'parse_state':state,'source_version':digest({'job_id':row.id,'updated_at':row.updated_at.isoformat(),'response':row.response}),'table':table,'source_scope':'saved_model_output_not_live_calendar','holdings_coverage_verified':False,'holding_match':holding_match}}

async def read(request,response,user,db,portfolio,job_id=None,limit=100,include_holdings=False):
    binding=request_binding(request)
    if binding is None:raise HTTPException(503,'Installed simulation binding required')
    response.headers['Cache-Control']='private, no-store';response.headers['Vary']='Cookie, Authorization'
    try:return await db.run_sync(lambda session:project(session,user.id,portfolio,binding,job_id,limit,include_holdings))
    except (PermissionError,ModuleLifecycleDenied,WorkflowDenied):raise HTTPException(403,'Current owned module view unavailable') from None
    except LookupError:raise HTTPException(404,'Saved event job not found in this module/account scope') from None
    except OverflowError:raise HTTPException(413,'Saved response too large for this bounded preview; no truncated calendar substituted') from None

@router.get('/{portfolio}')
async def history(portfolio:Literal['india','indmoney_us'],request:Request,response:Response,limit:int=Query(100,ge=1,le=100),user=Depends(get_current_user),db=Depends(get_async_db)):
    return await read(request,response,user,db,portfolio,limit=limit)

@router.get('/{portfolio}/{job_id}')
async def detail(portfolio:Literal['india','indmoney_us'],job_id:int,request:Request,response:Response,include_holdings:bool=False,user=Depends(get_current_user),db=Depends(get_async_db)):
    return await read(request,response,user,db,portfolio,job_id=job_id,include_holdings=include_holdings)
