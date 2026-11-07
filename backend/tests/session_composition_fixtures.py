"""Shared synthetic active-family identity for composed ownership fixtures."""
from datetime import datetime, timedelta
from app.core.security import JWTUtils
from app.domains.auth.models import AuthSessionFamily, User
from app.shared.ws_relay import SessionIdentity

async def active_identity(sessions, uid):
    async with sessions.kw['bind'].begin() as connection:
        await connection.run_sync(lambda db: AuthSessionFamily.__table__.create(db, checkfirst=True))
    sid = f'synthetic-session-family-{uid:032d}'
    async with sessions() as db:
        if await db.get(User, uid) is None:
            db.add(User(id=uid, email=f'actor{uid}@example.invalid', username=f'actor{uid}', password_hash='synthetic'))
            await db.flush()
        db.add(AuthSessionFamily(id=sid, user_id=uid, refresh_digest='0'*64,
            expires_at=datetime.utcnow()+timedelta(hours=1), is_active=True))
        await db.commit()
    token = JWTUtils.create_access_token(uid, f'actor{uid}@example.invalid', 'user', session_id=sid)
    claims = JWTUtils.verify_access_token(token)
    assert claims is not None and claims['sid'] == sid
    return SessionIdentity(uid, claims)
