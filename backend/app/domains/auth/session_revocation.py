"""Session loss uses the existing durable logout ledger, not a second user store."""
import math
import time
from datetime import timezone

from sqlalchemy import func, select
from app.domains.auth.models import ActivityLog


def authentication_time(claims: dict) -> float | None:
    value = claims.get('auth_time', claims.get('iat'))
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    value = float(value)
    return value if math.isfinite(value) and 0 < value <= time.time() + 1 else None


async def session_is_current(db, user_id: int, claims: dict) -> bool:
    authenticated = authentication_time(claims)
    if authenticated is None:
        return False
    result = await db.execute(select(func.max(ActivityLog.created_at)).where(
        ActivityLog.user_id == user_id, ActivityLog.action == 'logout',
    ))
    cutoff = result.scalar_one_or_none()
    if cutoff is None:
        return True
    return authenticated > cutoff.replace(tzinfo=timezone.utc).timestamp()
