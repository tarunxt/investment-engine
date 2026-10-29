"""Explicit owner/market advisory preference save; never an execution policy write."""
from typing import Literal
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select, update
from app.core.recovery import recovery_mode
from app.domains.auth.models import UserProfile, ActivityLog
from app.domains.auth.dependencies import get_current_user
from app.infrastructure.database.session import get_async_db
from app.domains.modules.lifecycle import ModuleLifecycleDenied, lock_owner
from app.domains.runs.analysis_workflows.contracts import WorkflowDenied, digest
from .event_history import authorize
from .http_bindings import request_binding

router = APIRouter(prefix='/uat2/simulation/buy-threshold', tags=['owner-advisory-preferences'])
FIELDS = {'india': 'zerodha_buy_threshold', 'indmoney_us': 'indmoney_buy_threshold'}

class SaveThreshold(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    expected_version: str = Field(pattern=r'^[a-f0-9]{64}$')
    value: float = Field(ge=-100, le=100, strict=True)

def version(row, portfolio):
    return digest({'owner': row.user_id, 'portfolio': portfolio,
                   'updated_at': row.updated_at.isoformat(),
                   'value': getattr(row, FIELDS[portfolio])})

def project(db, owner, portfolio, binding, body=None):
    authorize(db, owner, portfolio, binding)
    row = db.scalar(select(UserProfile).where(UserProfile.user_id == owner))
    if row is None:
        raise LookupError('Saved profile unavailable')
    if body is not None:
        if recovery_mode():
            raise PermissionError('Preference saving disabled during recovery')
        if version(row, portfolio) != body.expected_version:
            raise ValueError('Saved preference changed; reload before another explicit save')
        # Compare-and-swap includes the exact read revision. The ordinary profile
        # writer also advances this timestamp; no last-write-wins full-profile PUT.
        result = db.execute(update(UserProfile).where(
            UserProfile.user_id == owner, UserProfile.updated_at == row.updated_at,
            getattr(UserProfile, FIELDS[portfolio]) == getattr(row, FIELDS[portfolio])
        ).values(**{FIELDS[portfolio]: body.value, 'updated_at': datetime.utcnow()})
          .execution_options(synchronize_session=False))
        if result.rowcount != 1:
            raise ValueError('Saved preference changed; reload before another explicit save')
        db.add(ActivityLog(user_id=owner, action='update_advisory_buy_threshold',
                           details='Explicit market-scoped advisory preference update: '+portfolio))
        db.flush()
        db.refresh(row)
    return {'owner_id': owner, 'portfolio': portfolio, 'threshold': getattr(row, FIELDS[portfolio]),
            'version': version(row, portfolio), 'preferences_writable': not recovery_mode(),
            'advisory_only': True, 'simulation_only': True}

async def apply(request, response, user, db, portfolio, body=None):
    binding = request_binding(request)
    if binding is None:
        raise HTTPException(503, 'Installed simulation binding required')
    response.headers['Cache-Control'] = 'private, no-store'
    response.headers['Vary'] = 'Cookie, Authorization'
    try:
        if body is not None:
            await lock_owner(db, user.id)
        result = await db.run_sync(lambda session: project(session, user.id, portfolio, binding, body))
        if body is not None:
            await db.commit()
        return result
    except (PermissionError, ModuleLifecycleDenied, WorkflowDenied):
        await db.rollback()
        raise HTTPException(403, 'Owned selected module or writable preference unavailable') from None
    except LookupError:
        raise HTTPException(404, 'Saved owned profile unavailable') from None
    except ValueError:
        await db.rollback()
        raise HTTPException(409, 'Saved preference changed; reload before another explicit save') from None

@router.get('/{portfolio}')
async def read(portfolio: Literal['india', 'indmoney_us'], request: Request, response: Response,
               user=Depends(get_current_user), db=Depends(get_async_db)):
    return await apply(request, response, user, db, portfolio)

@router.put('/{portfolio}')
async def save(portfolio: Literal['india', 'indmoney_us'], body: SaveThreshold, request: Request, response: Response,
               user=Depends(get_current_user), db=Depends(get_async_db)):
    return await apply(request, response, user, db, portfolio, body)
