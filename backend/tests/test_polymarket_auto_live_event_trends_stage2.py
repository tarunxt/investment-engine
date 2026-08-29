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
                                        "current_yes_odds": 55.5,
                                        "current_no_odds": 44.5,
                                        "fair_yes_probability_pct": 74,
                                        "fair_no_probability_pct": 26,
                                        "returns_per_day": 13,
                                        "llm_completed_at": "2026-08-10T02:45:00+00:00",
                                        "llm_outputs": [
                                            {
                                                "provider": "deepseek",
                                                "model": "deepseek-v4-flash",
                                                "status": "completed",
                                                "llm_yes_odds": 74,
                                                "llm_no_odds": 26,
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
    assert len(response.events) == 2
    event = next(event for event in response.events if event.market_id == "market-1")
    assert event.market_id == "market-1"
    assert event.market_title == "Will event one happen?"
    assert event.scan_scores[0] == 74
    assert event.scan_sides[0] == "YES"
    assert event.scan_timestamps[0] == "2026-08-10T02:45:00+00:00"
    assert event.llm_yes_odds == 74
    assert event.llm_no_odds == 26
    assert event.current_yes_odds == 55.5
    assert event.current_no_odds == 44.5
    assert event.market_url == "https://example.com/market-1"
    assert event.returns_per_day == 6.95
    assert event.scan_llm_outputs[0][0].provider == "deepseek"
    assert event.score == 74
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
