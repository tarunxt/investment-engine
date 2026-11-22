"""Exercise the real sign-in and session dependencies against a disposable database."""
import re
from pathlib import Path
from typing import get_args

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import PasswordUtils
from app.domains.auth import google_signin
from app.domains.auth.models import ActivityLog, AuthSessionFamily, User, UserProfile, UserRole
from app.domains.auth.router import router as auth_router
from app.domains.auth.sidebar_visibility import Destination, OWNER_EMAIL, router
from app.domains.jobs.models import Job  # register User relationship
from app.domains.prompts.models import Prompt  # register User relationship
from app.infrastructure.database.session import get_async_db

PATH = "/auth/profile/sidebar-visibility"


def test_destination_ids_match_the_console_catalog():
    root = Path(__file__).resolve().parents[2]
    config = (root / "frontend/app/console/_components/sidebarNavigationConfig.ts").read_text()
    ids = re.findall(r"type: 'item',\s+id: '([^']+)'", config)
    assert set(get_args(Destination)) == {*ids, "appearance"}


@pytest.mark.asyncio
async def test_owner_login_methods_and_global_visibility(tmp_path, monkeypatch):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/sidebar.db")
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as conn:
        for model in (User, UserProfile, ActivityLog, AuthSessionFamily):
            await conn.run_sync(model.__table__.create)
    password = "SyntheticFixture123"
    async with sessions.begin() as db:
        for email, name, role in [(OWNER_EMAIL, "owner", UserRole.USER), ("other@example.com", "other", UserRole.ADMIN)]:
            db.add(User(email=email, username=name, password_hash=PasswordUtils.hash_password(password),
                        role=role, profile=UserProfile()))

    async def database():
        async with sessions() as db:
            yield db

    app = FastAPI()
    app.include_router(auth_router)
    app.include_router(router)
    app.dependency_overrides[get_async_db] = database
    # Google's cryptographic claim checks have separate tests. Keep this test offline.
    monkeypatch.setattr(google_signin, "verify_google_identity", lambda credential, client_id: OWNER_EMAIL)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        async def login(path, body):
            response = await client.post(path, json=body)
            assert response.status_code == 200, response.text
            return {"Authorization": "Bearer " + response.json()["access_token"]}

        anonymous = await client.get(PATH)
        assert anonymous.status_code == 401
        password_owner = await login("/auth/login", {"username": "owner", "password": password})
        google_owner = await login("/auth/google", {"credential": "verified-test-id"})
        other = await login("/auth/login", {"username": "other", "password": password})
        for headers in (google_owner, password_owner):
            assert (await client.get(PATH, headers=headers)).json() == {
                "can_manage": True, "visible_ids": None, "revision": 0,
            }
        selection = {"visible_ids": ["india-portfolio"], "revision": 0}
        assert (await client.put(PATH, json=selection)).status_code == 401
        assert (await client.put(PATH, headers=other, json=selection)).status_code == 403
        assert (await client.put(PATH, headers=password_owner, json=selection)).status_code == 200
        assert (await client.put(PATH, headers=google_owner, json=selection)).json()["revision"] == 1
        assert (await client.get(PATH, headers=other)).json() == {
            "can_manage": False, "visible_ids": ["india-portfolio"], "revision": 1,
        }
        assert (await client.put(PATH, headers=google_owner, json={"visible_ids": [], "revision": 0})).status_code == 409
        assert (await client.put(PATH, headers=google_owner, json={"visible_ids": ["typo"], "revision": 1})).status_code == 422
        assert (await client.put(PATH, headers=google_owner, json={"visible_ids": [], "revision": 1})).status_code == 200
        # A brand-new Google account inherits the empty selection on its first read.
        monkeypatch.setattr(google_signin, "verify_google_identity", lambda credential, client_id: "new@gmail.com")
        new_user = await login("/auth/google", {"credential": "second-verified-test-id"})
        response = await client.get(PATH, headers=new_user)
        assert response.json() == {"visible_ids": [], "revision": 2, "can_manage": False}
        assert "no-store" in response.headers["cache-control"]
    await engine.dispose()
