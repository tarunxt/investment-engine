from __future__ import annotations

import asyncio
import hashlib
import json
import time
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
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
from app.domains.polymarket_auto_live.console_projection import (
    build_minimal_workflow_stage_results,
)
from app.domains.polymarket_auto_live.console_profile import (
    scan_console_profile_markets,
)
from app.domains.polymarket_auto_live.schemas import (
    BullpenAutoLiveConsoleRunDetail,
    BullpenAutoLiveDecision,
    BullpenAutoLiveEventTrendsResponse,
    BullpenAutoLiveHistoryPage,
    BullpenAutoLiveRun,
    BullpenAutoLiveRunOrdersResponse,
    BullpenAutoLiveRunOnceRequest,
    BullpenAutoLiveSettings,
    BullpenAutoLiveSettingsUpdate,
    BullpenAutoLivePersistedStatus,
    BullpenAutoLiveState,
    BullpenAutoLiveSummary,
    BullpenAutoLiveSummarySection,
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
DASHBOARD_SUMMARY_TIMEOUT_SECONDS = 4.0
DASHBOARD_AUTH_CACHE_TIMEOUT_SECONDS = 0.25
DASHBOARD_SUMMARY_CACHE_CONTROL = "private, no-cache"
DASHBOARD_SUMMARY_MAX_BYTES = 150_000
DASHBOARD_SUMMARY_SLOW_THRESHOLD_MS = 1_500.0
HISTORY_TIMEOUT_SECONDS = 4.0
CONSOLE_RUN_DETAIL_TIMEOUT_SECONDS = 4.0


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


async def _read_dashboard_summary(
    credentials: HTTPAuthorizationCredentials | None,
) -> tuple[BullpenAutoLiveSummary, int]:
    """Read auth and the dashboard projection through one database session.

    The dashboard used to resolve ``get_current_user`` in one session and then
    open another session inside ``get_dashboard_summary``. Under pool pressure
    that second checkout could consume the entire four-second browser budget,
    leaving a completed run displayed as queued. Reusing the authenticated
    session keeps the read bounded and prevents the stage monitor from going
    stale while workers continue successfully in the background.
    """

    async with AsyncSessionLocal() as session:
        user_id = await _resolve_persisted_status_user_id(credentials, session)
        bot = await polymarket_auto_live_bot_manager.get_bot(user_id)
        summary = await bot.get_dashboard_summary(session=session)
        summary = BullpenAutoLiveSummary.model_validate(summary)
    return summary, user_id


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
    *,
    refresh_if_stale: bool = True,
    timeout_seconds: float | None = None,
) -> BullpenAutoLiveSummary:
    broker = get_bullpen_runtime_broker()
    historical_auth_error = any(
        run_contains_historical_auth_error(run)
        for run in [summary.latest_run, *summary.recent_runs]
    )
    try:
        auth_read = broker.resolve_latest_active_auth_result(
            refresh_if_stale=refresh_if_stale and historical_auth_error,
        )
        active_auth = (
            await asyncio.wait_for(auth_read, timeout=timeout_seconds)
            if timeout_seconds is not None
            else await auth_read
        )
    except Exception as exc:
        # Unknown live auth state must not turn a historical command error into
        # a login banner. Only a persisted active doctor verdict can do that.
        active_auth = None
        sections = dict(summary.sections)
        sections["runtime_auth"] = {
            "source": "redis_active_auth_cache",
            "status": "degraded",
            "detail": "Cached Bullpen authentication verdict is temporarily unavailable.",
        }
        degraded = list(dict.fromkeys([*summary.degraded_sections, "runtime_auth"]))
        logger.warning(
            "%s",
            json.dumps(
                {
                    "event": "bullpen_dashboard_cached_auth_unavailable",
                    "error_type": type(exc).__name__,
                },
                sort_keys=True,
                separators=(",", ":"),
            ),
        )
        return summary.model_copy(
            update={
                "runtime_auth": None,
                "sections": sections,
                "degraded_sections": degraded,
            }
        )

    sections = dict(summary.sections)
    sections["runtime_auth"] = {
        "source": "redis_active_auth_cache",
        "status": "cached" if active_auth is not None else "unavailable",
        "as_of": active_auth.checked_at if active_auth is not None else None,
        "detail": (
            None
            if active_auth is not None
            else "No active Bullpen authentication verdict has been cached yet."
        ),
    }
    return summary.model_copy(
        update={
            "runtime_auth": active_auth,
            "sections": sections,
        }
    )


