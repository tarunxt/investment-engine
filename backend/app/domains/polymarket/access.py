"""Existing singleton runtime is an explicit active-ADMIN operator capability."""
from __future__ import annotations

import logging
import asyncio
from fastapi import Depends, HTTPException, Request
from sqlalchemy import select
from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import User, UserRole

logger=logging.getLogger(__name__)


def user_can_access_singleton_bullpen_runtime(user: User) -> bool:
    return getattr(user,'role',None)==UserRole.ADMIN and bool(getattr(user,'is_active',False))


async def require_singleton_bullpen_runtime_access(request:Request, current_user:User=Depends(get_current_user)) -> User:
    allowed=user_can_access_singleton_bullpen_runtime(current_user)
    logger.info('operator_runtime_access actor=%s decision=%s method=%s path=%s',
                current_user.id,'allow' if allowed else 'deny',request.method,request.url.path)
    if not allowed:raise HTTPException(403,'Singleton financial runtime requires an active administrator role')
    return current_user


async def require_operator_user_id(user_id:int) -> None:
    """Recheck before cached per-user objects or runtime adapter construction."""
    from app.infrastructure.database.session import AsyncSessionLocal
    try:
        async with asyncio.timeout(2):
            async with AsyncSessionLocal() as session:
                row=(await session.execute(select(User.role,User.is_active).where(User.id==user_id))).first()
    except Exception:
        logger.warning('Operator authorization unavailable actor=%s',user_id)
        raise HTTPException(503,'Operator authorization unavailable') from None
    allowed=row is not None and row.role==UserRole.ADMIN and row.is_active
    logger.info('operator_object_access actor=%s decision=%s',user_id,'allow' if allowed else 'deny')
    if not allowed:raise HTTPException(403,'Singleton financial runtime requires an active administrator role')


def require_operator_user_id_sync(user_id:int) -> None:
    from app.infrastructure.database.sync_session import SyncSessionLocal
    with SyncSessionLocal() as session:
        row=session.execute(select(User.role,User.is_active).where(User.id==user_id)).first()
    allowed=row is not None and row.role==UserRole.ADMIN and row.is_active
    logger.info('operator_worker_access actor=%s decision=%s',user_id,'allow' if allowed else 'deny')
    if not allowed:raise PermissionError('Singleton financial runtime requires an active administrator role')


def require_operator_intent_sync(intent_id: str) -> None:
    from app.domains.polymarket_auto_live.models import PolymarketAutoLiveOrderIntentRecord
    from app.infrastructure.database.sync_session import SyncSessionLocal
    with SyncSessionLocal() as session:
        user_id = session.scalar(select(PolymarketAutoLiveOrderIntentRecord.user_id).where(
            PolymarketAutoLiveOrderIntentRecord.id == intent_id))
    if user_id is None:
        raise PermissionError('Operator intent not found')
    require_operator_user_id_sync(user_id)


def require_operator_bullpen008_run_sync(run_id: str) -> None:
    from app.domains.bullpen008.models import Bullpen008RunRecord
    from app.infrastructure.database.sync_session import SyncSessionLocal
    with SyncSessionLocal() as session:
        user_id = session.scalar(select(Bullpen008RunRecord.user_id).where(Bullpen008RunRecord.id == run_id))
    if user_id is None:
        raise PermissionError('Operator run not found')
    require_operator_user_id_sync(user_id)
