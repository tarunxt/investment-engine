import json
import os
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://test:test@localhost:5432/testdb",
)
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

import pytest
from pydantic import ValidationError

import app.infrastructure.database.all_models  # noqa: F401
from app.domains.polymarket_auto_live.bot import (
    BullpenAutoLiveBot,
    build_initial_run_summary,
    build_initial_scan_stage_result,
)
from app.domains.polymarket_auto_live.console_profile import (
    CONSOLE_PROFILE_ID,
    ConsoleWalletPosition,
    candidate_returns_per_day,
    next_console_schedule_time,
    position_returns_per_day,
    read_console_wallet_positions,
)
from app.domains.polymarket_auto_live.config import (
    auto_live_backend_allows_execution,
    auto_live_backend_execution_env_detail,
)
from app.domains.polymarket_auto_live.engine import (
    BullpenAutoLiveEngine,
    PositionSnapshot,
)
from app.domains.polymarket_auto_live.llm import run_llm_consensus
from app.domains.polymarket_auto_live.models import (
    PolymarketAutoLiveDecisionRecord,
    PolymarketAutoLiveStateRecord,
)
from app.domains.polymarket_auto_live.normalization import (
    normalize_auto_live_confidence,
    normalize_auto_live_evidence_status,
)
from app.domains.polymarket_auto_live.repository import (
    AsyncPolymarketAutoLiveRepository,
    apply_state_to_record,
    normalize_auto_live_status,
    record_to_decision,
    record_to_state,
)
from app.domains.polymarket_auto_live.rules import RuleEvaluation, evaluate_market_rules
from app.domains.polymarket_auto_live.scanner import (
    ScannedMarket,
    _evaluate_filter_reasons,
)
from app.domains.polymarket_auto_live.schemas import (
    BullpenAutoLiveConsoleCandidateInput,
    BullpenAutoLiveConsoleRunContext,
    BullpenAutoLiveBotCardSummary,
    BullpenAutoLiveDecision,
    BullpenAutoLiveLlmOutput,
    BullpenAutoLiveOrderPlan,
    BullpenAutoLiveRun,
    BullpenAutoLiveRunOnceRequest,
    BullpenAutoLiveSettings,
    BullpenAutoLiveState,
    BullpenAutoLiveSummary,
)
from app.domains.trading_bots.service import (
    build_trading_bots_overview,
    build_trading_bots_summary,
)


def test_auto_live_settings_enforce_cross_field_validation():
    with pytest.raises(ValidationError, match="max_single_trade_pct_bankroll"):
        BullpenAutoLiveSettings(
            max_single_trade_pct_bankroll=7,
            max_single_market_pct_bankroll=6,
        )

    with pytest.raises(ValidationError, match="allow_live_execution"):
        BullpenAutoLiveSettings(
            allow_live_execution=True,
            limit_orders_only=False,
        )


def test_initial_scan_stage_result_starts_immediately_for_manual_console_rows():
    request = BullpenAutoLiveRunOnceRequest(
        console_profile=BullpenAutoLiveConsoleRunContext(
            source_label="Saved Bullpen table",
            snapshot_id="snapshot-1",
            mode="30-days",
            total_candidates=12,
            candidate_rows=[
                BullpenAutoLiveConsoleCandidateInput(
                    question_id="question-1",
                    market_id="market-1",
                    market_title="Will stage 1 start immediately?",
                    selected=True,
                )
            ],
        )
    )

    summary = build_initial_run_summary(request)
    stage = build_initial_scan_stage_result(
        request=request,
        started_at="2026-06-25T05:00:00+00:00",
    )

    assert summary == "Stage 1 started. Bullpen scan is loading the current questions table."
    assert stage.reason == "Bullpen scan started with the current questions table."
    assert stage.started_at == "2026-06-25T05:00:00+00:00"
    assert stage.completed_at is None
    assert stage.outputs["workflow_stage_key"] == "scan"
    assert stage.outputs["phase_status"] == "running"
    assert stage.outputs["completed_items"] == 0
    assert stage.outputs["total_items"] == 12
    assert stage.outputs["selected_manual_candidate_count"] == 1


@pytest.mark.anyio
async def test_async_repository_save_run_persists_cancelled_active_run_payload():
    run = BullpenAutoLiveRun(
        id="run-save-test",
        triggered_by="manual",
        status="failed",
        dry_run=True,
        started_at="2026-06-25T07:00:00+00:00",
        completed_at="2026-06-25T07:01:00+00:00",
        summary="Auto-Live run cancelled by user.",
        error_message="Cancelled by user",
    )

    class _FakeAsyncSession:
        def __init__(self) -> None:
            self.records: dict[str, object] = {}
            self.flushed = False

        async def get(self, model, key):
            assert model.__name__ == "PolymarketAutoLiveRunRecord"
            return self.records.get(key)

        def add(self, record) -> None:
            self.records[record.id] = record

        async def flush(self) -> None:
            self.flushed = True

    session = _FakeAsyncSession()
    repo = AsyncPolymarketAutoLiveRepository(session)  # type: ignore[arg-type]

    await repo.save_run(7, run)

    saved_record = session.records["run-save-test"]
    assert session.flushed is True
    assert saved_record.user_id == 7
    assert saved_record.status == "failed"
    assert saved_record.summary == "Auto-Live run cancelled by user."
    assert saved_record.error_message == "Cancelled by user"
    assert saved_record.payload["summary"] == "Auto-Live run cancelled by user."
    assert saved_record.payload["error_message"] == "Cancelled by user"


@pytest.mark.anyio
async def test_stop_cancels_active_auto_live_run_immediately(monkeypatch):
    run = BullpenAutoLiveRun(
        id="run-stop-test",
        triggered_by="manual",
        status="running",
        dry_run=True,
        started_at="2026-06-25T07:00:00+00:00",
        summary="Stage 1 started.",
        stage_results=[
            build_initial_scan_stage_result(
                started_at="2026-06-25T07:00:00+00:00",
            )
        ],
    )
    settings = BullpenAutoLiveSettings(auto_live_enabled=True)
    state = BullpenAutoLiveState(
        running=True,
        paused=False,
        status="running",
        mode="analysis-only",
    )
    saved: dict[str, object] = {}
    revoked_run_ids: list[str] = []

    class _FakeSession:
        def __init__(self) -> None:
            self.committed = False

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def commit(self) -> None:
            self.committed = True

    fake_session = _FakeSession()

    class _FakeRepo:
        def __init__(self, session) -> None:
            assert session is fake_session

        async def ensure_settings(self, user_id: int):
            assert user_id == 7
            return settings

        async def ensure_state(self, user_id: int):
            assert user_id == 7
            return state

        async def get_running_run_record(self, user_id: int):
            assert user_id == 7
            return object()

        async def save_run(self, user_id: int, next_run: BullpenAutoLiveRun) -> None:
            assert user_id == 7
            saved["run"] = next_run

        async def save_state(self, user_id: int, next_state: BullpenAutoLiveState) -> None:
            assert user_id == 7
            saved["state"] = next_state

    async def _fake_revoke(run_id: str):
        revoked_run_ids.append(run_id)
        return "task-run-stop-test"

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.bot.AsyncSessionLocal",
        lambda: fake_session,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.bot.AsyncPolymarketAutoLiveRepository",
        _FakeRepo,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.bot.record_to_run",
        lambda _record: run,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.bot.revoke_registered_auto_live_run_task",
        _fake_revoke,
    )

    result = await BullpenAutoLiveBot(user_id=7).stop()

    saved_run = saved["run"]
    saved_state = saved["state"]
    assert isinstance(saved_run, BullpenAutoLiveRun)
    assert isinstance(saved_state, BullpenAutoLiveState)
    assert fake_session.committed is True
    assert saved_run.status == "failed"
    assert saved_run.completed_at is not None
    assert saved_run.error_message == "Cancelled by user"
    assert saved_run.summary == "Auto-Live run cancelled by user."
    assert saved_run.stage_results[0].outputs["phase_status"] == "cancelled"
    assert saved_run.stage_results[0].reason == "Cancelled by user."
    assert saved_state.running is False
    assert saved_state.paused is False
    assert saved_state.status == "stopped"
    assert "cancelled" in saved_state.last_action.lower()
    assert revoked_run_ids == ["run-stop-test"]
    assert result.status == "stopped"


def test_auto_live_backend_execution_flag_defaults_false(monkeypatch):
    monkeypatch.delenv("BULLPEN_AUTO_LIVE_ALLOW_EXECUTION", raising=False)
    assert auto_live_backend_allows_execution() is False

    monkeypatch.setenv("BULLPEN_AUTO_LIVE_ALLOW_EXECUTION", "true")
    assert auto_live_backend_allows_execution() is True

    monkeypatch.setenv("BULLPEN_AUTO_LIVE_ALLOW_EXECUTION", "1")
    assert auto_live_backend_allows_execution() is True

    monkeypatch.setenv("BULLPEN_AUTO_LIVE_ALLOW_EXECUTION", "yes")
    assert auto_live_backend_allows_execution() is True

    monkeypatch.setenv("BULLPEN_AUTO_LIVE_ALLOW_EXECUTION", "FALSE")
    assert auto_live_backend_allows_execution() is False


def test_auto_live_backend_execution_env_detail_names_process_and_restart(monkeypatch):
    monkeypatch.delenv("BULLPEN_AUTO_LIVE_ALLOW_EXECUTION", raising=False)
    missing_detail = auto_live_backend_execution_env_detail()
    assert "missing from this backend process" in missing_detail
    assert "/etc/investor/backend.env" in missing_detail
    assert "investor-celery-worker" in missing_detail

    monkeypatch.setenv("BULLPEN_AUTO_LIVE_ALLOW_EXECUTION", "false")
    blocked_detail = auto_live_backend_execution_env_detail()
    assert "currently 'false'" in blocked_detail
    assert "restart investor-backend" in blocked_detail

    monkeypatch.setenv("BULLPEN_AUTO_LIVE_ALLOW_EXECUTION", "on")
    assert "enabled" in auto_live_backend_execution_env_detail()


def test_console_schedule_uses_fixed_ist_slots():
    assert next_console_schedule_time(
        datetime(2026, 6, 24, 0, 29, tzinfo=UTC)
    ) == datetime(2026, 6, 24, 0, 30, tzinfo=UTC)
    assert next_console_schedule_time(
        datetime(2026, 6, 24, 6, 31, tzinfo=UTC)
    ) == datetime(2026, 6, 24, 12, 30, tzinfo=UTC)
    assert next_console_schedule_time(
        datetime(2026, 6, 24, 18, 29, tzinfo=UTC)
    ) == datetime(2026, 6, 24, 18, 30, tzinfo=UTC)


def test_candidate_returns_per_day_accepts_naive_close_time():
    returns = candidate_returns_per_day(
        _market(
            close_time="2026-06-25T00:00:00",
            current_yes_odds=20,
            current_no_odds=80,
        ),
        now=datetime(2026, 6, 21, 0, 0, tzinfo=UTC),
    )

    assert returns == 5.0


def test_position_returns_per_day_accepts_naive_close_time():
    returns = position_returns_per_day(
        _console_wallet_position(
            slug="naive-close-time-position",
            market_title="Will the naive close time stay safe?",
            current_price_cents=80,
            close_time="2026-06-25T00:00:00",
        ),
        now=datetime(2026, 6, 21, 0, 0, tzinfo=UTC),
    )

    assert returns == 5.0


@pytest.mark.anyio
async def test_console_profile_advances_to_stage_2_with_naive_candidate_close_time(
    monkeypatch,
):
    fixed_now = datetime(2026, 6, 21, 0, 0, tzinfo=UTC)
    candidate_market = _market(
        question="Will the naive candidate reach Stage 2?",
        slug="naive-stage-2-candidate",
        close_time="2026-06-25T00:00:00",
        current_yes_odds=21,
        current_no_odds=79,
    )

    async def fake_read_console_wallet_positions():
        return []

    async def fake_scan_console_profile_markets(**_kwargs):
        return SimpleNamespace(
            source_label="test",
            source_url="https://example.com",
            accepted=[candidate_market],
            rejected=[],
            total_candidates=1,
        )

    async def fake_refresh_execution_quote(*, slug: str | None, side: str):
        assert slug == candidate_market.slug
        assert side == "NO"
        return SimpleNamespace(
            market=candidate_market,
            current_price_cents=candidate_market.current_no_odds,
            spread_cents=2,
        )

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.utc_now",
        lambda: fixed_now,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.utc_now_iso",
        lambda: fixed_now.isoformat(),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.read_console_wallet_positions",
        fake_read_console_wallet_positions,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.scan_console_profile_markets",
        fake_scan_console_profile_markets,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.evaluate_market_rules",
        lambda *_args, **_kwargs: _fake_rules(hours_remaining=96),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.build_evidence_packet",
        lambda *args, **kwargs: _fake_evidence_packet(),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.run_llm_consensus",
        lambda *args, **kwargs: _fake_llm_consensus(fair_yes=8, fair_no=92),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_execution_quote",
        fake_refresh_execution_quote,
    )

    result = await BullpenAutoLiveEngine().execute(
        user_id=7,
        settings=BullpenAutoLiveSettings(
            strategy_profile=CONSOLE_PROFILE_ID,
            auto_live_enabled=True,
            dry_run=True,
        ),
        state=BullpenAutoLiveState(running=True),
        run=_run_snapshot(),
        positions=[],
        historical_decisions=[],
    )

    assert result.run.stage_results[0].outputs["workflow_stage_key"] == "scan"
    assert result.run.stage_results[0].outputs["phase_status"] == "completed"
    assert result.run.stage_results[1].outputs["workflow_stage_key"] == "llm"
    assert result.run.stage_results[1].outputs["phase_status"] == "completed"
    assert result.run.decisions_count == 1
    assert result.run.orders_planned == 1


