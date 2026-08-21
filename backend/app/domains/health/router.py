import asyncio
import json
from typing import Any

from fastapi import APIRouter, Request, Response, status
from sqlalchemy import func, select, text

from app.core.config import settings
from app.core.logging import get_logger
from app.domains.polymarket_auto_live.models import PolymarketAutoLiveOrderIntentRecord
from app.domains.polymarket_auto_live.order_intent_service import celery_ai_queue_consumer_diagnostics
from app.domains.polymarket_auto_live.order_intents import (
    INTENT_PENDING_CONFIRMATION_STATUSES,
    INTENT_READY_STATUSES,
)
from app.infrastructure.database.session import AsyncSessionLocal

router = APIRouter(prefix="/health", tags=["health"])
logger = get_logger(__name__)
READY_POSTGRES_TIMEOUT_SECONDS = 0.75
READY_REDIS_TIMEOUT_SECONDS = 0.75
READY_WORKER_INSPECT_TIMEOUT_SECONDS = 1.0
# Celery's inspector is allowed to consume its complete reply window. Keep the
# surrounding async deadline larger so normal thread scheduling/serialization
# overhead cannot turn a healthy ai consumer into a deterministic timeout.
READY_WORKER_TIMEOUT_SECONDS = 2.0
PENDING_STAGE3_INTENT_STATUSES = tuple(
    sorted(
        {
            "PLANNED",
            *INTENT_READY_STATUSES,
            *INTENT_PENDING_CONFIRMATION_STATUSES,
        }
    )
)


def _log_readiness_failure(
    request: Request,
    dependency: str,
    *,
    exception: BaseException | None = None,
    diagnostics: dict[str, Any] | None = None,
) -> None:
    """Log internal readiness detail without returning it to callers."""

    payload: dict[str, Any] = {
        "event": "health_ready_dependency_unavailable",
        "dependency": dependency,
        "correlation_id": getattr(request.state, "correlation_id", None)
        or request.headers.get("X-Correlation-ID"),
    }
    if exception is not None:
        payload["error_type"] = type(exception).__name__
    if diagnostics is not None:
        # Diagnostics are intentionally server-side only. They can include
        # worker topology and transport-specific failure context which should
        # never be exposed by a public readiness response.
        payload["diagnostics"] = diagnostics
    logger.warning(
        "%s",
        json.dumps(payload, default=str, sort_keys=True, separators=(",", ":")),
        exc_info=exception is not None,
    )


def _health_ready_response(
    response: Response,
    checks: dict[str, str],
    pending_stage3_intents: int | None,
) -> dict[str, object]:
    all_ok = all(value == "ok" for value in checks.values())
    if not all_ok:
        # ``curl --fail`` and load-balancer readiness checks must reject a
        # deployment that is alive but cannot advance queued Stage 3 orders.
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE

    return {
        "status": "ok" if all_ok else "degraded",
        "checks": checks,
        "pending_stage3_intents": (
            pending_stage3_intents if checks.get("postgres") == "ok" else None
        ),
    }


@router.get("/live")
async def health_live():
    """Liveness: process is running."""
    return {"status": "ok"}


@router.get("/ready")
async def health_ready(request: Request, response: Response):
    """Readiness: dependencies and required Stage 3 workers are available."""
    checks: dict[str, str] = {}
    pending_stage3_intents: int | None = None

    async def check_postgres() -> int:
        async with AsyncSessionLocal() as db:
            await db.execute(text("SELECT 1"))
            return int(
                await db.scalar(
                    select(func.count())
                    .select_from(PolymarketAutoLiveOrderIntentRecord)
                    .where(
                        PolymarketAutoLiveOrderIntentRecord.status.in_(
                            PENDING_STAGE3_INTENT_STATUSES
                        )
                    )
                )
                or 0
            )

    async def check_redis() -> None:
        import redis.asyncio as aioredis

        redis_client = aioredis.from_url(settings.redis_url)
        try:
            await redis_client.ping()
        finally:
            # A close failure must not mask the result of the actual readiness
            # probe. The client is short-lived and has no browser-facing state.
            try:
                await redis_client.aclose()
            except Exception:
                logger.debug("health ready Redis client close failed", exc_info=True)

    # These checks are operational diagnostics, not a dependency of page
    # rendering. Bound each one so a pool wait, broker stall, or Redis outage
    # reports degradation promptly instead of occupying an API worker.
    try:
        pending_stage3_intents = await asyncio.wait_for(
            check_postgres(),
            timeout=READY_POSTGRES_TIMEOUT_SECONDS,
        )
        checks["postgres"] = "ok"
    except Exception as exc:
        _log_readiness_failure(request, "postgres", exception=exc)
        checks["postgres"] = "unavailable"

    try:
        await asyncio.wait_for(
            check_redis(),
            timeout=READY_REDIS_TIMEOUT_SECONDS,
        )
        checks["redis"] = "ok"
    except Exception as exc:
        _log_readiness_failure(request, "redis", exception=exc)
        checks["redis"] = "unavailable"

    if checks.get("postgres") == "ok" and (pending_stage3_intents or 0) > 0:
        try:
            diagnostics = await asyncio.wait_for(
                asyncio.to_thread(
                    celery_ai_queue_consumer_diagnostics,
                    READY_WORKER_INSPECT_TIMEOUT_SECONDS,
                ),
                timeout=READY_WORKER_TIMEOUT_SECONDS,
            )
        except Exception as exc:
            _log_readiness_failure(
                request,
                "stage3_order_worker",
                exception=exc,
            )
            checks["stage3_order_worker"] = "unavailable"
        else:
            if diagnostics.get("ok"):
                checks["stage3_order_worker"] = "ok"
            else:
                _log_readiness_failure(
                    request,
                    "stage3_order_worker",
                    diagnostics=diagnostics,
                )
                checks["stage3_order_worker"] = "unavailable"

    return _health_ready_response(response, checks, pending_stage3_intents)


# Legacy /health endpoint kept for backwards-compat
@router.get("")
async def health_check():
    return {"status": "ok", "app": settings.app_name, "version": settings.version}
