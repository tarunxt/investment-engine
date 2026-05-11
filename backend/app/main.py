import time
from contextlib import asynccontextmanager
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.core.config import settings
from app.core.logging import configure_logging, get_logger
from app.core.seed import seed_system_prompts
from app.domains.ai_providers.router import router as providers_router
from app.domains.auth.router import router as auth_router
from app.domains.health.router import router as health_router
from app.domains.jobs.router import router as jobs_router
from app.domains.prompts.router import router as prompts_router
from app.infrastructure.database.session import AsyncSessionLocal, async_engine
from app.shared.exceptions import AppException

# Ensure all ORM models are registered with the shared metadata
from app.domains.auth.models import User, UserProfile, UserSession, APIKey, ActivityLog  # noqa: F401
from app.domains.jobs.models import Job  # noqa: F401
from app.domains.prompts.models import Prompt  # noqa: F401
from app.infrastructure.database.outbox.models import OutboxMessage  # noqa: F401

configure_logging()
logger = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting AI Investment Platform Backend")
    logger.info("Database: %s", settings.database_url.split("@")[-1])
    logger.info("Redis: %s", settings.redis_url)

    # Seed default prompts (idempotent — only inserts if missing)
    async with AsyncSessionLocal() as db:
        await seed_system_prompts(db)

    yield

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
    allow_origins=[settings.frontend_url],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Routers ───────────────────────────────────────────────────────────────────

app.include_router(health_router)
app.include_router(auth_router)
app.include_router(jobs_router)
app.include_router(prompts_router)
app.include_router(providers_router)


@app.get("/")
async def root():
    return {"status": "ok", "app": settings.app_name, "version": settings.version}
