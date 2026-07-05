import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from types import SimpleNamespace

from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import User
from app.domains.bullpen_trade_analysis.analytics import (
    generate_bullpen_post_trade_analysis,
)
from app.domains.bullpen_trade_analysis.models import (
    BullpenTradeAnalysisEventLogRecord,
    BullpenTradeAnalysisLlmRecord,
    BullpenTradeAnalysisRecord,
    BullpenTradeAnalysisSnapshotRecord,
)
from app.domains.bullpen_trade_analysis.router import router as trade_analysis_router
from app.domains.bullpen_trade_analysis.schemas import (
    BullpenTradeAnalysisDetailResponse,
    BullpenTradeAnalysisListResponse,
)
from app.domains.bullpen_trade_analysis.service import (
    BullpenTradeAnalysisService,
    capture_auto_live_buy_pre_submit_sync,
    capture_auto_live_buy_result_sync,
    capture_auto_live_exit_pre_submit_sync,
    capture_auto_live_exit_result_sync,
)
from app.infrastructure.database.base import Base
import app.infrastructure.database.all_models  # noqa: F401


def _current_user():
    return SimpleNamespace(id=7)


def _build_test_app() -> FastAPI:
    app = FastAPI()
    app.include_router(trade_analysis_router)
    app.dependency_overrides[get_current_user] = _current_user
    return app


def _build_session_factory():
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(
      engine,
      tables=[
          User.__table__,
          BullpenTradeAnalysisRecord.__table__,
          BullpenTradeAnalysisSnapshotRecord.__table__,
          BullpenTradeAnalysisLlmRecord.__table__,
          BullpenTradeAnalysisEventLogRecord.__table__,
      ],
    )
    SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)
    with SessionLocal() as session:
        session.add(
            User(
                id=7,
                email="trade-analysis@example.com",
                username="trade-analysis",
                password_hash="hashed",
            )
        )
        session.commit()
    return SessionLocal


def test_capture_buy_and_exit_updates_same_trade_record(monkeypatch):
    session_factory = _build_session_factory()
    monkeypatch.setattr(
        "app.domains.bullpen_trade_analysis.service.SyncSessionLocal",
        session_factory,
    )

    capture_auto_live_buy_pre_submit_sync(
        user_id=7,
        entry_reference="entry-1",
        context={
            "source_variant": "auto-live-stage3",
            "bot_name": "Bullpen x AI",
            "strategy_name": "Bullpen x AI Auto-Live",
            "strategy_version": "bullpen_console_top10",
            "run_id": "run-1",
            "event_id": "event-1",
            "event_slug": "event-1",
            "market_id": "market-1",
            "outcome_name": "YES",
            "title": "Will event 1 resolve yes?",
            "event_question": "Will event 1 resolve yes?",
            "category": "Politics",
            "topic": "Election",
            "event_close_time": "2026-07-05T10:00:00+00:00",
            "requested_amount": 5,
            "requested_price": 0.5,
            "buy_probability_estimate": 62,
            "market_probability": 50,
            "confidence": "High",
            "risk_score": "Ready",
            "expected_edge": 12,
            "expected_value": 0.6,
            "liquidity_score": 0.8,
            "volume_score": 0.7,
            "spread_score": 0.9,
            "volatility_score": 0.3,
            "evidence_status": "Strong",
            "event_state": "scheduled_not_occurred",
            "decision_summary": "Strong consensus buy.",
            "buy_reason": "Strong consensus buy.",
            "selected_by_rule": True,
            "selected_by_llm": True,
            "selected_by_hybrid": True,
            "llm_payloads": [
                {
                    "provider": "deepseek",
                    "model": "deepseek-v4-flash",
                    "confidence": "High",
                    "rationale": "Entry edge looks favorable.",
                    "tags": ["politics", "high_confidence"],
                }
            ],
            "market_snapshot_json": {"liquidity_usd": 12000, "volume_usd": 8000},
            "order_book_snapshot_json": {"spread_cents": 2},
            "log_metadata": {"order_plan_id": "order-1"},
        },
    )
    capture_auto_live_buy_result_sync(
        user_id=7,
        entry_reference="entry-1",
        raw_execution_response='{"orderId":"buy-1","status":"filled","filledAmount":5,"filledShares":10,"avgPrice":0.5,"fees":0.1}',
    )

    capture_auto_live_exit_pre_submit_sync(
        user_id=7,
        exit_reference="exit-1",
        context={
            "run_id": "run-1",
            "market_id": "market-1",
            "outcome_name": "YES",
            "title": "Will event 1 resolve yes?",
            "event_question": "Will event 1 resolve yes?",
            "requested_amount": 6,
            "requested_shares": 10,
            "requested_price": 0.6,
            "probability_estimate": 55,
            "market_probability": 60,
            "confidence": "Medium",
            "risk_score": "Watch",
            "expected_edge": -5,
            "expected_value": -0.3,
            "liquidity_score": 0.75,
            "volume_score": 0.7,
            "spread_score": 0.85,
            "volatility_score": 0.2,
            "decision_summary": "Rule exit after edge compression.",
            "sell_reason": "Rule exit after edge compression.",
            "event_state": "scheduled_not_occurred",
            "llm_payloads": [],
            "market_snapshot_json": {"liquidity_usd": 10000, "volume_usd": 7000},
            "order_book_snapshot_json": {"spread_cents": 3},
        },
    )
    capture_auto_live_exit_result_sync(
        user_id=7,
        exit_reference="exit-1",
        market_id="market-1",
        outcome_name="YES",
        title="Will event 1 resolve yes?",
        raw_execution_response='{"orderId":"sell-1","status":"filled","filledAmount":6,"filledShares":10,"avgPrice":0.6,"fees":0.1}',
        exit_type="SELL",
        sell_reason="Rule exit after edge compression.",
    )

    with session_factory() as session:
        records = session.execute(select(BullpenTradeAnalysisRecord)).scalars().all()
        assert len(records) == 1
        record = records[0]
        assert record.status == "SOLD"
        assert record.lifecycle_state == "BUY_AND_SELL_EXECUTED"
        assert record.final_tag == "RULE_EXIT"
        assert record.net_pnl == pytest.approx(0.8)
        assert record.buy_status == "filled"
        assert record.sell_status == "filled"

        snapshots = session.execute(
            select(BullpenTradeAnalysisSnapshotRecord).where(
                BullpenTradeAnalysisSnapshotRecord.trade_analysis_id == record.id
            )
        ).scalars().all()
        assert {snapshot.snapshot_type for snapshot in snapshots} >= {
            "BUY_PRE_SUBMIT",
            "BUY_POST_EXECUTION",
            "SELL_PRE_SUBMIT",
            "SELL_POST_EXECUTION",
        }

        llm_entries = session.execute(
            select(BullpenTradeAnalysisLlmRecord).where(
                BullpenTradeAnalysisLlmRecord.trade_analysis_id == record.id
            )
        ).scalars().all()
        assert any(entry.phase == "BUY_ANALYSIS" for entry in llm_entries)


