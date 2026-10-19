"""Local-only harness around real application auth/profile handlers.

No production import path references this module. Invoke via preview.py only.
"""
import os
import socket
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import APIRouter, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import select

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
from app.shared.types import JobStatus
from app.domains.auth.router import router
from app.core.security import PasswordUtils
from app.infrastructure.database.session import async_engine, AsyncSessionLocal


@asynccontextmanager
async def lifespan(app):
    async with async_engine.begin() as connection:
        for table in (User.__table__, UserProfile.__table__, ActivityLog.__table__,
                      UserSession.__table__, APIKey.__table__, Prompt.__table__,
                      Job.__table__, Run.__table__, RunJob.__table__):
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
    yield
    await async_engine.dispose()


app = FastAPI(title="Stage01 synthetic preview (real auth/profile handlers)", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=[os.environ["FRONTEND_URL"]],
                   allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

ALLOWED = {("POST", "/auth/login"), ("POST", "/auth/refresh"), ("POST", "/auth/logout"),
           ("GET", "/auth/me"), ("GET", "/auth/profile"), ("PUT", "/auth/profile")}


@app.middleware("http")
async def synthetic_boundary(request: Request, call_next):
    if request.url.path == "/auth/google/config" and request.method == "GET":
        return JSONResponse({"enabled": False, "client_id": None, "synthetic_preview": True})
    if request.url.path == "/preview-health":
        return JSONResponse({"synthetic": True, "database": "isolated SQLite", "outbound_network": "denied"})
    private_read = request.method == "GET" and (request.url.path in {"/jobs", "/runs"} or
                   any(request.url.path.startswith(prefix) and request.url.path[len(prefix):].isdigit()
                       for prefix in ("/jobs/", "/runs/")))
    if request.method != "OPTIONS" and not private_read and (request.method, request.url.path) not in ALLOWED:
        return JSONResponse({"detail": "Unavailable in synthetic Stage01 preview; no external actions are permitted"}, status_code=503)
    response = await call_next(request)
    response.headers["X-Stage01-Synthetic-Preview"] = "true"
    return response


app.include_router(router)

for private_router in (jobs_router, runs_router):
    for route in private_router.routes:
        if route.path in {'/jobs', '/jobs/{job_id}', '/runs', '/runs/{run_id}'} and route.methods == {'GET'}:
            app.include_router(APIRouter(routes=[route]))
