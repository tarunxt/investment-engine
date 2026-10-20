"""Transactional owner-scoped connection storage, resolution and key rotation.

Provisioning/session installation are internal interfaces for authorization code;
Stage09 intentionally exposes only masked GET metadata. Stage10 owns attempts,
callback state and full onboarding. No function enables a module or financial flag.
"""
import asyncio,json,re
from datetime import datetime,timezone
from uuid import uuid4
from sqlalchemy import select,update
from app.domains.auth.models import User,ActivityLog
from .models import IntegrationConnection,ConnectionCredential
from .crypto import ConnectionFault,ConnectionKeyring
from .material import AppMaterial,BoundToken,PlatformCredentialService,bind_app
from pydantic import SecretStr

def utc(value):return value.replace(tzinfo=timezone.utc) if value and value.tzinfo is None else value

def claims(row):
    return {'schema_version':1,'connection_id':row.id,'owner_id':row.owner_id,'provider':row.provider,
            'app_ownership_mode':row.app_ownership_mode,'connection_version':row.version,'provider_account_id':row.provider_account_id}

def validate_claims(row,payload):
    if any(payload.get(k)!=v for k,v in claims(row).items()):raise ConnectionFault('CONNECTION_BINDING_MISMATCH')

class ConnectionStore:
    def __init__(self,db,*,keyring=None,platform=None):
        self.db=db;self._keyring=keyring;self.platform=platform or PlatformCredentialService.from_settings()
    @property
    def keyring(self):
        if self._keyring is None:self._keyring=ConnectionKeyring.from_settings()
        return self._keyring
    async def _owner(self,owner):
        user=(await self.db.execute(select(User).where(User.id==owner,User.is_active.is_(True)).with_for_update())).scalar_one_or_none()
        if user is None:raise ConnectionFault('ACTIVE_IDENTITY_REQUIRED',403)
    async def get(self,owner,connection_id):
        row=(await self.db.execute(select(IntegrationConnection).where(IntegrationConnection.owner_id==owner,IntegrationConnection.id==connection_id))).scalar_one_or_none()
        if row is None:raise ConnectionFault('CONNECTION_NOT_FOUND',404)
        return row
    async def current(self,owner):
        return (await self.db.execute(select(IntegrationConnection).where(IntegrationConnection.owner_id==owner,IntegrationConnection.provider=='zerodha',IntegrationConnection.is_current.is_(True)))).scalar_one_or_none()
    async def material(self,row):
        if (row.credential_ref or '').startswith('legacy:'):raise ConnectionFault('LEGACY_BINDING_VERIFICATION_REQUIRED')
        secret=(await self.db.execute(select(ConnectionCredential).where(ConnectionCredential.id==row.credential_ref,ConnectionCredential.connection_id==row.id,ConnectionCredential.owner_id==row.owner_id))).scalar_one_or_none()
        if secret is None:raise ConnectionFault('CONNECTION_CREDENTIAL_MISSING')
        payload=self.keyring.open(secret.ciphertext,secret.key_version);validate_claims(row,payload)
        return secret,payload
    async def _persist(self,row,secret,payload,expected_version,*,target_key=None,event='connection_updated',changes=None):
        # Encrypt and verify candidate before the compare-and-swap. A failed key,
        # interrupted commit or stale writer leaves the prior binding intact.
        changes=dict(changes or {})
        payload={**payload,**claims(row),'connection_version':expected_version+1}
        if 'provider_account_id' in changes:payload['provider_account_id']=changes['provider_account_id']
        encrypted,key_version=self.keyring.seal(payload,target_key)
        if self.keyring.open(encrypted,key_version)!=payload:raise ConnectionFault('CONNECTION_ROTATION_VERIFICATION_FAILED')
        result=await self.db.execute(update(IntegrationConnection).where(IntegrationConnection.id==row.id,IntegrationConnection.owner_id==row.owner_id,IntegrationConnection.version==expected_version).values(version=expected_version+1,**changes))
        if result.rowcount!=1:raise ConnectionFault('CONNECTION_VERSION_CHANGED')
        secret.ciphertext=encrypted;secret.key_version=key_version
        self.db.add(ActivityLog(user_id=row.owner_id,action=event,resource_type='integration_connection',details=json.dumps({'connection_id':row.id,'version':expected_version+1,'mode':row.app_ownership_mode})))
        await self.db.flush();await self.db.commit();return row
    async def provision(self,owner,*,mode,app_key=None,app_secret=None,platform_ref=None,app_version=1,is_current=True):
        try:
            await self._owner(owner)
            if mode not in {'user_owned','platform_managed'}:raise ConnectionFault('CONNECTION_MODE_INVALID')
            if is_current and await self.current(owner):raise ConnectionFault('ONE_CURRENT_ACCOUNT_PER_PROVIDER')
            row=IntegrationConnection(id=str(uuid4()),owner_id=owner,provider='zerodha',app_ownership_mode=mode,version=1,is_current=is_current,status='configured')
            payload={**claims(row),'app_version':app_version,'token':None}
            if mode=='user_owned':
                if not app_key or not app_secret:raise ConnectionFault('CONNECTION_APP_MISSING')
                app=AppMaterial(SecretStr(app_key),SecretStr(app_secret),row.id,app_version)
                payload.update(app_key=app_key,app_secret=app_secret,app_fingerprint=app.fingerprint())
            else:
                if app_key or app_secret:raise ConnectionFault('PLATFORM_SECRET_STORAGE_FORBIDDEN')
                if not platform_ref or len(platform_ref)>100:raise ConnectionFault('PLATFORM_CREDENTIAL_REFERENCE_REQUIRED')
                payload.update(platform_ref=platform_ref,app_fingerprint=None)
                if not self.platform.approval_verified(platform_ref,app_version):row.status='approval_required'
            ciphertext,kv=self.keyring.seal(payload)
            secret=ConnectionCredential(id=str(uuid4()),connection_id=row.id,owner_id=owner,ciphertext=ciphertext,key_version=kv)
            row.credential_ref=secret.id;self.db.add(row);await self.db.flush();self.db.add(secret)
            self.db.add(ActivityLog(user_id=owner,action='connection_configured',resource_type='integration_connection',details=json.dumps({'connection_id':row.id,'version':1,'mode':mode})))
            await self.db.flush();await self.db.commit();return row
        except Exception as exc:
            await self.db.rollback()
            if isinstance(exc,ConnectionFault):raise
            raise ConnectionFault('CONNECTION_STORAGE_UNAVAILABLE',503) from None
    async def prepare_app(self,owner,connection_id):
        row=await self.get(owner,connection_id)
        if not row.is_current or row.status in {'disabled','legacy_review'}:raise ConnectionFault('CONNECTION_NOT_AUTHORIZABLE')
        _,payload=await self.material(row)
        if row.app_ownership_mode=='platform_managed' and payload.get('app_fingerprint') is None:
            app=self.platform.resolve(payload.get('platform_ref'),payload.get('app_version'))
        else:app=bind_app(payload,row.app_ownership_mode,self.platform)
        return row,app
    async def install_session(self,owner,connection_id,expected_version,*,app,provider_account_id,token,expires_at):
        try:
            await self._owner(owner);row=await self.get(owner,connection_id)
            if row.version!=expected_version:raise ConnectionFault('CONNECTION_VERSION_CHANGED')
            if not row.is_current or row.status=='disabled':raise ConnectionFault('CONNECTION_NOT_AUTHORIZABLE')
            if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}',provider_account_id or '') or not token or utc(expires_at)<=datetime.now(timezone.utc):raise ConnectionFault('CONNECTION_SESSION_INVALID')
            if row.provider_account_id and row.provider_account_id!=provider_account_id:raise ConnectionFault('CONNECTION_ACCOUNT_CHANGE_REQUIRES_REVIEW')
            secret,payload=await self.material(row);_,current_app=await self.prepare_app(owner,connection_id)
            if app.fingerprint()!=current_app.fingerprint() or app.reference!=current_app.reference or app.version!=current_app.version:raise ConnectionFault('CONNECTION_APP_BINDING_CHANGED')
            payload.update(token=token,app_fingerprint=current_app.fingerprint())
            return await self._persist(row,secret,payload,expected_version,event='connection_session_stored',changes={'provider_account_id':provider_account_id,'token_expires_at':expires_at,'status':'active'})
        except Exception as exc:
            await self.db.rollback()
            if isinstance(exc,ConnectionFault):raise
            raise ConnectionFault('CONNECTION_STORAGE_UNAVAILABLE',503) from None
    async def resolve_token(self,owner,connection_id=None):
        row=await self.get(owner,connection_id) if connection_id else await self.current(owner)
        if row is None:return None
        secret,payload=await self.material(row)
        return token_from_material(row,payload,self.platform)
    async def rotate(self,owner,connection_id,expected_version,target_key_version):
        try:
            await self._owner(owner);row=await self.get(owner,connection_id)
            if row.version!=expected_version:raise ConnectionFault('CONNECTION_VERSION_CHANGED')
            secret,payload=await self.material(row)
            return await self._persist(row,secret,payload,expected_version,target_key=target_key_version,event='connection_key_rotated')
        except Exception as exc:
            await self.db.rollback()
            if isinstance(exc,ConnectionFault):raise
            raise ConnectionFault('CONNECTION_STORAGE_UNAVAILABLE',503) from None

    async def disable(self,owner):
        """Immediately stop local credential resolution; provider revoke UX is Stage10."""
        try:
            await self._owner(owner);row=await self.current(owner)
            if row is None:return
            if row.status=='legacy_review':
                result=await self.db.execute(update(IntegrationConnection).where(IntegrationConnection.id==row.id,IntegrationConnection.owner_id==owner,IntegrationConnection.version==row.version).values(status='disabled',version=row.version+1))
                if result.rowcount!=1:raise ConnectionFault('CONNECTION_VERSION_CHANGED')
                await self.db.commit();return
            secret,payload=await self.material(row);payload['token']=None
            return await self._persist(row,secret,payload,row.version,event='connection_locally_disabled',changes={'status':'disabled','token_expires_at':None})
        except Exception as exc:
            await self.db.rollback()
            if isinstance(exc,ConnectionFault):raise
            raise ConnectionFault('CONNECTION_STORAGE_UNAVAILABLE',503) from None

    async def adopt_legacy(self,owner,connection_id,expected_version,*,platform_ref,app_version,expected_account_id,verify_account):
        """Explicit server-only adoption after provider identity verification.

        verify_account must perform the provider's authenticated identity read
        using the supplied bound token. No HTTP endpoint exposes this interface.
        Original legacy ciphertext is never updated or deleted.
        """
        from app.domains.zerodha.models import ZerodhaCredential
        from app.domains.zerodha.crypto import decrypt_token
        try:
            await self._owner(owner);row=await self.get(owner,connection_id)
            if row.version!=expected_version:raise ConnectionFault('CONNECTION_VERSION_CHANGED')
            if row.status!='legacy_review' or not row.is_current:raise ConnectionFault('LEGACY_ADOPTION_NOT_AVAILABLE')
            legacy=(await self.db.execute(select(ZerodhaCredential).where(ZerodhaCredential.user_id==owner))).scalar_one_or_none()
            if legacy is None or row.credential_ref!=f'legacy:zerodha:{legacy.id}':raise ConnectionFault('LEGACY_BINDING_MISMATCH')
            app=self.platform.resolve(platform_ref,app_version)
            candidate=BoundToken(owner,row.id,row.version,app,SecretStr(decrypt_token(legacy.access_token)),legacy.expires_at)
            candidate.validate()
            async with asyncio.timeout(15):account=await verify_account(candidate)
            if not isinstance(account,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}',account) or account!=expected_account_id:raise ConnectionFault('LEGACY_ACCOUNT_VERIFICATION_FAILED')
            payload={**claims(row),'connection_version':expected_version+1,'provider_account_id':account,'platform_ref':platform_ref,'app_version':app_version,'app_fingerprint':app.fingerprint(),'token':candidate.token.get_secret_value()}
            cipher,kv=self.keyring.seal(payload);self.keyring.open(cipher,kv)
            secret=ConnectionCredential(id=str(uuid4()),connection_id=row.id,owner_id=owner,ciphertext=cipher,key_version=kv)
            result=await self.db.execute(update(IntegrationConnection).where(IntegrationConnection.id==row.id,IntegrationConnection.owner_id==owner,IntegrationConnection.version==expected_version).values(version=expected_version+1,provider_account_id=account,credential_ref=secret.id,token_expires_at=legacy.expires_at,status='active'))
            if result.rowcount!=1:raise ConnectionFault('CONNECTION_VERSION_CHANGED')
            self.db.add(secret)
            self.db.add(ActivityLog(user_id=owner,action='legacy_connection_adopted',resource_type='integration_connection',details=json.dumps({'connection_id':row.id,'version':expected_version+1})))
            await self.db.flush();await self.db.commit();return row
        except Exception as exc:
            await self.db.rollback()
            if isinstance(exc,ConnectionFault):raise
            raise ConnectionFault('LEGACY_VERIFICATION_UNAVAILABLE',503) from None

