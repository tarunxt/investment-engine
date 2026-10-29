"""Bounded persisted recommendation context, never reconstructed from current inputs."""
import json, math
from types import SimpleNamespace
from typing import Literal
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy import select, and_, or_, func, cast, String
from app.domains.auth.dependencies import get_current_user
from app.infrastructure.database.session import get_async_db
from app.domains.runs.models import FinalActionableHistory as H, Run, RunJob, AutoRebalanceWorkflow
from app.domains.jobs.models import Job
from app.domains.runs.repository import PostgresRunRepository
from app.domains.runs.run_identity import analysis_run_identity
from app.domains.runs.final_actionable_history import normalize_stock_symbol, encode_history_cursor, decode_history_cursor
from app.domains.runs.analysis_workflows.contracts import WorkflowDenied, digest
from app.domains.modules.lifecycle import ModuleLifecycleDenied
from .event_history import authorize
from .http_bindings import request_binding

router=APIRouter(prefix='/uat2/simulation/recommendation-history',tags=['owner-saved-recommendations'])
FIELDS=('id','workflow_id','auto_rebalance_sequence','rebalance_run_id','stock_symbol','stock_name','covered_at',
        'action','score','consensus_numerator','consensus_denominator','historical_current_units',
        'historical_current_value','action_units','amount','technical_scan_run_id','formula_version','coverage_status','created_at')
COVERAGE={'suggested','not_mentioned','not_in_input_universe','run_failed','parse_failed'}
NUMBERS={'score','consensus_numerator','consensus_denominator','historical_current_units','historical_current_value','action_units','amount'}

def project(db,owner,portfolio,binding,symbol,limit=25,cursor=None):
    authorize(db,owner,portfolio,binding)
    if not 1<=limit<=50:raise ValueError('Bounded page required')
    requested_symbol=symbol
    symbol=normalize_stock_symbol(symbol)
    if not symbol or len(symbol)>64:raise ValueError('Recorded ticker required')
    market='india' if portfolio=='india' else 'us'
    conditions=[H.user_id==owner,H.market==market,H.stock_symbol==symbol]
    if cursor:
        if len(cursor)>512:raise ValueError('Bounded cursor required')
        covered,row_id=decode_history_cursor(cursor)
        if row_id<1:raise ValueError('Invalid cursor')
        conditions.append(or_(H.covered_at<covered,and_(H.covered_at==covered,H.id<row_id)))
    # Raw formula/snapshot JSON and raw job bodies are deliberately not loaded.
    columns=[getattr(H,name) for name in FIELDS]
    records=db.execute(select(*columns,func.substr(cast(H.source_run_ids_json,String),1,4097).label('references'))
        .where(*conditions).order_by(H.covered_at.desc(),H.id.desc()).limit(limit+1)).mappings().all()
    page=records[:limit];items=[];withheld=0
    for record in page:
        row=dict(record)
        try:
            raw=row.pop('references');references=json.loads(raw) if raw else None
            if references is not None and (len(raw)>4096 or not isinstance(references,list) or len(references)>16
                    or any(type(value) is not int or value<1 for value in references)):
                raise ValueError('Unverified bounded source list')
            ids={row['rebalance_run_id'],*(references or [])}
            if row['technical_scan_run_id'] is not None:ids.add(row['technical_scan_run_id'])
            missing_jobs=select(RunJob.id).outerjoin(Job,RunJob.job_id==Job.id).where(RunJob.run_id==Run.id,Job.id.is_(None)).exists()
            runs=db.execute(PostgresRunRepository(db)._owned_query(owner).with_only_columns(
                Run.id,Run.auto_rebalance_portfolio,Run.auto_rebalance_label,func.substr(Run.prompt,1,2049).label('prompt'))
                .where(Run.id.in_(ids),~missing_jobs)).mappings().all()
            if {item['id'] for item in runs}!=ids:raise ValueError('Source ownership unavailable')
            for item in runs:
                prompt=item['prompt'] or ''
                if len(prompt)-len(prompt.lstrip())>1024:raise ValueError('Source identity prefix exceeds bound')
                identity=analysis_run_identity(SimpleNamespace(**item))
                stage='technical' if item['id']==row['technical_scan_run_id'] else 'rebalance'
                if identity.market!=market or identity.stage!=stage:raise ValueError('Source market/stage unavailable')
            if row['workflow_id'] is not None and db.scalar(select(AutoRebalanceWorkflow.id).where(
                    AutoRebalanceWorkflow.id==row['workflow_id'],AutoRebalanceWorkflow.user_id==owner,
                    AutoRebalanceWorkflow.portfolio==portfolio)) is None:raise ValueError('Workflow ownership unavailable')
            if row['coverage_status'] not in COVERAGE:raise ValueError('Unknown recorded coverage')
            for field in NUMBERS:
                value=row[field]
                if value is not None and not math.isfinite(value):row[field]=None
            row['source_run_ids']=sorted(ids)
            row['source_list_state']='recorded_list' if references is not None else 'not_recorded'
            row['exchange_binding_verified']=False
            row['snapshot_binding_verified']=False
            row['record_version']=digest({'owner_id':owner,'portfolio':portfolio,**{key:value.isoformat() if hasattr(value,'isoformat') else value for key,value in row.items()}})
            items.append(row)
        except (ValueError,TypeError,KeyError,json.JSONDecodeError):withheld+=1
    more=len(records)>limit
    return {'schema_version':1,'owner_id':owner,'portfolio':portfolio,'symbol':symbol,'requested_symbol':requested_symbol,'items':items,'withheld_records':withheld,
            'has_more':more,'next_cursor':encode_history_cursor(page[-1]['covered_at'],page[-1]['id']) if more and page else None,
            'scanned_records':len(page),'simulation_only':True,'read_only':True,'current_risk_verified':False,
            'notice':'Persisted market/ticker context only. Exchange, account/snapshot linkage and full original policy are not established. No current holdings, current formula, FX or live acquisition is substituted.'}

@router.get('/{portfolio}')
async def history(portfolio:Literal['india','indmoney_us'],request:Request,response:Response,
                  symbol:str=Query(min_length=1,max_length=64),limit:int=Query(25,ge=1,le=50),cursor:str|None=Query(None,max_length=512),
                  user=Depends(get_current_user),db=Depends(get_async_db)):
    binding=request_binding(request)
    if binding is None:raise HTTPException(503,'Installed simulation binding required')
    response.headers['Cache-Control']='private, no-store';response.headers['Vary']='Cookie, Authorization'
    try:return await db.run_sync(lambda session:project(session,user.id,portfolio,binding,symbol,limit,cursor))
    except (PermissionError,ModuleLifecycleDenied,WorkflowDenied):raise HTTPException(403,'Current owned selected module unavailable') from None
    except (ValueError,TypeError):raise HTTPException(422,'Recorded ticker or history cursor is invalid') from None
