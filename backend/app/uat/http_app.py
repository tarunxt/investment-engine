"""Restricted HTTP factory for private tests; intentionally no deployable app.

Login routes mount only with an explicitly injected GoogleLogin. Refresh,
barrier and live dependencies are not supplied. A production router must never
be mounted here to fill those gaps. Session authentication is
injected by the caller, with separate signing and verified owner policy required.
"""
from dataclasses import asdict
import json
from urllib.parse import urlsplit
from typing import Literal
from fastapi import Depends, FastAPI, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field
from .owner_policy import AdmissionDenied
from .simulation import SyntheticBroker, SyntheticExportSink


class OrderInput(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    request_id: str = Field(min_length=1, max_length=64, pattern=r'^[a-zA-Z0-9_-]+$')
    symbol: Literal['SYNTHETIC-INDEX']
    side: Literal['buy', 'sell']
    quantity: int = Field(ge=1, le=100)


class ExportRow(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    symbol: Literal['SYNTHETIC-INDEX']
    quantity: int = Field(ge=0, le=100)


class ExportInput(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    rows: list[ExportRow] = Field(max_length=100)


def create_private_app(sessions, *, google_login=None):
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    broker = SyntheticBroker({'environment': 'uat', 'adapter': 'synthetic-v1'})
    export_sink = SyntheticExportSink({'environment': 'uat', 'destination': 'memory-sink-v1'})
    if google_login is not None:
        from .auth_routes import mount_auth_routes
        mount_auth_routes(app, google_login)

    async def owner(request: Request):
        values = request.headers.getlist('authorization')
        if len(values) != 1 or not values[0].startswith('Bearer '):
            raise HTTPException(401, 'UAT session required')
        try:
            return await sessions.authenticate(values[0][7:], 'access')
        except AdmissionDenied:
            raise HTTPException(401, 'UAT session denied') from None

    @app.get('/health', dependencies=[Depends(owner)])
    async def health():
        return {'status': 'ok', 'environment': 'uat', 'simulation': True}

    @app.get('/auth/me')
    async def me(user=Depends(owner)):
        return {'id': str(user.id), 'email': user.email, 'simulation': True}

    @app.post('/simulation/orders', dependencies=[Depends(owner)])
    async def order(payload: OrderInput):
        try:
            return asdict(broker.submit(**payload.model_dump()))
        except ValueError:
            raise HTTPException(409, 'Synthetic order rejected') from None

    @app.post('/simulation/exports', dependencies=[Depends(owner)])
    async def export(request: Request):
        # Require the same explicitly configured origin as the Google flow.
        # There is no client-selected destination, filesystem path or provider.
        origin = getattr(google_login, 'origin', None)
        if (not isinstance(origin, str) or not origin.startswith('https://')
                or request.headers.getlist('origin') != [origin]
                or request.headers.getlist('host') != [urlsplit(origin).netloc]
                or request.headers.getlist('content-type') != ['application/json']):
            raise HTTPException(401, 'UAT export denied')
        data = bytearray()
        async for chunk in request.stream():
            if len(data) + len(chunk) > 16384:
                raise HTTPException(413, 'Synthetic export too large')
            data.extend(chunk)
        def unique(pairs):
            result = {}
            for key, value in pairs:
                if key in result:
                    raise ValueError('duplicate field')
                result[key] = value
            return result
        try:
            payload = ExportInput.model_validate(json.loads(data, object_pairs_hook=unique))
        except (ValueError, TypeError, UnicodeError, RecursionError):
            raise HTTPException(422, 'Synthetic export rejected') from None
        try:
            return export_sink.export([row.model_dump() for row in payload.rows])
        except ValueError:
            raise HTTPException(409, 'Synthetic export rejected') from None

    return app

