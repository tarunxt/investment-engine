"""Restricted composition of actual CredX routes with synthetic adapters."""
from contextlib import asynccontextmanager
from fastapi import APIRouter, FastAPI, WebSocket
from fastapi.responses import JSONResponse
from app.core.uat2 import validate_uat2_startup, uat2_mode
from app.domains.auth.router import router as auth_router
from app.domains.modules.router import router as modules_router
from app.domains.indmoney_us.router import router as us_router
from app.uat2.router import router
from app.domains.jobs.router import router as jobs_router
from app.domains.runs.router import router as runs_router
from app.shared.exceptions import AppException
from app.domains.jobs.models import Job  # noqa: F401: existing User relationship
from app.domains.prompts.models import Prompt  # noqa: F401


@asynccontextmanager
async def lifespan(app):
    if not uat2_mode():
        raise RuntimeError("Restricted UAT2 entrypoint requires CREDX_UAT2=1")
    validate_uat2_startup()
    yield


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
app.include_router(auth_router)
# Management contract only; optional domain routers remain unavailable.
app.include_router(modules_router)
# Only portfolio read routes: price fetches and ingestion remain disabled.
for route in us_router.routes:
    if route.path in {'/indmoney-us/portfolio', '/indmoney-us/portfolio/{snapshot_id}'} and route.methods == {'GET'}:
        app.include_router(APIRouter(routes=[route]))
# Read-only actual job/run handlers make Stage02 ownership reviewable without
# mounting AI dispatch, exports, cancellations or production WebSocket relays.
for private_router in (jobs_router, runs_router):
    for route in private_router.routes:
        if route.path in {'/jobs', '/jobs/{job_id}', '/runs', '/runs/{run_id}'} and route.methods == {'GET'}:
            app.include_router(APIRouter(routes=[route]))
app.include_router(router)


@app.exception_handler(AppException)
async def application_error(_request, exc):
    return JSONResponse(status_code=exc.status_code,
                        content={'error': exc.code, 'message': exc.message, 'details': exc.details})


@app.get('/health')
async def health():
    return {'status': 'ok', 'environment': 'uat2', 'simulation': True}


@app.api_route('/{path:path}', methods=['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'])
async def unavailable(path: str):
    return JSONResponse({'detail': 'Module unavailable in UAT2 simulation',
                         'code': 'UAT2_UNAVAILABLE'}, status_code=503)


@app.websocket('/{path:path}')
async def unavailable_socket(websocket: WebSocket, path: str):
    await websocket.close(code=1008, reason='WebSockets unavailable in UAT2; use polling')

from app.domains.modules.transports import install_route_policy
install_route_policy(app)
