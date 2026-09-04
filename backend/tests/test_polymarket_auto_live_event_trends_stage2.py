import os
from datetime import UTC, datetime
from types import SimpleNamespace

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://test:test@localhost:5432/testdb",
)
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

import pytest

from app.domains.polymarket_auto_live import repository as repository_module
from app.domains.polymarket_auto_live.repository import (
    AsyncPolymarketAutoLiveRepository,
)


class _RowsResult:
    def __init__(self, rows):
        self._rows = rows

    def all(self):
        return self._rows

    def first(self):
        return self._rows[0] if self._rows else None


class _StageTwoOnlySession:
    def __init__(self):
        self.calls = 0

    async def get(self, _model, _identity):
        return None

    async def execute(self, _statement):
        self.calls += 1
        if self.calls == 1:
            return _RowsResult([
                SimpleNamespace(
                    id="run-stage2-only",
                    trend_stage_results=[
                        {
                            "stage_number": 1,
                            "stage_name": "Stage 1 - Scan",
                            "status": "pass",
                            "reason": "Scan complete",
                            "started_at": "2026-08-10T02:40:00+00:00",
                            "completed_at": "2026-08-10T02:45:00+00:00",
                            "outputs": {
                                "workflow_stage_key": "scan",
                                "accepted_candidates": [
                                    {
                                        "market_id": "market-stage1-only",
                                        "condition_id": "condition-stage1-only",
                                        "slug": "stage1-only-market",
                                        "question": "Will the Stage 1-only event happen?",
                                        "market_url": "https://example.com/market-stage1-only",
                                        "close_time": "2026-08-20T12:00:00+00:00",
                                        "current_yes_odds": 82,
                                        "current_no_odds": 18,
                                        "returns_per_day": 1.5,
                                    }
                                ],
                            },
                            "started_at": "2026-08-10T02:35:00+00:00",
                            "completed_at": "2026-08-10T02:40:00+00:00",
                        },
                        {
                            "stage_number": 2,
                            "stage_name": "Stage 2 - LLM",
                            "status": "pass",
                            "reason": "LLM review complete",
                            "outputs": {
                                "workflow_stage_key": "llm",
                                "llm_reviewed_candidates": [
                                    {
                                        "market_id": "market-1",
                                        "question_id": "question-1",
                                        "question": "Will event one happen?",
                                        "market_url": "https://example.com/market-1",
                                        "close_time": "2026-08-12T12:00:00+00:00",
                                        "current_yes_odds": 12.5,
                                        "current_no_odds": 87.5,
                                        "best_bid_cents": 1,
                                        "best_ask_cents": 44,
                                        "fair_yes_probability_pct": 10,
                                        "fair_no_probability_pct": 90,
                                        "returns_per_day": 13,
                                        "llm_completed_at": "2026-08-10T02:45:00+00:00",
                                        "llm_outputs": [
                                            {
                                                "provider": "deepseek",
                                                "model": "deepseek-v4-flash",
                                                "status": "completed",
                                                "llm_yes_odds": 10,
                                                "llm_no_odds": 90,
                                                "completed_at": "2026-08-10T02:45:00+00:00",
                                            }
                                        ],
                                    },
                                    {
                                        "market_id": "market-empty-consensus",
                                        "question": "Will an empty consensus stay uncovered?",
                                        "close_time": "2026-08-12T12:00:00+00:00",
                                        "current_yes_odds": 96.75,
                                        "current_no_odds": 3.25,
                                        "fair_yes_probability_pct": 0,
                                        "fair_no_probability_pct": 100,
                                        "current_exposure_usd": 25,
                                        "position_side": "YES",
                                        "llm_outputs": [],
                                    },
                                ],
                            },
                            "started_at": "2026-08-10T02:40:00+00:00",
                            "completed_at": "2026-08-10T02:45:00+00:00",
                        }
                    ],
                    started_at=datetime(2026, 8, 10, 2, 40, tzinfo=UTC),
                    completed_at=datetime(2026, 8, 10, 2, 45, tzinfo=UTC),
                    updated_at=datetime(2026, 8, 10, 2, 45, tzinfo=UTC),
                )
            ])
        return _RowsResult([])