def _dashboard_bytes(summary: BullpenAutoLiveSummary) -> bytes:
    return summary.model_dump_json(exclude_none=True).encode("utf-8")


def _fit_dashboard_response_budget(
    summary: BullpenAutoLiveSummary,
) -> tuple[BullpenAutoLiveSummary, bytes]:
    """Degrade optional detail deterministically before exceeding 150 KB."""

    serialized = _dashboard_bytes(summary)
    if len(serialized) <= DASHBOARD_SUMMARY_MAX_BYTES:
        return summary, serialized

    sections = dict(summary.sections)
    degraded = list(summary.degraded_sections)
    sections["decisions"] = BullpenAutoLiveSummarySection(
        source="postgresql_decision_projections",
        status="degraded",
        detail=(
            "Only the ten newest decision summaries are included to keep "
            "the live response bounded. Open History for full detail."
        ),
    )
    degraded.append("decisions")
    bounded = summary.model_copy(
        update={
            "recent_decisions": summary.recent_decisions[:10],
            "sections": sections,
            "degraded_sections": list(dict.fromkeys(degraded)),
        }
    )
    serialized = _dashboard_bytes(bounded)
    if len(serialized) <= DASHBOARD_SUMMARY_MAX_BYTES:
        return bounded, serialized

    # Projections are bounded at write time, but this also protects the route
    # from a malformed/legacy projection containing excessive nested detail.
    # Durable identities, status, counters, lifecycle, and order funnels stay.
    latest_run = bounded.latest_run
    if latest_run is not None:
        latest_run = latest_run.model_copy(
            update={
                # Preserve the canonical three-stage identity and durable
                # lifecycle even when expandable diagnostics are omitted.
                # An empty list made the browser invent Stage 1 as current.
                "stage_results": build_minimal_workflow_stage_results(
                    latest_run.stage_results
                ),
                "guardrail_checks": [],
                "decision_ids": [],
                "order_intent_ids": [],
                # Diagnostics and the selected-target snapshot are compact,
                # durable aggregates. Keeping them lets the browser render the
                # completed scan's real counts while the expandable row arrays
                # are loaded from the exact-run console endpoint.
                "diagnostics": latest_run.diagnostics,
                "stage2_llm_targets_snapshot": latest_run.stage2_llm_targets_snapshot,
            }
        )
    sections = dict(bounded.sections)
    sections["workflow"] = BullpenAutoLiveSummarySection(
        source="postgresql_console_projection",
        status="degraded",
        detail=(
            "Expandable stage diagnostics exceeded the live response budget. "
            "Open run detail for the complete frozen evidence."
        ),
    )
    bounded = bounded.model_copy(
        update={
            "latest_run": latest_run,
            "recent_runs": [latest_run] if latest_run is not None else [],
            "recent_decisions": bounded.recent_decisions[:5],
            "sections": sections,
            "degraded_sections": list(
                dict.fromkeys([*bounded.degraded_sections, "workflow"])
            ),
        }
    )
    serialized = _dashboard_bytes(bounded)
    if len(serialized) <= DASHBOARD_SUMMARY_MAX_BYTES:
        return bounded, serialized

    # Fail closed for payload size while preserving scheduler/settings/control
    # state. Full run and history endpoints remain the authoritative detail.
    sections = dict(bounded.sections)
    sections["workflow"] = BullpenAutoLiveSummarySection(
        source="postgresql_console_projection",
        status="unavailable",
        detail=(
            "Workflow detail is available from History but was omitted from "
            "this live poll because it exceeded the response budget."
        ),
    )
    sections["decisions"] = BullpenAutoLiveSummarySection(
        source="postgresql_decision_projections",
        status="unavailable",
        detail=(
            "Decision detail is available from History but was omitted from "
            "this live poll because it exceeded the response budget."
        ),
    )
    bounded = bounded.model_copy(
        update={
            "latest_run": None,
            "recent_runs": [],
            "recent_decisions": [],
            "latest_guardrail_checks": [],
            "sections": sections,
            "degraded_sections": list(
                dict.fromkeys([*bounded.degraded_sections, "workflow", "decisions"])
            ),
        }
    )
    serialized = _dashboard_bytes(bounded)
    if len(serialized) > DASHBOARD_SUMMARY_MAX_BYTES:
        raise HTTPException(
            status_code=503,
            detail=(
                "Auto-Live dashboard data exceeded its safe response budget. "
                "Scheduler status remains available; retry workflow detail shortly."
            ),
            headers={"Cache-Control": "no-store"},
        )
    return bounded, serialized


