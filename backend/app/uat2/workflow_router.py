"""Owner-scoped controls for the installed fake workflow; no provider inputs."""
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from typing import Literal
from sqlalchemy.exc import DBAPIError
from app.domains.auth.dependencies import get_current_user
from app.infrastructure.database.session import get_async_db
from app.domains.order_intents.contracts import OrderDenied
from app.domains.runs.analysis_workflows.contracts import WorkflowDenied
from .http_bindings import request_binding

router = APIRouter(prefix='/uat2/simulation', tags=['owner-simulation'])


async def private(response: Response): response.headers['Cache-Control'] = 'private, no-store'
router.dependencies.append(Depends(private))


@router.get('/journal-portfolio')
async def journal_portfolio(request:Request,user=Depends(get_current_user),db=Depends(get_async_db)):
    from .journal_portfolio import current_portfolio
    from app.domains.ai_limits.contracts import BoundaryDenied
    binding=request_binding(request)
    if binding is None:raise HTTPException(503,'Installed owned journal unavailable')
    try:return await db.run_sync(lambda session:current_portfolio(session,user.id,binding.analysis))
    except (WorkflowDenied,BoundaryDenied,PermissionError):raise HTTPException(409,'Current owned acquisition unavailable; no source acquired or fallback fixture returned') from None
    except DBAPIError:raise HTTPException(503,'Journal read unavailable; no fallback source returned') from None


class ConnectionChange(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    mode: Literal['user_owned', 'platform_managed']
    key: str = Field(min_length=8, max_length=96)
    expected_id: str | None = Field(default=None, max_length=36)
    expected_version: int | None = Field(default=None, gt=0)





class SnapshotPreview(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    key: str = Field(min_length=8, max_length=96)


class SnapshotAcceptance(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    review_digest: str = Field(pattern=r'^[a-f0-9]{64}$')


async def snapshot_work(request, user, db, operation):
    from .snapshot_reviews import SnapshotReviews
    binding = request_binding(request)
    if binding is None:
        raise HTTPException(503, 'Snapshot review unavailable')
    try:
        value = await db.run_sync(lambda session: operation(SnapshotReviews(binding.analysis), session, user.id))
        await db.commit()
        return value
    except (WorkflowDenied, PermissionError):
        await db.rollback()
        raise HTTPException(409, 'Current owned exact snapshot review required; inspect persisted status') from None
    except DBAPIError:
        await db.rollback()
        raise HTTPException(503, 'Snapshot transaction uncertain; read the same review before retrying') from None


@router.post('/snapshot-reviews')
async def preview_snapshot(body: SnapshotPreview, request: Request,
        user=Depends(get_current_user), db=Depends(get_async_db)):
    return await snapshot_work(request, user, db,
        lambda reviews, session, owner: reviews.preview(session, owner, body.key))


@router.get('/snapshot-reviews/{review_id}')
async def read_snapshot_review(review_id: str, request: Request,
        user=Depends(get_current_user), db=Depends(get_async_db)):
    return await snapshot_work(request, user, db,
        lambda reviews, session, owner: reviews.describe(session, owner, review_id))


@router.post('/snapshot-reviews/{review_id}/accept')
async def accept_snapshot_review(review_id: str, body: SnapshotAcceptance, request: Request,
        user=Depends(get_current_user), db=Depends(get_async_db)):
    return await snapshot_work(request, user, db,
        lambda reviews, session, owner: reviews.accept(session, owner, review_id, body.review_digest))


@router.post('/connections')
async def simulate_connection(body: ConnectionChange, request: Request,
        user=Depends(get_current_user), db=Depends(get_async_db)):
    from .synthetic_connections import connect, describe
    if request_binding(request) is None: raise HTTPException(503, 'Simulation workflow unavailable')
    try:
        result = await db.run_sync(lambda session: describe(connect(session, user.id, **body.model_dump())))
        await db.commit(); return result
    except (PermissionError, OrderDenied):
        await db.rollback(); raise HTTPException(409, 'Current owned fake connection and exact version required') from None
    except DBAPIError:
        await db.rollback(); raise HTTPException(503, 'Connection transaction unavailable; refresh persisted status',headers={'Retry-After':'3'}) from None


class BasketVersion(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True)
    revision_version:str|None=Field(default=None,pattern=r'^[a-f0-9]{64}$')

@router.post('/analysis/{workflow_id}/prepare-basket')
async def prepare_basket(workflow_id: int, request: Request,body:BasketVersion|None=None,user=Depends(get_current_user), db=Depends(get_async_db)):
    binding = request_binding(request)
    if binding is None: raise HTTPException(503, 'Simulation workflow unavailable')
    try:
        def work(session):
            row = binding.orders.prepare(session, user.id, workflow_id,revision_version=body.revision_version if body else None)
            return {'id': row.id, 'state': row.state, 'simulation_only': True, 'approval_recorded': False, 'requires_exact_confirmation': row.state == 'awaiting_approval'}
        result = await db.run_sync(work); await db.commit(); return result
    except (PermissionError, OrderDenied):
        await db.rollback(); raise HTTPException(409, 'Completed owned current analysis required; no approval recorded') from None


class ExportRequest(BaseModel):
    model_config = ConfigDict(extra='forbid',strict=True)
    key: str = Field(min_length=8,max_length=96)


@router.post('/analysis/{workflow_id}/private-export')
async def private_analysis_export(workflow_id:int,body:ExportRequest,request:Request,
        user=Depends(get_current_user),db=Depends(get_async_db)):
    from .private_exports import prepare_export
    from app.domains.ai_limits.contracts import BoundaryDenied
    binding=request_binding(request)
    if binding is None: raise HTTPException(503,'Private analysis export unavailable')
    try:
        value=await db.run_sync(lambda session:prepare_export(session,user.id,workflow_id,
            analysis=binding.analysis,key=body.key))
        await db.commit();return value
    except (BoundaryDenied,PermissionError,OrderDenied):
        await db.rollback();raise HTTPException(409,'Current completed owned analysis and local download required') from None