def token_from_material(row,payload,platform):
    validate_claims(row,payload)
    if row.status!='active' or not row.is_current:raise ConnectionFault('CONNECTION_NOT_ACTIVE',401)
    if not row.provider_account_id or not row.token_expires_at:raise ConnectionFault('CONNECTION_SESSION_INVALID',401)
    app=bind_app(payload,row.app_ownership_mode,platform)
    value=BoundToken(row.owner_id,row.id,row.version,app,SecretStr(payload.get('token') or ''),row.token_expires_at);value.validate();return value

class SyncConnectionStore:
    def __init__(self,db,*,keyring=None,platform=None):
        self.db=db;self.keyring=keyring;self.platform=platform or PlatformCredentialService.from_settings()
    def resolve_token(self,owner):
        row=self.db.execute(select(IntegrationConnection).where(IntegrationConnection.owner_id==owner,IntegrationConnection.provider=='zerodha',IntegrationConnection.is_current.is_(True))).scalar_one_or_none()
        if row is None:return None
        if (row.credential_ref or '').startswith('legacy:'):raise ConnectionFault('LEGACY_BINDING_VERIFICATION_REQUIRED')
        secret=self.db.execute(select(ConnectionCredential).where(ConnectionCredential.id==row.credential_ref,ConnectionCredential.connection_id==row.id,ConnectionCredential.owner_id==owner)).scalar_one_or_none()
        if secret is None:raise ConnectionFault('CONNECTION_CREDENTIAL_MISSING')
        ring=self.keyring or ConnectionKeyring.from_settings();return token_from_material(row,ring.open(secret.ciphertext,secret.key_version),self.platform)
