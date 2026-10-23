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


class ConnectionChange(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    mode: Literal['user_owned', 'platform_managed']
    key: str = Field(min_length=8, max_length=96)
    expected_id: str | None = Field(default=None, max_length=36)
    expected_version: int | None = Field(default=None, gt=0)


async def private(response: Response): response.headers['Cache-Control'] = 'private, no-store'
router.dependencies.append(Depends(private))


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


@router.post('/analysis/{workflow_id}/prepare-basket')
async def prepare_basket(workflow_id: int, request: Request, user=Depends(get_current_user), db=Depends(get_async_db)):
    binding = request_binding(request)
    if binding is None: raise HTTPException(503, 'Simulation workflow unavailable')
    try:
        def work(session):
            row = binding.orders.prepare(session, user.id, workflow_id)
            return {'id': row.id, 'state': row.state, 'simulation_only': True, 'approval_recorded': False, 'requires_exact_confirmation': row.state == 'awaiting_approval'}
        result = await db.run_sync(work); await db.commit(); return result
    except (PermissionError, OrderDenied):
        await db.rollback(); raise HTTPException(409, 'Completed owned current analysis required; no approval recorded') from None