@router.get("/settings", response_model=BullpenAutoLiveSettings)
async def get_auto_live_settings(current_user: User = Depends(get_current_user)):
    bot = await _get_bot(current_user)
    try:
        return await bot.get_settings()
    except SQLAlchemyError as exc:
        raise _database_not_ready_error(exc) from exc


@router.get("/stage1-scan-preview")
async def get_stage1_scan_preview(current_user: User = Depends(get_current_user)):
    """Run the canonical Stage 1 market filters without starting Stage 2/3."""
    bot = await _get_bot(current_user)
    settings = await bot.get_settings()
    scan = await scan_console_profile_markets(
        now=datetime.now(UTC),
        min_market_odds=settings.console_min_market_odds,
        custom_exclude_phrases=settings.console_custom_exclude_phrases,
        scan_scope=settings.console_scan_scope,
    )
    return {
        "source_label": scan.source_label,
        "source_url": scan.source_url,
        "scanned_at": scan.scanned_at,
        "total_candidates": scan.total_candidates,
        "scan_scope": settings.console_scan_scope,
        "scan_completeness": (
            "complete" if scan.complete_universe else "incomplete"
            if settings.console_scan_scope == "full_universe"
            else "trending"
        ),
        "bullpen_trending_rows": scan.trending_candidates,
        "complete_catalogue_markets": scan.catalogue_candidates,
        "warning": scan.warning,
        "details": scan.details,
        "accepted": [
            {
                "id": market.market_id,
                "question": market.question,
                "market_id": market.market_id,
                "close_time": market.close_time,
                "category": market.theme,
                "yes_odds": market.current_yes_odds,
                "no_odds": market.current_no_odds,
                "volume": market.volume_usd,
                "liquidity": market.liquidity_usd,
                "slug": market.slug,
                "market_url": market.market_url,
                "outcome_labels": market.outcome_labels,
                "description": market.description,
            }
            for market in scan.accepted
        ],
        "rejected": [
            {
                "id": market.market_id,
                "question": market.question,
                "market_id": market.market_id,
                "slug": market.slug,
                "market_url": market.market_url,
                "reasons": market.reasons,
            }
            for market in scan.rejected
        ],
    }


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
    request: Request,
    response: Response,
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
):
    """Load persisted console projections without worker or runtime work."""

    started_at = time.perf_counter()
    user_id: int | None = None
    try:
        summary, user_id = await asyncio.wait_for(
            _read_dashboard_summary(credentials),
            timeout=DASHBOARD_SUMMARY_TIMEOUT_SECONDS,
        )
        summary = await _attach_latest_active_auth(
            summary,
            refresh_if_stale=False,
            timeout_seconds=DASHBOARD_AUTH_CACHE_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError as exc:
        raise HTTPException(
            status_code=503,
            detail="Auto-Live dashboard data is temporarily delayed. Retry shortly.",
            headers={"Cache-Control": "no-store"},
        ) from exc
    except SQLAlchemyError as exc:
        raise _database_not_ready_error(exc) from exc

    summary, serialized = _fit_dashboard_response_budget(summary)
    etag = f'"{hashlib.sha256(serialized).hexdigest()}"'
    elapsed_ms = (time.perf_counter() - started_at) * 1000
    scheduler_section = summary.sections.get("scheduler")
    database_duration_ms = (
        scheduler_section.duration_ms
        if scheduler_section is not None
        and hasattr(scheduler_section, "duration_ms")
        else None
    )
    server_timing = ", ".join(
        [
            *(
                [f"db;dur={database_duration_ms:.1f}"]
                if database_duration_ms is not None
                else []
            ),
            f"app;dur={elapsed_ms:.1f}",
        ]
    )
    if request.headers.get("if-none-match") == etag:
        return Response(
            status_code=304,
            headers={
                "Cache-Control": DASHBOARD_SUMMARY_CACHE_CONTROL,
                "Vary": "Authorization, Cookie",
                "ETag": etag,
                "Server-Timing": server_timing,
            },
        )

    response.headers["Cache-Control"] = DASHBOARD_SUMMARY_CACHE_CONTROL
    response.headers["Vary"] = "Authorization, Cookie"
    response.headers["ETag"] = etag
    response.headers["Server-Timing"] = server_timing
    response.headers["X-Response-Bytes"] = str(len(serialized))
    if (
        elapsed_ms >= DASHBOARD_SUMMARY_SLOW_THRESHOLD_MS
        or len(serialized) > 50_000
    ):
        logger.warning(
            "%s",
            json.dumps(
                {
                    "event": "bullpen_dashboard_summary_slow_or_large",
                    "response_bytes": len(serialized),
                    "duration_ms": round(elapsed_ms, 2),
                    "database_duration_ms": (
                        round(database_duration_ms, 2)
                        if database_duration_ms is not None
                        else None
                    ),
                    "user_id": user_id,
                    "correlation_id": getattr(request.state, "correlation_id", None),
                },
                sort_keys=True,
                separators=(",", ":"),
            ),
        )
    return summary


@router.get("/history", response_model=BullpenAutoLiveHistoryPage)
async def list_auto_live_history(
    response: Response,
    page: int = Query(default=1, ge=1),
    size: int = Query(default=20, ge=1, le=50),
    current_user: User = Depends(get_current_user),
):
    """Return a compact, database-paginated run list for the History dialog."""

    started_at = time.perf_counter()
    bot = await _get_bot(current_user)
    try:
        history = await asyncio.wait_for(
            bot.list_run_history(page=page, size=size),
            timeout=HISTORY_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError as exc:
        raise HTTPException(
            status_code=503,
            detail="Auto-Live history is temporarily delayed. Retry shortly.",
            headers={"Cache-Control": "no-store"},
        ) from exc
    except SQLAlchemyError as exc:
        raise _database_not_ready_error(exc) from exc

    elapsed_ms = (time.perf_counter() - started_at) * 1000
    response.headers["Cache-Control"] = "private, no-cache"
    response.headers["Vary"] = "Authorization, Cookie"
    response.headers["Server-Timing"] = f"db;dur={elapsed_ms:.1f}, app;dur={elapsed_ms:.1f}"
    return history


@router.get("/history/event-trends", response_model=BullpenAutoLiveEventTrendsResponse)
async def list_auto_live_history_event_trends(
    response: Response,
    current_user: User = Depends(get_current_user),
):
    """Return the strongest-side score heatmap for the latest 20 scans."""
    bot = await _get_bot(current_user)
    try:
        trends = await asyncio.wait_for(bot.list_recent_event_trends(), timeout=HISTORY_TIMEOUT_SECONDS)
    except asyncio.TimeoutError as exc:
        raise HTTPException(status_code=503, detail="Auto-Live event trends are temporarily delayed. Retry shortly.", headers={"Cache-Control": "no-store"}) from exc
    except SQLAlchemyError as exc:
        raise _database_not_ready_error(exc) from exc
    response.headers["Cache-Control"] = "private, no-cache"
    response.headers["Vary"] = "Authorization, Cookie"
    return trends


@router.get("/runs", response_model=list[BullpenAutoLiveRun])
async def list_auto_live_runs(
    limit: int = Query(default=25, ge=1, le=50),
    include_detail: bool = Query(
        default=False,
        description="Include full stages, audit metadata, and request context.",
    ),
    current_user: User = Depends(get_current_user),
):
    bot = await _get_bot(current_user)
    return await bot.list_runs(limit=limit, include_detail=include_detail)


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


@router.get(
    "/runs/{run_id}/console",
    response_model=BullpenAutoLiveConsoleRunDetail,
)
async def get_auto_live_console_run_detail(
    run_id: str,
    response: Response,
    current_user: User = Depends(get_current_user),
):
    """Return one bounded exact-run projection for live dialog polling."""

    started_at = time.perf_counter()
    bot = await _get_bot(current_user)
    try:
        detail = await asyncio.wait_for(
            bot.get_console_run_detail(run_id),
            timeout=CONSOLE_RUN_DETAIL_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError as exc:
        raise HTTPException(
            status_code=503,
            detail="Auto-Live run detail is temporarily delayed. Retry shortly.",
            headers={"Cache-Control": "no-store"},
        ) from exc
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=_http_error_detail(exc)) from exc

    elapsed_ms = (time.perf_counter() - started_at) * 1000
    response.headers["Cache-Control"] = "private, no-cache"
    response.headers["Vary"] = "Authorization, Cookie"
    response.headers["Server-Timing"] = f"db;dur={elapsed_ms:.1f}, app;dur={elapsed_ms:.1f}"
    return detail


@router.get(
    "/runs/{run_id}/decisions",
    response_model=list[BullpenAutoLiveDecision],
)
async def list_auto_live_run_decisions(
    run_id: str,
    current_user: User = Depends(get_current_user),
):
    """Load full decision detail only after an operator selects one run."""

    bot = await _get_bot(current_user)
    try:
        return await bot.list_run_decisions(run_id)
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
