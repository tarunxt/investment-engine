"""Owned immutable fake receipt reads, never a current-source/credential/approval adapter."""
from datetime import datetime,timezone
from uuid import UUID
from fastapi import APIRouter,Depends,HTTPException,Request,Response,Query
from sqlalchemy import select
from sqlalchemy.exc import DBAPIError
from app.domains.auth.dependencies import get_current_user
from app.domains.connections.models import IntegrationConnection
from app.domains.modules.lifecycle import ModuleLifecycleDenied
from app.infrastructure.database.session import get_async_db
from app.infrastructure.database.outbox.models import OutboxMessage
from app.domains.runs.analysis_workflows.synthetic_journal import TOPIC,validated
from app.domains.runs.analysis_workflows.acquisition import MAX_FUTURE
from app.domains.runs.analysis_workflows.contracts import WorkflowDenied,utc,digest
from .http_bindings import request_binding
from .event_history import authorize
from .journal_portfolio import project_snapshot

router=APIRouter(prefix='/uat2/simulation/journal-history',tags=['owned-journal-history'])

def historical_source(db,message,owner,*,now=None):
    now=utc(now or datetime.now(timezone.utc))
    try:
        payload=message.payload;source=payload['source'];captured=datetime.fromisoformat(source['captured_at'])
        if type(payload['owner_id']) is not int or payload['owner_id']!=owner or type(source['owner_id']) is not int or source['owner_id']!=owner or captured.tzinfo is None or utc(captured)>now+MAX_FUTURE:raise WorkflowDenied('Owned historical source required')
        identifier=str(UUID(source['connection']['id']))
        connection=db.scalar(select(IntegrationConnection).where(IntegrationConnection.id==identifier,IntegrationConnection.owner_id==owner,IntegrationConnection.provider=='zerodha').execution_options(populate_existing=True))
        if connection is None or connection.credential_ref is not None or not (connection.provider_account_id or '').startswith('FAKE') or connection.app_ownership_mode not in {'user_owned','platform_managed'} or utc(connection.created_at)>utc(captured)+MAX_FUTURE:
            raise WorkflowDenied('Captured credential-free fake connection lineage required')
        # The existing exact hash/version/owner validator is retained. Read at
        # its capture instant only after actual-now future/lineage checks above;
        # this permits old evidence, never bypasses current analysis freshness.
        result=validated(message,owner,connection,utc(captured))
        project_snapshot(result,historical=True) # reject malformed display schema before listing its identity
        return result
    except (KeyError,TypeError,ValueError,AttributeError):raise WorkflowDenied('Historical receipt integrity/lineage unavailable') from None

def history(db,owner,binding,*,limit=100,before=None):
    authorize(db,owner,'india',binding)
    query=select(OutboxMessage).where(OutboxMessage.topic==TOPIC,OutboxMessage.payload['owner_id'].as_integer()==owner)
    if before is not None:query=query.where(OutboxMessage.payload['sequence'].as_integer()<before)
    messages=db.scalars(query.order_by(OutboxMessage.payload['sequence'].as_integer().desc(),OutboxMessage.id.desc()).limit(limit+1)).all()
    page=messages[:limit];items=[];rejected=0;sequences=set()
    for message in page:
        try:
            source=historical_source(db,message,owner);sequence=message.payload['sequence']
            if sequence in sequences:raise WorkflowDenied('Ambiguous receipt sequence')
            sequences.add(sequence);items.append({'id':str(message.id),'sequence':sequence,'captured_at':source['captured_at'],'source_hash':digest(source),'currency':'INR'})
        except WorkflowDenied:rejected+=1
    cursor=page[-1].payload.get('sequence') if page else None
    if len(messages)>limit and (type(cursor) is not int or cursor<1):raise WorkflowDenied('Verified pagination cursor unavailable')
    return {'schema_version':1,'owner_id':owner,'simulation_only':True,'read_only':True,'read_context':'history','current_research_ready':False,'orders_authorized':False,'items':items,'rejected_receipts':rejected,'has_more':len(messages)>limit,'next_before_sequence':cursor if len(messages)>limit else None}

def snapshot(db,owner,binding,identifier):
    authorize(db,owner,'india',binding)
    message=db.scalar(select(OutboxMessage).where(OutboxMessage.id==identifier,OutboxMessage.topic==TOPIC,OutboxMessage.payload['owner_id'].as_integer()==owner))
    if message is None:raise LookupError('Owned receipt missing')
    source=historical_source(db,message,owner)
    return {'schema_version':1,'owner_id':owner,'simulation_only':True,'read_only':True,'orders_authorized':False,'read_context':'history','current_research_ready':False,'complete_live_portfolio':False,'snapshot':project_snapshot(source,historical=True)}

async def read(request,response,user,db,operation):
    binding=request_binding(request)
    if binding is None:raise HTTPException(503,'Installed simulation history unavailable')
    response.headers['Cache-Control']='private, no-store';response.headers['Vary']='Cookie, Authorization'
    try:return await db.run_sync(lambda session:operation(session,user.id,binding))
    except (PermissionError,ModuleLifecycleDenied):raise HTTPException(403,'Owned selected-module view unavailable') from None
    except (WorkflowDenied,LookupError):raise HTTPException(404,'Owned historical receipt or captured lineage unavailable; no current source substituted') from None
    except DBAPIError:raise HTTPException(503,'Historical source unavailable; no empty history inferred') from None

@router.get('')
async def list_history(request:Request,response:Response,limit:int=Query(100,ge=1,le=100),before_sequence:int|None=Query(None,ge=1),user=Depends(get_current_user),db=Depends(get_async_db)):
    return await read(request,response,user,db,lambda session,owner,binding:history(session,owner,binding,limit=limit,before=before_sequence))

@router.get('/{receipt_id}')
async def get_history(receipt_id:UUID,request:Request,response:Response,user=Depends(get_current_user),db=Depends(get_async_db)):
    return await read(request,response,user,db,lambda session,owner,binding:snapshot(session,owner,binding,receipt_id))
