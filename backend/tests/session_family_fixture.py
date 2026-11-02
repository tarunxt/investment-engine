"""Synthetic session-family SQL double, not PostgreSQL/concurrency evidence."""
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

from app.core.security import AuthUtils, JWTUtils
from app.domains.auth.models import AuthSessionFamily, User, UserRole
from app.domains.auth.session_lifecycle import digest
from app.shared.ws_relay import SessionIdentity


class SessionFamilyFixture:
    def __init__(self, uid=42, state="active"):
        self.uid, self.sid, self.state = uid, "synthetic-family-" + "a" * 32, state
        self.tokens = AuthUtils.create_tokens(uid, "fixture@example.invalid", "user",
            session_id=self.sid, refresh_id="synthetic-refresh-id")
        self.claims = JWTUtils.verify_access_token(self.tokens["access_token"])
        now = datetime.now(UTC)
        self.user = SimpleNamespace(id=uid, email="fixture@example.invalid", username="fixture",
            full_name=None, role=UserRole.USER, is_active=True, is_verified=True,
            created_at=now, updated_at=now, last_login=None, profile=None)
        self.family = SimpleNamespace(id=self.sid, user_id=uid if state != "foreign" else uid + 1,
            is_active=state != "revoked", expires_at=datetime.utcnow() + timedelta(days=1),
            refresh_digest=digest(self.tokens["refresh_token"]))
        self.reads, self.family_reads, self.commits = 0, 0, 0

    @property
    def identity(self):
        return SessionIdentity(self.uid, self.claims)

    @asynccontextmanager
    async def session(self):
        yield self

    async def execute(self, statement):
        self.reads += 1
        params = statement.compile().params
        assert self.uid in params.values(), "query must remain owner scoped"
        entity = statement.column_descriptions[0].get("entity")
        if entity is AuthSessionFamily:
            self.family_reads += 1
            assert self.sid in params.values(), "query must select the supplied family"
            value = self.family if self.state != "missing" and self.family.user_id == self.uid else None
        else:
            assert entity is User
            value = self.user
        return SimpleNamespace(scalar_one_or_none=lambda: value, one_or_none=lambda: value)

    async def commit(self):
        self.commits += 1
