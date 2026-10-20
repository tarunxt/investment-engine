"""Local-only harness around real application auth/profile handlers.

No production import path references this module. Invoke via preview.py only.
"""
import asyncio
import os
import socket
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import APIRouter, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles

@compiles(JSONB, "sqlite")
def synthetic_sqlite_json(_type, _compiler, **_kw): return "JSON"

ROOT = Path(__file__).resolve().parents[2]
expected = f"sqlite+aiosqlite:///{ROOT / '.runtime/stage01-preview/preview.sqlite3'}"
if os.environ.get("DATABASE_URL") != expected or os.environ.get("STAGE01_PREVIEW") != "synthetic-only":
    raise RuntimeError("Use preview.py: only the dedicated synthetic SQLite file is allowed")

# Fail closed before application imports: no provider, SMTP, broker or Redis I/O.
def denied(*args, **kwargs):
    raise RuntimeError("Stage01 preview prohibits outbound network connections")

socket.socket.connect = denied
socket.socket.connect_ex = denied
socket.create_connection = denied

from app.domains.auth.models import User, UserProfile, UserRole, ActivityLog, UserSession, APIKey
from app.domains.jobs.models import Job  # register ORM relationships
from app.domains.prompts.models import Prompt
from app.domains.runs.models import Run, RunJob
from app.domains.jobs.router import router as jobs_router
from app.domains.runs.router import router as runs_router
from app.domains.jobs.ws_router import router as jobs_ws_router
from app.domains.runs.ws_router import router as runs_ws_router
from scripts.public_launch.preview_streams import install
install()
from app.infrastructure.database.outbox.models import OutboxMessage
from app.infrastructure.messaging.operation_models import IdempotencyOperation
from scripts.public_launch import preview_jobs, preview_stage05
from app.shared.exceptions import AppException
from app.shared.types import JobStatus
from app.domains.modules.router import router as modules_router
from app.domains.modules.models import UserModulePreferences, UserModule
from app.domains.auth.router import router
from app.core.security import PasswordUtils
from app.infrastructure.database.session import async_engine, AsyncSessionLocal


@asynccontextmanager
async def lifespan(app):
    async with async_engine.begin() as connection:
        for table in (User.__table__, UserProfile.__table__, ActivityLog.__table__,
                      UserSession.__table__, APIKey.__table__, Prompt.__table__,
                      Job.__table__, Run.__table__, RunJob.__table__,
                      OutboxMessage.__table__, IdempotencyOperation.__table__, *preview_stage05.TABLES, UserModulePreferences.__table__, UserModule.__table__):
            await connection.run_sync(table.create, checkfirst=True)
    async with AsyncSessionLocal() as db:
        for name, role in (("usera", UserRole.USER), ("userb", UserRole.USER), ("admin", UserRole.ADMIN)):
            existing = await db.scalar(select(User).where(User.username == name))
            if existing is not None and existing.email == f"{name}@example.invalid":
                existing.email = f"{name}@stage01.example.com"
            if existing is None:
                user = User(email=f"{name}@stage01.example.com", username=name,
                            full_name=f"Synthetic {name}", role=role, is_active=True,
                            is_verified=True, password_hash=PasswordUtils.hash_password("SyntheticPreview123!"))
                user.profile = UserProfile(bio=f"Synthetic preview: {name}", timezone="UTC")
                db.add(user)
        await db.flush()
        users = (await db.execute(select(User).where(User.username.in_(['usera', 'userb', 'admin'])))).scalars().all()
        for user in users:
            existing_job = await db.scalar(select(Job.id).where(Job.user_id == user.id).limit(1))
            if existing_job is None:
                job = Job(user_id=user.id, prompt=f'Stage02 private synthetic job: {user.username}',
                          provider='synthetic', model='offline', status=JobStatus.COMPLETED,
                          response=f'Private synthetic response for {user.username}', tokens_in=0, tokens_out=0)
                run = Run(user_id=user.id, prompt=job.prompt, prompt_preview=job.prompt,
                          status=JobStatus.COMPLETED, auto_export_enabled=False, export_status='disabled')
                db.add_all([job, run])
                await db.flush()
                db.add(RunJob(run_id=run.id, job_id=job.id))
        await db.commit()
    async def fake_consumer():
        while True:
            await asyncio.to_thread(preview_jobs.tick)
            await asyncio.sleep(1)
    consumer=asyncio.create_task(fake_consumer())
    try:
        yield
    finally:
        consumer.cancel()
        await asyncio.gather(consumer,return_exceptions=True)
        preview_jobs.engine.dispose()
        await async_engine.dispose()


app = FastAPI(title="Stage01 synthetic preview (real auth/profile handlers)", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=[os.environ["FRONTEND_URL"]],
                   allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

ALLOWED = {("POST", "/auth/login"), ("POST", "/auth/refresh"), ("POST", "/auth/logout"),
           ("GET", "/auth/me"), ("GET", "/auth/profile"), ("PUT", "/auth/profile"),
           ("POST", "/auth/websocket-ticket"), ("POST", "/jobs"), ("GET", "/me/modules"), ("PATCH", "/me/modules"),
           ("POST", "/me/modules/disable-impact")}


@app.middleware("http")
async def synthetic_boundary(request: Request, call_next):
    if request.url.path == "/auth/google/config" and request.method == "GET":
        return JSONResponse({"enabled": False, "client_id": None, "synthetic_preview": True})
    if request.url.path == "/preview-health":
        return JSONResponse({"synthetic": True, "database": "isolated SQLite", "outbound_network": "denied"})
    private_read = request.method == "GET" and (request.url.path in {"/jobs", "/runs"} or
                   any(request.url.path.startswith(prefix) and request.url.path[len(prefix):].isdigit()
                       for prefix in ("/jobs/", "/runs/")))
    if request.method != "OPTIONS" and (request.method, request.url.path) not in preview_stage05.ALLOWED and not private_read and (request.method, request.url.path) not in ALLOWED:
        return JSONResponse({"detail": "Unavailable in synthetic Stage01 preview; no external actions are permitted"}, status_code=503)
    response = await call_next(request)
    response.headers["X-Stage01-Synthetic-Preview"] = "true"
    return response


@app.exception_handler(AppException)
async def operation_error(_request, exc):
    return JSONResponse({'detail':exc.message},status_code=exc.status_code)

app.include_router(router)
app.include_router(modules_router)

for private_router in (jobs_router, runs_router):
    for route in private_router.routes:
        if route.path in {'/jobs', '/jobs/{job_id}', '/runs', '/runs/{run_id}'} and (route.methods == {'GET'} or route.path == '/jobs' and route.methods == {'POST'}):
            app.include_router(APIRouter(routes=[route]))

app.include_router(jobs_ws_router)
app.include_router(runs_ws_router)

preview_stage05.install(app)
