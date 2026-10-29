"""Owned recent activity metadata. No effect adapter, raw source or credential export.

Optional stores require today's selected-module view. Core order observations stay
available through the existing owner reader when optional modules are disabled.
"""
from datetime import datetime,timezone
from typing import Literal
from fastapi import APIRouter,Depends,HTTPException,Query,Request,Response
from sqlalchemy import select,or_
from sqlalchemy.orm import load_only
from sqlalchemy.exc import DBAPIError
from app.domains.auth.dependencies import get_current_user
from app.domains.modules.models import UserModule
from app.domains.modules.lifecycle import current_sync,WorkIdentity,ModuleLifecycleDenied
from app.domains.runs.models import AutoRebalanceWorkflow,Run
from app.domains.indmoney_us.models import IndMoneyUsPortfolioSnapshot
from app.domains.order_intents.presentation import owned_reviews
from app.domains.runs.analysis_workflows.contracts import WorkflowDenied,utc,digest
from app.infrastructure.database.session import get_async_db
from .journal_history import history as journal_history
from .http_bindings import request_binding
MODULES={'india':'zerodha_rebalance','indmoney_us':'indmoney_us'}
router=APIRouter(prefix='/uat2/simulation/activity-history',tags=['owner-recent-activity'])

def state(value):
    raw=getattr(value,'value',value)
    return raw if isinstance(raw,str) and raw in {'queued','processing','completed','partial','failed','cancelled','paused','skipped','pending','running','approved','submitting','acknowledged','unknown','filled','rejected','invalidated','draft','validated','awaiting_approval','preview','quarantined','accepted','legacy_unverified','recorded','unverified'} else 'unverified'

