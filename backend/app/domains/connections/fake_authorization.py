"""Deterministic authorization contract for isolated tests/previews. No sockets."""
from datetime import datetime,timedelta,timezone
from .crypto import ConnectionFault

class FakeKiteAuthorization:
    simulation=True
    def __init__(self):
        self.exchanges=0
        self.revocations=0
        self.revoke_success=True
    async def exchange(self,app,request_token):
        self.exchanges+=1
        if request_token=='fake-failure':raise ConnectionFault('PROVIDER_AUTHORIZATION_FAILED',502)
        account='FAKEOTHER' if request_token=='fake-other-account' else 'FAKEOWNER'
        return {'api_key':app.key.get_secret_value(),'broker':'ZERODHA','user_id':account,
            'email':'different-broker-email@example.invalid','access_token':'synthetic-only-token',
            'expires_at':datetime.now(timezone.utc)+timedelta(hours=1)}
    async def revoke(self,bound):
        self.revocations+=1
        return self.revoke_success
