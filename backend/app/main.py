import time
from contextlib import asynccontextmanager
from os import getenv
from urllib.parse import urlsplit
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.core.config import settings
from app.core.logging import configure_logging, get_logger
from app.core.seed import seed_system_prompts
from app.domains.ai_providers.router import router as providers_router
from app.domains.api_usage.router import router as api_usage_router
from app.domains.auth.router import router as auth_router
from app.domains.bullpen_run_audit.router import router as bullpen_run_audit_router
from app.domains.bullpen_trade_analysis.router import (
    router as bullpen_trade_analysis_router,
)
from app.domains.cost_drivers.router import router as cost_drivers_router
from app.domains.google_sheets.router import router as google_sheets_router
from app.domains.indmoney_us.events_router import router as indmoney_us_events_router
from app.domains.indmoney_us.router import router as indmoney_us_router
from app.domains.indmoney_us.threats_router import router as indmoney_us_threats_router
from app.domains.health.router import router as health_router
from app.domains.jobs.router import router as jobs_router
from app.domains.jobs.ws_router import router as jobs_ws_router
from app.domains.polymarket.router import router as polymarket_router
from app.domains.polymarket.runtime_broker import (
    close_bullpen_runtime_broker,
    get_bullpen_runtime_broker,
)
from app.domains.polymarket.service import polymarket_bot_manager
from app.domains.polymarket_auto_live.router import router as polymarket_auto_live_router
from app.domains.polymarket_auto_live.service import polymarket_auto_live_bot_manager
from app.domains.polymarket_direct.router import router as polymarket_direct_router
from app.domains.polymarket_direct.service import polymarket_direct_bot_manager
from app.domains.prompts.router import router as prompts_router
from app.domains.runs.router import router as runs_router
from app.domains.runs.ws_router import router as runs_ws_router
from app.domains.trading_bots.router import router as trading_bots_router
from app.domains.zerodha.router import router as zerodha_router
from app.domains.zerodha.events_router import router as zerodha_events_router
from app.domains.zerodha.threats_router import router as zerodha_threats_router
from app.infrastructure.database.session import AsyncSessionLocal, async_engine
from app.shared.exceptions import AppException

# Ensure all ORM models are registered with the shared metadata
from app.domains.cost_drivers.models import CostRecommendation, CostSnapshot, TrafficCostRollup  # noqa: F401
from app.domains.auth.models import User, UserProfile, UserSession, APIKey, ActivityLog  # noqa: F401
from app.domains.bullpen_trade_analysis.models import (  # noqa: F401
    BullpenTradeAnalysisEventLogRecord,
    BullpenTradeAnalysisLlmRecord,
    BullpenTradeAnalysisRecord,
    BullpenTradeAnalysisSnapshotRecord,
)
from app.domains.bullpen_run_audit.models import (  # noqa: F401
    BullpenRunAuditBlobRecord,
    BullpenRunAuditEventRecord,
    BullpenRunAuditFeedbackRecord,
    BullpenRunAuditFeedbackSubcallRecord,
    BullpenRunAuditFindingRecord,
    BullpenRunAuditFormulaRecord,
    BullpenRunAuditManualCheckRecord,
    BullpenRunAuditRemarkRecord,
    BullpenRunAuditSnapshotRecord,
    BullpenRunAuditStageRecord,
)
from app.domains.google_sheets.models import GoogleSheetsAppConfig, GoogleSheetsCredential  # noqa: F401
from app.domains.indmoney_us.models import IndMoneyUsPortfolioSnapshot  # noqa: F401
from app.domains.jobs.models import Job  # noqa: F401
from app.domains.polymarket.models import PolymarketRedeemAttemptRecord  # noqa: F401
from app.domains.polymarket_auto_live.models import (  # noqa: F401
    PolymarketAutoLiveDecisionRecord,
    PolymarketAutoLivePositionRecord,
    PolymarketAutoLiveRunRecord,
    PolymarketAutoLiveSettingsRecord,
    PolymarketAutoLiveStateRecord,
)
from app.domains.prompts.models import Prompt  # noqa: F401
from app.domains.runs.models import Run, RunJob  # noqa: F401
from app.domains.zerodha.audit import ZerodhaAuditLog  # noqa: F401
from app.domains.zerodha.models import ZerodhaCredential, ZerodhaPortfolioSnapshot  # noqa: F401
from app.infrastructure.database.outbox.models import OutboxMessage  # noqa: F401

configure_logging()
logger = get_logger(__name__)


