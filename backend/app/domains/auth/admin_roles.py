"""Narrow explicit administrative roles; never promote a cost reader to ADMIN."""
import logging
from datetime import datetime
from enum import Enum

from fastapi import Depends, HTTPException, Request
from sqlalchemy import DateTime, ForeignKey, String, UniqueConstraint, select
from sqlalchemy.orm import Mapped, mapped_column
from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import User, UserRole
from app.infrastructure.database.base import Base
from app.infrastructure.database.session import get_async_db

logger=logging.getLogger(__name__)


class AdministrativeRole(str,Enum):
    COST_DASHBOARD_ADMIN='cost_dashboard_admin'


class AdministrativeRoleGrant(Base):
    __tablename__='administrative_role_grants'
    __table_args__=(UniqueConstraint('user_id','role',name='uq_administrative_role_user_scope'),)
    id:Mapped[int]=mapped_column(primary_key=True)
    user_id:Mapped[int]=mapped_column(ForeignKey('users.id',ondelete='CASCADE'),nullable=False)
    role:Mapped[str]=mapped_column(String(40),nullable=False)
    source:Mapped[str]=mapped_column(String(80),nullable=False)
    created_at:Mapped[datetime]=mapped_column(DateTime,default=datetime.utcnow,nullable=False)


async def require_cost_dashboard_admin(request:Request, user:User=Depends(get_current_user), db=Depends(get_async_db)):
    allowed=user.role==UserRole.ADMIN
    if not allowed:
        allowed=(await db.execute(select(AdministrativeRoleGrant.id).where(
            AdministrativeRoleGrant.user_id==user.id,
            AdministrativeRoleGrant.role==AdministrativeRole.COST_DASHBOARD_ADMIN.value))).scalar_one_or_none() is not None
    logger.info('administrative_access actor=%s scope=cost_dashboard decision=%s method=%s path=%s',
                user.id,'allow' if allowed else 'deny',request.method,request.url.path)
    if not allowed:raise HTTPException(403,'Cost dashboard admin access required')
    return user


async def require_platform_admin(request: Request, user: User = Depends(get_current_user)) -> User:
    """Global maintenance never accepts the narrower cost-only role."""
    allowed = user.role == UserRole.ADMIN and user.is_active
    logger.info('administrative_access actor=%s scope=platform decision=%s method=%s path=%s',
                user.id, 'allow' if allowed else 'deny', request.method, request.url.path)
    if not allowed:
        raise HTTPException(403, 'Admin access required')
    return user
