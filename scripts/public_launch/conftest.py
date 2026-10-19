"""Opt-in synthetic fixtures. Never imported by the application."""
from dataclasses import dataclass, field
import socket

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool


@pytest.fixture(autouse=True)
def no_external_io(monkeypatch):
    def denied(*args, **kwargs):
        raise AssertionError("Stage 01 baseline tests prohibit network connections")
    monkeypatch.setattr(socket.socket, "connect", denied)
    monkeypatch.setattr(socket, "create_connection", denied)
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("AUTH_DISABLED", "false")
    monkeypatch.setenv("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
    monkeypatch.setenv("REDIS_URL", "redis://127.0.0.1:1/15")


@pytest.fixture
def isolated_db():
    from app.domains.jobs.models import Job  # noqa: F401
    from app.domains.prompts.models import Prompt  # noqa: F401
    from app.domains.auth.models import User, UserProfile, ActivityLog
    engine = create_engine("sqlite://", poolclass=StaticPool)
    for table in (User.__table__, UserProfile.__table__, ActivityLog.__table__):
        table.create(engine)
    with Session(engine, expire_on_commit=False) as session:
        yield session
    engine.dispose()


@pytest.fixture
def synthetic_users(isolated_db):
    from app.domains.auth.models import User, UserProfile, UserRole
    users = {}
    for name, role in (("userA", UserRole.USER), ("userB", UserRole.USER), ("admin", UserRole.ADMIN)):
        user = User(email=name.lower() + "@example.invalid", username=name,
                    password_hash="synthetic-unusable-password-hash", role=role,
                    is_active=True, is_verified=True)
        user.profile = UserProfile(bio="synthetic " + name, timezone="UTC")
        isolated_db.add(user)
        users[name] = user
    isolated_db.commit()
    return users


@dataclass
class FakeBroker:
    """In-memory accounts only; cannot resolve credentials or submit a live order."""
    orders: list = field(default_factory=list)

    def preview(self, owner, symbol, quantity):
        if owner not in {"userA", "userB", "admin"} or quantity <= 0:
            raise ValueError("invalid synthetic order")
        return {"owner": owner, "account": "fake-" + owner, "symbol": symbol,
                "quantity": quantity, "simulation": True}

    def submit(self, *args, **kwargs):
        raise RuntimeError("Stage 01 fixture supports previews only")


@pytest.fixture
def fake_broker():
    return FakeBroker()
