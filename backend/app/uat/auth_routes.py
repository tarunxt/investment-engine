"""Optional private login routes; requires explicit offline/live dependencies."""
import json
import time
from urllib.parse import urlsplit

from fastapi import Request
from starlette.responses import JSONResponse
from .owner_policy import AdmissionDenied

COOKIE = '__Host-credx_uat_login'


def mount_auth_routes(app, login, *, clock=time.monotonic):
    attempts = []

    def reject_duplicates(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError()
            result[key] = value
        return result

    async def body(request, fields):
        origins = request.headers.getlist('origin')
        hosts = request.headers.getlist('host')
        content_types = request.headers.getlist('content-type')
        if (origins != [login.origin] or hosts != [urlsplit(login.origin).netloc]
                or content_types != ['application/json']):
            raise ValueError()
        now = clock()
        attempts[:] = [t for t in attempts if t > now - 60]
        if len(attempts) >= 30:
            raise ValueError()
        attempts.append(now)
        data = bytearray()
        async for chunk in request.stream():
            data.extend(chunk)
            if len(data) > 17000:
                raise ValueError()
        result = json.loads(data, object_pairs_hook=reject_duplicates)
        if not isinstance(result, dict) or set(result) != set(fields):
            raise ValueError()
        return result

    def response(payload, status=200):
        return JSONResponse(payload, status_code=status, headers={'Cache-Control': 'no-store'})

    def cookie(request):
        raw = request.headers.getlist('cookie')
        if len(raw) != 1:
            raise ValueError()
        pairs = [part.strip().partition('=') for part in raw[0].split(';')]
        matches = [value for name, separator, value in pairs if name == COOKIE and separator]
        if len(matches) != 1:
            raise ValueError()
        return matches[0]

    @app.post('/auth/google/challenge')
    async def challenge(request: Request):
        try:
            await body(request, [])
            token, nonce = login.challenges.issue()
            result = response({'nonce': nonce})
            result.set_cookie(COOKIE, token, max_age=300, secure=True, httponly=True,
                              samesite='strict', path='/')
            return result
        except (ValueError, AdmissionDenied):
            return response({'detail': 'UAT identity denied'}, 401)

    @app.post('/auth/google')
    async def authenticate(request: Request):
        try:
            payload = await body(request, ['credential', 'nonce'])
            tokens = await login.login(origin=request.headers['origin'], cookie=cookie(request),
                                       nonce=payload['nonce'], credential=payload['credential'])
            result = response(tokens)
        except (ValueError, AdmissionDenied):
            result = response({'detail': 'UAT identity denied'}, 401)
        result.delete_cookie(COOKIE, secure=True, httponly=True, samesite='strict', path='/')
        return result