def _build_cors_allowed_origins() -> list[str]:
    """Allow the configured frontend origin plus its apex/www alias."""
    origins = {
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    }

    candidates = (
        settings.frontend_url,
        getenv("NEXT_PUBLIC_FRONTEND_URL"),
        getenv("NEXTAUTH_URL"),
    )

    for candidate in candidates:
        if not candidate:
            continue

        parsed = urlsplit(candidate)
        if not parsed.scheme or not parsed.netloc:
            continue

        host = parsed.hostname
        if not host:
            continue

        port = f":{parsed.port}" if parsed.port else ""
        origins.add(f"{parsed.scheme}://{host}{port}")

        if host in {"localhost", "127.0.0.1"}:
            continue

        if host.startswith("www."):
            alias_host = host.removeprefix("www.")
        else:
            alias_host = f"www.{host}"

        origins.add(f"{parsed.scheme}://{alias_host}{port}")

    return sorted(origins)


cors_allowed_origins = _build_cors_allowed_origins()


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting AI Investment Platform Backend")
    logger.info("Database: %s", settings.database_url.split("@")[-1])
    logger.info("Redis: %s", settings.redis_url)
    logger.info("CORS allowed origins: %s", cors_allowed_origins)
    get_bullpen_runtime_broker().validate_startup()
    # Do not terminalize persisted Auto-Live runs during FastAPI startup.
    # Late-acknowledged Celery work may still be queued/reserved while systemd
    # restarts services. The dedicated Auto-Live worker schedules lifecycle-
    # aware recovery after a redelivery/heartbeat grace period instead.
    logger.info(
        "Auto-Live restart recovery is deferred to the dedicated worker grace period."
    )

    # Seed default prompts (idempotent — only inserts if missing)
    async with AsyncSessionLocal() as db:
        await seed_system_prompts(db)

    yield

    await polymarket_bot_manager.shutdown()
    await polymarket_auto_live_bot_manager.shutdown()
    await polymarket_direct_bot_manager.shutdown()
    await close_bullpen_runtime_broker()
    await async_engine.dispose()
    logger.info("Shutdown complete")


app = FastAPI(title=settings.app_name, version=settings.version, lifespan=lifespan)


# ── Exception handlers ────────────────────────────────────────────────────────

@app.exception_handler(AppException)
async def app_exception_handler(request: Request, exc: AppException):
    logger.error("Application error [%s]: %s", exc.code, exc.message)
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": exc.code, "message": exc.message, "details": exc.details},
    )


@app.exception_handler(Exception)
async def general_exception_handler(request: Request, exc: Exception):
    logger.error("Unhandled exception", exc_info=exc)
    return JSONResponse(
        status_code=500,
        content={"error": "INTERNAL_SERVER_ERROR", "message": "An unexpected error occurred"},
    )


# ── Middleware ────────────────────────────────────────────────────────────────

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
}
PRODUCTION_ENVIRONMENTS = {"production", "prod"}


def _request_is_https(request: Request) -> bool:
    forwarded_proto = request.headers.get("x-forwarded-proto", "")
    return request.url.scheme == "https" or forwarded_proto.split(",", 1)[0].strip() == "https"


def _add_security_headers(request: Request, response):
    for header, value in SECURITY_HEADERS.items():
        response.headers.setdefault(header, value)

    if settings.environment.lower() in PRODUCTION_ENVIRONMENTS and _request_is_https(request):
        response.headers.setdefault(
            "Strict-Transport-Security",
            "max-age=63072000; includeSubDomains; preload",
        )


@app.middleware("http")
async def security_headers_middleware(request: Request, call_next):
    response = await call_next(request)
    _add_security_headers(request, response)
    return response


@app.middleware("http")
async def correlation_id_middleware(request: Request, call_next):
    corr_id = request.headers.get("X-Correlation-ID", str(uuid4()))
    request.state.correlation_id = corr_id
    start = time.monotonic()
    response = await call_next(request)
    duration_ms = (time.monotonic() - start) * 1000
    logger.debug(
        "%s %s %s %.2fms corr=%s",
        request.method,
        request.url.path,
        response.status_code,
        duration_ms,
        corr_id,
    )
    response.headers["X-Correlation-ID"] = corr_id
    return response


app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Routers ───────────────────────────────────────────────────────────────────

app.include_router(health_router)
app.include_router(auth_router)
app.include_router(bullpen_run_audit_router)
app.include_router(bullpen_trade_analysis_router)
app.include_router(cost_drivers_router)
app.include_router(google_sheets_router)
app.include_router(indmoney_us_events_router)
app.include_router(indmoney_us_router)
app.include_router(indmoney_us_threats_router)
app.include_router(jobs_router)
app.include_router(jobs_ws_router)
app.include_router(polymarket_router)
app.include_router(polymarket_auto_live_router)
app.include_router(polymarket_direct_router)
app.include_router(prompts_router)
app.include_router(providers_router)
app.include_router(api_usage_router)
app.include_router(runs_router)
app.include_router(runs_ws_router)
app.include_router(trading_bots_router)
app.include_router(zerodha_events_router)
app.include_router(zerodha_router)
app.include_router(zerodha_threats_router)


@app.get("/")
async def root():
    return {"status": "ok", "app": settings.app_name, "version": settings.version}
