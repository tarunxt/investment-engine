import os
from pathlib import Path

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://test:test@localhost:5432/testdb",
)
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

import httpx
import pytest
from fastapi import FastAPI
from types import SimpleNamespace

from app.domains.auth.dependencies import get_current_user
from app.domains.polymarket_auto_live.router import router as auto_live_router
from app.domains.polymarket_auto_live.schemas import (
    BullpenAutoLiveRun,
    BullpenAutoLiveRunOnceRequest,
    BullpenAutoLiveSettings,
    BullpenAutoLiveSettingsUpdate,
)
from app.domains.trading_bots.router import router as trading_bots_router
from app.domains.trading_bots.schemas import (
    TradingBotCardSummary,
    TradingBotsSummaryResponse,
)


def _current_user():
    return SimpleNamespace(id=7)


def _build_test_app(*routers) -> FastAPI:
    app = FastAPI()
    for router in routers:
        app.include_router(router)
    app.dependency_overrides[get_current_user] = _current_user
    return app


def _summary_card(bot_id: str, name: str, route: str):
    return TradingBotCardSummary(
        id=bot_id,  # type: ignore[arg-type]
        name=name,
        route=route,
        status="stopped",
        mode="paper" if bot_id != "bullpen-x-ai" else "analysis-only",
        guardrails_summary="Guardrails ready",
        strategy_summary="Strategy summary",
        risk_summary="Risk summary",
    )


@pytest.mark.anyio
async def test_trading_bots_summary_route_returns_four_cards(monkeypatch):
    app = _build_test_app(trading_bots_router)

    async def fake_build_trading_bots_summary(user_id: int):
        return TradingBotsSummaryResponse(
            generated_at="2026-06-21T10:00:00+00:00",
            cards=[
                _summary_card(
                    "bullpen-x-polymarket",
                    "Bullpen x Polymarket",
                    "/console/polymarket-bot",
                ),
                _summary_card(
                    "polymarket-direct",
                    "Polymarket Direct",
                    "/console/polymarket-direct-bot",
                ),
                _summary_card(
                    "bullpen-x-ai",
                    "Bullpen x AI",
                    "/console/bullpen-ai",
                ),
                _summary_card(
                    "bullpen-ai-auto-live",
                    "Bullpen AI Auto-Live",
                    "/console/trading-bots/bullpen-ai-auto-live",
                ),
            ],
        )

    monkeypatch.setattr(
        "app.domains.trading_bots.router.build_trading_bots_summary",
        fake_build_trading_bots_summary,
    )

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.get("/trading-bots/summary")

    assert response.status_code == 200
    payload = response.json()
    assert len(payload["cards"]) == 4
    assert [card["id"] for card in payload["cards"]] == [
        "bullpen-x-polymarket",
        "polymarket-direct",
        "bullpen-x-ai",
        "bullpen-ai-auto-live",
    ]


class _FakeAutoLiveBot:
    def __init__(self) -> None:
        self.settings = BullpenAutoLiveSettings()
        self.run_once_request: BullpenAutoLiveRunOnceRequest | None = None

    async def get_settings(self) -> BullpenAutoLiveSettings:
        return self.settings

    async def update_settings(
        self,
        update: BullpenAutoLiveSettingsUpdate,
    ) -> BullpenAutoLiveSettings:
        merged = self.settings.model_dump()
        merged.update(update.model_dump(exclude_unset=True))
        self.settings = BullpenAutoLiveSettings.model_validate(merged)
        return self.settings

    async def reset_settings(self) -> BullpenAutoLiveSettings:
        self.settings = BullpenAutoLiveSettings()
        return self.settings

    async def run_once(
        self,
        *,
        triggered_by: str = "manual",
        request: BullpenAutoLiveRunOnceRequest | None = None,
    ) -> BullpenAutoLiveRun:
        self.run_once_request = request
        return BullpenAutoLiveRun(
            id="run-1",
            triggered_by=triggered_by,  # type: ignore[arg-type]
            status="running",
            dry_run=True,
            started_at="2026-06-21T10:00:00+00:00",
            summary="Queued",
            request_context=request,
        )

    async def get_run(self, run_id: str) -> BullpenAutoLiveRun:
        if run_id != "run-1":
            raise ValueError("Auto-Live run not found.")
        return BullpenAutoLiveRun(
            id=run_id,
            triggered_by="manual",
            status="running",
            dry_run=True,
            started_at="2026-06-21T10:00:00+00:00",
            summary="Queued",
        )