@pytest.mark.anyio
async def test_console_profile_reports_incremental_stage_2_progress(monkeypatch):
    fixed_now = datetime(2026, 6, 21, 0, 0, tzinfo=UTC)
    first_market = _market(
        question="Will the first Stage 1 market finish review?",
        slug="stage-2-shortlist-1",
        current_yes_odds=12,
        current_no_odds=88,
    )
    second_market = _market(
        question="Will the second Stage 1 market finish review?",
        slug="stage-2-shortlist-2",
        current_yes_odds=10,
        current_no_odds=90,
    )

    async def fake_read_console_wallet_positions():
        return []

    async def fake_scan_console_profile_markets(**_kwargs):
        return SimpleNamespace(
            source_label="test",
            source_url="https://example.com",
            accepted=[first_market, second_market],
            rejected=[],
            total_candidates=2,
        )

    async def fake_refresh_execution_quote(*, slug: str | None, side: str):
        assert side == "NO"
        market = {
            first_market.slug: first_market,
            second_market.slug: second_market,
        }[slug]
        return SimpleNamespace(
            market=market,
            current_price_cents=market.current_no_odds,
            spread_cents=2,
        )

    progress_runs: list[BullpenAutoLiveRun] = []

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.utc_now",
        lambda: fixed_now,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.utc_now_iso",
        lambda: fixed_now.isoformat(),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.read_console_wallet_positions",
        fake_read_console_wallet_positions,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.scan_console_profile_markets",
        fake_scan_console_profile_markets,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.candidate_returns_per_day",
        lambda *_args, **_kwargs: 9.0,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.evaluate_market_rules",
        lambda *_args, **_kwargs: _fake_rules(hours_remaining=96),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.build_evidence_packet",
        lambda *args, **kwargs: _fake_evidence_packet(),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.run_llm_consensus",
        lambda *args, **kwargs: _fake_llm_consensus(fair_yes=8, fair_no=92),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_execution_quote",
        fake_refresh_execution_quote,
    )

    result = await BullpenAutoLiveEngine().execute(
        user_id=7,
        settings=BullpenAutoLiveSettings(
            strategy_profile=CONSOLE_PROFILE_ID,
            auto_live_enabled=True,
            dry_run=True,
        ),
        state=BullpenAutoLiveState(running=True),
        run=_run_snapshot(),
        positions=[],
        historical_decisions=[],
        progress_callback=lambda current_run, _state: progress_runs.append(
            current_run.model_copy(deep=True)
        ),
    )

    llm_running_stages = [
        stage
        for snapshot in progress_runs
        for stage in snapshot.stage_results
        if stage.outputs.get("workflow_stage_key") == "llm"
        and stage.outputs.get("phase_status") == "running"
    ]

    assert llm_running_stages
    assert any(stage.completed_at is None for stage in llm_running_stages)
    assert any(stage.outputs.get("completed_items") == 1 for stage in llm_running_stages)
    assert any(
        "reviewing event 1 of 2" in stage.reason.lower()
        for stage in llm_running_stages
    )
    assert any(
        stage.outputs.get("stage1_accepted_candidate_count") == 2
        for stage in llm_running_stages
    )

    llm_stage = next(
        stage
        for stage in result.run.stage_results
        if stage.outputs.get("workflow_stage_key") == "llm"
    )
    assert llm_stage.outputs["item_label"] == "events"
    assert llm_stage.reason == (
        "LLM review completed for 2 events from 2 Stage 1 candidates."
    )


@pytest.mark.anyio
async def test_console_profile_reports_incremental_stage_3_counters_and_mode_reason(
    monkeypatch,
):
    fixed_now = datetime(2026, 6, 21, 0, 0, tzinfo=UTC)
    candidate_market = _market(
        question="Will the Stage 3 monitor surface live counters?",
        slug="stage-3-counter-candidate",
        current_yes_odds=12,
        current_no_odds=88,
    )

    async def fake_read_console_wallet_positions():
        return []

    async def fake_scan_console_profile_markets(**_kwargs):
        return SimpleNamespace(
            source_label="test",
            source_url="https://example.com",
            accepted=[candidate_market],
            rejected=[],
            total_candidates=1,
        )

    async def fake_refresh_execution_quote(*, slug: str | None, side: str):
        assert slug == candidate_market.slug
        assert side == "NO"
        return SimpleNamespace(
            market=candidate_market,
            current_price_cents=candidate_market.current_no_odds,
            spread_cents=2,
        )

    progress_runs: list[BullpenAutoLiveRun] = []

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.utc_now",
        lambda: fixed_now,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.utc_now_iso",
        lambda: fixed_now.isoformat(),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.read_console_wallet_positions",
        fake_read_console_wallet_positions,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.scan_console_profile_markets",
        fake_scan_console_profile_markets,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.evaluate_market_rules",
        lambda *_args, **_kwargs: _fake_rules(hours_remaining=96),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.build_evidence_packet",
        lambda *args, **kwargs: _fake_evidence_packet(),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.run_llm_consensus",
        lambda *args, **kwargs: _fake_llm_consensus(fair_yes=8, fair_no=92),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_execution_quote",
        fake_refresh_execution_quote,
    )

    result = await BullpenAutoLiveEngine().execute(
        user_id=7,
        settings=BullpenAutoLiveSettings(
            strategy_profile=CONSOLE_PROFILE_ID,
            auto_live_enabled=True,
            dry_run=True,
        ),
        state=BullpenAutoLiveState(running=True),
        run=_run_snapshot(),
        positions=[],
        historical_decisions=[],
        progress_callback=lambda current_run, _state: progress_runs.append(
            current_run.model_copy(deep=True)
        ),
    )

    invest_running_stages = [
        stage
        for snapshot in progress_runs
        for stage in snapshot.stage_results
        if stage.outputs.get("workflow_stage_key") == "invest"
        and stage.outputs.get("phase_status") == "running"
    ]

    assert invest_running_stages
    assert any(stage.outputs.get("decisions_count") == 1 for stage in invest_running_stages)
    assert any(stage.outputs.get("orders_planned") == 1 for stage in invest_running_stages)
    assert any(stage.outputs.get("orders_submitted") == 0 for stage in invest_running_stages)
    assert any(
        stage.outputs.get("execution_mode_reason") == "Dry-run is enabled."
        for stage in invest_running_stages
    )

    invest_stage = next(
        stage
        for stage in result.run.stage_results
        if stage.outputs.get("workflow_stage_key") == "invest"
    )
    assert invest_stage.outputs["orders_processed"] == 1
    assert invest_stage.outputs["execution_mode_reason"] == "Dry-run is enabled."


@pytest.mark.anyio
async def test_console_profile_reviews_all_stage1_events_before_building_ranked_invest_table(
    monkeypatch,
):
    fixed_now = datetime(2026, 6, 21, 0, 0, tzinfo=UTC)
    first_market = _market(
        question="Will the first lower-return event still be reviewed?",
        slug="stage-1-event-1",
        current_yes_odds=18,
        current_no_odds=82,
    )
    second_market = _market(
        question="Will the second lower-return event still be reviewed?",
        slug="stage-1-event-2",
        current_yes_odds=22,
        current_no_odds=78,
    )

    async def fake_read_console_wallet_positions():
        return []

    async def fake_scan_console_profile_markets(**_kwargs):
        return SimpleNamespace(
            source_label="test",
            source_url="https://example.com",
            accepted=[first_market, second_market],
            rejected=[],
            total_candidates=2,
        )

    async def fake_refresh_execution_quote(*, slug: str | None, side: str):
        assert side == "YES"
        market = {
            first_market.slug: first_market,
            second_market.slug: second_market,
        }[slug]
        return SimpleNamespace(
            market=market,
            current_price_cents=market.current_yes_odds,
            spread_cents=2,
        )

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.utc_now",
        lambda: fixed_now,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.utc_now_iso",
        lambda: fixed_now.isoformat(),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.read_console_wallet_positions",
        fake_read_console_wallet_positions,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.scan_console_profile_markets",
        fake_scan_console_profile_markets,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.candidate_returns_per_day",
        lambda market, **_kwargs: 1.5 if market.slug == first_market.slug else 2.0,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.evaluate_market_rules",
        lambda *_args, **_kwargs: _fake_rules(hours_remaining=96),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.build_evidence_packet",
        lambda *args, **kwargs: _fake_evidence_packet(),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.run_llm_consensus",
        lambda *args, **kwargs: _fake_llm_consensus(fair_yes=91, fair_no=9),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_execution_quote",
        fake_refresh_execution_quote,
    )

    result = await BullpenAutoLiveEngine().execute(
        user_id=7,
        settings=BullpenAutoLiveSettings(
            strategy_profile=CONSOLE_PROFILE_ID,
            auto_live_enabled=True,
            dry_run=True,
        ),
        state=BullpenAutoLiveState(running=True),
        run=_run_snapshot(),
        positions=[],
        historical_decisions=[],
    )

    buy_decisions = [decision for decision in result.decisions if decision.decision == "BUY_NEW"]

    assert result.run.stage_results[1].outputs["llm_candidate_count"] == 2
    assert len(buy_decisions) == 2
    assert all(decision.order_plan is not None for decision in buy_decisions)
    assert all(decision.order_plan.side == "YES" for decision in buy_decisions)


@pytest.mark.anyio
async def test_console_profile_stage_2_reviews_active_positions_and_persists_llm_outputs(
    monkeypatch,
):
    fixed_now = datetime(2026, 6, 21, 0, 0, tzinfo=UTC)
    active_market = _market(
        question="Will the active position get refreshed LLM odds?",
        slug="active-stage-2-position",
        close_time="2026-06-25T00:00:00+00:00",
        current_yes_odds=20,
        current_no_odds=80,
    )
    active_position = _console_wallet_position(
        slug="active-stage-2-position",
        market_title=active_market.question,
        current_price_cents=80,
        close_time="2026-06-25T00:00:00+00:00",
        side="NO",
        shares=5,
        exposure_usd=4.0,
    )

    async def fake_read_console_wallet_positions():
        return [active_position]

    async def fake_scan_console_profile_markets(**_kwargs):
        return SimpleNamespace(
            source_label="test",
            source_url="https://example.com",
            accepted=[active_market],
            rejected=[],
            total_candidates=1,
        )

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.utc_now",
        lambda: fixed_now,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.utc_now_iso",
        lambda: fixed_now.isoformat(),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.read_console_wallet_positions",
        fake_read_console_wallet_positions,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.scan_console_profile_markets",
        fake_scan_console_profile_markets,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.evaluate_market_rules",
        lambda *_args, **_kwargs: _fake_rules(hours_remaining=96),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.build_evidence_packet",
        lambda *args, **kwargs: _fake_evidence_packet(),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.run_llm_consensus",
        lambda *args, **kwargs: _fake_llm_consensus(fair_yes=14, fair_no=86),
    )

    result = await BullpenAutoLiveEngine().execute(
        user_id=7,
        settings=BullpenAutoLiveSettings(
            strategy_profile=CONSOLE_PROFILE_ID,
            auto_live_enabled=True,
            dry_run=True,
        ),
        state=BullpenAutoLiveState(running=True),
        run=_run_snapshot(),
        positions=[],
        historical_decisions=[],
    )

    llm_stage = next(
        stage
        for stage in result.run.stage_results
        if stage.outputs.get("workflow_stage_key") == "llm"
    )
    reviewed_position = llm_stage.outputs["llm_reviewed_candidates"][0]

    assert llm_stage.outputs["active_position_rows_reviewed"] == 1
    assert llm_stage.outputs["llm_candidate_count"] == 1
    assert reviewed_position["source_kind"] == "active_position"
    assert reviewed_position["position_key"] == "active-stage-2-position::NO"
    assert reviewed_position["fair_yes_probability_pct"] == 14
    assert reviewed_position["fair_no_probability_pct"] == 86
    assert reviewed_position["llm_outputs"][0]["llm_no_odds"] == 86
    assert result.decisions[0].decision == "HOLD"
    assert result.decisions[0].llm_outputs[0].llm_no_odds == 86
    assert result.decisions[0].fair_no_probability_pct == 86


@pytest.mark.anyio
async def test_console_profile_stage_2_hydrates_missing_active_position_markets_before_llm(
    monkeypatch,
):
    fixed_now = datetime(2026, 6, 21, 0, 0, tzinfo=UTC)
    active_market = _market(
        question="Will Norway win on 2026-06-26?",
        slug="norway-win-2026-06-26",
        theme="Sports",
        close_time="2026-06-27T03:59:59+00:00",
        current_yes_odds=31,
        current_no_odds=69,
        description=(
            'This market will resolve to "Yes" if Norway wins on June 26, 2026. '
            "Otherwise, it resolves to No."
        ),
    )
    active_position = _console_wallet_position(
        slug=active_market.slug or "norway-win-2026-06-26",
        market_title=active_market.question,
        current_price_cents=69,
        close_time="2026-06-27T03:59:59+00:00",
        side="NO",
        shares=5,
        exposure_usd=3.45,
    )
    llm_market_descriptions: list[str | None] = []

    async def fake_read_console_wallet_positions():
        return [active_position]

    async def fake_scan_console_profile_markets(**_kwargs):
        return SimpleNamespace(
            source_label="test",
            source_url="https://example.com",
            accepted=[],
            rejected=[],
            total_candidates=0,
        )

    async def fake_fetch_market_by_slug(slug: str):
        assert slug == active_market.slug
        return active_market

    def fake_run_llm_consensus(market, *_args, **_kwargs):
        llm_market_descriptions.append(market.description)
        assert market.slug == active_market.slug
        assert market.description == active_market.description
        return _fake_llm_consensus(fair_yes=22, fair_no=78)

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.utc_now",
        lambda: fixed_now,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.utc_now_iso",
        lambda: fixed_now.isoformat(),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.read_console_wallet_positions",
        fake_read_console_wallet_positions,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.scan_console_profile_markets",
        fake_scan_console_profile_markets,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.fetch_market_by_slug",
        fake_fetch_market_by_slug,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.build_evidence_packet",
        lambda *args, **kwargs: _fake_evidence_packet(),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.run_llm_consensus",
        fake_run_llm_consensus,
    )

    result = await BullpenAutoLiveEngine().execute(
        user_id=7,
        settings=BullpenAutoLiveSettings(
            strategy_profile=CONSOLE_PROFILE_ID,
            auto_live_enabled=True,
            dry_run=True,
        ),
        state=BullpenAutoLiveState(running=True),
        run=_run_snapshot(),
        positions=[],
        historical_decisions=[],
    )

    llm_stage = next(
        stage
        for stage in result.run.stage_results
        if stage.outputs.get("workflow_stage_key") == "llm"
    )
    reviewed_position = llm_stage.outputs["llm_reviewed_candidates"][0]

    assert llm_market_descriptions == [active_market.description]
    assert reviewed_position["source_kind"] == "active_position"
    assert reviewed_position["slug"] == active_market.slug
    assert reviewed_position["fair_yes_probability_pct"] == 22
    assert reviewed_position["fair_no_probability_pct"] == 78
    assert reviewed_position["yes_definition"] == "Norway wins on June 26, 2026"


