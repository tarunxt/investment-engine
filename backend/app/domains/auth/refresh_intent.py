"""One-way BFF dispatch intent, without replacement-token recovery or takeover.

This is coordination, not account authorization. Every operation also verifies
the refresh credential and authoritative active user/family. A duplicate claim
returns no credentials and never dispatches refresh. Direct /refresh retains
strict rotated-credential reuse revocation.
"""
import secrets
from fastapi import HTTPException
from app.core.security import JWTUtils
from .session_lifecycle import denied, digest, subject, session_id


class RefreshIntents:
    def __init__(self, store):
        self.store = store

    async def claim(self, token):
        payload = JWTUtils.verify_refresh_token(token)
        if payload is None:
            raise denied()
        uid, sid = subject(payload), session_id(payload)
        user = await self.store.lock_user(uid)
        family = await self.store.lock_family(uid, sid)
        from datetime import datetime
        if user is None or not user.is_active or family is None or not family.is_active or family.expires_at <= datetime.utcnow():
            raise denied()
        token_hash = digest(token)
        if await self.store.lock_intent(token_hash) is not None:
            raise HTTPException(409, detail="Refresh already reserved or uncertain; reload the latest session or sign in again. Do not retry this credential.")
        if not secrets.compare_digest(family.refresh_digest, token_hash):
            family.is_active = False
            await self.store.commit()
            raise denied()
        nonce = secrets.token_urlsafe(32)
        await self.store.create_intent(token_hash, sid, digest(nonce))
        return nonce

    async def begin(self, token, nonce, uid, sid):
        intent = await self.store.lock_intent(digest(token))
        if (intent is None or intent.family_id != sid or intent.started or
                not isinstance(nonce, str) or not secrets.compare_digest(intent.nonce_digest, digest(nonce))):
            raise denied()
        intent.started = True
        # Commit before rotation may consume the credential. Any failure/lost
        # acknowledgement now requires reauthentication, never nonce takeover.
        await self.store.commit()
