"""Durable family lifecycle; callers own the database transaction and commit.

All mutations lock user before family. A second use of a still-valid rotated
refresh credential revokes that family, including concurrent duplicate uses.
No grace replay window or process-local revocation fallback is provided.
"""
from datetime import datetime
import hashlib
import secrets

from fastapi import HTTPException

from app.core.security import AuthUtils, JWTUtils


def denied():
    return HTTPException(status_code=401, detail="Session expired or revoked; sign in again")


def subject(payload):
    try:
        value = payload["sub"]
        if not isinstance(value, str) or not value.isdecimal() or int(value) < 1:
            raise ValueError
        return int(value)
    except (KeyError, TypeError, ValueError):
        raise denied() from None


def session_id(payload):
    value = payload.get("sid")
    if not isinstance(value, str) or not 32 <= len(value) <= 64:
        raise denied()
    return value


def digest(token):
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class SessionLifecycle:
    def __init__(self, store):
        self.store = store

    async def require_active(self, payload):
        uid, sid = subject(payload), session_id(payload)
        family = await self.store.active(uid, sid)
        if family is None or not family.is_active or family.expires_at <= datetime.utcnow():
            raise denied()
        return family

    def tokens(self, user, sid):
        return AuthUtils.create_tokens(user.id, user.email, user.role.value,
                                      session_id=sid, refresh_id=secrets.token_urlsafe(32))

    async def issue(self, user):
        user = await self.store.lock_user(user.id)
        if user is None or not user.is_active:
            raise denied()
        sid = secrets.token_urlsafe(32)
        tokens = self.tokens(user, sid)
        payload = JWTUtils.verify_refresh_token(tokens["refresh_token"])
        await self.store.create(user.id, sid, digest(tokens["refresh_token"]),
                                datetime.utcfromtimestamp(payload["exp"]))
        return tokens

    async def rotate(self, token):
        payload = JWTUtils.verify_refresh_token(token)
        if payload is None:
            raise denied()
        uid, sid = subject(payload), session_id(payload)
        user = await self.store.lock_user(uid)
        family = await self.store.lock_family(uid, sid)
        if (user is None or not user.is_active or family is None or
                not family.is_active or family.expires_at <= datetime.utcnow()):
            raise denied()
        if not secrets.compare_digest(family.refresh_digest, digest(token)):
            family.is_active = False
            # Persist revocation before reporting denial: a normal exception
            # would otherwise roll back the security event with the request.
            await self.store.commit()
            raise denied()
        tokens = self.tokens(user, sid)
        replacement = JWTUtils.verify_refresh_token(tokens["refresh_token"])
        family.refresh_digest = digest(tokens["refresh_token"])
        family.expires_at = datetime.utcfromtimestamp(replacement["exp"])
        return user, tokens

    async def revoke_current(self, payload):
        uid, sid = subject(payload), session_id(payload)
        await self.store.lock_user(uid)
        family = await self.store.lock_family(uid, sid)
        if family is None:
            raise denied()
        family.is_active = False

    async def revoke_all(self, user_id):
        # Must share the password-write transaction. Serializes issuance and
        # rotation for this account; other accounts/families are unaffected.
        await self.store.lock_user(user_id)
        await self.store.revoke_all(user_id)