def test_auto_live_normalization_maps_raw_labels_to_strict_buckets():
    assert normalize_auto_live_evidence_status("conflicting_evidence") == "Moderate"
    assert normalize_auto_live_evidence_status("official") == "Strong"
    assert normalize_auto_live_evidence_status(None) == "Low"
    assert normalize_auto_live_confidence("very_high") == "High"
    assert normalize_auto_live_confidence("moderate") == "Medium"
    assert normalize_auto_live_confidence(None) == "Low"


def test_auto_live_status_normalization_maps_legacy_values():
    assert normalize_auto_live_status("idle") == "stopped"
    assert normalize_auto_live_status("not_configured") == "not-configured"
    assert normalize_auto_live_status("not configured") == "not-configured"
    assert normalize_auto_live_status("") == "not-configured"
    assert normalize_auto_live_status("unknown") == "error"


def test_record_to_state_normalizes_legacy_statuses():
    record = PolymarketAutoLiveStateRecord(
        user_id=1,
        running=False,
        paused=False,
        status="idle",
        mode="dry-run",
        payload={"status": "idle"},
    )

    state = record_to_state(record)

    assert state.status == "stopped"


def test_apply_state_to_record_normalizes_legacy_status_assignments():
    record = PolymarketAutoLiveStateRecord(
        user_id=1,
        running=False,
        paused=False,
        status="not-configured",
        mode="dry-run",
        payload={},
    )
    state = BullpenAutoLiveState()
    state.status = "idle"

    apply_state_to_record(record, state)

    assert record.status == "stopped"
    assert record.payload["status"] == "stopped"


def test_record_to_decision_drops_malformed_legacy_order_plan():
    executed_at = "2026-06-25T06:00:00+00:00"
    executed_at_dt = datetime.fromisoformat(executed_at)
    record = PolymarketAutoLiveDecisionRecord(
        id="decision-legacy-order-plan",
        user_id=1,
        run_id="run-legacy-order-plan",
        market_id="market-legacy-order-plan",
        slug="legacy-order-plan",
        market_title="Will Erika Sema win?",
        side="NO",
        decision="BUY_NEW",
        risk_status="Ready",
        edge_pp=14.5,
        score=9.2,
        created_at=executed_at_dt,
        updated_at=executed_at_dt,
        payload={
            "created_at": executed_at,
            "updated_at": executed_at,
            "market_url": "https://example.com/markets/legacy-order-plan",
            "close_time": "2026-06-30T00:00:00+00:00",
            "theme": "Politics",
            "price_cents": 42.0,
            "current_yes_odds": 58.0,
            "current_no_odds": 42.0,
            "fair_probability_pct": 61.0,
            "fair_yes_probability_pct": 39.0,
            "fair_no_probability_pct": 61.0,
            "confidence": "High",
            "evidence_status": "Strong",
            "adjudication_required": False,
            "current_exposure_usd": 0.0,
            "target_exposure_usd": 5.0,
            "key_evidence": ["Legacy payload regression coverage."],
            "red_flags": [],
            "reason": "Legacy order-plan payload should not break hydration.",
            "summary": "Legacy order-plan payload should not break hydration.",
            "llm_outputs": [],
            "stage_results": [],
            "guardrail_checks": [],
            "order_plan": {
                "id": "order-legacy-order-plan",
                "action": "buy",
                "side": "ERIKA SEMA",
                "order_type": "limit",
                "status": "planned",
                "market_id": "market-legacy-order-plan",
                "market_title": "Will Erika Sema win?",
                "order_size_usd": 5.0,
                "shares": 11.9,
                "limit_price_cents": 42.0,
                "refreshed_market_price_cents": 42.0,
                "max_slippage_cents": 2.0,
                "dry_run": True,
                "detail": "Legacy malformed payload.",
                "execution_response": None,
                "created_at": executed_at,
                "executed_at": None,
            },
        },
    )

    decision = record_to_decision(record)

    assert decision.id == "decision-legacy-order-plan"
    assert decision.side == "NO"
    assert decision.order_plan is None


@pytest.mark.anyio
async def test_console_wallet_positions_parse_top_level_positions_payload(monkeypatch):
    async def fake_run_first_bullpen_json(*_args, **_kwargs):
        return {
            "positions": [
                {
                    "slug": "candidate-x-win",
                    "market": "Will candidate X win?",
                    "outcome": "No",
                    "shares": 12,
                    "avg_price": 0.42,
                    "current_price": 0.39,
                    "invested_usd": 5.04,
                    "end_date": "2026-06-30T23:59:00+00:00",
                }
            ]
        }

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.console_profile.run_first_bullpen_json",
        fake_run_first_bullpen_json,
    )

    positions = await read_console_wallet_positions()

    assert len(positions) == 1
    assert positions[0].market_id == "candidate-x-win"
    assert positions[0].shares == 12
    assert positions[0].side == "NO"
    assert positions[0].current_no_odds == 39


@pytest.mark.anyio
async def test_console_wallet_positions_aggregate_duplicate_lots(monkeypatch):
    async def fake_run_first_bullpen_json(*_args, **_kwargs):
        return {
            "positions": [
                {
                    "condition_id": "0xabc",
                    "market": "Will candidate X win?",
                    "outcome": "No",
                    "shares": 5,
                    "avg_price": 0.4,
                    "current_price": 0.39,
                    "invested_usd": 2.0,
                    "end_date": "2026-06-30T23:59:00+00:00",
                },
                {
                    "slug": "candidate-x-win",
                    "condition_id": "0xabc",
                    "market": "Will candidate X win?",
                    "outcome": "No",
                    "shares": 7,
                    "avg_price": 0.5,
                    "current_price": 0.39,
                    "invested_usd": 3.5,
                    "end_date": "2026-06-30T23:59:00+00:00",
                },
            ]
        }

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.console_profile.run_first_bullpen_json",
        fake_run_first_bullpen_json,
    )

    positions = await read_console_wallet_positions()

    assert len(positions) == 1
    assert positions[0].slug == "candidate-x-win"
    assert positions[0].condition_id == "0xabc"
    assert positions[0].shares == 12
    assert positions[0].exposure_usd == 5.5
    assert positions[0].average_price_cents == 45.8333
    assert positions[0].current_no_odds == 39


def test_market_rules_extract_resolution_criteria_and_deadline():
    market = _market(
        description=(
            'This market will resolve to "Yes" if candidate X wins the election '
            "by November 6, 2026, 11:59 PM ET. Otherwise, it resolves to No."
        ),
        close_time="2026-11-07T05:00:00+00:00",
    )

    result = evaluate_market_rules(
        market,
        now=datetime(2026, 11, 1, 12, 0, tzinfo=UTC),
    )

    assert result.fail_reason is None
    assert result.outcome_clear is True
    assert result.ambiguous is False
    assert result.expired is False
    assert result.yes_definition == "candidate X wins the election by November 6, 2026, 11:59 PM ET"
    assert result.deadline_et == "2026-11-06 11:59:00 PM ET"
    assert result.hours_remaining is not None
    assert result.hours_remaining > 0


def test_market_rules_fail_without_resolution_criteria():
    result = evaluate_market_rules(
        _market(description=None),
        now=datetime(2026, 6, 21, 12, 0, tzinfo=UTC),
    )

    assert result.outcome_clear is False
    assert result.ambiguous is True
    assert result.fail_reason == "Resolution criteria are unavailable."


def test_candidate_filter_reasons_block_sports_and_low_liquidity():
    market = _market(
        question="Will the Lakers win the NBA Finals?",
        theme="Sports",
        liquidity_usd=250,
    )

    reasons = _evaluate_filter_reasons(market, min_liquidity_usd=1_000)

    assert "Excluded sports market." in reasons
    assert any("Excluded low-liquidity market" in reason for reason in reasons)


def test_candidate_filter_reasons_block_wimbledon_tennis_markets():
    market = _market(
        question="Will Aryna Sabalenka be the 2026 Women's Wimbledon Winner?",
        theme="WTA",
    )

    reasons = _evaluate_filter_reasons(market, min_liquidity_usd=0)

    assert "Excluded sports market." in reasons


def test_candidate_filter_reasons_block_trump_insult_markets():
    market = _market(
        question="Will Donald Trump publicly insult someone on June 27, 2026?",
        theme="Trump",
    )

    reasons = _evaluate_filter_reasons(market, min_liquidity_usd=0)

    assert "Excluded insult or name-calling market." in reasons


def test_candidate_filter_reasons_block_unclear_social_count_market():
    market = _market(
        question="How many tweets will candidate X post this week?",
        slug="candidate-x-10-tweets",
        outcome_labels=["0-10", "11-20", "21+"],
        current_yes_odds=None,
        current_no_odds=None,
    )

    reasons = _evaluate_filter_reasons(market, min_liquidity_usd=0)

    assert "Excluded tweet-count or social-post-count market." in reasons
    assert "Excluded unclear non-binary market." in reasons


@pytest.mark.anyio
async def test_trading_bots_summary_returns_four_cards_in_order(monkeypatch):
    async def fake_bullpen_state():
        return _fake_polymarket_state()

    async def fake_direct_state():
        return _fake_polymarket_state(
            running=False,
            mode="mock",
            doctor_ok=False,
            doctor_message="Direct execution not configured",
            tracked_accounts=[],
            next_poll_at=None,
        )

    auto_live_summary = BullpenAutoLiveSummary(
        state=BullpenAutoLiveState(
            running=True,
            status="running",
            mode="dry-run",
            last_run_at="2026-06-21T10:00:00+00:00",
            next_run_at="2026-06-21T10:01:00+00:00",
            last_action="Dry-run cycle completed safely.",
        ),
        settings=BullpenAutoLiveSettings(auto_live_enabled=True),
        bot_card=BullpenAutoLiveBotCardSummary(
            status="running",
            mode="dry-run",
            invested_usd=0,
            current_value_usd=0,
            pnl_usd=0,
            return_pct=None,
            active_positions=0,
            trades_today=0,
            last_run_at="2026-06-21T10:00:00+00:00",
            next_run_at="2026-06-21T10:01:00+00:00",
            guardrails_summary="Max single trade: 2.00% | Cash reserve: 40.00%",
            strategy_summary="Auto-Live strategy",
            risk_summary="Auto-Live risk",
        ),
    )

    class FakeBot:
        def __init__(self, state):
            self._state = state

        async def get_state(self):
            return await self._state()

    class FakeSummaryBot:
        async def get_summary(self):
            return auto_live_summary

    async def fake_get_bullpen_bot(user_id: int):
        return FakeBot(fake_bullpen_state)

    async def fake_get_direct_bot(user_id: int):
        return FakeBot(fake_direct_state)

    async def fake_get_auto_live_bot(user_id: int):
        return FakeSummaryBot()

    monkeypatch.setattr(
        "app.domains.trading_bots.service.polymarket_bot_manager.get_bot",
        fake_get_bullpen_bot,
    )
    monkeypatch.setattr(
        "app.domains.trading_bots.service.polymarket_direct_bot_manager.get_bot",
        fake_get_direct_bot,
    )
    monkeypatch.setattr(
        "app.domains.trading_bots.service.polymarket_auto_live_bot_manager.get_bot",
        fake_get_auto_live_bot,
    )

    summary = await build_trading_bots_summary(user_id=7)
    overview = await build_trading_bots_overview(user_id=7)

    assert [card.id for card in summary.cards] == [
        "bullpen-x-polymarket",
        "polymarket-direct",
        "bullpen-x-ai",
        "bullpen-ai-auto-live",
    ]
    assert summary.cards[0].name == "Bullpen x Polymarket"
    assert summary.cards[1].status == "not-configured"
    assert summary.cards[2].source == "placeholder"
    assert summary.cards[3].route == "/console/trading-bots/bullpen-ai-auto-live"

    assert len(overview.bots) == 4
    assert overview.bots[0].href == "/console/polymarket-bot"
    assert overview.bots[3].next_scheduled_run == "2026-06-21T10:01:00+00:00"


def _market(
    *,
    question: str = "Will candidate X win?",
    description: str | None = (
        'This market will resolve to "Yes" if candidate X wins. Otherwise, it resolves to No.'
    ),
    close_time: str | None = "2026-06-30T23:59:00+00:00",
    theme: str = "Politics",
    liquidity_usd: float | None = 5_000,
    slug: str | None = "candidate-x-win",
    outcome_labels: list[str] | None = None,
    current_yes_odds: float | None = 54,
    current_no_odds: float | None = 46,
) -> ScannedMarket:
    return ScannedMarket(
        market_id=slug or "market-1",
        question=question,
        market_url="https://polymarket.com/event/test-market",
        slug=slug,
        close_time=close_time,
        theme=theme,
        current_yes_odds=current_yes_odds,
        current_no_odds=current_no_odds,
        volume_usd=10_000,
        liquidity_usd=liquidity_usd,
        description=description,
        outcome_labels=outcome_labels or ["Yes", "No"],
        event_slug="test-market",
        best_bid_cents=53,
        best_ask_cents=55,
        spread_cents=2,
        raw={},
    )


def _console_wallet_position(
    *,
    slug: str,
    market_title: str,
    current_price_cents: float,
    shares: float = 10,
    average_price_cents: float = 45,
    exposure_usd: float = 4.5,
    close_time: str = "2026-06-25T00:00:00+00:00",
    side: str = "NO",
) -> ConsoleWalletPosition:
    return ConsoleWalletPosition(
        market_id=slug,
        slug=slug,
        condition_id=None,
        market_title=market_title,
        market_url=f"https://polymarket.com/event/{slug}",
        side=side,
        shares=shares,
        average_price_cents=average_price_cents,
        exposure_usd=exposure_usd,
        current_price_cents=current_price_cents,
        current_yes_odds=round(100 - current_price_cents, 2),
        current_no_odds=round(current_price_cents, 2),
        close_time=close_time,
        theme="Politics",
        is_claimable=False,
    )


