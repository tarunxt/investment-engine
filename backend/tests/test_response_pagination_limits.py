from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI

from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import UserRole
from app.domains.indmoney_us.events_router import router as indmoney_events_router
from app.domains.indmoney_us.router import router as indmoney_router
from app.domains.indmoney_us.threats_router import router as indmoney_threats_router
from app.domains.polymarket.router import router as polymarket_router
from app.domains.polymarket_auto_live.router import router as auto_live_router
from app.domains.zerodha.events_router import router as zerodha_events_router
from app.domains.zerodha.router import router as zerodha_router
from app.domains.zerodha.threats_router import router as zerodha_threats_router


@pytest.mark.anyio
@pytest.mark.parametrize(
    "path",
    [
        "/zerodha/portfolio?limit=121",
        "/indmoney-us/portfolio?limit=121",
        "/zerodha/threats/history?limit=101",
        "/indmoney-us/threats/history?limit=101",
        "/zerodha/events/history?limit=101",
        "/indmoney-us/events/history?limit=101",
        "/polymarket/auto-live/runs?limit=51",
        "/polymarket/history?limit=201",
    ],
)
async def test_high_traffic_routes_reject_hostile_page_sizes(path: str):
    app = FastAPI()
    for router in (
        zerodha_router,
        indmoney_router,
        zerodha_threats_router,
        indmoney_threats_router,
        zerodha_events_router,
        indmoney_events_router,
        auto_live_router,
        polymarket_router,
    ):
        app.include_router(router)
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(
        id=7,
        role=UserRole.ADMIN,
    )

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://testserver",
    ) as client:
        response = await client.get(path)

    assert response.status_code == 422
