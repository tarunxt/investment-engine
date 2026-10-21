"""Fail-closed startup and bounded ASGI ingress. Never logs request contents."""
import asyncio
from urllib.parse import urlsplit


def validate_public_startup(settings):
    env=settings.environment.lower()
    if env not in {'production','prod','uat2','development','test'}:
        raise RuntimeError('Unknown deployment environment')
    if settings.auth_disabled and (env not in {'development','test'} or urlsplit(settings.frontend_url).hostname not in {'localhost','127.0.0.1','::1'}):
        raise RuntimeError('Auth bypass requires explicit isolated loopback development')
    if env not in {'development','test'}:
        from app.core.security import signing_key
        if settings.auth_disabled or settings.debug:
            raise RuntimeError('Public service requires authentication and debug disabled')
        signing_key()
        parsed=urlsplit(settings.frontend_url)
        if parsed.scheme!='https' or not parsed.hostname or parsed.username or parsed.query or parsed.fragment:
            raise RuntimeError('Public service requires an explicit HTTPS frontend origin')


def origin(value):
    try:
        p=urlsplit(value or '')
        if p.scheme not in {'http','https'} or not p.hostname or p.username or p.password or p.query or p.fragment or p.path not in {'','/'}:return None
        return (p.scheme,p.hostname,p.port or (443 if p.scheme=='https' else 80))
    except ValueError:return None


class PublicIngress:
    """Body cap includes chunked uploads. No cookies accepted cross-origin.

    Backend bearer/service clients may omit Origin. Browser cookie mutations
    must carry the exact configured origin; the existing BFF adds its own CSRF
    and request-local confirmation. This does not replace those checks.
    """
    def __init__(self,app,*,frontend_url,max_body=2*1024*1024):
        self.app,self.allowed,self.max_body=app,origin(frontend_url),max_body
        if not self.allowed or type(max_body)is not int or not 1024<=max_body<=8*1024*1024:raise ValueError('Invalid ingress policy')

    async def __call__(self,scope,receive,send):
        if scope['type'] not in {'http','websocket'}:return await self.app(scope,receive,send)
        headers=scope.get('headers',[]);origins=[v.decode('latin1') for k,v in headers if k.lower()==b'origin']
        bad=len(origins)>1 or bool(origins and origin(origins[0])!=self.allowed)
        if scope['type']=='websocket':
            if bad or not origins:return await send({'type':'websocket.close','code':1008})
            return await self.app(scope,receive,send)
        method=scope.get('method','GET');cookie=any(k.lower()==b'cookie' for k,v in headers)
        if bad or (cookie and method not in {'GET','HEAD','OPTIONS'} and not origins):return await self.reject(send,403)
        lengths=[v for k,v in headers if k.lower()==b'content-length']
        if len(lengths)>1 or (lengths and any(k.lower()==b'transfer-encoding' for k,v in headers)):return await self.reject(send,400)
        if lengths:
            try:
                if not lengths[0].isdigit():raise ValueError
                if int(lengths[0])>self.max_body:return await self.reject(send,413)
            except ValueError:return await self.reject(send,400)
        chunks=[];size=0;deadline=asyncio.get_running_loop().time()+10
        while True:
            try:m=await asyncio.wait_for(receive(),timeout=max(0,deadline-asyncio.get_running_loop().time()))
            except TimeoutError:return await self.reject(send,408)
            if m['type']=='http.disconnect':return
            size+=len(m.get('body',b''))
            if size>self.max_body:return await self.reject(send,413)
            chunks.append(m.get('body',b''))
            if not m.get('more_body',False):break
        if lengths and int(lengths[0])!=size:return await self.reject(send,400)
        consumed=False
        async def bounded_receive():
            nonlocal consumed
            if consumed:return await receive()
            consumed=True;return {'type':'http.request','body':b''.join(chunks),'more_body':False}
        await self.app(scope,bounded_receive,send)

    @staticmethod
    async def reject(send,status):
        await send({'type':'http.response.start','status':status,'headers':[(b'cache-control',b'no-store'),(b'content-type',b'application/json')]})
        await send({'type':'http.response.body','body':b'{"detail":"Request boundary rejected"}'})