def _manual_console_candidate_row(
    *,
    market_id: str,
    question_id: str,
    market_title: str,
    slug: str,
    current_yes_odds: float,
    current_no_odds: float,
    llm_yes_odds: float,
    llm_no_odds: float,
    returns_per_day: float,
    selected: bool,
    confidence: str = "High",
    evidence_status: str = "Strong",
) -> BullpenAutoLiveConsoleCandidateInput:
    return BullpenAutoLiveConsoleCandidateInput(
        question_id=question_id,
        market_id=market_id,
        market_title=market_title,
        slug=slug,
        market_url=f"https://polymarket.com/event/{slug}",
        close_time="2026-06-25T00:00:00+00:00",
        theme="Politics",
        current_yes_odds=current_yes_odds,
        current_no_odds=current_no_odds,
        llm_yes_odds=llm_yes_odds,
        llm_no_odds=llm_no_odds,
        returns_per_day=returns_per_day,
        amount_to_be_invested=5,
        llm_disagreement_level="Low",
        llm_disagreement_category="CONSENSUS",
        adjudication_required=False,
        confidence=confidence,
        evidence_status=evidence_status,
        event_state="scheduled_not_occurred",
        rules='This market will resolve to "Yes" if candidate X wins. Otherwise, it resolves to "No".',
        selected=selected,
        llm_outputs=[
            BullpenAutoLiveLlmOutput(
                provider="openai",
                model="gpt-4o-mini",
                llm_yes_odds=llm_yes_odds,
                llm_no_odds=llm_no_odds,
                confidence=confidence,
                evidence_status=evidence_status,
                event_state="scheduled_not_occurred",
                key_evidence=["Momentum remains against the Yes case."],
                red_flags=[],
                rationale="Manual Bullpen x AI table row",
                completed_at="2026-06-21T11:58:00+00:00",
            )
        ],
    )


def _fake_polymarket_state(
    *,
    running: bool = True,
    mode: str = "live-read",
    doctor_ok: bool = True,
    doctor_message: str = "ok",
    tracked_accounts: list | None = None,
    next_poll_at: str | None = "2026-06-21T10:05:00+00:00",
):
    return SimpleNamespace(
        running=running,
        paused=False,
        mode=mode,
        session_started_at="2026-06-21T09:00:00+00:00",
        started_at="2026-06-21T09:00:00+00:00",
        last_poll_at="2026-06-21T10:00:00+00:00",
        next_poll_at=next_poll_at,
        last_error=None,
        tracked_accounts=tracked_accounts or [SimpleNamespace(id="acct-1")],
        open_positions=[
            SimpleNamespace(cost_basis=10.0, shares=5),
            SimpleNamespace(cost_basis=0.0, shares=0),
        ],
        trade_history=[],
        metrics=SimpleNamespace(total_pnl=2.5),
        config=SimpleNamespace(
            fixed_copy_trade_size=1.0,
            max_live_exposure_per_market=5.0,
            max_live_daily_loss=10.0,
            max_live_trades_per_day=25,
            require_manual_confirmation=False,
        ),
        live=SimpleNamespace(
            balance=SimpleNamespace(
                account_value_usd=12.5,
                message="ready",
            ),
            source_status=SimpleNamespace(last_live_read_error=None),
            doctor=SimpleNamespace(ok=doctor_ok, message=doctor_message),
            max_live_trade_size=1.0,
            pending_confirmations=[],
            emergency_stopped=False,
            live_trades_today=1,
            recent_decisions=[],
        ),
    )


def _fake_evidence_packet():
    return SimpleNamespace(
        built_at="2026-06-21T10:00:00+00:00",
        queries=["candidate x"],
        warnings=[],
        results=[],
    )


def _fake_llm_consensus(
    *,
    fair_yes: float = 72,
    fair_no: float = 28,
    average_yes: float | None = None,
    median_yes: float | None = None,
    trimmed_mean_yes: float | None = None,
    iqr_yes: float | None = None,
    trimmed_range_yes: float | None = None,
    min_yes: float | None = None,
    max_yes: float | None = None,
    spread_yes: float = 0,
    disagreement_level: str = "Low",
    disagreement_category: str = "CONSENSUS",
    adjudication_required: bool = False,
    consensus_method: str = "trimmedMean",
    rationale_mismatch_count: int = 0,
    confidence: str = "High",
    evidence_status: str = "Strong",
    event_state: str = "scheduled_not_occurred",
    provider_error_rate: float = 0,
):
    outputs = [
        BullpenAutoLiveLlmOutput(
            provider="openai",
            model="gpt-4o-mini",
            llm_yes_odds=fair_yes,
            llm_no_odds=fair_no,
            confidence=confidence,
            evidence_status=evidence_status,
            event_state=event_state,
            key_evidence=["Confirmed evidence"],
            red_flags=[],
            rationale="Strong enough to test Auto-Live execution wiring.",
            completed_at="2026-06-21T10:00:00+00:00",
        )
    ]
    consensus = SimpleNamespace(
        fair_yes_probability_pct=fair_yes,
        fair_no_probability_pct=fair_no,
        average_yes=fair_yes if average_yes is None else average_yes,
        median_yes=fair_yes if median_yes is None else median_yes,
        trimmed_mean_yes=fair_yes if trimmed_mean_yes is None else trimmed_mean_yes,
        iqr_yes=0 if iqr_yes is None else iqr_yes,
        trimmed_range_yes=0 if trimmed_range_yes is None else trimmed_range_yes,
        min_yes=fair_yes if min_yes is None else min_yes,
        max_yes=fair_yes if max_yes is None else max_yes,
        spread_yes=spread_yes,
        disagreement_level=disagreement_level,
        disagreement_category=disagreement_category,
        adjudication_required=adjudication_required,
        consensus_method=consensus_method,
        rationale_mismatch_count=rationale_mismatch_count,
        confidence=confidence,
        evidence_status=evidence_status,
        event_state=event_state,
        provider_error_rate=provider_error_rate,
    )
    return outputs, consensus


def _fake_rules(
    *,
    hours_remaining: float = 72,
    fail_reason: str | None = None,
    deadline_et: str = "2026-06-24 08:00:00 PM ET",
) -> RuleEvaluation:
    return RuleEvaluation(
        yes_definition=None if fail_reason else "candidate X wins by the deadline",
        resolution_criteria=(
            None
            if fail_reason
            else 'This market will resolve to "Yes" if candidate X wins by the deadline.'
        ),
        deadline_et=deadline_et,
        hours_remaining=hours_remaining,
        outcome_clear=fail_reason is None,
        expired=False,
        ambiguous=fail_reason is not None,
        fail_reason=fail_reason,
    )


def _fake_live_controls(
    *,
    unlocked: bool = True,
    unlock_mode: str = "manual",
    locked_reason: str | None = None,
    emergency_stopped: bool = False,
    doctor_ok: bool = True,
    doctor_message: str = "Bullpen doctor passed",
    balance_status: str = "ready",
    balance_message: str = "Balance ready",
):
    return SimpleNamespace(
        unlocked=unlocked,
        unlock_mode=unlock_mode,
        locked_reason=locked_reason,
        emergency_stopped=emergency_stopped,
        doctor=SimpleNamespace(ok=doctor_ok, message=doctor_message),
        balance=SimpleNamespace(status=balance_status, message=balance_message),
    )


def _historical_decision(
    *,
    decision_id: str,
    realized_pnl_usd: float | None,
    executed_at: str,
    order_status: str = "submitted",
) -> BullpenAutoLiveDecision:
    order_plan = BullpenAutoLiveOrderPlan.model_construct(
        id=f"{decision_id}-order",
        action="buy",
        side="YES",
        order_type="limit",
        status=order_status,
        market_id="historical-market",
        market_title="Historical market",
        order_size_usd=5.0,
        shares=10.0,
        limit_price_cents=50.0,
        refreshed_market_price_cents=50.0,
        max_slippage_cents=2.0,
        dry_run=False,
        detail="Historical order",
        execution_response="ok",
        created_at=executed_at,
        executed_at=executed_at,
    )
    return BullpenAutoLiveDecision.model_construct(
        id=decision_id,
        run_id="historical-run",
        created_at=executed_at,
        updated_at=executed_at,
        market_id="historical-market",
        market_title="Historical market",
        market_url="https://example.com/historical",
        slug="historical-market",
        close_time="2026-06-30T00:00:00+00:00",
        theme="Politics",
        side="YES",
        decision="BUY_NEW",
        risk_status="Ready",
        price_cents=50.0,
        current_yes_odds=50.0,
        current_no_odds=50.0,
        fair_probability_pct=60.0,
        fair_yes_probability_pct=60.0,
        fair_no_probability_pct=40.0,
        edge_pp=10.0,
        score=10.0,
        confidence="High",
        evidence_status="Strong",
        event_state="scheduled_not_occurred",
        adjudication_required=False,
        disagreement_level="Low",
        current_exposure_usd=0.0,
        target_exposure_usd=0.0,
        realized_pnl_usd=realized_pnl_usd,
        hours_remaining=24.0,
        key_evidence=[],
        red_flags=[],
        rationale="Historical order",
        reason="Historical order",
        summary="Historical order",
        order_plan=order_plan,
        llm_outputs=[],
        stage_results=[],
        guardrail_checks=[],
    )


@pytest.mark.anyio
async def test_console_profile_buys_fixed_five_dollar_top10_and_exits_lower_ranked_positions(
    monkeypatch,
):
    fixed_now = datetime(2026, 6, 21, 0, 0, tzinfo=UTC)
    active_high_slug = "active-high"
    active_low_slug = "active-low"
    active_high_market = _market(
        question="Will the high-ranked active position resolve No?",
        slug=active_high_slug,
        close_time="2026-06-25T00:00:00+00:00",
        current_yes_odds=65,
        current_no_odds=35,
    )
    active_low_market = _market(
        question="Will the lower-ranked active position resolve No?",
        slug=active_low_slug,
        close_time="2026-06-25T00:00:00+00:00",
        current_yes_odds=21,
        current_no_odds=79,
    )
    live_positions = [
        _console_wallet_position(
            slug=active_high_slug,
            market_title=active_high_market.question,
            current_price_cents=35,
        ),
        _console_wallet_position(
            slug=active_low_slug,
            market_title=active_low_market.question,
            current_price_cents=79,
        ),
    ]
    candidate_markets = [
        _market(
            question=f"Candidate market {index + 1}",
            slug=f"candidate-market-{index + 1}",
            close_time="2026-06-25T00:00:00+00:00",
            current_yes_odds=60 - (index * 4),
            current_no_odds=40 + (index * 4),
        )
        for index in range(10)
    ]
    market_lookup = {
        market.slug: market
        for market in [active_high_market, active_low_market, *candidate_markets]
        if market.slug
    }

    async def fake_read_console_wallet_positions():
        return live_positions

    async def fake_scan_console_profile_markets(**kwargs):
        return SimpleNamespace(
            source_label="test",
            source_url="https://example.com",
            accepted=[active_high_market, active_low_market, *candidate_markets],
            rejected=[],
            total_candidates=12,
        )

    async def fake_refresh_execution_quote(*, slug: str | None, side: str):
        market = market_lookup[slug]
        return SimpleNamespace(
            market=market,
            current_price_cents=(
                market.current_yes_odds if side == "YES" else market.current_no_odds
            ),
            spread_cents=2,
        )

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.utc_now",
        lambda: fixed_now,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.utc_now_iso",
        lambda: fixed_now.isoformat(),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.read_console_wallet_positions",
        fake_read_console_wallet_positions,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.scan_console_profile_markets",
        fake_scan_console_profile_markets,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.evaluate_market_rules",
        lambda *_args, **_kwargs: _fake_rules(hours_remaining=96),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.build_evidence_packet",
        lambda *args, **kwargs: _fake_evidence_packet(),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.run_llm_consensus",
        lambda *args, **kwargs: _fake_llm_consensus(fair_yes=10, fair_no=90),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_execution_quote",
        fake_refresh_execution_quote,
    )

    result = await BullpenAutoLiveEngine().execute(
        user_id=7,
        settings=BullpenAutoLiveSettings(
            strategy_profile=CONSOLE_PROFILE_ID,
            auto_live_enabled=True,
            dry_run=True,
        ),
        state=BullpenAutoLiveState(running=True),
        run=_run_snapshot(),
        positions=[],
        historical_decisions=[],
    )

    buy_decisions = [decision for decision in result.decisions if decision.decision == "BUY_NEW"]
    exit_decisions = [decision for decision in result.decisions if decision.decision == "EXIT"]
    hold_decisions = [decision for decision in result.decisions if decision.decision == "HOLD"]
    skip_decisions = [decision for decision in result.decisions if decision.decision == "SKIP"]

    assert len(buy_decisions) == 9
    assert len(exit_decisions) == 1
    assert len(hold_decisions) == 1
    assert len(skip_decisions) == 1
    assert exit_decisions[0].market_id == active_low_slug
    assert hold_decisions[0].market_id == active_high_slug
    assert skip_decisions[0].reason == "Candidate qualified but did not make the top-10 returns/day table."
    assert all(decision.order_plan is not None for decision in buy_decisions)
    assert all(decision.order_plan.order_size_usd == 5 for decision in buy_decisions)
    assert all(decision.order_plan.side == "NO" for decision in buy_decisions)
    assert all(decision.order_plan.status == "skipped" for decision in buy_decisions)
    assert result.run.summary.startswith("Console schedule simulated")
    assert result.run.orders_planned == 10
    assert result.state.next_run_at == "2026-06-21T00:30:00+00:00"


