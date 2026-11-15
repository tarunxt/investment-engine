from datetime import datetime, timezone

import httpx
import pytest
from fastapi import FastAPI

from app.domains.auth.models import User, UserProfile
from app.domains.prompts.models import Prompt  # noqa: F401; complete User relationship registry
from app.domains.runs import router as routes


@pytest.mark.asyncio
@pytest.mark.parametrize('market', ['india', 'us'])
@pytest.mark.parametrize('profile_timezone', ['Asia/Kolkata', 'America/New_York', 'UTC', None, 'Invalid/Zone'])
async def test_authenticated_history_uses_real_user_profile(market, profile_timezone):
    user = User(id=73, email='fixture@example.test', username='fixture', password_hash='unused')
    user.profile = UserProfile(user_id=73, timezone=profile_timezone) if profile_timezone else None
    assert not hasattr(user, 'timezone')
    calls = []

    class Session:
        async def run_sync(self, callback):
            return callback(self)

        def execute(self, query):
            calls.append(query)
            return self

        def all(self):
            return []

    async def db():
        yield Session()

    app = FastAPI()
    app.include_router(routes.router)
    app.dependency_overrides[routes.get_current_user] = lambda: user
    app.dependency_overrides[routes.get_async_db] = db
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        response = await client.get('/runs/final-actionables/score-history', params=[('market', market), ('symbols', 'HAL'), ('days', '5'), ('as_of', datetime(2026, 10, 28, 18, tzinfo=timezone.utc).isoformat())])
    if profile_timezone is None or profile_timezone == 'Invalid/Zone':
        assert response.status_code == 422
        assert not calls
    else:
        assert response.status_code == 200, response.text
        data = response.json()
        assert data['timezone'] == profile_timezone
        assert data['market'] == market
        assert data['observations'] == []
        assert len(calls) == 2
        assert all(73 in query.compile().params.values() for query in calls)
