from fastapi import APIRouter
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.infrastructure.database.session import AsyncSessionLocal

router = APIRouter(prefix="/health", tags=["health"])


@router.get("/live")
async def health_live():
    """Liveness: process is running."""
    return {"status": "ok"}


@router.get("/ready")
async def health_ready():
    """Readiness: DB and Redis are reachable."""
    checks: dict[str, str] = {}

    # Postgres
    try:
        async with AsyncSessionLocal() as db:
            await db.execute(text("SELECT 1"))
        checks["postgres"] = "ok"
    except Exception as exc:
        checks["postgres"] = f"error: {exc}"

    # Redis
    try:
        import redis.asyncio as aioredis
        r = aioredis.from_url(settings.redis_url)
        await r.ping()
        await r.aclose()
        checks["redis"] = "ok"
    except Exception as exc:
        checks["redis"] = f"error: {exc}"

    all_ok = all(v == "ok" for v in checks.values())
    return {"status": "ok" if all_ok else "degraded", "checks": checks}


# Legacy /health endpoint kept for backwards-compat
@router.get("")
async def health_check():
    return {"status": "ok", "app": settings.app_name, "version": settings.version}