class _LatestCompletedStageOneSession:
    def __init__(self):
        self.calls = 0

    async def get(self, _model, _identity):
        return None

    async def execute(self, _statement):
        self.calls += 1
        if self.calls == 1:
            return _RowsResult([
                SimpleNamespace(
                    id="newer-run-without-scan",
                    trend_stage_results=[],
                    started_at=datetime(2026, 8, 11, 2, 40, tzinfo=UTC),
                    completed_at=None,
                    updated_at=datetime(2026, 8, 11, 2, 40, tzinfo=UTC),
                ),
                SimpleNamespace(
                    id="latest-run-with-stage1-candidates",
                    trend_stage_results=[
                        {
                            "stage_number": 1,
                            "stage_name": "Stage 1 - Scan",
                            "status": "pass",
                            "reason": "Scan complete",
                            "started_at": "2026-08-10T02:40:00+00:00",
                            "completed_at": "2026-08-10T02:45:00+00:00",
                            "outputs": {
                                "workflow_stage_key": "scan",
                                "accepted_candidates": [],
                                "accepted_candidates_count": 1,
                            },
                        }
                    ],
                    started_at=datetime(2026, 8, 10, 2, 40, tzinfo=UTC),
                    completed_at=datetime(2026, 8, 10, 2, 45, tzinfo=UTC),
                    updated_at=datetime(2026, 8, 10, 2, 45, tzinfo=UTC),
                ),
            ])
        if self.calls == 3:
            return _RowsResult([
                SimpleNamespace(
                    trend_stage_results=[
                        {
                            "stage_number": 1,
                            "stage_name": "Stage 1 - Scan",
                            "status": "pass",
                            "reason": "Scan complete",
                            "started_at": "2026-08-10T02:40:00+00:00",
                            "completed_at": "2026-08-10T02:45:00+00:00",
                            "outputs": {
                                "workflow_stage_key": "scan",
                                "accepted_candidates": [
                                    {
                                        "market_id": "retained-stage1-market",
                                        "condition_id": "retained-stage1-condition",
                                        "slug": "retained-stage1-slug",
                                        "question": "Will retained Stage 1 data be shown?",
                                        "close_time": "2026-08-20T12:00:00+00:00",
                                        "current_yes_odds": 81,
                                        "current_no_odds": 19,
                                        "returns_per_day": 1.7,
                                    }
                                ],
                            },
                        }
                    ]
                )
            ])
        return _RowsResult([])


@pytest.mark.anyio
async def test_event_trends_use_stage2_review_when_stage3_has_no_decisions(monkeypatch):
    monkeypatch.setattr(
        repository_module,
        "utc_now",
        lambda: datetime(2026, 8, 10, 2, 45, tzinfo=UTC),
    )
    session = _StageTwoOnlySession()
    response = await AsyncPolymarketAutoLiveRepository(session).list_recent_event_trends(
        7
    )

    assert session.calls == 3
    assert len(response.events) == 3
    event = next(event for event in response.events if event.market_id == "market-1")
    assert event.market_id == "market-1"
    assert event.market_title == "Will event one happen?"
    assert event.scan_scores[0] == 90
    assert event.scan_sides[0] == "NO"
    assert event.scan_timestamps[0] == "2026-08-10T02:45:00+00:00"
    assert event.llm_yes_odds == 10
    assert event.llm_no_odds == 90
    assert event.current_yes_odds == 44
    assert event.current_no_odds == 99
    assert event.market_url == "https://example.com/market-1"
    assert event.returns_per_day == 0.16
    assert event.scan_llm_outputs[0][0].provider == "deepseek"
    assert event.score == 90
    assert len(event.scan_scores) == 20

    empty_consensus = next(
        event
        for event in response.events
        if event.market_id == "market-empty-consensus"
    )
    assert empty_consensus.scan_scores[0] is None
    assert empty_consensus.llm_yes_odds is None
    assert empty_consensus.llm_no_odds is None
    assert empty_consensus.scan_llm_outputs[0] == []
    assert empty_consensus.is_active_position is True
    assert empty_consensus.returns_per_day is not None

    stage1_only = next(
        event for event in response.events if event.market_id == "market-stage1-only"
    )
    assert stage1_only.close_time == "2026-08-20T12:00:00+00:00"
    assert stage1_only.condition_id == "condition-stage1-only"
    assert stage1_only.slug == "stage1-only-market"
    assert stage1_only.current_yes_odds == 82
    assert stage1_only.current_no_odds == 18
    assert stage1_only.llm_yes_odds is None
    assert stage1_only.llm_no_odds is None
    assert stage1_only.returns_per_day == 1.5
    assert stage1_only.scan_scores[0] is None


@pytest.mark.anyio
async def test_event_trends_use_latest_run_that_actually_completed_stage1(monkeypatch):
    monkeypatch.setattr(
        repository_module,
        "utc_now",
        lambda: datetime(2026, 8, 11, 2, 45, tzinfo=UTC),
    )
    session = _LatestCompletedStageOneSession()

    response = await AsyncPolymarketAutoLiveRepository(session).list_recent_event_trends(
        7
    )

    assert session.calls == 4
    assert len(response.events) == 1
    assert response.events[0].market_id == "retained-stage1-market"
    assert response.events[0].condition_id == "retained-stage1-condition"
    assert response.events[0].slug == "retained-stage1-slug"
    assert response.events[0].close_time == "2026-08-20T12:00:00+00:00"
    assert response.events[0].returns_per_day == 1.7
