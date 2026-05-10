from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from contextlib import asynccontextmanager
import time

from app.db.init_db import init_db
from app.db.database import SessionLocal
from app.api.routes.jobs import router as jobs_router
from app.api.routes.auth import router as auth_router
from app.api.routes.health import router as health_router
from app.api.routes.prompts import router as prompts_router
from app.api.routes.providers import router as providers_router
from app.core.logging import configure_logging, get_logger
from app.core.config import settings
from app.core.exceptions import AppException, exception_to_http
from app.core.seed import seed_system_prompts

# Configure logging
configure_logging()
logger = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup logic
    logger.info("🚀 Starting AI Investment Platform Backend")
    init_db()
    logger.info(f"✅ Database initialized - {settings.database_url}")
    logger.info(f"✅ Redis configured - {settings.redis_url}")

    db = SessionLocal()
    try:
        seed_system_prompts(db)
    finally:
        db.close()

    yield

    # Shutdown logic
    logger.info("🛑 Shutting down AI Investment Platform Backend")


app = FastAPI(
    title=settings.app_name,
    version=settings.version,
    lifespan=lifespan
)


# Exception handlers
@app.exception_handler(AppException)
async def app_exception_handler(request: Request, exc: AppException):
    logger.error(f"Application error: {exc.code} - {exc.message}")
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "error": exc.code,
            "message": exc.message,
            "details": exc.details
        }
    )


@app.exception_handler(Exception)
async def general_exception_handler(request: Request, exc: Exception):
    logger.error(f"Unhandled exception: {str(exc)}", exc_info=exc)
    return JSONResponse(
        status_code=500,
        content={
            "error": "INTERNAL_SERVER_ERROR",
            "message": "An unexpected error occurred",
            "details": {}
        }
    )


# Request/Response logging middleware
@app.middleware("http")
async def log_requests(request: Request, call_next):
    start_time = time.time()
    
    # Log request
    logger.debug(f"→ {request.method} {request.url.path}")
    
    response = await call_next(request)
    
    # Log response
    duration_ms = (time.time() - start_time) * 1000
    logger.debug(
        f"← {request.method} {request.url.path} {response.status_code} ({duration_ms:.2f}ms)"
    )
    
    return response


# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_url],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Routes
app.include_router(health_router)
app.include_router(auth_router)
app.include_router(jobs_router)
app.include_router(prompts_router)
app.include_router(providers_router)


@app.get("/")
async def root():
    return {
        "status": "ok",
        "app": settings.app_name,
        "version": settings.version,
        "message": "AI Investment Platform Backend is running"
    }