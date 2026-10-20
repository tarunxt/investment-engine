"""In-process secret-bearing values. Never response DTOs or default credentials."""
import hashlib,hmac,json
from dataclasses import dataclass,field
from datetime import datetime,timezone
from pydantic import SecretStr
from .crypto import ConnectionFault

@dataclass(frozen=True)
class AppMaterial:
    key:SecretStr=field(repr=False)
    secret:SecretStr=field(repr=False)
    reference:str
    version:int
    def fingerprint(self):
        return hashlib.sha256(json.dumps([self.key.get_secret_value(),self.secret.get_secret_value()],separators=(',',':')).encode()).hexdigest()
    def __repr__(self):return '<AppMaterial redacted>'

@dataclass(frozen=True)
class BoundToken:
    owner_id:int
    connection_id:str
    version:int
    app:AppMaterial=field(repr=False)
    token:SecretStr=field(repr=False)
    expires_at:datetime
    def __repr__(self):return '<BoundToken redacted>'
    def validate(self):
        expiry=self.expires_at.replace(tzinfo=timezone.utc) if self.expires_at.tzinfo is None else self.expires_at
        if expiry<=datetime.now(timezone.utc):raise ConnectionFault('CONNECTION_TOKEN_EXPIRED',401)
        if not self.token.get_secret_value():raise ConnectionFault('CONNECTION_TOKEN_MISSING',401)

class PlatformCredentialService:
    """Exact versioned platform references, resolved only in server processes.

    Real deployment must supply verified approval and this service's credentials.
    The Stage09 executor never reads or provisions those values. Test adapters
    implement the same interface with fake material; they do not grant approval.
    """
    def __init__(self,entries=None,*,approved=False,approval_reference=None):
        self._entries=dict(entries or {});self.approved=approved;self.approval_reference=approval_reference
    def __repr__(self):return '<PlatformCredentialService redacted>'
    @classmethod
    def from_settings(cls):
        from app.core.config import settings
        entries={}
        if settings.zerodha_api_key and settings.zerodha_api_secret:
            ref=settings.kite_managed_credential_ref;version=settings.kite_managed_credential_version
            entries[(ref,version)]=AppMaterial(SecretStr(settings.zerodha_api_key),SecretStr(settings.zerodha_api_secret),ref,version)
        return cls(entries,approved=settings.kite_managed_provider_approved,approval_reference=settings.kite_managed_approval_reference)
    def approval_verified(self,reference,version):
        return bool(self.approved and self.approval_reference and (reference,version) in self._entries)
    def resolve(self,reference,version):
        if not self.approved or not self.approval_reference:raise ConnectionFault('PLATFORM_PROVIDER_APPROVAL_REQUIRED')
        value=self._entries.get((reference,version))
        if value is None:raise ConnectionFault('PLATFORM_CREDENTIAL_REFERENCE_UNAVAILABLE',503)
        return value

def bind_app(payload,mode,platform):
    if mode=='user_owned':
        if not payload.get('app_key') or not payload.get('app_secret'):raise ConnectionFault('CONNECTION_APP_MISSING')
        app=AppMaterial(SecretStr(payload['app_key']),SecretStr(payload['app_secret']),payload['connection_id'],payload['app_version'])
    elif mode=='platform_managed':
        app=platform.resolve(payload.get('platform_ref'),payload.get('app_version'))
        if 'app_key' in payload or 'app_secret' in payload:raise ConnectionFault('PLATFORM_SECRET_STORAGE_FORBIDDEN')
    else:raise ConnectionFault('CONNECTION_MODE_INVALID')
    if not hmac.compare_digest(app.fingerprint(),str(payload.get('app_fingerprint',''))):raise ConnectionFault('CONNECTION_APP_BINDING_CHANGED')
    return app