@pytest.mark.anyio
async def test_console_profile_manual_row_with_conflicting_evidence_normalizes_and_plans_buy_new(
    monkeypatch,
):
    fixed_now = datetime(2026, 6, 21, 12, 0, tzinfo=UTC)
    manual_row = _manual_console_candidate_row(
        market_id="candidate-market-1",
        question_id="candidate-market-1",
        market_title="Candidate market 1",
        slug="candidate-market-1",
        current_yes_odds=18,
        current_no_odds=82,
        llm_yes_odds=8,
        llm_no_odds=92,
        returns_per_day=9.5,
        selected=True,
        confidence="very_high",
        evidence_status="conflicting_evidence",
    )
    market_lookup = {
        manual_row.slug: _market(
            question=manual_row.market_title,
            slug=manual_row.slug,
            close_time=manual_row.close_time,
            current_yes_odds=manual_row.current_yes_odds,
            current_no_odds=manual_row.current_no_odds,
        )
    }

    async def fake_read_console_wallet_positions():
        return []

    async def fake_refresh_execution_quote(*, slug: str | None, side: str):
        market = market_lookup[slug]
        return SimpleNamespace(
            market=market,
            current_price_cents=(
                market.current_yes_odds if side == "YES" else market.current_no_odds
            ),
            spread_cents=2,
        )

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.utc_now",
        lambda: fixed_now,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.utc_now_iso",
        lambda: fixed_now.isoformat(),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.read_console_wallet_positions",
        fake_read_console_wallet_positions,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_execution_quote",
        fake_refresh_execution_quote,
    )

    result = await BullpenAutoLiveEngine().execute(
        user_id=7,
        settings=BullpenAutoLiveSettings(
            strategy_profile=CONSOLE_PROFILE_ID,
            auto_live_enabled=True,
            dry_run=True,
        ),
        state=BullpenAutoLiveState(running=True),
        run=_run_snapshot(
            request_context=BullpenAutoLiveRunOnceRequest(
                console_profile=BullpenAutoLiveConsoleRunContext(
                    source_label="Bullpen CLI",
                    source_url="https://app.bullpen.fi/predictions/trending?ref=intrepid-crane-3",
                    scanned_at=fixed_now.isoformat(),
                    total_candidates=1,
                    candidate_rows=[manual_row],
                )
            )
        ),
        positions=[],
        historical_decisions=[],
    )

    buy_decisions = [decision for decision in result.decisions if decision.decision == "BUY_NEW"]

    assert len(buy_decisions) == 1
    assert buy_decisions[0].evidence_status == "Moderate"
    assert buy_decisions[0].confidence == "High"
    assert buy_decisions[0].order_plan is not None
    assert buy_decisions[0].order_plan.order_size_usd == 5
    assert buy_decisions[0].order_plan.status == "skipped"
    assert buy_decisions[0].stage_results[2].outputs["evidence_status"] == "Moderate"
    assert result.run.orders_planned == 1
    assert result.run.decisions_count == 1


@pytest.mark.anyio
async def test_console_profile_manual_table_rows_create_two_fixed_buy_new_decisions(
    monkeypatch,
):
    fixed_now = datetime(2026, 6, 21, 12, 0, tzinfo=UTC)
    manual_rows = [
        _manual_console_candidate_row(
            market_id="candidate-market-1",
            question_id="candidate-market-1",
            market_title="Candidate market 1",
            slug="candidate-market-1",
            current_yes_odds=18,
            current_no_odds=82,
            llm_yes_odds=8,
            llm_no_odds=92,
            returns_per_day=9.5,
            selected=True,
        ),
        _manual_console_candidate_row(
            market_id="candidate-market-2",
            question_id="candidate-market-2",
            market_title="Candidate market 2",
            slug="candidate-market-2",
            current_yes_odds=22,
            current_no_odds=78,
            llm_yes_odds=91,
            llm_no_odds=9,
            returns_per_day=7.2,
            selected=True,
            evidence_status="conflicting_evidence",
        ),
    ]
    market_lookup = {
        row.slug: _market(
            question=row.market_title,
            slug=row.slug,
            close_time=row.close_time,
            current_yes_odds=row.current_yes_odds,
            current_no_odds=row.current_no_odds,
        )
        for row in manual_rows
        if row.slug
    }

    async def fake_read_console_wallet_positions():
        return []

    async def fake_refresh_execution_quote(*, slug: str | None, side: str):
        market = market_lookup[slug]
        return SimpleNamespace(
            market=market,
            current_price_cents=(
                market.current_yes_odds if side == "YES" else market.current_no_odds
            ),
            spread_cents=2,
        )

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.utc_now",
        lambda: fixed_now,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.utc_now_iso",
        lambda: fixed_now.isoformat(),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.read_console_wallet_positions",
        fake_read_console_wallet_positions,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_execution_quote",
        fake_refresh_execution_quote,
    )

    result = await BullpenAutoLiveEngine().execute(
        user_id=7,
        settings=BullpenAutoLiveSettings(
            strategy_profile=CONSOLE_PROFILE_ID,
            auto_live_enabled=True,
            dry_run=True,
        ),
        state=BullpenAutoLiveState(running=True),
        run=_run_snapshot(
            request_context=BullpenAutoLiveRunOnceRequest(
                console_profile=BullpenAutoLiveConsoleRunContext(
                    source_label="Bullpen CLI",
                    source_url="https://app.bullpen.fi/predictions/trending?ref=intrepid-crane-3",
                    scanned_at=fixed_now.isoformat(),
                    total_candidates=2,
                    candidate_rows=manual_rows,
                )
            )
        ),
        positions=[],
        historical_decisions=[],
    )

    buy_decisions = [decision for decision in result.decisions if decision.decision == "BUY_NEW"]

    assert len(buy_decisions) == 2
    assert all(decision.order_plan is not None for decision in buy_decisions)
    assert all(decision.order_plan.order_size_usd == 5 for decision in buy_decisions)
    assert sorted(decision.order_plan.side for decision in buy_decisions) == [
        "NO",
        "YES",
    ]
    assert sorted(decision.evidence_status for decision in buy_decisions) == [
        "Moderate",
        "Strong",
    ]
    assert result.run.decisions_count == 2
    assert result.run.diagnostics.qualified_candidate_rows == 2
    assert sorted(result.run.diagnostics.top_candidate_market_ids) == [
        "candidate-market-1",
        "candidate-market-2",
    ]


@pytest.mark.anyio
async def test_console_profile_manual_rows_skip_unsupported_wallet_position_sides(
    monkeypatch,
):
    fixed_now = datetime(2026, 6, 21, 12, 0, tzinfo=UTC)
    manual_row = _manual_console_candidate_row(
        market_id="candidate-market-1",
        question_id="candidate-market-1",
        market_title="Candidate market 1",
        slug="candidate-market-1",
        current_yes_odds=18,
        current_no_odds=82,
        llm_yes_odds=8,
        llm_no_odds=92,
        returns_per_day=9.5,
        selected=True,
    )
    market_lookup = {
        manual_row.slug: _market(
            question=manual_row.market_title,
            slug=manual_row.slug,
            close_time=manual_row.close_time,
            current_yes_odds=manual_row.current_yes_odds,
            current_no_odds=manual_row.current_no_odds,
        )
    }

    async def fake_read_console_wallet_positions():
        return [
            _console_wallet_position(
                slug="will-erika-sema-win",
                market_title="Will Erika Sema win?",
                current_price_cents=54,
                side="ERIKA SEMA",
            )
        ]

    async def fake_refresh_execution_quote(*, slug: str | None, side: str):
        market = market_lookup[slug]
        return SimpleNamespace(
            market=market,
            current_price_cents=(
                market.current_yes_odds if side == "YES" else market.current_no_odds
            ),
            spread_cents=2,
        )

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.utc_now",
        lambda: fixed_now,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.utc_now_iso",
        lambda: fixed_now.isoformat(),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.read_console_wallet_positions",
        fake_read_console_wallet_positions,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_execution_quote",
        fake_refresh_execution_quote,
    )

    result = await BullpenAutoLiveEngine().execute(
        user_id=7,
        settings=BullpenAutoLiveSettings(
            strategy_profile=CONSOLE_PROFILE_ID,
            auto_live_enabled=True,
            dry_run=True,
        ),
        state=BullpenAutoLiveState(running=True),
        run=_run_snapshot(
            request_context=BullpenAutoLiveRunOnceRequest(
                console_profile=BullpenAutoLiveConsoleRunContext(
                    source_label="Bullpen CLI",
                    source_url="https://app.bullpen.fi/predictions/trending?ref=intrepid-crane-3",
                    scanned_at=fixed_now.isoformat(),
                    total_candidates=1,
                    candidate_rows=[manual_row],
                )
            )
        ),
        positions=[],
        historical_decisions=[],
    )

    buy_decisions = [decision for decision in result.decisions if decision.decision == "BUY_NEW"]

    assert len(buy_decisions) == 1
    assert buy_decisions[0].market_id == "candidate-market-1"
    assert all(decision.market_id != "will-erika-sema-win" for decision in result.decisions)
    assert result.run.stage_results[0].outputs["unsupported_wallet_positions_skipped"] == 1
    assert result.run.stage_results[0].outputs["workflow_stage_key"] == "scan"
    assert result.run.stage_results[0].outputs["phase_status"] == "completed"


@pytest.mark.anyio
async def test_console_profile_manual_selected_rows_skip_backend_rescan_and_avoid_zero_decisions(
    monkeypatch,
):
    fixed_now = datetime(2026, 6, 21, 12, 0, tzinfo=UTC)
    manual_rows = [
        _manual_console_candidate_row(
            market_id="candidate-market-1",
            question_id="candidate-market-1",
            market_title="Candidate market 1",
            slug="candidate-market-1",
            current_yes_odds=19,
            current_no_odds=81,
            llm_yes_odds=10,
            llm_no_odds=90,
            returns_per_day=8.4,
            selected=True,
        ),
        _manual_console_candidate_row(
            market_id="candidate-market-2",
            question_id="candidate-market-2",
            market_title="Candidate market 2",
            slug="candidate-market-2",
            current_yes_odds=17,
            current_no_odds=83,
            llm_yes_odds=12,
            llm_no_odds=88,
            returns_per_day=6.8,
            selected=True,
        ),
    ]
    market_lookup = {
        row.slug: _market(
            question=row.market_title,
            slug=row.slug,
            close_time=row.close_time,
            current_yes_odds=row.current_yes_odds,
            current_no_odds=row.current_no_odds,
        )
        for row in manual_rows
        if row.slug
    }

    async def fake_read_console_wallet_positions():
        return []

    async def fake_refresh_execution_quote(*, slug: str | None, side: str):
        market = market_lookup[slug]
        return SimpleNamespace(
            market=market,
            current_price_cents=(
                market.current_yes_odds if side == "YES" else market.current_no_odds
            ),
            spread_cents=2,
        )

    async def fail_scan_candidate_markets(**_kwargs):
        raise AssertionError("Manual Bullpen x AI rows should bypass the backend rescan.")

    async def fail_scan_console_profile_markets(**_kwargs):
        raise AssertionError("Manual Bullpen x AI rows should bypass the console profile scan.")

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.utc_now",
        lambda: fixed_now,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.utc_now_iso",
        lambda: fixed_now.isoformat(),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.read_console_wallet_positions",
        fake_read_console_wallet_positions,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_execution_quote",
        fake_refresh_execution_quote,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.scan_candidate_markets",
        fail_scan_candidate_markets,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.scan_console_profile_markets",
        fail_scan_console_profile_markets,
    )

    result = await BullpenAutoLiveEngine().execute(
        user_id=7,
        settings=BullpenAutoLiveSettings(
            strategy_profile=CONSOLE_PROFILE_ID,
            auto_live_enabled=True,
            dry_run=True,
        ),
        state=BullpenAutoLiveState(running=True),
        run=_run_snapshot(
            request_context=BullpenAutoLiveRunOnceRequest(
                console_profile=BullpenAutoLiveConsoleRunContext(
                    source_label="Bullpen CLI",
                    source_url="https://app.bullpen.fi/predictions/trending?ref=intrepid-crane-3",
                    scanned_at=fixed_now.isoformat(),
                    total_candidates=2,
                    candidate_rows=manual_rows,
                )
            )
        ),
        positions=[],
        historical_decisions=[],
    )

    assert result.run.summary.startswith("Console schedule simulated")
    assert result.run.decisions_count == 2
    assert result.run.summary.endswith("planned orders. Dry-run is enabled.")
    assert result.run.diagnostics.used_manual_console_rows is True
    assert result.run.diagnostics.selected_manual_candidate_ids == [
        "candidate-market-1",
        "candidate-market-2",
    ]
    assert len(result.run.stage_results[0].outputs["accepted_candidates"]) == 2
    assert result.run.stage_results[0].outputs["accepted_candidates"][0]["market_id"] == (
        "candidate-market-1"
    )
    assert result.run.stage_results[0].outputs["accepted_candidates"][0]["selected"] is True
    assert result.run.stage_results[0].outputs["rejected_candidates"] == []
    assert result.run.stage_results[0].outputs["accepted_candidates_count"] == 2
    assert result.run.stage_results[0].outputs["rejected_candidates_count"] == 0


@pytest.mark.anyio
async def test_console_profile_manual_selected_rows_rerun_llm_when_reuse_is_disabled(
    monkeypatch,
):
    fixed_now = datetime(2026, 6, 21, 12, 0, tzinfo=UTC)
    manual_rows = [
        _manual_console_candidate_row(
            market_id="candidate-market-1",
            question_id="candidate-market-1",
            market_title="Candidate market 1",
            slug="candidate-market-1",
            current_yes_odds=19,
            current_no_odds=81,
            llm_yes_odds=10,
            llm_no_odds=90,
            returns_per_day=8.4,
            selected=True,
        ),
        _manual_console_candidate_row(
            market_id="candidate-market-2",
            question_id="candidate-market-2",
            market_title="Candidate market 2",
            slug="candidate-market-2",
            current_yes_odds=17,
            current_no_odds=83,
            llm_yes_odds=12,
            llm_no_odds=88,
            returns_per_day=6.8,
            selected=True,
        ),
    ]
    market_lookup = {
        row.slug: _market(
            question=row.market_title,
            slug=row.slug,
            close_time=row.close_time,
            current_yes_odds=row.current_yes_odds,
            current_no_odds=row.current_no_odds,
        )
        for row in manual_rows
        if row.slug
    }
    llm_calls: list[str] = []

    async def fake_read_console_wallet_positions():
        return []

    async def fake_refresh_execution_quote(*, slug: str | None, side: str):
        market = market_lookup[slug]
        return SimpleNamespace(
            market=market,
            current_price_cents=(
                market.current_yes_odds if side == "YES" else market.current_no_odds
            ),
            spread_cents=2,
        )

    async def fail_scan_candidate_markets(**_kwargs):
        raise AssertionError("Manual Bullpen x AI rows should bypass the backend rescan.")

    async def fail_scan_console_profile_markets(**_kwargs):
        raise AssertionError("Manual Bullpen x AI rows should bypass the console profile scan.")

    def fake_run_llm_consensus(market, *_args, **_kwargs):
        llm_calls.append(market.market_id)
        if market.market_id == "candidate-market-1":
            return _fake_llm_consensus(fair_yes=10, fair_no=90)
        return _fake_llm_consensus(fair_yes=12, fair_no=88)

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.utc_now",
        lambda: fixed_now,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.utc_now_iso",
        lambda: fixed_now.isoformat(),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.read_console_wallet_positions",
        fake_read_console_wallet_positions,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_execution_quote",
        fake_refresh_execution_quote,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.scan_candidate_markets",
        fail_scan_candidate_markets,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.scan_console_profile_markets",
        fail_scan_console_profile_markets,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.evaluate_market_rules",
        lambda *_args, **_kwargs: _fake_rules(hours_remaining=60),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.build_evidence_packet",
        lambda *args, **kwargs: _fake_evidence_packet(),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.run_llm_consensus",
        fake_run_llm_consensus,
    )

    result = await BullpenAutoLiveEngine().execute(
        user_id=7,
        settings=BullpenAutoLiveSettings(
            strategy_profile=CONSOLE_PROFILE_ID,
            auto_live_enabled=True,
            dry_run=True,
        ),
        state=BullpenAutoLiveState(running=True),
        run=_run_snapshot(
            request_context=BullpenAutoLiveRunOnceRequest(
                console_profile=BullpenAutoLiveConsoleRunContext(
                    source_label="Bullpen CLI",
                    source_url="https://app.bullpen.fi/predictions/trending?ref=intrepid-crane-3",
                    scanned_at=fixed_now.isoformat(),
                    total_candidates=2,
                    reuse_saved_llm_outputs=False,
                    candidate_rows=manual_rows,
                )
            )
        ),
        positions=[],
        historical_decisions=[],
    )

    assert llm_calls == ["candidate-market-1", "candidate-market-2"]
    assert result.run.decisions_count == 2
    assert result.run.stage_results[1].outputs["workflow_stage_key"] == "llm"
    assert result.run.stage_results[1].outputs["phase_status"] == "completed"
    assert result.run.stage_results[1].outputs["llm_candidate_count"] == 2
    assert not result.run.stage_results[1].outputs.get("reused_existing_llm_outputs")


