from __future__ import annotations

import asyncio
import json
import time

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import get_logger
from app.core.security import JWTUtils
from app.domains.auth.dependencies import (
    get_current_user,
    get_or_create_dev_user,
    is_auth_disabled,
    security,
)
from app.domains.auth.models import User
from app.domains.polymarket.runtime_broker import get_bullpen_runtime_broker
from app.domains.polymarket_auto_live.schemas import (
    BullpenAutoLiveDecision,
    BullpenAutoLiveRun,
    BullpenAutoLiveRunOrdersResponse,
    BullpenAutoLiveRunOnceRequest,
    BullpenAutoLiveSettings,
    BullpenAutoLiveSettingsUpdate,
    BullpenAutoLivePersistedStatus,
    BullpenAutoLiveState,
    BullpenAutoLiveSummary,
)
from app.domains.polymarket_auto_live.service import polymarket_auto_live_bot_manager
from app.domains.polymarket_auto_live.run_recovery import (
    run_contains_historical_auth_error,
)
from app.infrastructure.database.session import AsyncSessionLocal

router = APIRouter(prefix="/polymarket/auto-live", tags=["polymarket"])
logger = get_logger(__name__)

# A persisted status read is two primary-key rows plus one indexed active-run
# identity lookup. Bound it well below the browser timeout so a saturated
# database produces a compact retryable state instead of a page-level
# indefinite wait.
PERSISTED_STATUS_TIMEOUT_SECONDS = 2.0
PERSISTED_STATUS_SLOW_THRESHOLD_MS = 500.0
PERSISTED_STATUS_CACHE_CONTROL = "private, max-age=5, stale-while-revalidate=30"


async def _get_bot(current_user: User):
    return await polymarket_auto_live_bot_manager.get_bot(current_user.id)


async def _resolve_persisted_status_user_id(
    credentials: HTTPAuthorizationCredentials | None,
    session: AsyncSession,
) -> int:
    """Resolve only the auth fields needed by the first-paint status read.

    The normal ``get_current_user`` dependency eagerly loads a profile using a
    separate request session.  This endpoint instead uses its single session
    for the minimal user lookup plus the two scheduler records, so database
    pool pressure cannot double its connection use.
    """

    if not credentials:
        if is_auth_disabled():
            return (await get_or_create_dev_user(session)).id
        raise HTTPException(
            status_code=401,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )

    payload = JWTUtils.verify_token(credentials.credentials)
    if not payload:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    try:
        user_id = int(payload.get("sub"))
    except (TypeError, ValueError):
        raise HTTPException(status_code=401, detail="Invalid token payload") from None

    row = (
        await session.execute(
            select(User.id, User.is_active).where(User.id == user_id)
        )
    ).one_or_none()
    if row is None:
        raise HTTPException(status_code=401, detail="User not found")
    if not row.is_active:
        raise HTTPException(status_code=403, detail="User account is inactive")
    return int(row.id)


async def _read_persisted_status(
    credentials: HTTPAuthorizationCredentials | None,
) -> tuple[BullpenAutoLivePersistedStatus, int, float]:
    """Read auth and scheduler rows in one short-lived database session."""

    database_started_at = time.perf_counter()
    async with AsyncSessionLocal() as session:
        user_id = await _resolve_persisted_status_user_id(credentials, session)
        bot = await polymarket_auto_live_bot_manager.get_bot(user_id)
        snapshot = await bot.get_persisted_status(session=session)
        # Keep malformed persisted payloads inside the same bounded read.  This
        # is defensive for legacy rows and also ensures a corrupt snapshot
        # becomes a compact retryable response rather than a response-model 500.
        snapshot = BullpenAutoLivePersistedStatus.model_validate(snapshot)
    database_duration_ms = (time.perf_counter() - database_started_at) * 1000
    return snapshot, user_id, database_duration_ms


def _http_error_detail(exc: Exception) -> str:
    message = str(exc).strip()
    if message and message.lower() != "none":
        return f"{exc.__class__.__name__}: {message}"
    return f"{exc.__class__.__name__}: {exc!r}"


def _database_not_ready_error(exc: SQLAlchemyError) -> HTTPException:
    logger.warning(
        "%s",
        json.dumps(
            {
                "event": "bullpen_auto_live_database_unavailable",
                "error_type": type(exc).__name__,
            },
            sort_keys=True,
            separators=(",", ":"),
        ),
        exc_info=exc,
    )
    return HTTPException(
        status_code=503,
        detail="Auto-Live data is temporarily unavailable. Retry shortly.",
    )


