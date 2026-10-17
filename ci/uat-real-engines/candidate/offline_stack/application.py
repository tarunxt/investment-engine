"""Private assembled candidate. No environment loader or module-level app."""
import json
from fastapi import Request
from starlette.responses import HTMLResponse, Response, JSONResponse
from app.uat.http_app import create_private_app
from .barrier import OwnerBarrier, SESSION_COOKIE, cookie_token


class CookieExchange:
    def __init__(self,app):self.app=app

    async def __call__(self,scope,receive,send):
        if scope['type']!='http' or scope.get('method')!='POST' or scope.get('path')!='/auth/google':
            return await self.app(scope,receive,send)
        messages=[];size=0
        async def buffer(message):
            nonlocal size
            size+=len(message.get('body',b''))
            if size>18000:raise ValueError('bounded login response')
            messages.append(message)
        await self.app(scope,receive,buffer)
        start=next(m for m in messages if m['type']=='http.response.start')
        body=b''.join(m.get('body',b'') for m in messages)
        if start['status']!=200:
            for message in messages:await send(message)
            return
        token=json.loads(body)['access_token']
        result=JSONResponse({'authenticated':True,'simulation':True},headers={'Cache-Control':'no-store'})
        result.set_cookie(SESSION_COOKIE,token,max_age=900,secure=True,httponly=True,samesite='strict',path='/')
        # Preserve the challenge-cookie deletion from the verified login route.
        result.raw_headers.extend((k,v) for k,v in start['headers'] if k.lower()==b'set-cookie')
        await result(scope,receive,send)


def assemble(*,sessions,google_login,registry,frontend_directory=None):
    app=create_private_app(sessions,google_login=google_login)

    @app.post('/auth/logout')
    async def logout(request:Request):
        await registry.revoke(cookie_token(request.scope['headers']))
        result=JSONResponse({'authenticated':False},headers={'Cache-Control':'no-store'})
        result.delete_cookie(SESSION_COOKIE,secure=True,httponly=True,samesite='strict',path='/')
        return result

    from starlette.staticfiles import StaticFiles
    from .frontend_assets import export_policy
    if frontend_directory is None:
        raise ValueError('Explicit reviewed frontend export required')
    policy=export_policy(frontend_directory)
    app.mount('/',StaticFiles(directory=frontend_directory,html=True),name='private-frontend')
    return OwnerBarrier(CookieExchange(app),sessions=sessions,origin=google_login.origin,content_security_policy=policy)
