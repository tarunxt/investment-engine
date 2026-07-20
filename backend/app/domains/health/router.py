from fastapi import APIRouter
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.domains.polymarket_auto_live.models import PolymarketAutoLiveOrderIntentRecord
from app.domains.polymarket_auto_live.order_intent_service import celery_ai_queue_consumer_diagnostics
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
            pending_stage3_intents = int(
                await db.scalar(
                    select(func.count())
                    .select_from(PolymarketAutoLiveOrderIntentRecord)
                    .where(PolymarketAutoLiveOrderIntentRecord.status.in_(("PLANNED", "READY", "RETRY_WAIT", "WAITING_FOR_COLLATERAL", "WAITING_FOR_EXIT")))
                )
                or 0
            )
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

    if checks.get("postgres") == "ok" and pending_stage3_intents > 0:
        import asyncio

        diagnostics = await asyncio.to_thread(celery_ai_queue_consumer_diagnostics)
        if not diagnostics.get("ok"):
            checks["stage3_order_worker"] = (
                f"error: {pending_stage3_intents} pending Stage 3 intents require queue ai, "
                f"but no worker reports consuming it. {diagnostics.get('error')}"
            )
        else:
            checks["stage3_order_worker"] = "ok"

    all_ok = all(v == "ok" for v in checks.values())
    return {
        "status": "ok" if all_ok else "degraded",
        "checks": checks,
        "pending_stage3_intents": pending_stage3_intents if checks.get("postgres") == "ok" else None,
    }


# Legacy /health endpoint kept for backwards-compat
@router.get("")
async def health_check():
    return {"status": "ok", "app": settings.app_name, "version": settings.version}