def _persisted_status_server_timing(
    duration_ms: float,
    database_duration_ms: float | None = None,
) -> str:
    parts = []
    if database_duration_ms is not None:
        parts.append(f"db;dur={database_duration_ms:.1f}")
    # This endpoint intentionally makes no Redis, Bullpen CLI, Celery, or
    # provider calls. The app timing covers response validation/serialization.
    parts.append(f"app;dur={duration_ms:.1f}")
    return ", ".join(parts)


def _log_persisted_status_duration(
    *,
    request: Request,
    user_id: int | None,
    outcome: str,
    duration_ms: float,
    database_duration_ms: float | None = None,
    exception: BaseException | None = None,
) -> None:
    payload = {
        "event": "bullpen_auto_live_persisted_status",
        "path": request.url.path,
        "outcome": outcome,
        "duration_ms": round(duration_ms, 2),
        "correlation_id": getattr(request.state, "correlation_id", None)
        or request.headers.get("X-Correlation-ID"),
        "user_id": user_id,
        "database_duration_ms": (
            round(database_duration_ms, 2)
            if database_duration_ms is not None
            else None
        ),
        "redis_duration_ms": 0,
        "runtime_duration_ms": 0,
        "external_duration_ms": 0,
    }
    if exception is not None:
        payload["error_type"] = type(exception).__name__
    log = (
        logger.debug
        if outcome == "ok" and duration_ms < PERSISTED_STATUS_SLOW_THRESHOLD_MS
        else logger.warning
    )
    exc_info = (
        (type(exception), exception, exception.__traceback__)
        if exception is not None
        and not isinstance(exception, (HTTPException, asyncio.CancelledError))
        else None
    )
    log(
        "%s",
        json.dumps(payload, sort_keys=True, separators=(",", ":")),
        exc_info=exc_info,
    )


async def _attach_latest_active_auth(
    summary: BullpenAutoLiveSummary,
) -> BullpenAutoLiveSummary:
    broker = get_bullpen_runtime_broker()
    historical_auth_error = any(
        run_contains_historical_auth_error(run)
        for run in [summary.latest_run, *summary.recent_runs]
    )
    try:
        active_auth = await broker.resolve_latest_active_auth_result(
            refresh_if_stale=historical_auth_error,
        )
    except Exception:
        # Unknown live auth state must not turn a historical command error into
        # a login banner. Only a persisted active doctor verdict can do that.
        active_auth = None
    return summary.model_copy(update={"runtime_auth": active_auth})


@router.get("/settings", response_model=BullpenAutoLiveSettings)
async def get_auto_live_settings(current_user: User = Depends(get_current_user)):
    bot = await _get_bot(current_user)
    try:
        return await bot.get_settings()
    except SQLAlchemyError as exc:
        raise _database_not_ready_error(exc) from exc


@router.put("/settings", response_model=BullpenAutoLiveSettings)
async def update_auto_live_settings(
    request: BullpenAutoLiveSettingsUpdate,
    current_user: User = Depends(get_current_user),
):
    bot = await _get_bot(current_user)
    try:
        return await bot.update_settings(request)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=_http_error_detail(exc)) from exc


@router.post("/settings/reset", response_model=BullpenAutoLiveSettings)
async def reset_auto_live_settings(current_user: User = Depends(get_current_user)):
    bot = await _get_bot(current_user)
    return await bot.reset_settings()


@router.get("/state", response_model=BullpenAutoLiveState)
async def get_auto_live_state(current_user: User = Depends(get_current_user)):
    bot = await _get_bot(current_user)
    try:
        return await bot.get_state()
    except SQLAlchemyError as exc:
        raise _database_not_ready_error(exc) from exc


