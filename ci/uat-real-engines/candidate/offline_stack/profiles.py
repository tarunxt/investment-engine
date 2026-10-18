"""UAT-only SQLAlchemy model/repository; never imports production metadata.

Fixture tests create this metadata only in in-memory SQLite. A PostgreSQL
connection, migration and any persistent installation remain separately gated.
"""
import asyncio
from dataclasses import dataclass
from threading import RLock
from sqlalchemy import Boolean, CheckConstraint, Integer, JSON, String, select
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker
from app.uat.owner_policy import OWNER_EMAIL, AdmissionDenied


class Base(DeclarativeBase):
    pass


class Profile(Base):
    __tablename__ = 'uat_synthetic_profiles'
    __table_args__ = (CheckConstraint('id = 1', name='uat_single_owner'),
                     CheckConstraint("email = " + repr(OWNER_EMAIL), name='uat_owner_email'))
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    email: Mapped[str] = mapped_column(String(254), unique=True, nullable=False)
    google_sub: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False)
    portfolio: Mapped[dict] = mapped_column(JSON, nullable=False)


@dataclass(frozen=True)
class Owner:
    id: int
    email: str
    google_sub: str
    is_active: bool


class Profiles:
    def __init__(self, engine):
        self.sessions = sessionmaker(bind=engine, expire_on_commit=False)
        self._lock = RLock()

    @staticmethod
    def view(row):
        return None if row is None else Owner(row.id, row.email, row.google_sub, row.is_active)

    def _resolve(self, sub, email):
        if email != OWNER_EMAIL or not isinstance(sub, str) or not 1 <= len(sub) <= 255:
            raise AdmissionDenied('UAT identity denied')
        try:
            with self._lock, self.sessions.begin() as session:
                row = session.get(Profile, 1)
                if row is None:
                    row = Profile(id=1, email=OWNER_EMAIL, google_sub=sub, is_active=True,
                                  portfolio={'positions': [], 'integrations': [], 'simulation': True})
                    session.add(row)
                    session.flush()
                if row.google_sub != sub or row.email != OWNER_EMAIL or row.is_active is not True:
                    raise AdmissionDenied('UAT identity denied')
                return self.view(row)
        except Exception:
            raise AdmissionDenied('UAT profile unavailable') from None

    async def resolve(self, sub, email):
        return await asyncio.to_thread(self._resolve, sub, email)

    def _load(self, identity):
        if identity != '1':
            return None
        with self._lock, self.sessions() as session:
            return self.view(session.get(Profile, 1))

    async def load(self, identity):
        try:
            return await asyncio.to_thread(self._load, identity)
        except Exception:
            raise AdmissionDenied('UAT profile unavailable') from None
