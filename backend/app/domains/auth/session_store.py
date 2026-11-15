"""SQLAlchemy persistence; database errors propagate, never authorize fallback."""
from sqlalchemy import select, update
from sqlalchemy.orm import selectinload

from app.domains.auth.models import AuthSessionFamily, AuthRefreshIntent, User


class SqlSessionFamilies:
    def __init__(self, db):
        self.db = db

    async def active(self, uid, sid):
        return (await self.db.execute(
            select(AuthSessionFamily).join(User, User.id == AuthSessionFamily.user_id)
            .where(AuthSessionFamily.id == sid, AuthSessionFamily.user_id == uid,
                   User.is_active.is_(True))
            .execution_options(populate_existing=True)
        )).scalar_one_or_none()

    async def lock_user(self, uid):
        return (await self.db.execute(
            select(User).where(User.id == uid).options(selectinload(User.profile)).with_for_update(of=User)
            .execution_options(populate_existing=True)
        )).scalar_one_or_none()

    async def lock_family(self, uid, sid):
        return (await self.db.execute(
            select(AuthSessionFamily).where(AuthSessionFamily.id == sid,
                                            AuthSessionFamily.user_id == uid)
            .with_for_update().execution_options(populate_existing=True)
        )).scalar_one_or_none()

    async def create(self, uid, sid, token_digest, expires_at):
        self.db.add(AuthSessionFamily(id=sid, user_id=uid, refresh_digest=token_digest,
                                     expires_at=expires_at, is_active=True))
        await self.db.flush()

    async def revoke_all(self, uid):
        await self.db.execute(update(AuthSessionFamily)
                              .where(AuthSessionFamily.user_id == uid)
                              .values(is_active=False))

    async def commit(self):
        await self.db.commit()

    async def lock_intent(self, token_digest):
        return (await self.db.execute(select(AuthRefreshIntent)
            .where(AuthRefreshIntent.token_digest == token_digest).with_for_update()
            .execution_options(populate_existing=True))).scalar_one_or_none()

    async def create_intent(self, token_digest, sid, nonce_digest):
        self.db.add(AuthRefreshIntent(token_digest=token_digest, family_id=sid,
                                     nonce_digest=nonce_digest, started=False))
        await self.db.flush()