@router.get("/status", response_model=BullpenAutoLivePersistedStatus)
async def get_auto_live_persisted_status(
    request: Request,
    response: Response,
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
):
    """Read the scheduler/configuration rows without probing runtime services.

    This endpoint intentionally does not share the behavior of ``/summary``:
    it never runs recovery, enqueues a due run, asks Celery for worker state,
    reads Redis, or invokes Bullpen authentication.  Runtime diagnostics remain
    available from their dedicated endpoints and can load independently.
    """

    started_at = time.perf_counter()
    outcome = "ok"
    caught_exception: BaseException | None = None
    user_id: int | None = None
    database_duration_ms: float | None = None
    try:
        # ``wait_for`` covers authentication, session checkout, both indexed
        # scheduler reads, and persisted payload validation. It is compatible
        # with the systemd runtime's Python 3.10+ baseline and avoids a 30s
        # SQLAlchemy pool wait before this endpoint can return its fallback.
        snapshot, user_id, database_duration_ms = await asyncio.wait_for(
            _read_persisted_status(credentials),
            timeout=PERSISTED_STATUS_TIMEOUT_SECONDS,
        )
        # Keep this defensive validation here as well: it protects the route
        # contract when tests or future adapters replace the read helper.
        if not isinstance(snapshot, BullpenAutoLivePersistedStatus):
            snapshot = BullpenAutoLivePersistedStatus.model_validate(snapshot)
    except asyncio.CancelledError as exc:
        outcome = "cancelled"
        caught_exception = exc
        raise
    except asyncio.TimeoutError as exc:
        outcome = "timeout"
        caught_exception = exc
        duration_ms = (time.perf_counter() - started_at) * 1000
        raise HTTPException(
            status_code=503,
            detail="Auto-Live status is temporarily unavailable. Retry shortly.",
            headers={
                "Cache-Control": "no-store",
                "Server-Timing": _persisted_status_server_timing(
                    duration_ms,
                    database_duration_ms,
                ),
            },
        ) from exc
    except HTTPException as exc:
        outcome = f"http-{exc.status_code}"
        caught_exception = exc
        raise
    except SQLAlchemyError as exc:
        outcome = "database-error"
        caught_exception = exc
        duration_ms = (time.perf_counter() - started_at) * 1000
        # This is a new lightweight browser-facing endpoint.  Unlike the
        # legacy summary route, never reflect driver or connection details.
        raise HTTPException(
            status_code=503,
            detail="Auto-Live status is temporarily unavailable. Retry shortly.",
            headers={
                "Cache-Control": "no-store",
                "Server-Timing": _persisted_status_server_timing(
                    duration_ms,
                    database_duration_ms,
                ),
            },
        ) from exc
    except Exception as exc:
        outcome = "error"
        caught_exception = exc
        duration_ms = (time.perf_counter() - started_at) * 1000
        raise HTTPException(
            status_code=503,
            detail="Auto-Live status is temporarily unavailable. Retry shortly.",
            headers={
                "Cache-Control": "no-store",
                "Server-Timing": _persisted_status_server_timing(
                    duration_ms,
                    database_duration_ms,
                ),
            },
        ) from exc
    finally:
        duration_ms = (time.perf_counter() - started_at) * 1000
        _log_persisted_status_duration(
            request=request,
            user_id=user_id,
            outcome=outcome,
            duration_ms=duration_ms,
            database_duration_ms=database_duration_ms,
            exception=caught_exception,
        )

    response.headers["Cache-Control"] = PERSISTED_STATUS_CACHE_CONTROL
    response.headers["Vary"] = "Authorization, Cookie"
    response.headers["Server-Timing"] = _persisted_status_server_timing(
        duration_ms,
        database_duration_ms,
    )
    return snapshot


@router.get("/summary", response_model=BullpenAutoLiveSummary)
async def get_auto_live_summary(current_user: User = Depends(get_current_user)):
    bot = await _get_bot(current_user)
    try:
        return await _attach_latest_active_auth(await bot.get_summary())
    except SQLAlchemyError as exc:
        raise _database_not_ready_error(exc) from exc


@router.get("/summary/dashboard", response_model=BullpenAutoLiveSummary)
async def get_auto_live_dashboard_summary(
    current_user: User = Depends(get_current_user),
):
    """Load current dashboard progress without ten historical stage payloads."""

    bot = await _get_bot(current_user)
    try:
        return await _attach_latest_active_auth(await bot.get_dashboard_summary())
    except SQLAlchemyError as exc:
        raise _database_not_ready_error(exc) from exc


@router.get("/runs", response_model=list[BullpenAutoLiveRun])
async def list_auto_live_runs(current_user: User = Depends(get_current_user)):
    bot = await _get_bot(current_user)
    return await bot.list_runs()


