"""Bounded owned saved Threats reports; no provider, scan, scheduler or order adapter."""
from typing import Literal
from fastapi import APIRouter,Depends,HTTPException,Request,Response,Query
from sqlalchemy import select,or_
from sqlalchemy.orm import load_only
from sqlalchemy.exc import DBAPIError
from app.domains.auth.dependencies import get_current_user
from app.domains.jobs.models import Job
from app.domains.zerodha.threats import parse_zerodha_threat_report,extract_threat_prompt_metadata
from app.domains.public_service.redaction import redact,redact_source_text
from app.domains.runs.analysis_workflows.contracts import WorkflowDenied,digest
from app.domains.modules.lifecycle import ModuleLifecycleDenied
from app.infrastructure.database.session import get_async_db
from .event_history import authorize,MODULES
from .http_bindings import request_binding

router=APIRouter(prefix='/uat2/simulation/threat-history',tags=['owner-saved-threats'])
MARKERS={'india':'[ZERODHA_THREATS]','indmoney_us':'[INDMONEY_US_THREATS]'}
FIELDS=(Job.id,Job.user_id,Job.provider,Job.model,Job.status,Job.created_at,Job.updated_at,Job.estimated_cost,Job.error_message)

def project(db,owner,portfolio,binding,job_id=None,*,limit=100,before=None):
    authorize(db,owner,portfolio,binding)
    other=MARKERS['indmoney_us' if portfolio=='india' else 'india']
    fields=(*FIELDS,Job.prompt,Job.response) if job_id is not None else FIELDS
    query=select(Job).options(load_only(*fields,raiseload=True)).where(Job.user_id==owner,Job.prompt.startswith(MARKERS[portfolio]),~Job.prompt.contains(other),or_(Job.module_id.is_(None),Job.module_id==MODULES[portfolio]),or_(Job.auto_rebalance_portfolio.is_(None),Job.auto_rebalance_portfolio==portfolio))
    envelope={'schema_version':1,'owner_id':owner,'portfolio':portfolio,'simulation_only':True,'read_only':True,'scan_started':False,'orders_authorized':False,'current_risk_verified':False,'holdings_relationship_verified':False}
    def metadata(row):return {'job_id':row.id,'status':row.status,'provider':redact(row.provider),'model':redact(row.model),'created_at':row.created_at,'updated_at':row.updated_at,'estimated_cost_usd':row.estimated_cost,'error_message':redact(row.error_message) if row.error_message else None}
    if job_id is None:
        if before is not None:query=query.where(Job.id<before)
        rows=db.scalars(query.order_by(Job.id.desc()).limit(limit+1)).all();page=rows[:limit]
        return {**envelope,'items':[metadata(row) for row in page],'has_more':len(rows)>limit,'next_before_job_id':page[-1].id if len(rows)>limit and page else None}
    row=db.scalar(query.where(Job.id==job_id))
    if row is None:raise LookupError('Owned saved Threats source not found')
    body=redact_source_text(row.response) if row.response is not None else ''
    if body is None:raise OverflowError('Saved source exceeds explicit UTF-8 bound')
    report=parse_zerodha_threat_report(body)
    recognized=bool(report and (report['summary_items'] or report['tables'] or report['bottom_line']))
    if row.status in {'failed','cancelled','canceled'}:state='failed'
    elif row.status not in {'completed','partial'}:state='incomplete'
    elif not row.response:state='missing_output'
    elif row.status=='partial':state='partial_report' if recognized else 'partial_unparsed'
    else:state='parsed_report' if recognized else 'unparsed_output'
    metadata_valid=True
    try:
        captured=extract_threat_prompt_metadata(row.prompt);snapshot_date=captured.snapshot_date;captured_at=captured.captured_at
    except (ValueError,TypeError):metadata_valid=False;snapshot_date=None;captured_at=None
    version=digest({'schema':1,'owner_id':owner,'portfolio':portfolio,'job_id':row.id,'provider':row.provider,'model':row.model,'status':row.status,'updated_at':row.updated_at.isoformat() if row.updated_at else None,'prompt':row.prompt,'response':row.response})
    return {**envelope,'item':{**metadata(row),'parse_state':state,'source_version':version,'projection_hash':digest(report),'source_redacted':body!=(row.response or ''),'source_scope':'owned_historical_model_output_not_current_portfolio_risk','source_metadata_verified':metadata_valid,'snapshot_date':snapshot_date,'captured_at':captured_at,'report':report}}

async def read(request,response,user,db,portfolio,job_id=None,limit=100,before=None):
    binding=request_binding(request)
    if binding is None:raise HTTPException(503,'Installed simulation read binding unavailable')
    response.headers['Cache-Control']='private, no-store';response.headers['Vary']='Cookie, Authorization'
    try:return await db.run_sync(lambda session:project(session,user.id,portfolio,binding,job_id,limit=limit,before=before))
    except (PermissionError,ModuleLifecycleDenied,WorkflowDenied):raise HTTPException(403,'Current owned selected-module view unavailable') from None
    except LookupError:raise HTTPException(404,'Saved Threats source unavailable in this owner/module scope') from None
    except OverflowError:raise HTTPException(413,'Saved source exceeds the 256,000-byte projection bound; no partial report substituted') from None
    except DBAPIError:raise HTTPException(503,'Saved source unavailable; no empty or risk-free result inferred') from None

@router.get('/{portfolio}')
async def history(portfolio:Literal['india','indmoney_us'],request:Request,response:Response,limit:int=Query(100,ge=1,le=100),before_job_id:int|None=Query(None,ge=1),user=Depends(get_current_user),db=Depends(get_async_db)):
    return await read(request,response,user,db,portfolio,limit=limit,before=before_job_id)

@router.get('/{portfolio}/{job_id}')
async def detail(portfolio:Literal['india','indmoney_us'],job_id:int,request:Request,response:Response,user=Depends(get_current_user),db=Depends(get_async_db)):
    return await read(request,response,user,db,portfolio,job_id)
