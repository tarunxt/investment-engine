import asyncio
from threading import Event, get_ident
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI

from app.domains.auth.models import UserRole
from app.domains.cost_drivers import router as routes
from app.domains.cost_drivers import service
from app.domains.cost_drivers.cache import RefreshCooldownError
from app.domains.cost_drivers.schemas import CostDriversDashboard


def _app(role=UserRole.ADMIN):
    app = FastAPI()
    app.include_router(routes.router)

    async def current_user():
        return SimpleNamespace(role=role, email="fixture@example.test")

    app.dependency_overrides[routes.get_current_user] = current_user

    @app.get("/probe")
    async def probe():
        return {"status": "ok"}

    return app


@pytest.mark.parametrize(
    "method,path,expected_arguments,response_keys",
    [
        ("GET", "/summary?month=2026-07", {"month": "2026-07"}, None),
        ("GET", "/aws", {}, ("topServices", "topUsageTypes", "inventory", "debug")),
        ("GET", "/traffic", {}, ("traffic",)),
        ("GET", "/recommendations", {}, ("recommendations",)),
        ("POST", "/refresh?month=2026-07", {"force_refresh": True, "month": "2026-07"}, None),
    ],
)
def test_slow_dashboard_does_not_block_other_requests(
    monkeypatch, method, path, expected_arguments, response_keys
):
    started = Event()
    release = Event()
    calls = []
    threads = []
    main_thread = get_ident()
    payload = service._empty_live_dashboard("2026-07")

    def slow_dashboard(**kwargs):
        calls.append(kwargs)
        threads.append(get_ident())
        started.set()
        release.wait(timeout=2)
        return payload

    monkeypatch.setattr(routes, "get_dashboard", slow_dashboard)

    async def scenario():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=_app()), base_url="http://test"
        ) as client:
            request = asyncio.create_task(
                client.request(method, "/api/admin/cost-drivers" + path)
            )
            try:
                assert await asyncio.to_thread(started.wait, 1)
                probe = await asyncio.wait_for(client.get("/probe"), timeout=0.25)
                assert probe.json() == {"status": "ok"}
                assert not request.done()
            finally:
                release.set()
                response = await request
        assert response.status_code == 200
        expected = (
            {key: payload[key] for key in response_keys}
            if response_keys is not None
            else CostDriversDashboard.model_validate(payload).model_dump()
        )
        assert response.json() == expected

    asyncio.run(scenario())
    assert calls == [expected_arguments]
    assert threads and main_thread not in threads


def test_cost_dashboard_routes_still_require_admin(monkeypatch):
    def forbidden_dashboard(**_kwargs):
        pytest.fail("An unauthorized caller must not collect dashboard data")

    monkeypatch.setattr(routes, "get_dashboard", forbidden_dashboard)

    async def scenario():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=_app(UserRole.USER)), base_url="http://test"
        ) as client:
            for method, path in [
                ("GET", "/summary"),
                ("GET", "/aws"),
                ("GET", "/traffic"),
                ("GET", "/recommendations"),
                ("POST", "/refresh"),
            ]:
                response = await client.request(method, "/api/admin/cost-drivers" + path)
                assert response.status_code == 403
                assert response.json()["detail"] == "Cost dashboard admin access required"

    asyncio.run(scenario())


def test_refresh_cooldown_response_preserves_retry_after(monkeypatch):
    def rate_limited(**kwargs):
        assert kwargs == {"force_refresh": True, "month": "2026-07"}
        raise RefreshCooldownError(73)

    monkeypatch.setattr(routes, "get_dashboard", rate_limited)

    async def scenario():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=_app()), base_url="http://test"
        ) as client:
            response = await client.post("/api/admin/cost-drivers/refresh?month=2026-07")
        assert response.status_code == 429
        assert response.headers["retry-after"] == "73"
        assert response.json()["detail"] == str(RefreshCooldownError(73))

    asyncio.run(scenario())


def test_invalid_month_never_starts_collection(monkeypatch):
    def forbidden_dashboard(**_kwargs):
        pytest.fail("An invalid month must not collect dashboard data")

    monkeypatch.setattr(routes, "get_dashboard", forbidden_dashboard)

    async def scenario():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=_app()), base_url="http://test"
        ) as client:
            for method, path in [("GET", "/summary"), ("POST", "/refresh")]:
                response = await client.request(
                    method, "/api/admin/cost-drivers" + path, params={"month": "2026-13"}
                )
                assert response.status_code == 422

    asyncio.run(scenario())
