"""Read-only startup readiness: missing/unavailable schema must stop startup."""
from sqlalchemy import select
from .models import AuthSessionFamily, AuthRefreshIntent

async def require_session_schema(db):
    await db.execute(select(AuthSessionFamily).limit(0))
    await db.execute(select(AuthRefreshIntent).limit(0))