@pytest.mark.anyio
async def test_auto_live_settings_routes_load_validate_and_reset(monkeypatch):
    app = _build_test_app(auto_live_router)
    fake_bot = _FakeAutoLiveBot()

    async def fake_get_bot(user_id: int):
        return fake_bot

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.router.polymarket_auto_live_bot_manager.get_bot",
        fake_get_bot,
    )

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        get_response = await client.get("/polymarket/auto-live/settings")
        assert get_response.status_code == 200
        assert get_response.json() == BullpenAutoLiveSettings().model_dump(mode="json")

        invalid_response = await client.put(
            "/polymarket/auto-live/settings",
            json={
                "max_single_trade_pct_bankroll": 7,
                "max_single_market_pct_bankroll": 6,
            },
        )
        assert invalid_response.status_code == 400
        assert "max_single_trade_pct_bankroll" in invalid_response.json()["detail"]

        update_response = await client.put(
            "/polymarket/auto-live/settings",
            json={
                "bankroll_usd": 250,
                "auto_live_enabled": True,
                "dry_run": True,
                "llm_execution_mode": "single_combined",
                "llm_events_per_prompt": 7,
                "console_llm_prompt_template": "Saved prompt {{SELECTED_QUESTIONS}}",
            },
        )
        assert update_response.status_code == 200
        assert update_response.json()["bankroll_usd"] == 250
        assert update_response.json()["auto_live_enabled"] is True
        assert update_response.json()["llm_execution_mode"] == "single_combined"
        assert update_response.json()["llm_events_per_prompt"] == 7
        assert (
            update_response.json()["console_llm_prompt_template"]
            == "Saved prompt {{SELECTED_QUESTIONS}}"
        )

        invalid_llm_events_response = await client.put(
            "/polymarket/auto-live/settings",
            json={"llm_events_per_prompt": "7.5"},
        )
        assert invalid_llm_events_response.status_code == 422
        assert "llm_events_per_prompt" in str(invalid_llm_events_response.json())

        reset_response = await client.post("/polymarket/auto-live/settings/reset")
        assert reset_response.status_code == 200
        assert reset_response.json() == BullpenAutoLiveSettings().model_dump(mode="json")


@pytest.mark.anyio
async def test_auto_live_run_once_route_accepts_manual_console_rows(monkeypatch):
    app = _build_test_app(auto_live_router)
    fake_bot = _FakeAutoLiveBot()

    async def fake_get_bot(user_id: int):
        return fake_bot

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.router.polymarket_auto_live_bot_manager.get_bot",
        fake_get_bot,
    )

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.post(
            "/polymarket/auto-live/run-once",
            json={
                "client_run_id": "client-run-0001",
                "console_profile": {
                    "source_label": "Bullpen CLI",
                    "total_candidates": 2,
                    "candidate_rows": [
                        {
                            "question_id": "candidate-market-1",
                            "market_id": "candidate-market-1",
                            "market_title": "Candidate market 1",
                            "slug": "candidate-market-1",
                            "current_yes_odds": 18,
                            "current_no_odds": 82,
                            "llm_yes_odds": 8,
                            "llm_no_odds": 92,
                            "returns_per_day": 9.2,
                            "amount_to_be_invested": 5,
                            "selected": True,
                            "llm_outputs": [],
                        }
                    ],
                }
            },
        )

    assert response.status_code == 200
    assert fake_bot.run_once_request is not None
    assert fake_bot.run_once_request.client_run_id == "client-run-0001"
    assert fake_bot.run_once_request.console_profile is not None
    assert fake_bot.run_once_request.console_profile.source_label == "Bullpen CLI"
    assert fake_bot.run_once_request.console_profile.candidate_rows[0].selected is True


@pytest.mark.anyio
async def test_auto_live_exact_run_route_supports_idempotent_start_recovery(
    monkeypatch,
):
    app = _build_test_app(auto_live_router)
    fake_bot = _FakeAutoLiveBot()

    async def fake_get_bot(user_id: int):
        return fake_bot

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.router.polymarket_auto_live_bot_manager.get_bot",
        fake_get_bot,
    )

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://testserver",
    ) as client:
        found = await client.get("/polymarket/auto-live/runs/run-1")
        missing = await client.get("/polymarket/auto-live/runs/missing-run")

    assert found.status_code == 200
    assert found.json()["id"] == "run-1"
    assert missing.status_code == 404


def test_polymarket_manual_invest_route_remains_available():
    source = Path("app/domains/polymarket/router.py").read_text()
    assert '@router.post("/manual-invest"' in source
    assert "execute_manual_investments" in source