def project(db,owner,binding,*,portfolio=None,limit=100):
    binding.scope.validate(db,owner)
    if portfolio not in (None,'india','indmoney_us') or type(limit) is not int or not 1<=limit<=100:raise ValueError('Bounded supported activity scope required')
    records=[];sources=[];observed=datetime.now(timezone.utc)
    def append(kind,market,identifier,when,status,*,basis='created',unresolved=False,version=None):
        records.append({'key':f'{kind}:{market or "core"}:{identifier}','kind':kind,'portfolio':market,'resource_id':str(identifier),'recorded_at':utc(when).isoformat(),'time_basis':basis,'state':state(status),'unresolved':bool(unresolved),'source_version':version,'historical_only':True})
    # Existing reader validates stored integrity; runtime=None cannot enable an
    # approval or invoke a risk/provider adapter. Serialize metadata only.
    reviews=owned_reviews(db,owner,runtime=None)
    for row in reviews['intents']:
        market=next((key for key,module in MODULES.items() if row['module_id']==module),None)
        if portfolio is None or market==portfolio:append('review',market,row['id'],datetime.fromisoformat(row['created_at']),row['state'],unresolved=row['unresolved'])
    sources.append({'name':'order_reviews','portfolio':None,'status':'available','has_more':reviews['has_more'],'rejected':0})
    for market,module in MODULES.items():
        if portfolio is not None and market!=portfolio:continue
        selection=db.scalar(select(UserModule).where(UserModule.user_id==owner,UserModule.module_id==module))
        if selection is None or not selection.enabled:
            sources.append({'name':'module_history','portfolio':market,'status':'not_selected','has_more':False,'rejected':0});continue
        try:current_sync(db,WorkIdentity(owner,module,selection.version),capability='view',boundary='http')
        except ModuleLifecycleDenied:
            sources.append({'name':'module_history','portfolio':market,'status':'restricted','has_more':False,'rejected':0});continue
        fields=(AutoRebalanceWorkflow.id,AutoRebalanceWorkflow.user_id,AutoRebalanceWorkflow.portfolio,AutoRebalanceWorkflow.module_id,AutoRebalanceWorkflow.orchestration_kind,AutoRebalanceWorkflow.sequence,AutoRebalanceWorkflow.status,AutoRebalanceWorkflow.control_version,AutoRebalanceWorkflow.created_at,AutoRebalanceWorkflow.updated_at)
        flows=db.scalars(select(AutoRebalanceWorkflow).options(load_only(*fields,raiseload=True)).where(AutoRebalanceWorkflow.user_id==owner,AutoRebalanceWorkflow.portfolio==market,or_(AutoRebalanceWorkflow.module_id.is_(None),AutoRebalanceWorkflow.module_id==module)).order_by(AutoRebalanceWorkflow.created_at.desc(),AutoRebalanceWorkflow.id.desc()).limit(limit+1)).all()
        legacy={};rejected=0
        for row in flows[:limit]:
            if row.orchestration_kind=='analysis_v1':
                if row.module_id!=module:rejected+=1;continue
                append('research',market,row.id,row.created_at,row.status,version=row.control_version)
            elif type(row.sequence) is int and row.sequence>0:
                legacy[row.sequence]={'when':row.updated_at or row.created_at,'state':state(row.status),'version':row.control_version}
            else:rejected+=1
        # Group legacy stage-runs by their actual stored portfolio/sequence.
        # A group is historical, never inferred to be a completed durable run.
        fields=(Run.id,Run.user_id,Run.module_id,Run.auto_rebalance_portfolio,Run.auto_rebalance_sequence,Run.created_at)
        runs=db.scalars(select(Run).options(load_only(*fields,raiseload=True)).where(Run.user_id==owner,Run.auto_rebalance_portfolio==market,Run.auto_rebalance_sequence>0,or_(Run.module_id.is_(None),Run.module_id==module)).order_by(Run.created_at.desc(),Run.id.desc()).limit(limit+1)).all()
        for row in runs[:limit]:
            entry=legacy.setdefault(row.auto_rebalance_sequence,{'when':row.created_at,'state':'recorded','version':None})
            if utc(row.created_at)>utc(entry['when']):entry['when']=row.created_at
        for sequence,entry in legacy.items():append('legacy_research',market,sequence,entry['when'],entry['state'],basis='last_saved',version=entry['version'])
        sources.append({'name':'research_history','portfolio':market,'status':'available','has_more':len(flows)>limit or len(runs)>limit,'rejected':rejected})
        if market=='india':
            journal=journal_history(db,owner,binding,limit=limit)
            for row in journal['items']:append('source',market,row['id'],datetime.fromisoformat(row['captured_at']),'recorded',basis='captured',version=row['source_hash'])
            sources.append({'name':'source_history','portfolio':market,'status':'available','has_more':journal['has_more'],'rejected':journal['rejected_receipts']})
        else:
            fields=(IndMoneyUsPortfolioSnapshot.id,IndMoneyUsPortfolioSnapshot.user_id,IndMoneyUsPortfolioSnapshot.created_at,IndMoneyUsPortfolioSnapshot.accepted_at,IndMoneyUsPortfolioSnapshot.acceptance_state,IndMoneyUsPortfolioSnapshot.content_hash)
            snapshots=db.scalars(select(IndMoneyUsPortfolioSnapshot).options(load_only(*fields,raiseload=True)).where(IndMoneyUsPortfolioSnapshot.user_id==owner).order_by(IndMoneyUsPortfolioSnapshot.created_at.desc(),IndMoneyUsPortfolioSnapshot.id.desc()).limit(limit+1)).all()
            for row in snapshots[:limit]:append('import',market,row.id,row.accepted_at or row.created_at,row.acceptance_state,basis='accepted' if row.accepted_at else 'created',version=row.content_hash)
            sources.append({'name':'source_history','portfolio':market,'status':'available','has_more':len(snapshots)>limit,'rejected':0})
    for row in records:row['record_hash']=digest({'activity_schema':1,'owner_id':owner,**row})
    records.sort(key=lambda row:(row['recorded_at'],row['key']),reverse=True)
    if len({row['key'] for row in records})!=len(records):raise WorkflowDenied('Ambiguous owned activity identity')
    return {'schema_version':1,'owner_id':owner,'portfolio':portfolio,'simulation_only':True,'read_only':True,'orders_authorized':False,'complete_account_history':False,'live_reconciliation_verified':False,'observed_at':observed.isoformat(),'items':records[:limit],'has_more':len(records)>limit or any(row['has_more'] for row in sources),'sources':sources,'notice':'Bounded recent owned records. Optional history is omitted when current selection/policy denies it. Unclassified operator/live stores and full account export are outside this read projection; no empty broker state is inferred.'}

@router.get('')
async def recent(request:Request,response:Response,portfolio:Literal['india','indmoney_us']|None=None,limit:int=Query(100,ge=1,le=100),user=Depends(get_current_user),db=Depends(get_async_db)):
    binding=request_binding(request)
    if binding is None:raise HTTPException(503,'Installed owner simulation activity binding unavailable')
    response.headers['Cache-Control']='private, no-store';response.headers['Vary']='Cookie, Authorization'
    try:return await db.run_sync(lambda session:project(session,user.id,binding,portfolio=portfolio,limit=limit))
    except (WorkflowDenied,PermissionError):raise HTTPException(403,'Owned simulation activity scope unavailable') from None
    except DBAPIError:raise HTTPException(503,'Recorded activity unavailable; no complete or empty history inferred') from None
