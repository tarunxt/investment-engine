"""Bounded Redis transaction adapter, invoked off the ASGI event loop.

Client is injected; this module has no endpoint/config/environment loader.
No production Redis database index or queue names are accepted.
"""
import asyncio
import hashlib
import json
import time
import uuid
import jwt
from redis.exceptions import WatchError
from app.uat.owner_policy import AdmissionDenied, OWNER_EMAIL
from app.uat.session_verifier import SessionVerifier

KEY = 'credx:uat:owner-sessions:v1'
CAPACITY = 128


class Registry:
    def __init__(self, client, *, signing_key, clock=time.time):
        self.client, self.key, self.clock = client, signing_key, clock
        self.verifier = SessionVerifier(environment='uat', key=signing_key)

    def _store(self, token, jti, expires):
        for attempt in range(3):
            try:
                with self.client.pipeline() as p:
                    p.watch(KEY)
                    entries = p.hgetall(KEY)
                    if len(entries) > CAPACITY:
                        raise ValueError()
                    expired = [k for k,v in entries.items() if json.loads(v)['exp'] <= self.clock()]
                    if len(entries)-len(expired) >= CAPACITY or jti.encode() in entries:
                        raise ValueError()
                    p.multi()
                    if expired: p.hdel(KEY,*expired)
                    p.hset(KEY,jti,json.dumps({'sha256':hashlib.sha256(token.encode()).hexdigest(),'exp':expires}))
                    p.expire(KEY,900)
                    p.execute()
                    return
            except WatchError:
                continue
        raise ValueError()

    async def issue(self, owner):
        if owner.email != OWNER_EMAIL or owner.is_active is not True or owner.id != 1:
            raise AdmissionDenied('UAT session denied')
        try:
            now=int(self.clock()); jti=uuid.uuid4().hex
            token=jwt.encode(dict(sub='1',email=OWNER_EMAIL,type='access',iss='credx-uat',
                aud='credx-uat-api',iat=now,nbf=now,exp=now+900,jti=jti),self.key,algorithm='HS256')
            await asyncio.to_thread(self._store,token,jti,now+900)
            return {'access_token':token}
        except Exception:
            raise AdmissionDenied('UAT session unavailable') from None

    async def verify(self, token, token_type):
        claims=await self.verifier(token,token_type)
        try:
            raw=await asyncio.to_thread(self.client.hget,KEY,claims['jti'])
            entry=json.loads(raw)
            if entry['exp'] <= self.clock() or entry['sha256'] != hashlib.sha256(token.encode()).hexdigest():
                raise ValueError()
            return claims
        except Exception:
            raise AdmissionDenied('UAT session unavailable') from None

    async def revoke(self, token):
        try:
            claims=await self.verifier(token,'access')
            await asyncio.to_thread(self.client.hdel,KEY,claims['jti'])
        except Exception:
            raise AdmissionDenied('UAT session unavailable') from None