def test_generate_post_trade_analysis_penalizes_high_confidence_loss():
    analysis = generate_bullpen_post_trade_analysis(
        {
            "net_pnl": -1.2,
            "buy_notional": 5.0,
            "fees_total": 0.2,
            "buy_spread_score": 0.2,
            "buy_liquidity_score": 0.2,
            "buy_probability_delta": 1.5,
            "buy_confidence": 0.85,
            "drawdown_while_held": -0.22,
        }
    )

    assert analysis["reinforcement_signal"] == "PENALTY"
    assert analysis["human_review_required"] is True
    assert analysis["should_avoid_similar_trade"] is True
    assert analysis["mistake_category"] in {
        "OVERCONFIDENT_LLM",
        "POOR_LIQUIDITY_OR_SPREAD",
        "LATE_EXIT",
        "WEAK_EDGE",
        "LOW_LIQUIDITY",
    }


@pytest.mark.anyio
async def test_trade_analysis_list_route_passes_authenticated_user_id(monkeypatch):
    app = _build_test_app()
    captured: dict[str, object] = {}

    async def fake_list_trades(self, **kwargs):
        captured.update(kwargs)
        return BullpenTradeAnalysisListResponse()

    monkeypatch.setattr(BullpenTradeAnalysisService, "list_trades", fake_list_trades)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.get("/bullpen-ai/trade-analysis?status=OPEN&final_tag=PROFIT")

    assert response.status_code == 200
    assert captured["user_id"] == 7
    assert captured["status"] == "OPEN"
    assert captured["final_tag"] == "PROFIT"


@pytest.mark.anyio
async def test_trade_analysis_detail_route_passes_authenticated_user_id(monkeypatch):
    app = _build_test_app()
    captured: dict[str, object] = {}

    async def fake_get_trade_detail(self, **kwargs):
        captured.update(kwargs)
        return BullpenTradeAnalysisDetailResponse(
            trade={
                "id": "trade-1",
                "entry_reference": "entry-1",
                "source_variant": "manual-dashboard",
                "bot_name": "Bullpen x AI",
                "status": "BOUGHT",
                "lifecycle_state": "BUY_EXECUTED_ONLY",
                "final_tag": "OPEN",
                "pnl_outcome_tag": "OPEN",
                "title": "Trade 1",
                "event_question": "Trade 1",
                "buy_selected_by_rule": False,
                "buy_selected_by_llm": False,
                "buy_selected_by_hybrid_decision": False,
                "buy_computed_tags_json": [],
                "buy_rule_checks_json": [],
                "sell_computed_tags_json": [],
                "sell_rule_checks_json": [],
                "should_avoid_similar_trade": False,
                "should_increase_confidence_for_similar_trade": False,
                "human_review_required": False,
                "metadata_json": {},
                "created_at": "2026-07-05T10:00:00+00:00",
                "updated_at": "2026-07-05T10:00:00+00:00",
            }
        )

    monkeypatch.setattr(BullpenTradeAnalysisService, "get_trade_detail", fake_get_trade_detail)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.get("/bullpen-ai/trade-analysis/trade-1")

    assert response.status_code == 200
    assert captured["user_id"] == 7
    assert captured["trade_id"] == "trade-1"