@router.get("/runs/{run_id}", response_model=BullpenAutoLiveRun)
async def get_auto_live_run(
    run_id: str,
    current_user: User = Depends(get_current_user),
):
    """Return one user-owned durable run for ambiguity-safe start recovery."""

    bot = await _get_bot(current_user)
    try:
        return await bot.get_run(run_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=_http_error_detail(exc)) from exc


@router.get("/runs/{run_id}/orders", response_model=BullpenAutoLiveRunOrdersResponse)
async def get_auto_live_run_orders(
    run_id: str,
    current_user: User = Depends(get_current_user),
):
    bot = await _get_bot(current_user)
    try:
        return await bot.get_run_orders(run_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=_http_error_detail(exc)) from exc


@router.post("/runs/{run_id}/reconcile", response_model=BullpenAutoLiveRunOrdersResponse)
async def reconcile_auto_live_run_order_states(
    run_id: str,
    current_user: User = Depends(get_current_user),
):
    bot = await _get_bot(current_user)
    try:
        return await bot.reconcile_run_orders(run_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=_http_error_detail(exc)) from exc


@router.post(
    "/runs/{run_id}/retry-exits-and-continue-buys",
    response_model=BullpenAutoLiveRunOrdersResponse,
)
async def retry_failed_exits_and_continue_buys(
    run_id: str,
    current_user: User = Depends(get_current_user),
):
    bot = await _get_bot(current_user)
    try:
        return await bot.retry_failed_exits_and_continue_buys(run_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=_http_error_detail(exc)) from exc


@router.get("/decisions", response_model=list[BullpenAutoLiveDecision])
async def list_auto_live_decisions(current_user: User = Depends(get_current_user)):
    bot = await _get_bot(current_user)
    return await bot.list_decisions()


@router.post("/orders/{intent_id}/retry", response_model=BullpenAutoLiveRunOrdersResponse)
async def retry_auto_live_order(
    intent_id: str,
    remote_absence_verified: bool = False,
    current_user: User = Depends(get_current_user),
):
    bot = await _get_bot(current_user)
    try:
        return await bot.retry_order_intent(
            intent_id,
            remote_absence_verified=remote_absence_verified,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=_http_error_detail(exc)) from exc


@router.post("/orders/{intent_id}/cancel", response_model=BullpenAutoLiveRunOrdersResponse)
async def cancel_auto_live_order(
    intent_id: str,
    current_user: User = Depends(get_current_user),
):
    bot = await _get_bot(current_user)
    try:
        return await bot.cancel_order_intent(intent_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=_http_error_detail(exc)) from exc


@router.post("/run-once", response_model=BullpenAutoLiveRun)
async def run_auto_live_once(
    request: BullpenAutoLiveRunOnceRequest | None = None,
    current_user: User = Depends(get_current_user),
):
    bot = await _get_bot(current_user)
    try:
        return await bot.run_once(triggered_by="manual", request=request)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=_http_error_detail(exc)) from exc


@router.post("/start", response_model=BullpenAutoLiveState)
async def start_auto_live(current_user: User = Depends(get_current_user)):
    bot = await _get_bot(current_user)
    return await bot.start()


@router.post("/stop", response_model=BullpenAutoLiveState)
async def stop_auto_live(current_user: User = Depends(get_current_user)):
    bot = await _get_bot(current_user)
    return await bot.stop()


@router.post("/pause", response_model=BullpenAutoLiveState)
async def pause_auto_live(current_user: User = Depends(get_current_user)):
    bot = await _get_bot(current_user)
    return await bot.pause()


@router.post("/resume", response_model=BullpenAutoLiveState)
async def resume_auto_live(current_user: User = Depends(get_current_user)):
    bot = await _get_bot(current_user)
    return await bot.resume()


@router.post("/emergency-stop", response_model=BullpenAutoLiveState)
async def emergency_stop_auto_live(current_user: User = Depends(get_current_user)):
    bot = await _get_bot(current_user)
    return await bot.emergency_stop()


@router.post("/clear-emergency-stop", response_model=BullpenAutoLiveState)
async def clear_auto_live_emergency_stop(
    current_user: User = Depends(get_current_user),
):
    bot = await _get_bot(current_user)
    return await bot.clear_emergency_stop()
