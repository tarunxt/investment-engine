"""ASGI owner barrier for all downstream pages/assets/API; no WebSockets.

Only the two exact POST login protocol paths are bootstrap exceptions. They
still enforce origin/host, challenge cookies and Google verification downstream.
An external private-access boundary is still required before any exposure.
"""
from urllib.parse import urlsplit
from starlette.responses import JSONResponse
from app.uat.owner_policy import AdmissionDenied

SESSION_COOKIE='__Host-credx_uat_session'
BOOTSTRAP=frozenset(['/auth/google/challenge','/auth/google'])


def cookie_token(headers):
    values=[v for k,v in headers if k.lower()==b'cookie']
    if len(values)!=1 or len(values[0])>18000: raise AdmissionDenied('UAT session denied')
    parts=[p.strip().partition(b'=') for p in values[0].split(b';')]
    tokens=[v for k,sep,v in parts if k==SESSION_COOKIE.encode() and sep]
    if len(tokens)!=1 or not tokens[0]:raise AdmissionDenied('UAT session denied')
    try:return tokens[0].decode('ascii')
    except UnicodeError:raise AdmissionDenied('UAT session denied') from None


class OwnerBarrier:
    def __init__(self,app,*,sessions,origin,content_security_policy=None):
        self.app,self.sessions,self.origin=app,sessions,origin
        self.host=urlsplit(origin).netloc.encode()
        self.csp=(content_security_policy or "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'").encode()

    async def __call__(self,scope,receive,send):
        if scope['type']=='lifespan':return await self.app(scope,receive,send)
        if scope['type']=='websocket':
            return await send({'type':'websocket.close','code':1008})
        if scope['type']!='http':return
        headers=scope.get('headers',[])
        def values(name):return [v for k,v in headers if k.lower()==name]
        async def denied():
            await JSONResponse({'detail':'UAT access denied'},status_code=401,
                headers={'Cache-Control':'no-store','X-Robots-Tag':'noindex'})(scope,receive,send)
        if (values(b'host')!=[self.host] or values(b'authorization') or
            scope.get('scheme')!='https' or len(headers)>80):return await denied()
        if scope.get('method') not in ('GET','HEAD') and values(b'origin')!=[self.origin.encode()]:
            return await denied()
        path=scope.get('path','')
        if scope.get('method')=='POST' and path in BOOTSTRAP:
            return await self.app(scope,receive,send)
        try:
            token=cookie_token(headers)
            await self.sessions.authenticate(token,'access')
        except Exception:
            return await denied()
        # Client Authorization is forbidden. Only the validated host-only cookie
        # becomes the internal bearer credential required by the private API.
        internal=dict(scope)
        internal['headers']=headers+[(b'authorization',b'Bearer '+token.encode())]
        async def secure_send(message):
            if message['type']=='http.response.start':
                message=dict(message)
                message['headers']=[(k,v) for k,v in message.get('headers',[]) if k.lower() not in (b'cache-control',b'content-security-policy')]+[
                    (b'cache-control',b'no-store'),(b'x-robots-tag',b'noindex'),
                    (b'content-security-policy',self.csp),
                    (b'x-content-type-options',b'nosniff')]
            await send(message)
        return await self.app(internal,receive,secure_send)