@pytest.mark.anyio
async def test_console_profile_manual_rows_exclude_trump_insult_markets_before_stage_2(
    monkeypatch,
):
    fixed_now = datetime(2026, 6, 21, 12, 0, tzinfo=UTC)
    manual_rows = [
        _manual_console_candidate_row(
            market_id="trump-insult-market",
            question_id="trump-insult-market",
            market_title="Will Donald Trump publicly insult someone on June 27, 2026?",
            slug="trump-insult-market",
            current_yes_odds=90.5,
            current_no_odds=9.5,
            llm_yes_odds=6,
            llm_no_odds=94,
            returns_per_day=18,
            selected=True,
        ),
        _manual_console_candidate_row(
            market_id="candidate-market-2",
            question_id="candidate-market-2",
            market_title="Will candidate market 2 resolve No?",
            slug="candidate-market-2",
            current_yes_odds=22,
            current_no_odds=78,
            llm_yes_odds=9,
            llm_no_odds=91,
            returns_per_day=7.2,
            selected=True,
        ),
    ]
    market_lookup = {
        row.slug: _market(
            question=row.market_title,
            slug=row.slug,
            close_time=row.close_time,
            current_yes_odds=row.current_yes_odds,
            current_no_odds=row.current_no_odds,
        )
        for row in manual_rows
        if row.slug
    }

    async def fake_read_console_wallet_positions():
        return []

    async def fake_refresh_execution_quote(*, slug: str | None, side: str):
        market = market_lookup[slug]
        return SimpleNamespace(
            market=market,
            current_price_cents=(
                market.current_yes_odds if side == "YES" else market.current_no_odds
            ),
            spread_cents=2,
        )

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.utc_now",
        lambda: fixed_now,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.utc_now_iso",
        lambda: fixed_now.isoformat(),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.read_console_wallet_positions",
        fake_read_console_wallet_positions,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_execution_quote",
        fake_refresh_execution_quote,
    )

    result = await BullpenAutoLiveEngine().execute(
        user_id=7,
        settings=BullpenAutoLiveSettings(
            strategy_profile=CONSOLE_PROFILE_ID,
            auto_live_enabled=True,
            dry_run=True,
        ),
        state=BullpenAutoLiveState(running=True),
        run=_run_snapshot(
            request_context=BullpenAutoLiveRunOnceRequest(
                console_profile=BullpenAutoLiveConsoleRunContext(
                    source_label="Bullpen CLI",
                    source_url="https://app.bullpen.fi/predictions/trending?ref=intrepid-crane-3",
                    scanned_at=fixed_now.isoformat(),
                    total_candidates=2,
                    candidate_rows=manual_rows,
                )
            )
        ),
        positions=[],
        historical_decisions=[],
    )

    assert result.run.decisions_count == 1
    assert result.run.diagnostics.selected_manual_candidate_ids == ["candidate-market-2"]
    assert result.run.stage_results[0].outputs["accepted_candidates_count"] == 1
    assert result.run.stage_results[0].outputs["rejected_candidates_count"] == 1
    assert result.run.stage_results[0].outputs["llm_candidate_count"] == 1
    assert (
        result.run.stage_results[0].outputs["rejected_candidates"][0]["reasons"]
        == ["Excluded insult or name-calling market."]
    )
    assert all(
        "publicly insult" not in decision.market_title.lower()
        for decision in result.decisions
    )


@pytest.mark.anyio
async def test_console_profile_stage_2_still_runs_llm_when_rules_are_incomplete(
    monkeypatch,
):
    fixed_now = datetime(2026, 6, 21, 12, 0, tzinfo=UTC)
    market = _market(
        question="Will unclear-rules market resolve Yes?",
        slug="unclear-rules-market",
        description=None,
        current_yes_odds=34,
        current_no_odds=66,
    )

    async def fake_scan_console_profile_markets(**kwargs):
        return SimpleNamespace(
            source_label="Bullpen CLI",
            source_url="https://app.bullpen.fi/predictions/trending?ref=intrepid-crane-3",
            total_candidates=1,
            accepted=[market],
            rejected=[],
        )

    async def fake_read_console_wallet_positions():
        return []

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.utc_now",
        lambda: fixed_now,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.utc_now_iso",
        lambda: fixed_now.isoformat(),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.scan_console_profile_markets",
        fake_scan_console_profile_markets,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.read_console_wallet_positions",
        fake_read_console_wallet_positions,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.evaluate_market_rules",
        lambda *_args, **_kwargs: _fake_rules(
            fail_reason="Resolution criteria are unavailable."
        ),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.build_evidence_packet",
        lambda *args, **kwargs: _fake_evidence_packet(),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.run_llm_consensus",
        lambda *args, **kwargs: _fake_llm_consensus(fair_yes=82, fair_no=18),
    )

    result = await BullpenAutoLiveEngine().execute(
        user_id=7,
        settings=BullpenAutoLiveSettings(
            strategy_profile=CONSOLE_PROFILE_ID,
            auto_live_enabled=True,
            dry_run=True,
        ),
        state=BullpenAutoLiveState(running=True),
        run=_run_snapshot(),
        positions=[],
        historical_decisions=[],
    )

    reviewed_candidate = result.run.stage_results[1].outputs["llm_reviewed_candidates"][0]
    assert reviewed_candidate["fair_yes_probability_pct"] == 82
    assert reviewed_candidate["fair_no_probability_pct"] == 18
    assert "still blocked because Resolution criteria are unavailable" in reviewed_candidate["reason"]
    assert result.decisions[0].decision == "SKIP"
    assert result.decisions[0].llm_outputs[0].llm_yes_odds == 82
    assert result.decisions[0].stage_results[1].status == "warning"


@pytest.mark.anyio
async def test_console_profile_manual_scan_rows_skip_backend_rescan_and_run_llm_from_snapshot(
    monkeypatch,
):
    fixed_now = datetime(2026, 6, 21, 12, 0, tzinfo=UTC)
    progress_snapshots: list[list[tuple[int, str | None, str | None]]] = []
    manual_rows = [
        BullpenAutoLiveConsoleCandidateInput(
            question_id="candidate-market-1",
            market_id="candidate-market-1",
            market_title="Candidate market 1",
            slug="candidate-market-1",
            market_url="https://polymarket.com/event/candidate-market-1",
            close_time="2026-06-24T00:00:00+00:00",
            theme="Politics",
            current_yes_odds=19,
            current_no_odds=81,
            returns_per_day=7.6,
            rules='This market will resolve to "Yes" if candidate X wins.',
            selected=False,
            llm_outputs=[],
        ),
        BullpenAutoLiveConsoleCandidateInput(
            question_id="candidate-market-2",
            market_id="candidate-market-2",
            market_title="Candidate market 2",
            slug="candidate-market-2",
            market_url="https://polymarket.com/event/candidate-market-2",
            close_time="2026-06-24T00:00:00+00:00",
            theme="Politics",
            current_yes_odds=17,
            current_no_odds=83,
            returns_per_day=6.8,
            rules='This market will resolve to "Yes" if candidate Y wins.',
            selected=False,
            llm_outputs=[],
        ),
    ]
    market_lookup = {
        row.slug: _market(
            question=row.market_title,
            slug=row.slug,
            close_time=row.close_time,
            current_yes_odds=row.current_yes_odds,
            current_no_odds=row.current_no_odds,
        )
        for row in manual_rows
        if row.slug
    }

    async def fake_read_console_wallet_positions():
        return []

    async def fake_refresh_execution_quote(*, slug: str | None, side: str):
        market = market_lookup[slug]
        return SimpleNamespace(
            market=market,
            current_price_cents=(
                market.current_yes_odds if side == "YES" else market.current_no_odds
            ),
            spread_cents=2,
        )

    async def fail_scan_candidate_markets(**_kwargs):
        raise AssertionError("Manual Bullpen x AI scan rows should bypass the backend rescan.")

    async def fail_scan_console_profile_markets(**_kwargs):
        raise AssertionError("Manual Bullpen x AI scan rows should bypass the console profile scan.")

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.utc_now",
        lambda: fixed_now,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.utc_now_iso",
        lambda: fixed_now.isoformat(),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.read_console_wallet_positions",
        fake_read_console_wallet_positions,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.scan_candidate_markets",
        fail_scan_candidate_markets,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.scan_console_profile_markets",
        fail_scan_console_profile_markets,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.evaluate_market_rules",
        lambda *_args, **_kwargs: _fake_rules(hours_remaining=60),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.build_evidence_packet",
        lambda *args, **kwargs: _fake_evidence_packet(),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.run_llm_consensus",
        lambda *args, **kwargs: _fake_llm_consensus(fair_yes=10, fair_no=90),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_execution_quote",
        fake_refresh_execution_quote,
    )

    def record_progress(run: BullpenAutoLiveRun, _state: BullpenAutoLiveState):
        progress_snapshots.append(
            [
                (
                    stage.stage_number,
                    stage.outputs.get("workflow_stage_key")
                    if isinstance(stage.outputs, dict)
                    else None,
                    stage.outputs.get("phase_status")
                    if isinstance(stage.outputs, dict)
                    else None,
                )
                for stage in run.stage_results
            ]
        )

    result = await BullpenAutoLiveEngine().execute(
        user_id=7,
        settings=BullpenAutoLiveSettings(
            strategy_profile=CONSOLE_PROFILE_ID,
            auto_live_enabled=True,
            dry_run=True,
        ),
        state=BullpenAutoLiveState(running=True),
        run=_run_snapshot(
            request_context=BullpenAutoLiveRunOnceRequest(
                console_profile=BullpenAutoLiveConsoleRunContext(
                    source_label="Bullpen CLI",
                    source_url="https://app.bullpen.fi/predictions/trending?ref=intrepid-crane-3",
                    scanned_at=fixed_now.isoformat(),
                    total_candidates=2,
                    candidate_rows=manual_rows,
                )
            )
        ),
        positions=[],
        historical_decisions=[],
        progress_callback=record_progress,
    )

    buy_decisions = [decision for decision in result.decisions if decision.decision == "BUY_NEW"]

    assert len(buy_decisions) == 2
    assert result.run.decisions_count == 2
    assert result.run.diagnostics.used_manual_console_rows is True
    assert result.run.diagnostics.candidate_rows_before_llm == 2
    assert result.run.diagnostics.llm_candidate_count == 2
    assert result.run.stage_results[0].outputs["used_manual_console_rows"] is True
    assert result.run.stage_results[0].outputs["candidate_rows_before_llm"] == 2
    assert result.run.stage_results[0].outputs["phase_status"] == "completed"
    assert len(result.run.stage_results[0].outputs["accepted_candidates"]) == 2
    assert result.run.stage_results[0].outputs["accepted_candidates"][0]["question_id"] == (
        "candidate-market-1"
    )
    assert result.run.stage_results[0].outputs["accepted_candidates"][0]["selected"] is False
    assert result.run.stage_results[0].outputs["rejected_candidates"] == []
    assert result.run.stage_results[0].outputs["accepted_candidates_count"] == 2
    assert result.run.stage_results[0].outputs["rejected_candidates_count"] == 0
    assert result.run.stage_results[1].outputs["workflow_stage_key"] == "llm"
    assert result.run.stage_results[1].outputs["phase_status"] == "completed"
    assert result.run.stage_results[1].outputs["llm_candidate_count"] == 2
    invest_stage = next(
        stage
        for stage in result.run.stage_results
        if stage.outputs.get("workflow_stage_key") == "invest"
    )
    assert invest_stage.outputs["phase_status"] == "completed"
    assert invest_stage.outputs["decisions_count"] == 2
    assert any(
        any(
            stage_number == 2
            and workflow_stage_key == "llm"
            and phase_status == "running"
            for stage_number, workflow_stage_key, phase_status in snapshot
        )
        for snapshot in progress_snapshots
    )
    assert any(
        any(
            stage_number == 3
            and workflow_stage_key == "invest"
            and phase_status == "running"
            for stage_number, workflow_stage_key, phase_status in snapshot
        )
        for snapshot in progress_snapshots
    )


