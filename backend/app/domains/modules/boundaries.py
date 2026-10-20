"""Adapters for integration in07-08; none bypass existing domain gates."""
from fastapi import Depends, HTTPException
from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import User
from app.infrastructure.database.session import get_async_db
from .policy import ModulePolicy


def module_http_dependency(module_id: str, capability: str):
    async def admitted(user: User = Depends(get_current_user), db=Depends(get_async_db)):
        decision = await ModulePolicy(db).authorize(owner_id=user.id, resource_owner_id=user.id,
            module_id=module_id, capability=capability, boundary='http')
        if not decision.allowed:
            raise HTTPException(403, {'code': 'MODULE_POLICY_DENIED', 'reasons': decision.reasons})
        return decision
    return admitted


async def check_owned_boundary(db, *, owner_id: int, resource_owner_id: int | None,
                               module_id: str | None, capability: str, boundary,
                               expected_version: int | None = None):
    """Workers/streams/effects must derive resource_owner_id from stored ownership.

    Recheck at dispatch and before each effect/stream delivery. A user ID in a
    queued payload or a prior cached decision is not ownership or authority.
    Existing domain checks remain required until every integration is verified.
    """
    return await ModulePolicy(db).authorize(owner_id=owner_id, resource_owner_id=resource_owner_id,
        module_id=module_id, capability=capability, boundary=boundary, expected_version=expected_version)
