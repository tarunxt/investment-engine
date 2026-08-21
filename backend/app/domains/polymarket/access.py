from __future__ import annotations

from fastapi import Depends, HTTPException, status

from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import User, UserRole


def user_can_access_singleton_bullpen_runtime(user: User) -> bool:
    """The Bullpen CLI uses one host credential store, so it is admin-only."""

    return user.role == UserRole.ADMIN


async def require_singleton_bullpen_runtime_access(
    current_user: User = Depends(get_current_user),
) -> User:
    if not user_can_access_singleton_bullpen_runtime(current_user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Bullpen runtime access is restricted to the singleton system account.",
        )
    return current_user
