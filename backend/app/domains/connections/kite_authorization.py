"""Kite server-side wire contract. No default HTTP client or runtime wiring.

A separately approved composition must supply an authenticated, bounded transport
that redacts URLs/bodies and never logs tokens. Tests inject an offline transport.
"""
import hashlib
from datetime import datetime,timedelta,timezone
from zoneinfo import ZoneInfo
from .crypto import ConnectionFault


def next_kite_expiry(issued_at):
    local=issued_at.astimezone(ZoneInfo('Asia/Kolkata'))
    expiry=local.replace(hour=6,minute=0,second=0,microsecond=0)
    if expiry<=local:expiry+=timedelta(days=1)
    return expiry.astimezone(timezone.utc)


class KiteAuthorizationProtocol:
    simulation=False
    def __init__(self,transport,*,clock=lambda:datetime.now(timezone.utc)):
        self.transport=transport
        self.clock=clock

    async def exchange(self,app,request_token):
        key=app.key.get_secret_value()
        checksum=hashlib.sha256((key+request_token+app.secret.get_secret_value()).encode()).hexdigest()
        result=await self.transport('POST','https://api.kite.trade/session/token',
            headers={'X-Kite-Version':'3'},data={'api_key':key,'request_token':request_token,'checksum':checksum})
        if not isinstance(result,dict) or result.get('status')!='success' or not isinstance(result.get('data'),dict):
            raise ConnectionFault('PROVIDER_AUTHORIZATION_FAILED',502)
        data=result['data']
        # Only required identity and access token fields leave this adapter.
        return {name:data.get(name) for name in ('api_key','broker','user_id','access_token')}|{'expires_at':next_kite_expiry(self.clock())}

    async def revoke(self,bound):
        result=await self.transport('DELETE','https://api.kite.trade/session/token',
            headers={'X-Kite-Version':'3'},params={'api_key':bound.app.key.get_secret_value(),'access_token':bound.token.get_secret_value()})
        return isinstance(result,dict) and result.get('status')=='success' and result.get('data') is True