async def _execute_auto_live(
    monkeypatch,
    *,
    market: ScannedMarket | None = None,
    settings: BullpenAutoLiveSettings | None = None,
    rules: RuleEvaluation | None = None,
    llm_consensus: tuple[list[BullpenAutoLiveLlmOutput], object] | None = None,
    live_controls=None,
    positions: list[PositionSnapshot] | None = None,
    historical_decisions: list[BullpenAutoLiveDecision] | None = None,
    refreshed_price_cents: float | None = None,
    refreshed_spread_cents: float | None = 2,
    runtime_settings=None,
    balance_after_order_status: str = "ready",
    allow_execution_env: bool = False,
):
    fixed_now = datetime(2026, 6, 21, 12, 0, tzinfo=UTC)
    market = market or _market()
    settings = settings or BullpenAutoLiveSettings()
    rules = rules or _fake_rules()
    llm_consensus = llm_consensus or _fake_llm_consensus()
    live_controls = live_controls or _fake_live_controls()
    positions = positions or []
    historical_decisions = historical_decisions or []
    executor_calls: list[tuple[str, dict[str, object]]] = []

    async def fake_scan_candidate_markets(**kwargs):
        return SimpleNamespace(
            source_label="test",
            source_url="https://example.com",
            accepted=[market],
            rejected=[],
        )

    async def fake_refresh_execution_quote(**kwargs):
        side = kwargs["side"]
        current_price_cents = refreshed_price_cents
        if current_price_cents is None:
            current_price_cents = (
                market.current_yes_odds if side == "YES" else market.current_no_odds
            )
        return SimpleNamespace(
            market=market,
            current_price_cents=current_price_cents,
            spread_cents=refreshed_spread_cents,
        )

    async def fake_refresh_live_controls(**kwargs):
        return live_controls

    async def fake_refresh_runtime_execution_settings(**kwargs):
        return runtime_settings or SimpleNamespace(
            auto_live_enabled=settings.auto_live_enabled,
            dry_run=settings.dry_run,
            allow_live_execution=settings.allow_live_execution,
            emergency_stop=settings.emergency_stop,
            paused=False,
            running=True,
        )

    async def fake_refresh_balance():
        return SimpleNamespace(
            status=balance_after_order_status,
            available_balance_usd=50.0,
            account_value_usd=50.0,
            message="Balance ready"
            if balance_after_order_status == "ready"
            else "Balance unavailable",
        )

    class RecordingExecutor:
        async def execute(self, *args, **kwargs):
            executor_calls.append(("execute", {"args": args, "kwargs": kwargs}))
            return "unused-execute"

        async def buy_limit(self, **kwargs):
            executor_calls.append(("buy_limit", kwargs))
            return "buy-limit-submitted"

        async def sell_limit(self, **kwargs):
            executor_calls.append(("sell_limit", kwargs))
            return "sell-limit-submitted"

    monkeypatch.setenv(
        "BULLPEN_AUTO_LIVE_ALLOW_EXECUTION",
        "true" if allow_execution_env else "false",
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.utc_now",
        lambda: fixed_now,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.utc_now_iso",
        lambda: fixed_now.isoformat(),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.scan_candidate_markets",
        fake_scan_candidate_markets,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.evaluate_market_rules",
        lambda *_args, **_kwargs: rules,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.build_evidence_packet",
        lambda *args, **kwargs: _fake_evidence_packet(),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.run_llm_consensus",
        lambda *args, **kwargs: llm_consensus,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_execution_quote",
        fake_refresh_execution_quote,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_live_controls",
        fake_refresh_live_controls,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_runtime_execution_settings",
        fake_refresh_runtime_execution_settings,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_balance",
        fake_refresh_balance,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.bullpen_module.BullpenLiveExecutor",
        lambda: RecordingExecutor(),
    )

    result = await BullpenAutoLiveEngine().execute(
        user_id=7,
        settings=settings,
        state=BullpenAutoLiveState(running=True),
        run=_run_snapshot(dry_run=settings.dry_run),
        positions=positions,
        historical_decisions=historical_decisions,
    )
    return result, executor_calls


def _run_snapshot(
    *,
    dry_run: bool = True,
    request_context: BullpenAutoLiveRunOnceRequest | None = None,
) -> BullpenAutoLiveRun:
    return BullpenAutoLiveRun(
        id="run-1",
        triggered_by="manual",
        status="running",
        dry_run=dry_run,
        started_at="2026-06-21T10:00:00+00:00",
        summary="Queued",
        request_context=request_context,
    )


@pytest.mark.anyio
async def test_auto_live_live_request_falls_back_to_simulation_when_env_blocks(monkeypatch):
    market = _market(current_yes_odds=54, current_no_odds=46)
    monkeypatch.setenv("BULLPEN_AUTO_LIVE_ALLOW_EXECUTION", "false")

    async def fake_scan_candidate_markets(**kwargs):
        return SimpleNamespace(
            source_label="test",
            source_url="https://example.com",
            accepted=[market],
            rejected=[],
        )

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.scan_candidate_markets",
        fake_scan_candidate_markets,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.build_evidence_packet",
        lambda *args, **kwargs: _fake_evidence_packet(),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.run_llm_consensus",
        lambda *args, **kwargs: _fake_llm_consensus(),
    )
    async def fake_refresh_execution_quote(**kwargs):
        return SimpleNamespace(
            market=market,
            current_price_cents=54,
            spread_cents=2,
        )

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_execution_quote",
        fake_refresh_execution_quote,
    )

    result = await BullpenAutoLiveEngine().execute(
        user_id=7,
        settings=BullpenAutoLiveSettings(
            auto_live_enabled=True,
            dry_run=False,
            allow_live_execution=True,
            require_manual_confirmation=False,
        ),
        state=BullpenAutoLiveState(running=True),
        run=_run_snapshot(dry_run=False),
        positions=[],
        historical_decisions=[],
    )

    assert result.run.dry_run is True
    assert result.run.live_execution_requested is True
    assert result.run.orders_submitted == 0
    assert result.state.dry_run is True
    assert result.state.live_armed is False
    assert result.state.live_execution_allowed is False
    assert result.decisions[0].order_plan is not None
    assert result.decisions[0].order_plan.status == "skipped"
    assert "simulation only" in result.decisions[0].order_plan.detail.lower()


@pytest.mark.anyio
async def test_auto_live_exit_sells_the_held_side_not_the_new_signal_side(monkeypatch):
    market = _market(current_yes_odds=70, current_no_odds=30)
    now = datetime(2026, 6, 21, 10, 0, tzinfo=UTC)

    async def fake_scan_candidate_markets(**kwargs):
        return SimpleNamespace(
            source_label="test",
            source_url="https://example.com",
            accepted=[market],
            rejected=[],
        )

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.scan_candidate_markets",
        fake_scan_candidate_markets,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.build_evidence_packet",
        lambda *args, **kwargs: _fake_evidence_packet(),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.run_llm_consensus",
        lambda *args, **kwargs: _fake_llm_consensus(fair_yes=82, fair_no=18),
    )
    async def fake_refresh_execution_quote(**kwargs):
        return SimpleNamespace(
            market=market,
            current_price_cents=30,
            spread_cents=2,
        )

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_execution_quote",
        fake_refresh_execution_quote,
    )

    result = await BullpenAutoLiveEngine().execute(
        user_id=7,
        settings=BullpenAutoLiveSettings(
            auto_live_enabled=True,
            dry_run=True,
        ),
        state=BullpenAutoLiveState(running=True),
        run=_run_snapshot(),
        positions=[
            PositionSnapshot(
                market_id=market.market_id,
                slug=market.slug,
                market_title=market.question,
                market_url=market.market_url,
                theme=market.theme,
                side="NO",
                exposure_usd=12,
                shares=20,
                average_price_cents=40,
                opened_at=now,
                updated_at=now,
            )
        ],
        historical_decisions=[],
    )

    assert result.decisions[0].decision == "EXIT"
    assert result.decisions[0].order_plan is not None
    assert result.decisions[0].order_plan.side == "NO"
    assert result.decisions[0].order_plan.refreshed_market_price_cents == 30


@pytest.mark.anyio
async def test_auto_live_pauses_live_mode_when_bullpen_doctor_fails(monkeypatch):
    market = _market()
    monkeypatch.setenv("BULLPEN_AUTO_LIVE_ALLOW_EXECUTION", "true")

    async def fake_scan_candidate_markets(**kwargs):
        return SimpleNamespace(
            source_label="test",
            source_url="https://example.com",
            accepted=[market],
            rejected=[],
        )

    async def fake_refresh_live_controls(**kwargs):
        return SimpleNamespace(
            unlocked=True,
            unlock_mode="manual",
            locked_reason=None,
            emergency_stopped=False,
            doctor=SimpleNamespace(ok=False, message="Bullpen doctor failed"),
            balance=SimpleNamespace(status="ready", message="Balance ready"),
        )

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.scan_candidate_markets",
        fake_scan_candidate_markets,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.build_evidence_packet",
        lambda *args, **kwargs: _fake_evidence_packet(),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.run_llm_consensus",
        lambda *args, **kwargs: _fake_llm_consensus(),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_live_controls",
        fake_refresh_live_controls,
    )

    result = await BullpenAutoLiveEngine().execute(
        user_id=7,
        settings=BullpenAutoLiveSettings(
            auto_live_enabled=True,
            dry_run=False,
            allow_live_execution=True,
            require_manual_confirmation=False,
            pause_if_doctor_fails=True,
        ),
        state=BullpenAutoLiveState(running=True),
        run=_run_snapshot(dry_run=False),
        positions=[],
        historical_decisions=[],
    )

    assert result.run.status == "failed"
    assert result.state.paused is True
    assert result.state.doctor_status == "fail"
    assert result.state.live_execution_allowed is False
    assert result.decisions[0].order_plan is None
    assert "doctor failed" in result.run.summary.lower()


def test_auto_live_llm_consensus_matches_requested_statistics(monkeypatch):
    yes_values = [70, 28, 70, 70, 90, 10, 25, 40, 25, 20, 65, 65, 55]
    targets = [(f"provider-{index}", f"model-{index}") for index in range(len(yes_values))]

    class FakeProvider:
        def __init__(self, provider_name: str, yes_value: float) -> None:
            self.provider_name = provider_name
            self.yes_value = yes_value

        def generate(self, *, prompt: str, model: str):
            return SimpleNamespace(
                content=json.dumps(
                    {
                        "markets": [
                            {
                                "llm_yes_odds": self.yes_value,
                                "llm_no_odds": 100 - self.yes_value,
                                "confidence": "High",
                                "evidence_status": "Strong",
                                "event_state": "scheduled_not_occurred",
                                "key_evidence": ["Fact"],
                                "red_flags": [],
                                "rationale": "Consensus test payload",
                            }
                        ]
                    }
                ),
                provider=self.provider_name,
                model=model,
            )

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.llm.resolve_auto_live_llm_targets",
        lambda: targets,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.llm.ProviderFactory.create",
        lambda provider_name: FakeProvider(
            provider_name,
            yes_values[int(provider_name.rsplit("-", 1)[-1])],
        ),
    )

    outputs, consensus = run_llm_consensus(
        _market(),
        _fake_rules(),
        _fake_evidence_packet(),
    )

    assert len(outputs) == len(yes_values)
    assert consensus.average_yes == pytest.approx(48.69, abs=0.01)
    assert consensus.median_yes == 55
    assert consensus.min_yes == 10
    assert consensus.max_yes == 90
    assert consensus.spread_yes == 80
    assert consensus.disagreement_level == "High"
    assert consensus.disagreement_category == "HIGH_DISAGREEMENT"
    assert consensus.adjudication_required is True
    assert consensus.consensus_method == "median"


@pytest.mark.anyio
async def test_run_llm_consensus_treats_single_uncertain_outlier_as_consensus_with_outlier(monkeypatch):
    yes_values = [10, 12, 15, 8, 14, 9, 11, 13, 50]
    targets = [(f"provider-{index}", f"model-{index}") for index in range(len(yes_values))]

    class FakeProvider:
        def __init__(self, provider_name: str, yes_value: float) -> None:
            self.provider_name = provider_name
            self.yes_value = yes_value

        def generate(self, *, prompt: str, model: str):
            return SimpleNamespace(
                content=json.dumps(
                    {
                        "markets": [
                            {
                                "llm_yes_odds": self.yes_value,
                                "llm_no_odds": 100 - self.yes_value,
                                "confidence": "High",
                                "evidence_status": "Strong",
                                "event_state": "no_confirmed_event",
                                "key_evidence": ["Fact"],
                                "red_flags": [],
                                "rationale": "No confirmed evidence the event has happened yet.",
                            }
                        ]
                    }
                ),
                provider=self.provider_name,
                model=model,
            )

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.llm.resolve_auto_live_llm_targets",
        lambda: targets,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.llm.ProviderFactory.create",
        lambda provider_name: FakeProvider(
            provider_name,
            yes_values[int(provider_name.rsplit("-", 1)[-1])],
        ),
    )

    outputs, consensus = run_llm_consensus(
        _market(),
        _fake_rules(),
        _fake_evidence_packet(),
    )

    assert len(outputs) == len(yes_values)
    assert consensus.disagreement_level == "Medium"
    assert consensus.disagreement_category == "CONSENSUS_WITH_OUTLIER"
    assert consensus.adjudication_required is False
    assert consensus.median_yes == 12
    assert consensus.trimmed_mean_yes == pytest.approx(12.0, abs=0.01)
    assert consensus.fair_yes_probability_pct == pytest.approx(12.0, abs=0.01)


@pytest.mark.anyio
async def test_run_llm_consensus_marks_rationale_odds_mismatch_and_reduces_weight(monkeypatch):
    targets = [("openai", "gpt-4o-mini")]

    class FakeProvider:
        def generate(self, *, prompt: str, model: str):
            return SimpleNamespace(
                content=json.dumps(
                    {
                        "markets": [
                            {
                                "llm_yes_odds": 52,
                                "llm_no_odds": 48,
                                "confidence": "Medium",
                                "evidence_status": "Low",
                                "event_state": "no_confirmed_event",
                                "key_evidence": ["No official confirmation found."],
                                "red_flags": [],
                                "rationale": "No credible evidence confirms the event, so it looks unlikely.",
                            }
                        ]
                    }
                ),
                provider="openai",
                model=model,
            )

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.llm.resolve_auto_live_llm_targets",
        lambda: targets,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.llm.ProviderFactory.create",
        lambda provider_name: FakeProvider(),
    )

    outputs, consensus = run_llm_consensus(
        _market(),
        _fake_rules(),
        _fake_evidence_packet(),
    )

    assert outputs[0].rationale_odds_mismatch is True
    assert outputs[0].effective_weight == pytest.approx(0.35, abs=0.001)
    assert consensus.rationale_mismatch_count == 1


