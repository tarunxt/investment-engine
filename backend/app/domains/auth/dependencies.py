from time import monotonic

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import settings
from app.core.security import JWTUtils, PasswordUtils
from app.core.logging import get_logger
from app.core.request_timing import add_auth_duration
from app.domains.auth.models import User, UserRole, UserProfile
from app.infrastructure.database.session import get_async_db

logger = get_logger(__name__)
security = HTTPBearer(auto_error=False)


def is_auth_disabled() -> bool:
    return settings.auth_disabled or settings.environment.lower() == "development"


async def get_or_create_dev_user(db: AsyncSession) -> User:
    result = await db.execute(
        select(User).where(User.email == "dev@localhost").options(selectinload(User.profile))
    )
    user = result.scalar_one_or_none()
    if user:
        return user

    user = User(
        email="dev@localhost",
        username="dev",
        password_hash=PasswordUtils.hash_password("DevPassword123"),
        full_name="Local Developer",
        role=UserRole.ADMIN,
        is_active=True,
        is_verified=True,
    )
    db.add(user)
    await db.flush()
    db.add(UserProfile(user_id=user.id))
    await db.commit()
    await db.refresh(user)
    logger.info("Created local development auth-bypass user")
    return user


async def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
    db: AsyncSession = Depends(get_async_db),
) -> User:
    started_at = monotonic()
    try:
        if not credentials and is_auth_disabled():
            return await get_or_create_dev_user(db)
        if not credentials:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Not authenticated",
                headers={"WWW-Authenticate": "Bearer"},
            )

        token = credentials.credentials
        payload = JWTUtils.verify_token(token)
        if not payload:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid or expired token",
                headers={"WWW-Authenticate": "Bearer"},
            )

        sub = payload.get("sub")
        if not sub:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token payload")

        result = await db.execute(
            select(User).where(User.id == int(sub)).options(selectinload(User.profile))
        )
        user = result.scalar_one_or_none()
        if not user:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
        if not user.is_active:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="User account is inactive")
        return user
    finally:
        add_auth_duration((monotonic() - started_at) * 1000)


async def get_optional_user(
    credentials: HTTPAuthorizationCredentials = Depends(HTTPBearer(auto_error=False)),
    db: AsyncSession = Depends(get_async_db),
) -> User | None:
    if not credentials:
        return None
    try:
        return await get_current_user(credentials, db)
    except HTTPException:
        return None


async def require_admin(current_user: User = Depends(get_current_user)) -> User:
    if current_user.role != UserRole.ADMIN:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")
    return current_user


async def require_user(current_user: User = Depends(get_current_user)) -> User:
    if current_user.role not in (UserRole.USER, UserRole.ADMIN):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="User access required")
    return current_user
