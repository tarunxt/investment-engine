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
        editor = PATH + "/settings"
        for headers in (google_owner, password_owner):
            assert (await client.get(PATH, headers=headers)).json()["can_manage"]
            assert (await client.get(editor, headers=headers)).json()["visible_ids"] is None
        found = await client.get(PATH + "/users", params={"q": "OTHER@EXAMPLE"}, headers=google_owner)
        assert len(found.json()) == 1
        target = found.json()[0]
        assert set(target) == {"id", "email", "username"}
        target_editor = f"{editor}?user_id={target['id']}"
        assert (await client.get(PATH + "/users", headers=other)).status_code == 403
        assert (await client.get(target_editor, headers=other)).status_code == 403
        assert (await client.get(editor + "?user_id=99999", headers=google_owner)).status_code == 404

        async def save(url, headers, mode, ids, revision, expected=200):
            response = await client.put(url, headers=headers, json={"mode": mode, "visible_ids": ids, "revision": revision})
            assert response.status_code == expected, response.text
            return response.json()

        defaults = ["india-portfolio", "overview"]
        extras = ["market-scanner", "database", "prompt-library", "run-history"]
        await save(editor, {}, "custom", defaults, 0, 401)
        await save(target_editor, other, "extra", extras, 0, 403)
        await save(editor, password_owner, "custom", defaults, 0)
        assert (await save(editor, google_owner, "custom", defaults, 0))["revision"] == 1
        await save(editor, google_owner, "custom", [], 0, 409)
        await save(editor, google_owner, "extra", extras, 1, 422)
        await save(editor, google_owner, "custom", ["typo"], 1, 422)
        await save(target_editor, google_owner, "extra", extras, 0)
        assert (await client.get(PATH, headers=other)).json()["visible_ids"] == sorted(defaults + extras)
        # New Google users follow global defaults, independently of the override.
        monkeypatch.setattr(google_signin, "verify_google_identity", lambda credential, client_id: "new@gmail.com")
        new_user = await login("/auth/google", {"credential": "second-verified-test-id"})
        async def visible(headers):
            response = await client.get(PATH, headers=headers)
            assert "no-store" in response.headers["cache-control"]
            return response.json()["visible_ids"]
        assert await visible(new_user) == defaults
        await save(editor, password_owner, "custom", ["profile"], 1)
        assert await visible(other) == sorted(["profile", *extras])
        await save(target_editor, password_owner, "custom", extras, 1)
        assert await visible(other) == sorted(extras)
        await save(editor, google_owner, "custom", [], 2)
        assert await visible(other) == sorted(extras)
        assert await visible(new_user) == []
        await save(target_editor, password_owner, "inherit", [], 2)
        assert await visible(other) == []
        await save(editor, google_owner, "custom", defaults, 3)
        assert await visible(other) == defaults
    await engine.dispose()