@pytest.mark.anyio
async def test_auto_live_high_llm_disagreement_blocks_trade(monkeypatch):
    result, _ = await _execute_auto_live(
        monkeypatch,
        settings=BullpenAutoLiveSettings(
            max_llm_spread_pp=30,
            half_size_llm_spread_pp=15,
        ),
        llm_consensus=_fake_llm_consensus(
            fair_yes=55,
            fair_no=45,
            average_yes=48.69,
            median_yes=55,
            trimmed_mean_yes=52.14,
            min_yes=10,
            max_yes=90,
            spread_yes=80,
            disagreement_level="High",
            disagreement_category="HIGH_DISAGREEMENT",
            adjudication_required=True,
        ),
    )

    assert result.decisions[0].decision == "SKIP"
    assert result.decisions[0].risk_status == "Blocked"
    assert "llm disagreement is above the configured maximum" in result.decisions[0].reason.lower()


@pytest.mark.anyio
async def test_auto_live_weak_evidence_blocks_trade(monkeypatch):
    result, _ = await _execute_auto_live(
        monkeypatch,
        settings=BullpenAutoLiveSettings(min_evidence_status="Moderate"),
        llm_consensus=_fake_llm_consensus(
            fair_yes=72,
            fair_no=28,
            evidence_status="Low",
        ),
    )

    assert result.decisions[0].decision == "SKIP"
    assert "evidence is below the configured minimum" in result.decisions[0].reason.lower()


@pytest.mark.anyio
async def test_auto_live_conflicting_evidence_blocks_trade(monkeypatch):
    result, _ = await _execute_auto_live(
        monkeypatch,
        llm_consensus=_fake_llm_consensus(
            fair_yes=72,
            fair_no=28,
            event_state="conflicting",
        ),
    )

    assert result.decisions[0].decision == "SKIP"
    assert "evidence is conflicting" in result.decisions[0].reason.lower()


@pytest.mark.anyio
async def test_auto_live_edge_below_minimum_blocks_trade(monkeypatch):
    result, _ = await _execute_auto_live(
        monkeypatch,
        settings=BullpenAutoLiveSettings(min_score=0),
        llm_consensus=_fake_llm_consensus(fair_yes=56, fair_no=44),
    )

    assert result.decisions[0].decision == "SKIP"
    assert "edge 2.00 is below the minimum 15.00." in result.decisions[0].reason.lower()


@pytest.mark.anyio
async def test_auto_live_score_below_minimum_blocks_trade(monkeypatch):
    result, _ = await _execute_auto_live(
        monkeypatch,
        settings=BullpenAutoLiveSettings(
            min_evidence_status="Low",
            min_confidence="Low",
        ),
        llm_consensus=_fake_llm_consensus(
            fair_yes=70,
            fair_no=30,
            confidence="Low",
            evidence_status="Moderate",
        ),
    )

    assert result.decisions[0].decision == "SKIP"
    assert "Score 7.04 is below the minimum 8.00." in result.decisions[0].reason


@pytest.mark.anyio
async def test_auto_live_deadline_too_close_blocks_new_trade(monkeypatch):
    result, _ = await _execute_auto_live(
        monkeypatch,
        rules=_fake_rules(hours_remaining=4, deadline_et="2026-06-21 04:00:00 PM ET"),
    )

    assert result.decisions[0].decision == "SKIP"
    assert "too close to the deadline" in result.decisions[0].reason.lower()


@pytest.mark.anyio
async def test_auto_live_market_exposure_cap_blocks_buy_new(monkeypatch):
    result, _ = await _execute_auto_live(
        monkeypatch,
        settings=BullpenAutoLiveSettings(
            bankroll_usd=100,
            max_single_trade_pct_bankroll=0.5,
            max_single_market_pct_bankroll=0.5,
        ),
    )

    assert result.decisions[0].decision == "SKIP"
    assert "order size is below the minimum order usd" in result.decisions[0].reason.lower()


@pytest.mark.anyio
async def test_auto_live_theme_exposure_cap_blocks_trade(monkeypatch):
    now = datetime(2026, 6, 21, 12, 0, tzinfo=UTC)
    result, _ = await _execute_auto_live(
        monkeypatch,
        positions=[
            PositionSnapshot(
                market_id="other-market",
                slug="other-market",
                market_title="Other market",
                market_url="https://example.com/other-market",
                theme="Politics",
                side="YES",
                exposure_usd=20,
                shares=40,
                average_price_cents=50,
                opened_at=now,
                updated_at=now,
            )
        ],
    )

    assert result.decisions[0].decision == "SKIP"
    assert "target exposure is zero after kelly and capacity caps" in result.decisions[0].reason.lower()


@pytest.mark.anyio
async def test_auto_live_open_exposure_cap_blocks_trade(monkeypatch):
    now = datetime(2026, 6, 21, 12, 0, tzinfo=UTC)
    result, _ = await _execute_auto_live(
        monkeypatch,
        positions=[
            PositionSnapshot(
                market_id="market-a",
                slug="market-a",
                market_title="Market A",
                market_url="https://example.com/market-a",
                theme="Theme A",
                side="YES",
                exposure_usd=60,
                shares=120,
                average_price_cents=50,
                opened_at=now,
                updated_at=now,
            )
        ],
    )

    assert result.decisions[0].decision == "SKIP"
    assert "target exposure is zero after kelly and capacity caps" in result.decisions[0].reason.lower()


@pytest.mark.anyio
async def test_auto_live_cash_reserve_breach_blocks_trade(monkeypatch):
    now = datetime(2026, 6, 21, 12, 0, tzinfo=UTC)
    result, _ = await _execute_auto_live(
        monkeypatch,
        positions=[
            PositionSnapshot(
                market_id="market-a",
                slug="market-a",
                market_title="Market A",
                market_url="https://example.com/market-a",
                theme="Theme A",
                side="YES",
                exposure_usd=60,
                shares=120,
                average_price_cents=50,
                opened_at=now,
                updated_at=now,
            )
        ],
    )

    assert result.decisions[0].decision == "SKIP"
    assert "target exposure is zero after kelly and capacity caps" in result.decisions[0].reason.lower()
    stage5 = next(
        stage for stage in result.decisions[0].stage_results if stage.stage_number == 5
    )
    assert stage5.outputs["remaining_cash_reserve_capacity"] == 0


@pytest.mark.anyio
async def test_auto_live_daily_loss_stop_blocks_execution(monkeypatch):
    result, executor_calls = await _execute_auto_live(
        monkeypatch,
        settings=BullpenAutoLiveSettings(
            auto_live_enabled=True,
            dry_run=False,
            allow_live_execution=True,
            require_manual_confirmation=False,
            max_daily_loss_pct_bankroll=3,
        ),
        historical_decisions=[
            _historical_decision(
                decision_id="loss-day",
                realized_pnl_usd=-5.0,
                executed_at="2026-06-21T11:00:00+00:00",
            )
        ],
        allow_execution_env=True,
    )

    assert result.run.status == "failed"
    assert result.state.paused is True
    assert result.state.live_execution_allowed is False
    assert result.decisions[0].order_plan is None
    assert executor_calls == []
    assert "daily loss stop is hit" in result.run.summary.lower()


@pytest.mark.anyio
async def test_auto_live_weekly_loss_stop_blocks_execution(monkeypatch):
    result, executor_calls = await _execute_auto_live(
        monkeypatch,
        settings=BullpenAutoLiveSettings(
            auto_live_enabled=True,
            dry_run=False,
            allow_live_execution=True,
            require_manual_confirmation=False,
            max_weekly_loss_pct_bankroll=8,
        ),
        historical_decisions=[
            _historical_decision(
                decision_id="loss-week",
                realized_pnl_usd=-9.0,
                executed_at="2026-06-18T12:00:00+00:00",
            )
        ],
        allow_execution_env=True,
    )

    assert result.run.status == "failed"
    assert result.state.paused is True
    assert result.decisions[0].order_plan is None
    assert executor_calls == []
    assert "weekly loss stop is hit" in result.run.summary.lower()


@pytest.mark.anyio
async def test_auto_live_emergency_stop_blocks_execution(monkeypatch):
    result, executor_calls = await _execute_auto_live(
        monkeypatch,
        settings=BullpenAutoLiveSettings(
            auto_live_enabled=True,
            dry_run=False,
            allow_live_execution=True,
            require_manual_confirmation=False,
            emergency_stop=True,
        ),
        allow_execution_env=True,
    )

    assert result.decisions[0].decision == "SKIP"
    assert result.state.live_execution_allowed is False
    assert executor_calls == []
    assert "emergency stop is active" in result.decisions[0].reason.lower()


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("pause_if_balance_unavailable", "expect_paused", "expect_order_plan"),
    [(True, True, False), (False, False, True)],
)
async def test_auto_live_balance_unavailable_blocks_or_pauses(
    monkeypatch,
    pause_if_balance_unavailable: bool,
    expect_paused: bool,
    expect_order_plan: bool,
):
    result, executor_calls = await _execute_auto_live(
        monkeypatch,
        settings=BullpenAutoLiveSettings(
            auto_live_enabled=True,
            dry_run=False,
            allow_live_execution=True,
            require_manual_confirmation=False,
            pause_if_balance_unavailable=pause_if_balance_unavailable,
        ),
        live_controls=_fake_live_controls(balance_status="unavailable", balance_message="Balance unavailable"),
        allow_execution_env=True,
    )

    assert result.run.status == "failed"
    assert result.state.paused is expect_paused
    assert result.state.balance_status == "fail"
    assert result.state.live_execution_allowed is False
    assert executor_calls == []
    if expect_order_plan:
        assert result.decisions[0].order_plan is not None
        assert "balance is not ready" in result.decisions[0].order_plan.detail.lower()
    else:
        assert result.decisions[0].order_plan is None


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("pause_if_doctor_fails", "expect_paused", "expect_order_plan"),
    [(True, True, False), (False, False, True)],
)
async def test_auto_live_doctor_failure_blocks_or_pauses(
    monkeypatch,
    pause_if_doctor_fails: bool,
    expect_paused: bool,
    expect_order_plan: bool,
):
    result, executor_calls = await _execute_auto_live(
        monkeypatch,
        settings=BullpenAutoLiveSettings(
            auto_live_enabled=True,
            dry_run=False,
            allow_live_execution=True,
            require_manual_confirmation=False,
            pause_if_doctor_fails=pause_if_doctor_fails,
        ),
        live_controls=_fake_live_controls(doctor_ok=False, doctor_message="Bullpen doctor failed"),
        allow_execution_env=True,
    )

    assert result.run.status == "failed"
    assert result.state.paused is expect_paused
    assert result.state.doctor_status == "fail"
    assert result.state.live_execution_allowed is False
    assert executor_calls == []
    if expect_order_plan:
        assert result.decisions[0].order_plan is not None
        assert "doctor failed" in result.decisions[0].order_plan.detail.lower()
    else:
        assert result.decisions[0].order_plan is None


@pytest.mark.anyio
async def test_auto_live_dry_run_creates_decisions_without_live_executor_calls(monkeypatch):
    result, executor_calls = await _execute_auto_live(
        monkeypatch,
        settings=BullpenAutoLiveSettings(
            auto_live_enabled=True,
            dry_run=True,
            allow_live_execution=False,
        ),
        allow_execution_env=True,
    )

    assert result.decisions[0].decision == "BUY_NEW"
    assert result.decisions[0].order_plan is not None
    assert result.decisions[0].order_plan.status == "skipped"
    assert executor_calls == []


@pytest.mark.anyio
async def test_auto_live_live_execution_uses_limit_order_executor_only_after_guardrails_pass(monkeypatch):
    result, executor_calls = await _execute_auto_live(
        monkeypatch,
        settings=BullpenAutoLiveSettings(
            auto_live_enabled=True,
            dry_run=False,
            allow_live_execution=True,
            require_manual_confirmation=False,
        ),
        allow_execution_env=True,
    )

    assert result.run.status == "completed"
    assert result.run.orders_submitted == 1
    assert result.decisions[0].order_plan is not None
    assert result.decisions[0].order_plan.side == "YES"
    assert result.decisions[0].order_plan.status == "submitted"
    assert [call[0] for call in executor_calls] == ["buy_limit"]
    assert executor_calls[0][1]["outcome"] == "Yes"
    assert result.positions[0].side == "YES"


@pytest.mark.anyio
async def test_auto_live_logs_submitted_and_skipped_decisions_with_reasons(monkeypatch):
    logged_messages: list[tuple[str, str]] = []

    def capture(level: str):
        def _log(message: str, *args, **kwargs):
            rendered = message % args if args else message
            logged_messages.append((level, rendered))

        return _log

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.logger",
        SimpleNamespace(
            info=capture("info"),
            warning=capture("warning"),
        ),
    )

    live_result, _ = await _execute_auto_live(
        monkeypatch,
        settings=BullpenAutoLiveSettings(
            auto_live_enabled=True,
            dry_run=False,
            allow_live_execution=True,
            require_manual_confirmation=False,
        ),
        allow_execution_env=True,
    )
    skipped_result, _ = await _execute_auto_live(
        monkeypatch,
        settings=BullpenAutoLiveSettings(
            max_llm_spread_pp=30,
            half_size_llm_spread_pp=15,
        ),
        llm_consensus=_fake_llm_consensus(
            fair_yes=55,
            fair_no=45,
            average_yes=48.69,
            median_yes=55,
            trimmed_mean_yes=52.14,
            min_yes=10,
            max_yes=90,
            spread_yes=80,
            disagreement_level="High",
            disagreement_category="HIGH_DISAGREEMENT",
            adjudication_required=True,
        ),
    )

    decision_logs = [
        (level, message)
        for level, message in logged_messages
        if "Auto-Live decision" in message
    ]

    assert live_result.decisions[0].order_plan is not None
    assert live_result.decisions[0].order_plan.status == "submitted"
    assert skipped_result.decisions[0].decision == "SKIP"
    assert any(
        level == "info"
        and "action=BUY_NEW" in message
        and "order_status=submitted" in message
        for level, message in decision_logs
    )
    assert any(
        level == "warning"
        and "action=SKIP" in message
        and "llm disagreement is above the configured maximum" in message.lower()
        for level, message in decision_logs
    )


def test_auto_live_domain_never_uses_bypass_trade_risk_flag():
    source = "\n".join(
        path.read_text()
        for path in Path("backend/app/domains/polymarket_auto_live").glob("*.py")
    )
    assert "bypass_trade_risk=True" not in source
