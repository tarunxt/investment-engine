"""One-use authorization and explicit review over the Stage09 connection registry.

Provider I/O is injected. No default provider and no live or financial adapter is
installed by these routes. Atomic compare-and-swap is required even with row locks.
"""
import asyncio
import hashlib
import hmac
import json
import re
import secrets
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode, urlsplit
from sqlalchemy import select, update
from app.domains.auth.models import ActivityLog
from app.domains.jobs.models import Job
from app.domains.modules.models import UserModule, UserModulePreferences
from .crypto import ConnectionFault
from .material import bind_app
from .models import ConnectionAttempt, IntegrationConnection, ConnectionBindingHistory
from .service import ConnectionStore, claims, utc


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def attempt_fingerprint(app):
    return digest(json.dumps([app.fingerprint(),app.reference,app.version],separators=(',',':')))


def now():
    return datetime.now(timezone.utc)


def claim_statement(owner, attempt_id, clock):
    return update(ConnectionAttempt).where(
        ConnectionAttempt.id==attempt_id, ConnectionAttempt.owner_id==owner,
        ConnectionAttempt.consumed_at.is_(None), ConnectionAttempt.expires_at>clock
    ).values(consumed_at=clock).execution_options(synchronize_session='fetch')


class ConnectionAuthorization:
    def __init__(self, store: ConnectionStore, provider, *, callback_url, allowed_callbacks):
        self.store = store
        self.db = store.db
        self.provider = provider
        if callback_url not in allowed_callbacks or urlsplit(callback_url).fragment or urlsplit(callback_url).query:
            raise ConnectionFault('CALLBACK_NOT_ALLOWLISTED')
        parts = urlsplit(callback_url)
        if parts.scheme != 'https' and not (parts.scheme == 'http' and parts.hostname in {'127.0.0.1', 'localhost'}):
            raise ConnectionFault('CALLBACK_NOT_ALLOWLISTED')
        self.callback_url = callback_url

    async def app(self, row):
        _, payload = await self.store.material(row)
        if row.app_ownership_mode == 'platform_managed' and payload.get('app_fingerprint') is None:
            return self.store.platform.resolve(payload.get('platform_ref'), payload.get('app_version'))
        return bind_app(payload, row.app_ownership_mode, self.store.platform)

    async def start(self, owner, connection_id, version, session):
        await self.store._owner(owner)
        row = await self.store.get(owner, connection_id)
        if row.version != version:
            raise ConnectionFault('CONNECTION_VERSION_CHANGED')
        if row.status == 'legacy_review':
            raise ConnectionFault('LEGACY_BINDING_VERIFICATION_REQUIRED')
        app = await self.app(row)
        state = secrets.token_urlsafe(32)
        attempt = ConnectionAttempt(owner_id=owner, connection_id=row.id,
            connection_version=version, app_mode=row.app_ownership_mode,
            app_fingerprint=attempt_fingerprint(app), session_digest=digest(session),
            state_digest=digest(state), expires_at=now()+timedelta(minutes=5))
        self.db.add(attempt)
        await self.db.flush()
        await self.db.commit()
        # Kite returns redirect_params to the app's registered callback; never
        # accept an arbitrary return URL or imply redirect_uri is supported.
        params = urlencode({'state':state, 'attempt_id':attempt.id})
        url = 'https://kite.zerodha.com/connect/login?' + urlencode({
            'v':3, 'api_key':app.key.get_secret_value(), 'redirect_params':params})
        return {'attempt_id':attempt.id, 'state':state, 'expires_at':attempt.expires_at,
            'login_url':url, 'simulation':bool(self.provider.simulation)}

    async def attempt(self, owner, attempt_id, session):
        row = (await self.db.execute(select(ConnectionAttempt).where(
            ConnectionAttempt.id==attempt_id, ConnectionAttempt.owner_id==owner))).scalar_one_or_none()
        if row is None:
            raise ConnectionFault('CONNECTION_ATTEMPT_NOT_FOUND',404)
        if not hmac.compare_digest(row.session_digest, digest(session)):
            raise ConnectionFault('CONNECTION_ATTEMPT_SESSION_MISMATCH',403)
        if utc(row.expires_at) <= now():
            raise ConnectionFault('CONNECTION_ATTEMPT_EXPIRED')
        return row

    async def callback(self, owner, attempt_id, session, *, state, request_token):
        await self.store._owner(owner)
        attempt = await self.attempt(owner, attempt_id, session)
        if not hmac.compare_digest(attempt.state_digest, digest(state)):
            raise ConnectionFault('CONNECTION_ATTEMPT_STATE_MISMATCH',403)
        row = await self.store.get(owner, attempt.connection_id)
        app = await self.app(row)
        if row.version != attempt.connection_version or row.app_ownership_mode != attempt.app_mode or attempt_fingerprint(app)!=attempt.app_fingerprint:
            raise ConnectionFault('CONNECTION_VERSION_CHANGED')
        result = await self.db.execute(claim_statement(owner,attempt.id,now()))
        if result.rowcount != 1:
            raise ConnectionFault('CONNECTION_ATTEMPT_ALREADY_USED')
        # Durable consume BEFORE I/O: exchange timeout/crash may never retry the
        # same request token. A fresh attempt leaves an existing binding intact.
        await self.db.commit()
        try:
            async with asyncio.timeout(12):
                response = await self.provider.exchange(app, request_token)
            if (response.get('api_key')!=app.key.get_secret_value() or response.get('broker')!='ZERODHA'
                or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}',response.get('user_id',''))
                or not response.get('access_token') or utc(response['expires_at'])<=now()):
                raise ConnectionFault('PROVIDER_IDENTITY_INVALID')
            # Broker email is deliberately not compared with Google email.
            payload = {'attempt_id':attempt.id,'owner_id':owner,'connection_id':row.id,
                'connection_version':attempt.connection_version,'app_mode':attempt.app_mode,'app_fingerprint':attempt.app_fingerprint,
                'account':response['user_id'],'token':response['access_token'],
                'expires_at':utc(response['expires_at']).isoformat()}
            cipher, key = self.store.keyring.seal(payload)
            attempt.candidate_ciphertext=cipher
            attempt.candidate_key_version=key
            await self.db.commit()
            return {'attempt_id':attempt.id,'review_required':True,
                'connection_id':row.id,'account_label':'***'+response['user_id'][-4:], 'app_ownership_mode':row.app_ownership_mode,
                'connection_version':attempt.connection_version,'simulation':bool(self.provider.simulation)}
        except Exception as exc:
            await self.db.rollback()
            if isinstance(exc,ConnectionFault):raise
            raise ConnectionFault('PROVIDER_AUTHORIZATION_FAILED',502) from None

    async def pause(self, owner):
        # Invalidate existing module approval/version snapshots and pause all
        # schedules; no new execution approval is granted by connecting an app.
        await self.db.execute(update(UserModulePreferences).where(UserModulePreferences.user_id==owner)
            .values(version=UserModulePreferences.version+1))
        await self.db.execute(update(UserModule).where(UserModule.user_id==owner)
            .values(version=UserModule.version+1,schedules_paused=True))
        await self.db.execute(update(Job).where(Job.user_id==owner,Job.module_id.is_not(None),
            Job.status.in_(['pending','processing'])).values(module_cancel_requested=True))

    async def remember_binding(self,row,secret):
        if not row.provider_account_id:return
        # Each completed binding generation is captured before replacement.
        # No route or service updates/deletes these snapshots. The encrypted
        # envelope retains the original owner/connection/version claims.
        self.db.add(ConnectionBindingHistory(connection_id=row.id,owner_id=row.owner_id,
            connection_version=row.version,app_mode=row.app_ownership_mode,
            provider_account_id=row.provider_account_id,ciphertext=secret.ciphertext,key_version=secret.key_version))
        await self.db.flush()

    async def confirm(self, owner, attempt_id, session, *, version, previous_id=None, previous_version=None):
        try:
            await self.store._owner(owner)
            attempt = await self.attempt(owner,attempt_id,session)
            row = await self.store.get(owner,attempt.connection_id)
            if not attempt.candidate_ciphertext or attempt.review_completed_at:
                raise ConnectionFault('CONNECTION_REVIEW_UNAVAILABLE')
            candidate = self.store.keyring.open(attempt.candidate_ciphertext,attempt.candidate_key_version)
            app = await self.app(row)
            if (candidate['attempt_id']!=attempt.id or candidate['owner_id']!=owner or candidate['connection_id']!=row.id
                or row.version!=version or version!=attempt.connection_version or candidate['connection_version']!=version
                or candidate['app_mode']!=row.app_ownership_mode or attempt.app_mode!=row.app_ownership_mode
                or attempt_fingerprint(app)!=candidate['app_fingerprint'] or utc(datetime.fromisoformat(candidate['expires_at']))<=now()):
                raise ConnectionFault('CONNECTION_VERSION_CHANGED')
            current = await self.store.current(owner)
            if current is not None and current.id != row.id:
                if current.id!=previous_id or current.version!=previous_version:
                    raise ConnectionFault('ACCOUNT_SWITCH_REQUIRES_CURRENT_REVIEW')
                prior_secret,prior_payload=await self.store.material(current)
                await self.remember_binding(current,prior_secret)
                prior_payload.update({**claims(current),'connection_version':previous_version+1,'token':None})
                prior_secret.ciphertext,prior_secret.key_version=self.store.keyring.seal(prior_payload)
                switched = await self.db.execute(update(IntegrationConnection).where(
                    IntegrationConnection.id==current.id, IntegrationConnection.owner_id==owner,
                    IntegrationConnection.version==previous_version, IntegrationConnection.is_current.is_(True))
                    .values(is_current=False,status='disabled',version=previous_version+1))
                if switched.rowcount!=1:raise ConnectionFault('CONNECTION_VERSION_CHANGED')
            used=await self.db.execute(update(ConnectionAttempt).where(ConnectionAttempt.id==attempt.id,
                ConnectionAttempt.review_completed_at.is_(None)).values(review_completed_at=now(),candidate_ciphertext=None,candidate_key_version=None))
            if used.rowcount!=1:raise ConnectionFault('CONNECTION_REVIEW_UNAVAILABLE')
            secret,payload=await self.store.material(row)
            await self.remember_binding(row,secret)
            payload.update({**claims(row),'connection_version':version+1,'provider_account_id':candidate['account'],
                'app_fingerprint':app.fingerprint(),'token':candidate['token']})
            cipher,key=self.store.keyring.seal(payload)
            result=await self.db.execute(update(IntegrationConnection).where(IntegrationConnection.id==row.id,
                IntegrationConnection.owner_id==owner,IntegrationConnection.version==version).values(
                version=version+1,provider_account_id=candidate['account'],token_expires_at=datetime.fromisoformat(candidate['expires_at']),status='active',is_current=True))
            if result.rowcount!=1:raise ConnectionFault('CONNECTION_VERSION_CHANGED')
            secret.ciphertext=cipher;secret.key_version=key
            await self.pause(owner)
            self.db.add(ActivityLog(user_id=owner,action='connection_authorization_reviewed',resource_type='integration_connection',details=row.id))
            await self.db.commit()
            return {'status':'connected','connection_id':row.id,'version':version+1,'schedules_paused':True,
                'financial_execution_granted':False,'simulation':bool(self.provider.simulation)}
        except Exception as exc:
            await self.db.rollback()
            if isinstance(exc,ConnectionFault):raise
            raise ConnectionFault('CONNECTION_STORAGE_UNAVAILABLE',503) from None

    async def mark_revoked(self, owner, connection_id, version):
        """Explicit invalid-token response only, not a transport timeout."""
        try:
            await self.store._owner(owner)
            row=await self.store.get(owner,connection_id)
            if row.version!=version:raise ConnectionFault('CONNECTION_VERSION_CHANGED')
            secret,payload=await self.store.material(row)
            await self.remember_binding(row,secret)
            payload['token']=None
            await self.pause(owner)
            return await self.store._persist(row,secret,payload,version,
                event='connection_provider_revoked',changes={'status':'revoked','token_expires_at':None})
        except Exception:
            await self.db.rollback()
            raise

    async def disconnect(self, owner, connection_id, version):
        await self.store._owner(owner)
        row=await self.store.get(owner,connection_id)
        if not row.is_current or row.version!=version:raise ConnectionFault('CONNECTION_VERSION_CHANGED')
        bound=None
        try:bound=await self.store.resolve_token(owner,connection_id)
        except ConnectionFault:pass  # Local disable must still work on expired/revoked sessions.
        if row.status!='legacy_review':
            secret,_=await self.store.material(row)
            await self.remember_binding(row,secret)
        await self.pause(owner)
        await self.store.disable(owner)
        revoked=False
        if bound:
            try:
                async with asyncio.timeout(8):revoked=await self.provider.revoke(bound)
            except Exception:pass
        return {'local_disabled':True,'provider_revoked':bool(revoked),
            'provider_revocation_status':'simulated' if self.provider.simulation else ('confirmed' if revoked else 'not_confirmed'),
            'identity_retained':True,'schedules_paused':True}
