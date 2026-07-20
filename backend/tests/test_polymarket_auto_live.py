import json
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://test:test@localhost:5432/testdb",
)
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

import pytest
from pydantic import ValidationError

import app.infrastructure.database.all_models  # noqa: F401
from app.domains.polymarket.bullpen_llm_execution import (
    BullpenLlmEventProviderResult,
    BullpenLlmTargetExecutionResult,
    ParsedBullpenMarketRow,
)
from app.domains.polymarket_auto_live.bot import (
    BullpenAutoLiveBot,
    _state_has_due_scheduled_run,
    build_initial_run_summary,
    build_initial_scan_stage_result,
)
from app.domains.polymarket_auto_live.console_profile import (
    CONSOLE_PROFILE_ID,
    ConsoleWalletPosition,
    candidate_returns_per_day,
    llm_returns_per_day,
    console_market_filter_reasons,
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
    ConsoleStageTwoSharedReview,
    PositionSnapshot,
    _execute_console_stage_two_shared_llm,
    _apply_next_cycle_schedule,
    _manual_console_market,
    _summarize_stage3_step2_buy_queue,
    _stage3_capacity_sizing_market_ids,
    build_console_trade_amount_breakdown,
    build_workflow_stage_result,
    reset_workflow_stage_results,
    _reconcile_historical_pending_exit_keys,
    _auto_live_record_id,
)
from app.domains.polymarket_auto_live.llm import (
    resolve_auto_live_llm_targets,
    run_llm_consensus,
)
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
    BullpenAutoLiveGuardrailCheck,
    BullpenAutoLiveLlmOutput,
    BullpenAutoLiveLlmTarget,
    BullpenAutoLiveOrderPlan,
    BullpenAutoLiveRun,
    BullpenAutoLiveRunOnceRequest,
    BullpenAutoLiveSettings,
    BullpenAutoLiveState,
    BullpenAutoLiveSummary,
)
from app.domains.runs.schemas import (
    BullpenLlmExecutionOptions,
    PreparedPolymarketEventContext,
    PolymarketEventQuestionPayload,
)
from app.domains.trading_bots.service import (
    build_trading_bots_overview,
    build_trading_bots_summary,
)




def test_state_has_due_scheduled_run_allows_polling_failsafe():
    settings = BullpenAutoLiveSettings(auto_live_enabled=True)
    state = BullpenAutoLiveState(
        running=True,
        paused=False,
        next_run_at="2026-07-19T11:56:00+00:00",
    )

    assert _state_has_due_scheduled_run(
        settings,
        state,
        reference_time=datetime(2026, 7, 19, 11, 56, 10, tzinfo=UTC),
    )


def test_state_has_due_scheduled_run_respects_disabled_and_future_runs():
    due_state = BullpenAutoLiveState(
        running=True,
        paused=False,
        next_run_at="2026-07-19T11:57:00+00:00",
    )

    assert not _state_has_due_scheduled_run(
        BullpenAutoLiveSettings(auto_live_enabled=True),
        due_state,
        reference_time=datetime(2026, 7, 19, 11, 56, 10, tzinfo=UTC),
    )
    assert not _state_has_due_scheduled_run(
        BullpenAutoLiveSettings(auto_live_enabled=False),
        due_state.model_copy(update={"next_run_at": "2026-07-19T11:56:00+00:00"}),
        reference_time=datetime(2026, 7, 19, 11, 56, 10, tzinfo=UTC),
    )

def test_console_profile_next_cycle_uses_custom_auto_run_schedule():
    settings = BullpenAutoLiveSettings(
        strategy_profile=CONSOLE_PROFILE_ID,
        console_auto_start_at="15:50:00 18 July, 2026",
        console_auto_refresh_minutes=60,
    )
    state = BullpenAutoLiveState(running=True)

    _apply_next_cycle_schedule(
        settings=settings,
        state=state,
        reference_time=datetime(2026, 7, 18, 11, 0, tzinfo=UTC),
    )

    assert state.next_run_at == "2026-07-18T11:20:00+00:00"
    assert state.next_scan_at == state.next_run_at
    assert state.next_llm_run_at == state.next_run_at
    assert state.next_rebalance_at == state.next_run_at


def test_auto_live_record_id_caps_long_action_labels_for_database_columns():
    record_id = _auto_live_record_id(
        "decision",
        run_id="2d09bb75-d8ba-48a1-bbdf-f42c7e43f58a",
        market_id="very-long-polymarket-market-id-that-does-not-affect-id-length",
        action="EVENT_EXIT_REDEEM_CLAIM_WITH_EXTREMELY_LONG_MANUAL_ACTION_LABEL",
    )

    assert len(record_id) <= 64
    assert record_id.startswith("decision-")
    assert record_id.rsplit("-", 1)[-1]


def test_auto_live_retry_clears_stale_stage3_until_stage2_rebuilds():
    run = BullpenAutoLiveRun(
        id="retry-run",
        triggered_by="scheduler",
        status="running",
        dry_run=True,
        started_at="2026-07-18T00:00:00+00:00",
        summary="Retrying Auto-Live run.",
        stage_results=[
            build_workflow_stage_result(
                stage_number=1,
                workflow_stage_key="scan",
                phase_status="completed",
                status="pass",
                reason="Stage 1 finished.",
            ),
            build_workflow_stage_result(
                stage_number=2,
                workflow_stage_key="llm",
                phase_status="completed",
                status="pass",
                reason="Old Stage 2 attempt finished.",
            ),
            build_workflow_stage_result(
                stage_number=3,
                workflow_stage_key="invest",
                phase_status="running",
                status="pass",
                reason="Old Stage 3 attempt was running when the worker retried.",
                completed_at=None,
            ),
        ],
    )

    reset_workflow_stage_results(run, from_stage_number=2)

    assert [stage.stage_number for stage in run.stage_results] == [1]
    assert run.stage_results[0].outputs["workflow_stage_key"] == "scan"


def test_historical_pending_redeem_stops_blocking_after_retry_cooldown(monkeypatch):
    fixed_now = datetime(2026, 7, 17, 10, 0, tzinfo=UTC)
    monkeypatch.setenv("POLYMARKET_REDEEM_RETRY_COOLDOWN_SECONDS", "60")
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.utc_now",
        lambda: fixed_now,
    )

    recent_pending_decision = SimpleNamespace(
        market_id="market-1",
        order_plan=SimpleNamespace(
            dry_run=False,
            status="settlement_pending",
            action="redeem",
            executed_at="2026-07-17T09:59:30+00:00",
            side="NO",
            shares=2,
        ),
        stage_results=[SimpleNamespace(outputs={"condition_id": "condition-1"})],
    )
    cooled_down_decision = SimpleNamespace(
        market_id="market-1",
        order_plan=SimpleNamespace(
            dry_run=False,
            status="settlement_pending",
            action="redeem",
            executed_at="2026-07-17T09:58:00+00:00",
            side="NO",
            shares=2,
        ),
        stage_results=[SimpleNamespace(outputs={"condition_id": "condition-1"})],
    )
    live_position = SimpleNamespace(
        condition_id="condition-1",
        is_claimable=True,
        market_id="market-1",
        side="NO",
        shares=2,
    )

    _, pending_recent = _reconcile_historical_pending_exit_keys(
        [recent_pending_decision],
        [live_position],
    )
    _, pending_after_cooldown = _reconcile_historical_pending_exit_keys(
        [cooled_down_decision],
        [live_position],
    )

    assert pending_recent == {"condition-1"}
    assert pending_after_cooldown == set()


@pytest.mark.anyio
async def test_refresh_live_controls_allows_auto_live_stage3_when_copy_bot_is_paper(monkeypatch):
    from app.domains.polymarket_auto_live.execution import refresh_live_controls

    class FakeBot:
        async def refresh_doctor(self):
            return None

        async def refresh_balance(self):
            return None

        async def get_state(self):
            return SimpleNamespace(
                config=SimpleNamespace(
                    live_trading=True,
                    use_live_reads=True,
                    live_unlock_mode="automatic",
                ),
                live=SimpleNamespace(
                    unlocked=False,
                    unlock_mode="locked",
                    locked_reason="PAPER_TRADING must be false.",
                    emergency_stopped=False,
                    manually_locked=False,
                    doctor=SimpleNamespace(ok=True),
                    balance=SimpleNamespace(status="ready"),
                ),
            )

    async def fake_get_bot(user_id):
        return FakeBot()

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.execution.polymarket_bot_manager.get_bot",
        fake_get_bot,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.execution.refresh_runtime_execution_settings",
        AsyncMock(
            return_value=SimpleNamespace(
                auto_live_enabled=True,
                dry_run=False,
                allow_live_execution=True,
                emergency_stop=False,
                paused=False,
            )
        ),
    )

    controls = await refresh_live_controls(user_id=1)

    assert controls.unlocked is True
    assert controls.unlock_mode == "automatic"
    assert controls.locked_reason is None


@pytest.mark.anyio
async def test_refresh_live_controls_allows_auto_live_stage3_without_dashboard_unlock_when_armed(
    monkeypatch,
):
    from app.domains.polymarket_auto_live.execution import refresh_live_controls

    class FakeBot:
        async def refresh_doctor(self):
            return None

        async def refresh_balance(self):
            return None

        async def get_state(self):
            return SimpleNamespace(
                config=SimpleNamespace(
                    live_trading=False,
                    use_live_reads=False,
                    live_unlock_mode="manual",
                ),
                live=SimpleNamespace(
                    unlocked=False,
                    unlock_mode="locked",
                    locked_reason="Dashboard live unlock is required",
                    emergency_stopped=False,
                    manually_locked=False,
                    doctor=SimpleNamespace(ok=True),
                    balance=SimpleNamespace(status="ready"),
                ),
            )

    async def fake_get_bot(user_id):
        return FakeBot()

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.execution.polymarket_bot_manager.get_bot",
        fake_get_bot,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.execution.refresh_runtime_execution_settings",
        AsyncMock(
            return_value=SimpleNamespace(
                auto_live_enabled=True,
                dry_run=False,
                allow_live_execution=True,
                emergency_stop=False,
                paused=False,
            )
        ),
    )

    controls = await refresh_live_controls(user_id=1)

    assert controls.unlocked is True
    assert controls.unlock_mode == "automatic"
    assert controls.locked_reason is None


@pytest.mark.anyio
async def test_refresh_live_controls_keeps_dashboard_unlock_gate_when_auto_live_is_not_armed(
    monkeypatch,
):
    from app.domains.polymarket_auto_live.execution import refresh_live_controls

    class FakeBot:
        async def refresh_doctor(self):
            return None

        async def refresh_balance(self):
            return None

        async def get_state(self):
            return SimpleNamespace(
                config=SimpleNamespace(
                    live_trading=True,
                    use_live_reads=True,
                    live_unlock_mode="manual",
                ),
                live=SimpleNamespace(
                    unlocked=False,
                    unlock_mode="locked",
                    locked_reason="Dashboard live unlock is required.",
                    emergency_stopped=False,
                    manually_locked=False,
                    doctor=SimpleNamespace(ok=True),
                    balance=SimpleNamespace(status="ready"),
                ),
            )

    async def fake_get_bot(user_id):
        return FakeBot()

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.execution.polymarket_bot_manager.get_bot",
        fake_get_bot,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.execution.refresh_runtime_execution_settings",
        AsyncMock(
            return_value=SimpleNamespace(
                auto_live_enabled=True,
                dry_run=True,
                allow_live_execution=False,
                emergency_stop=False,
                paused=False,
            )
        ),
    )

    controls = await refresh_live_controls(user_id=1)

    assert controls.unlocked is False
    assert controls.unlock_mode == "locked"
    assert controls.locked_reason == "Dashboard live unlock is required."


@pytest.mark.anyio
async def test_refresh_live_controls_respects_manual_live_lock_when_auto_live_is_armed(
    monkeypatch,
):
    from app.domains.polymarket_auto_live.execution import refresh_live_controls

    class FakeBot:
        async def refresh_doctor(self):
            return None

        async def refresh_balance(self):
            return None

        async def get_state(self):
            return SimpleNamespace(
                config=SimpleNamespace(
                    live_trading=True,
                    use_live_reads=True,
                    live_unlock_mode="manual",
                ),
                live=SimpleNamespace(
                    unlocked=False,
                    unlock_mode="locked",
                    locked_reason="Live locked manually.",
                    emergency_stopped=False,
                    manually_locked=True,
                    doctor=SimpleNamespace(ok=True),
                    balance=SimpleNamespace(status="ready"),
                ),
            )

    async def fake_get_bot(user_id):
        return FakeBot()

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.execution.polymarket_bot_manager.get_bot",
        fake_get_bot,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.execution.refresh_runtime_execution_settings",
        AsyncMock(
            return_value=SimpleNamespace(
                auto_live_enabled=True,
                dry_run=False,
                allow_live_execution=True,
                emergency_stop=False,
                paused=False,
            )
        ),
    )

    controls = await refresh_live_controls(user_id=1)

    assert controls.unlocked is False
    assert controls.unlock_mode == "locked"
    assert controls.locked_reason == "Live locked manually."


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


def test_synchronize_state_refreshes_stale_live_execution_guardrails(monkeypatch):
    monkeypatch.setenv("BULLPEN_AUTO_LIVE_ALLOW_EXECUTION", "true")

    stale_state = BullpenAutoLiveState(
        paused=False,
        latest_guardrail_checks=[
            BullpenAutoLiveGuardrailCheck(
                id="live-execution-env",
                label="Backend live execution",
                status="watch",
                detail="Backend environment blocks Auto-Live execution, so runs stay in simulation mode.",
                value="Blocked",
                checked_at="2026-06-30T00:00:00+00:00",
            )
        ],
    )
    settings = BullpenAutoLiveSettings(
        auto_live_enabled=True,
        dry_run=False,
        allow_live_execution=True,
    )

    synchronized = BullpenAutoLiveBot(user_id=7)._synchronize_state(settings, stale_state)
    guardrails = {check.id: check for check in synchronized.latest_guardrail_checks}

    assert synchronized.live_armed is True
    assert synchronized.mode == "live-trading"
    assert guardrails["live-execution-env"].status == "pass"
    assert guardrails["live-execution-env"].value == "Allowed"
    assert "allows Auto-Live execution" in guardrails["live-execution-env"].detail
    assert guardrails["live-armed"].value == "Armed"
    assert guardrails["runtime-status"].value == "Ready"


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


def test_auto_live_due_run_scan_uses_sub_minute_interval():
    from celery.schedules import schedule

    from app.infrastructure.messaging.celery_app import celery

    due_scan = celery.conf.beat_schedule["polymarket-auto-live-due-run-scan"]

    assert due_scan["task"] == (
        "app.domains.polymarket_auto_live.tasks.enqueue_due_polymarket_auto_live_runs"
    )
    assert isinstance(due_scan["schedule"], schedule)
    assert due_scan["schedule"].run_every.total_seconds() == 10.0


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


def test_llm_returns_per_day_uses_unpriced_upside_for_current_side_matching_strongest_llm_odds_with_naive_close_time():
    returns = llm_returns_per_day(
        llm_yes_odds=5,
        llm_no_odds=95,
        close_time="2026-06-25T00:00:00",
        now=datetime(2026, 6, 21, 0, 0, tzinfo=UTC),
        current_yes_odds=75.5,
        current_no_odds=24.5,
    )

    assert returns == 18.88


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
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_balance",
        _fake_ready_balance,
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
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_balance",
        _fake_ready_balance,
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
async def test_console_profile_stage_2_reviews_the_full_eligible_universe_even_when_the_saved_cap_is_lower(monkeypatch):
    fixed_now = datetime(2026, 6, 21, 0, 0, tzinfo=UTC)
    markets = [
        _market(
            question=f"Will capped Stage 2 market {index} finish review?",
            slug=f"stage-2-cap-{index}",
            current_yes_odds=10 + index,
            current_no_odds=90 - index,
        )
        for index in range(5)
    ]
    reviewed_slugs: list[str | None] = []

    async def fake_read_console_wallet_positions():
        return []

    async def fake_scan_console_profile_markets(**_kwargs):
        return SimpleNamespace(
            source_label="test",
            source_url="https://example.com",
            accepted=markets,
            rejected=[],
            total_candidates=len(markets),
        )

    async def fake_refresh_execution_quote(*, slug: str | None, side: str):
        market = next(item for item in markets if item.slug == slug)
        return SimpleNamespace(
            market=market,
            current_price_cents=market.current_no_odds,
            spread_cents=2,
        )

    def fake_run_llm_consensus(market, *_args, **_kwargs):
        reviewed_slugs.append(market.slug)
        return _fake_llm_consensus(fair_yes=8, fair_no=92)

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
        fake_run_llm_consensus,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_execution_quote",
        fake_refresh_execution_quote,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_balance",
        _fake_ready_balance,
    )

    result = await BullpenAutoLiveEngine().execute(
        user_id=7,
        settings=BullpenAutoLiveSettings(
            strategy_profile=CONSOLE_PROFILE_ID,
            auto_live_enabled=True,
            dry_run=True,
            max_llm_candidates_per_run=2,
            console_llm_targets=[
                BullpenAutoLiveLlmTarget(provider="openai", model="gpt-4o-mini")
            ],
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

    assert reviewed_slugs == [
        "stage-2-cap-0",
        "stage-2-cap-1",
        "stage-2-cap-2",
        "stage-2-cap-3",
        "stage-2-cap-4",
    ]
    assert llm_stage.outputs["llm_candidate_count"] == 5
    assert llm_stage.outputs["llm_candidate_count_before_cap"] == 5
    assert llm_stage.outputs["max_llm_candidates_per_run"] == 5
    assert llm_stage.outputs["configured_max_llm_candidates_per_run"] == 2
    assert llm_stage.outputs["llm_candidates_skipped_by_cap"] == 0
    assert llm_stage.outputs["stage2_universe_complete"] is True


@pytest.mark.anyio
async def test_console_profile_shared_stage_2_path_uses_saved_execution_settings(
    monkeypatch,
):
    fixed_now = datetime(2026, 6, 21, 0, 0, tzinfo=UTC)
    candidate_market = _market(
        question="Will the shared Stage 2 path use the saved settings?",
        slug="shared-stage-2-settings",
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

    async def fake_refresh_balance():
        return SimpleNamespace(
            status="ready",
            available_balance_usd=50.0,
            account_value_usd=50.0,
            message="Balance ready",
        )

    async def fake_execute_console_stage_two_shared_llm(
        *,
        llm_markets,
        rules_by_market_id,
        settings,
        now,
        target_progress_callback=None,
    ):
        if target_progress_callback is not None:
            target_progress_callback(
                1,
                [
                    {
                        "provider": "openai",
                        "model": "gpt-test",
                        "status": "completed",
                        "usable_event_count": 1,
                    }
                ],
            )
        assert now == fixed_now
        assert len(llm_markets) == 1
        assert rules_by_market_id[candidate_market.market_id].hours_remaining == 96
        assert settings.llm_execution_mode == "single_combined"
        assert settings.llm_events_per_prompt == 7
        assert (
            settings.console_llm_prompt_template
            == "Saved Stage 2 prompt {{SELECTED_QUESTIONS}}"
        )
        outputs, consensus = _fake_llm_consensus(fair_yes=8, fair_no=92)
        return ConsoleStageTwoSharedReview(
            prepared_payload_by_market_id={
                candidate_market.market_id: PolymarketEventQuestionPayload(
                    question_ref="Q1",
                    question_id=candidate_market.market_id,
                    market_id=candidate_market.market_id,
                    question=candidate_market.question,
                    close_time=candidate_market.close_time,
                    current_time_utc=fixed_now.isoformat(),
                    current_time_et=fixed_now.isoformat(),
                    deadline_et="2026-06-24 08:00:00 PM ET",
                    hours_remaining=96,
                    category=candidate_market.theme,
                    outcomes=["Yes", "No"],
                    current_yes_odds=12,
                    current_no_odds=88,
                    market_url=candidate_market.market_url,
                    slug=candidate_market.slug,
                    polymarket_rules=(
                        'This market will resolve to "Yes" if candidate X wins by the deadline.'
                    ),
                    preflight_evidence_block="Verified Evidence Block:",
                )
            },
            question_runtime_by_market_id={
                candidate_market.market_id: {
                    "question_id": candidate_market.market_id,
                    "preflight_evidence_block": "Verified Evidence Block:",
                }
            },
            outputs_by_market_id={candidate_market.market_id: outputs},
            consensus_by_market_id={candidate_market.market_id: consensus},
            execution_options=BullpenLlmExecutionOptions(
                execution_mode="single_combined",
                events_per_prompt=7,
                target_count=1,
                prompt_template_hash="shared-stage-2-hash",
            ),
                runtime_outputs={
                    "llm_execution_mode": "single_combined",
                    "llm_events_per_prompt": 7,
                    "llm_target_count": 1,
                    "llm_provider_target_count": 1,
                    "llm_selected_target_count": 1,
                    "llm_started_provider_target_count": 1,
                    "llm_completed_provider_target_count": 1,
                    "llm_usable_provider_target_count": 1,
                    "llm_passed_provider_target_count": 1,
                    "llm_failed_provider_target_count": 0,
                    "llm_prompt_template_hash": "shared-stage-2-hash",
                    "llm_primary_request_count": 1,
                    "llm_retry_request_count": 0,
                "llm_recovery_batch_count": 0,
                "llm_failed_event_count": 0,
                "llm_invalid_event_count": 0,
                "llm_blocked_event_count": 0,
                "llm_max_observed_concurrency": 1,
                "llm_target_runs": [
                        {
                            "provider": "openai",
                            "model": "gpt-4o-mini",
                            "status": "completed",
                            "usable_event_count": 1,
                            "primary_request_count": 1,
                        }
                    ],
                },
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
        lambda *_args, **_kwargs: 9.0,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.evaluate_market_rules",
        lambda *_args, **_kwargs: _fake_rules(hours_remaining=96),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_execution_quote",
        fake_refresh_execution_quote,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_balance",
        fake_refresh_balance,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.resolve_auto_live_llm_targets",
        lambda _settings: [("openai", "gpt-4o-mini")],
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine._execute_console_stage_two_shared_llm",
        fake_execute_console_stage_two_shared_llm,
    )

    result = await BullpenAutoLiveEngine().execute(
        user_id=7,
        settings=BullpenAutoLiveSettings(
            strategy_profile=CONSOLE_PROFILE_ID,
            auto_live_enabled=True,
            dry_run=True,
            llm_execution_mode="single_combined",
            llm_events_per_prompt=7,
            console_llm_prompt_template="Saved Stage 2 prompt {{SELECTED_QUESTIONS}}",
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

    assert llm_stage.outputs["llm_execution_mode"] == "single_combined"
    assert llm_stage.outputs["llm_events_per_prompt"] == 7
    assert llm_stage.outputs["llm_primary_request_count"] == 1
    assert llm_stage.outputs["llm_completed_provider_target_count"] == 1
    assert (
        llm_stage.outputs["llm_prompt_template"]
        == "Saved Stage 2 prompt {{SELECTED_QUESTIONS}}"
    )
    assert llm_stage.outputs["llm_prompt_template_hash"] == "shared-stage-2-hash"
    assert llm_stage.outputs["llm_reviewed_candidates"][0]["prepared_question_payload"][
        "market_id"
    ] == candidate_market.market_id
    assert result.run.orders_planned == 1


@pytest.mark.anyio
async def test_shared_stage_2_creates_one_child_execution_per_selected_target(
    monkeypatch,
):
    fixed_now = datetime(2026, 6, 21, 0, 0, tzinfo=UTC)
    candidate_market = _market(
        question="Will four selected models create four Stage 2 executions?",
        slug="four-stage-2-targets",
        current_yes_odds=12,
        current_no_odds=88,
    )
    settings = BullpenAutoLiveSettings(
        strategy_profile=CONSOLE_PROFILE_ID,
        console_llm_targets=[
            BullpenAutoLiveLlmTarget(provider="deepseek", model="deepseek-v4-flash"),
            BullpenAutoLiveLlmTarget(provider="deepseek", model="deepseek-reasoner"),
            BullpenAutoLiveLlmTarget(provider="deepseek", model="deepseek-chat"),
            BullpenAutoLiveLlmTarget(provider="deepseek", model="deepseek-coder"),
        ],
        llm_execution_mode="single_combined",
    )
    llm_markets = [
        {
            "kind": "candidate",
            "market": candidate_market,
            "returns_per_day": 9.0,
        }
    ]
    rules_by_market_id = {
        candidate_market.market_id: _fake_rules(hours_remaining=96)
    }
    target_calls: list[tuple[str, str]] = []

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.prepare_polymarket_event_context",
        lambda context: PreparedPolymarketEventContext(
            question_payload=context.question_payload,
            runtime_metadata={
                "question_runtime": {
                    candidate_market.market_id: {
                        "question_id": candidate_market.market_id,
                        "question": candidate_market.question,
                    }
                }
            },
        ),
    )

    def fake_execute_bullpen_llm_target(
        _context,
        *,
        provider_name: str,
        model_name: str,
        prepared_context,
    ):
        target_calls.append((provider_name, model_name))
        event_id = str(
            prepared_context.question_payload[0].market_id
            or prepared_context.question_payload[0].question_id
        )
        row = ParsedBullpenMarketRow(
            event_id=event_id,
            record={"event_id": event_id},
            question_ref=prepared_context.question_payload[0].question_ref,
            question_id=prepared_context.question_payload[0].question_id,
            market_id=prepared_context.question_payload[0].market_id,
            question=prepared_context.question_payload[0].question,
            llm_yes_odds=91.0,
            llm_no_odds=9.0,
            yes_definition="candidate X wins by the deadline",
            deadline_et="2026-06-24 08:00:00 PM ET",
            deadline_utc="2026-06-24T20:00:00+00:00",
            resolution_timezone="America/New_York",
            hours_remaining=96.0,
            evidence_status="Strong",
            event_state="scheduled_not_occurred",
            confidence="High",
            key_evidence=[],
            key_evidence_source_ids=[],
            red_flags=[],
            rationale="Usable odds returned for Stage 2.",
        )
        event_result = BullpenLlmEventProviderResult(
            event_id=event_id,
            provider=provider_name,
            model=model_name,
            status="success",
            row=row,
        )
        return BullpenLlmTargetExecutionResult(
            provider=provider_name,
            model=model_name,
            response_text=json.dumps(
                {
                    "markets": [
                        {
                            "event_id": event_id,
                            "llm_yes_odds": 91,
                            "llm_no_odds": 9,
                        }
                    ]
                }
            ),
            runtime_metadata={
                "llm_model": model_name,
                "llm_batches": [],
                "question_runtime": {
                    candidate_market.market_id: {
                        "question_id": candidate_market.market_id,
                        "question": candidate_market.question,
                    }
                },
            },
            event_results={event_id: event_result},
            batch_metadata=[],
            status="completed",
            tokens_in=100,
            tokens_out=25,
            estimated_cost=0.01,
            web_search_used=False,
            web_search_queries=[],
            web_sources=[],
            primary_request_count=1,
            retry_request_count=0,
            recovery_batch_count=0,
            recovered_event_count=0,
            failed_event_count=0,
            blocked_event_count=0,
            invalid_event_count=0,
            max_observed_concurrency=1,
            prompt_size_estimates=[],
        )

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.execute_bullpen_llm_target",
        fake_execute_bullpen_llm_target,
    )

    review = await _execute_console_stage_two_shared_llm(
        llm_markets=llm_markets,
        rules_by_market_id=rules_by_market_id,
        settings=settings,
        now=fixed_now,
    )

    expected_targets = {
        ("deepseek", "deepseek-v4-flash"),
        ("deepseek", "deepseek-reasoner"),
        ("deepseek", "deepseek-chat"),
        ("deepseek", "deepseek-coder"),
    }
    assert set(target_calls) == expected_targets
    assert review.runtime_outputs["llm_selected_target_count"] == 4
    assert review.runtime_outputs["llm_completed_provider_target_count"] == 4
    assert review.runtime_outputs["llm_usable_provider_target_count"] == 4
    assert review.runtime_outputs["llm_failed_provider_target_count"] == 0
    assert {
        (row["provider"], row["model"])
        for row in review.runtime_outputs["llm_target_runs"]
    } == expected_targets
    assert all(
        row["response_text"] and row["usable_event_count"] == 1
        for row in review.runtime_outputs["llm_target_runs"]
    )


@pytest.mark.anyio
async def test_console_profile_stage_2_uses_frozen_run_target_snapshot_after_restart(
    monkeypatch,
):
    fixed_now = datetime(2026, 6, 21, 0, 0, tzinfo=UTC)
    candidate_market = _market(
        question="Will the run keep its frozen Stage 2 targets after settings change?",
        slug="frozen-stage-2-targets",
        current_yes_odds=12,
        current_no_odds=88,
    )
    frozen_targets = [
        BullpenAutoLiveLlmTarget(provider="deepseek", model="deepseek-v4-flash"),
        BullpenAutoLiveLlmTarget(provider="deepseek", model="deepseek-reasoner"),
        BullpenAutoLiveLlmTarget(provider="deepseek", model="deepseek-chat"),
        BullpenAutoLiveLlmTarget(provider="deepseek", model="deepseek-coder"),
    ]

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

    async def fake_shared_review(
        *,
        llm_markets,
        rules_by_market_id,
        settings,
        now,
        target_progress_callback=None,
    ):
        if target_progress_callback is not None:
            target_progress_callback(
                4,
                [
                    {
                        "provider": target.provider,
                        "model": target.model,
                        "status": "completed",
                        "usable_event_count": 1,
                    }
                    for target in frozen_targets
                ],
            )
        assert now == fixed_now
        assert len(llm_markets) == 1
        assert rules_by_market_id[candidate_market.market_id].hours_remaining == 96
        assert [
            (target.provider, target.model)
            for target in settings.console_llm_targets
        ] == [
            (target.provider, target.model) for target in frozen_targets
        ]
        outputs = [
            BullpenAutoLiveLlmOutput(
                provider=target.provider,
                model=target.model,
                llm_yes_odds=90.0,
                llm_no_odds=10.0,
                confidence="High",
                evidence_status="Strong",
                event_state="scheduled_not_occurred",
                rationale="Frozen target returned usable odds.",
                completed_at=fixed_now.isoformat(),
            )
            for target in frozen_targets
        ]
        _, consensus = _fake_llm_consensus(fair_yes=90, fair_no=10)
        return ConsoleStageTwoSharedReview(
            prepared_payload_by_market_id={
                candidate_market.market_id: PolymarketEventQuestionPayload(
                    question_ref="Q1",
                    question_id=candidate_market.market_id,
                    market_id=candidate_market.market_id,
                    question=candidate_market.question,
                    close_time=candidate_market.close_time,
                    current_time_utc=fixed_now.isoformat(),
                    current_time_et=fixed_now.isoformat(),
                    deadline_et="2026-06-24 08:00:00 PM ET",
                    hours_remaining=96,
                    category=candidate_market.theme,
                    outcomes=["Yes", "No"],
                    current_yes_odds=12,
                    current_no_odds=88,
                    market_url=candidate_market.market_url,
                    slug=candidate_market.slug,
                    polymarket_rules=(
                        'This market will resolve to "Yes" if candidate X wins by the deadline.'
                    ),
                )
            },
            question_runtime_by_market_id={candidate_market.market_id: {}},
            outputs_by_market_id={candidate_market.market_id: outputs},
            consensus_by_market_id={candidate_market.market_id: consensus},
            execution_options=BullpenLlmExecutionOptions(
                execution_mode="single_combined",
                events_per_prompt=20,
                target_count=4,
                prompt_template_hash="frozen-stage-2-hash",
            ),
            runtime_outputs={
                "llm_execution_mode": "single_combined",
                "llm_events_per_prompt": 20,
                "llm_target_count": 4,
                "llm_provider_target_count": 4,
                "llm_selected_target_count": 4,
                "llm_started_provider_target_count": 4,
                "llm_completed_provider_target_count": 4,
                "llm_usable_provider_target_count": 4,
                "llm_passed_provider_target_count": 4,
                "llm_failed_provider_target_count": 0,
                "llm_prompt_template_hash": "frozen-stage-2-hash",
                "llm_target_runs": [
                    {
                        "provider": target.provider,
                        "model": target.model,
                        "status": "completed",
                        "usable_event_count": 1,
                    }
                    for target in frozen_targets
                ],
            },
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
        lambda *_args, **_kwargs: 9.0,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.evaluate_market_rules",
        lambda *_args, **_kwargs: _fake_rules(hours_remaining=96),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_execution_quote",
        fake_refresh_execution_quote,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_balance",
        _fake_ready_balance,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine._execute_console_stage_two_shared_llm",
        fake_shared_review,
    )

    result = await BullpenAutoLiveEngine().execute(
        user_id=7,
        settings=BullpenAutoLiveSettings(
            strategy_profile=CONSOLE_PROFILE_ID,
            auto_live_enabled=True,
            dry_run=True,
            console_llm_targets=[
                BullpenAutoLiveLlmTarget(provider="openai", model="gpt-4o-mini")
            ],
        ),
        state=BullpenAutoLiveState(running=True),
        run=_run_snapshot(stage2_llm_targets_snapshot=frozen_targets),
        positions=[],
        historical_decisions=[],
    )

    llm_stage = next(
        stage
        for stage in result.run.stage_results
        if stage.outputs.get("workflow_stage_key") == "llm"
    )

    assert llm_stage.outputs["llm_target_snapshot_source"] == "run_snapshot"
    assert llm_stage.outputs["llm_selected_target_count"] == 4
    assert llm_stage.outputs["llm_usable_provider_target_count"] == 4
    assert llm_stage.outputs["llm_targets"] == [
        {"provider": target.provider, "model": target.model}
        for target in frozen_targets
    ]


@pytest.mark.anyio
async def test_console_profile_stage_2_fails_clearly_when_frozen_targets_are_empty(
    monkeypatch,
):
    fixed_now = datetime(2026, 6, 21, 0, 0, tzinfo=UTC)
    candidate_market = _market(
        question="Will Stage 2 fail when no targets are frozen?",
        slug="empty-stage-2-targets",
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

    async def fail_shared_review(**_kwargs):
        raise AssertionError("Stage 2 shared execution should not run without targets")

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
        "app.domains.polymarket_auto_live.engine.refresh_execution_quote",
        fake_refresh_execution_quote,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_balance",
        _fake_ready_balance,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine._execute_console_stage_two_shared_llm",
        fail_shared_review,
    )

    result = await BullpenAutoLiveEngine().execute(
        user_id=7,
        settings=BullpenAutoLiveSettings(
            strategy_profile=CONSOLE_PROFILE_ID,
            auto_live_enabled=True,
            dry_run=True,
            console_llm_targets=[
                BullpenAutoLiveLlmTarget(provider="openai", model="gpt-4o-mini")
            ],
        ),
        state=BullpenAutoLiveState(running=True),
        run=_run_snapshot(stage2_llm_targets_snapshot=[]),
        positions=[],
        historical_decisions=[],
    )

    llm_stage = next(
        stage
        for stage in result.run.stage_results
        if stage.outputs.get("workflow_stage_key") == "llm"
    )

    assert result.run.status == "failed"
    assert llm_stage.outputs["phase_status"] == "failed"
    assert llm_stage.status == "fail"
    assert "no llm targets were selected" in result.run.summary.lower()
    assert llm_stage.outputs["llm_target_runs"] == []
    assert not any(
        stage.outputs.get("workflow_stage_key") == "invest"
        for stage in result.run.stage_results
    )


@pytest.mark.anyio
async def test_console_profile_blocks_stage_2_and_stage_3_when_fresh_wallet_positions_fail(
    monkeypatch,
):
    fixed_now = datetime(2026, 6, 21, 0, 0, tzinfo=UTC)
    candidate_market = _market(
        question="Will Stage 1 wallet refresh failure block later stages?",
        slug="stage-1-wallet-refresh-failure",
        current_yes_odds=12,
        current_no_odds=88,
    )

    async def fake_read_console_wallet_positions():
        raise RuntimeError("fresh positions refresh failed")

    async def fake_scan_console_profile_markets(**_kwargs):
        return SimpleNamespace(
            source_label="test",
            source_url="https://example.com",
            accepted=[candidate_market],
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
        "app.domains.polymarket_auto_live.engine.refresh_balance",
        _fake_ready_balance,
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

    stage1 = next(
        stage
        for stage in result.run.stage_results
        if stage.outputs.get("workflow_stage_key") == "scan"
    )
    stage2 = next(
        stage
        for stage in result.run.stage_results
        if stage.outputs.get("workflow_stage_key") == "llm"
    )
    stage3 = next(
        stage
        for stage in result.run.stage_results
        if stage.outputs.get("workflow_stage_key") == "invest"
    )

    assert result.run.status == "failed"
    assert result.decisions == []
    assert "could not refresh fresh bullpen wallet positions" in result.run.summary.lower()
    assert stage1.outputs["phase_status"] == "failed"
    assert stage2.outputs["phase_status"] == "blocked"
    assert stage3.outputs["phase_status"] == "blocked"
    assert stage2.outputs["blocked_by_stage1_wallet_refresh"] is True
    assert stage3.outputs["blocked_by_stage1_wallet_refresh"] is True


@pytest.mark.anyio
async def test_console_profile_stage_2_keeps_provider_and_parsing_failures_attributed_to_the_correct_model(
    monkeypatch,
):
    fixed_now = datetime(2026, 6, 21, 0, 0, tzinfo=UTC)
    candidate_market = _market(
        question="Will Stage 2 keep provider and parsing failures attributed?",
        slug="stage-2-error-attribution",
        current_yes_odds=12,
        current_no_odds=88,
    )
    frozen_targets = [
        BullpenAutoLiveLlmTarget(provider="deepseek", model="deepseek-v4-flash"),
        BullpenAutoLiveLlmTarget(provider="deepseek", model="deepseek-reasoner"),
        BullpenAutoLiveLlmTarget(provider="deepseek", model="deepseek-chat"),
        BullpenAutoLiveLlmTarget(provider="deepseek", model="deepseek-coder"),
    ]

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

    async def fake_shared_review(
        *,
        llm_markets,
        rules_by_market_id,
        settings,
        now,
        target_progress_callback=None,
    ):
        assert now == fixed_now
        assert len(llm_markets) == 1
        assert rules_by_market_id[candidate_market.market_id].hours_remaining == 96
        assert [
            (target.provider, target.model)
            for target in settings.console_llm_targets
        ] == [
            (target.provider, target.model) for target in frozen_targets
        ]
        if target_progress_callback is not None:
            target_progress_callback(
                4,
                [
                    {
                        "provider": "deepseek",
                        "model": "deepseek-v4-flash",
                        "status": "completed",
                        "usable_event_count": 1,
                    },
                    {
                        "provider": "deepseek",
                        "model": "deepseek-reasoner",
                        "status": "failed",
                        "usable_event_count": 0,
                        "error": "Provider timeout",
                    },
                    {
                        "provider": "deepseek",
                        "model": "deepseek-chat",
                        "status": "failed",
                        "usable_event_count": 0,
                        "error": "LLM response was not valid JSON.",
                    },
                    {
                        "provider": "deepseek",
                        "model": "deepseek-coder",
                        "status": "failed",
                        "usable_event_count": 0,
                        "error": "Response schema validation failed.",
                    },
                ],
            )
        outputs = [
            BullpenAutoLiveLlmOutput(
                provider="deepseek",
                model="deepseek-v4-flash",
                llm_yes_odds=91.0,
                llm_no_odds=9.0,
                confidence="High",
                evidence_status="Strong",
                event_state="scheduled_not_occurred",
                rationale="Usable odds.",
                completed_at=fixed_now.isoformat(),
            ),
            BullpenAutoLiveLlmOutput(
                provider="deepseek",
                model="deepseek-reasoner",
                error="Provider timeout",
                completed_at=fixed_now.isoformat(),
            ),
            BullpenAutoLiveLlmOutput(
                provider="deepseek",
                model="deepseek-chat",
                invalid_reason="LLM response was not valid JSON.",
                rationale="LLM response was not valid JSON.",
                completed_at=fixed_now.isoformat(),
            ),
            BullpenAutoLiveLlmOutput(
                provider="deepseek",
                model="deepseek-coder",
                invalid_reason="Response schema validation failed.",
                rationale="Response schema validation failed.",
                completed_at=fixed_now.isoformat(),
            ),
        ]
        _, consensus = _fake_llm_consensus(fair_yes=91, fair_no=9)
        return ConsoleStageTwoSharedReview(
            prepared_payload_by_market_id={
                candidate_market.market_id: PolymarketEventQuestionPayload(
                    question_ref="Q1",
                    question_id=candidate_market.market_id,
                    market_id=candidate_market.market_id,
                    question=candidate_market.question,
                    close_time=candidate_market.close_time,
                    current_time_utc=fixed_now.isoformat(),
                    current_time_et=fixed_now.isoformat(),
                    deadline_et="2026-06-24 08:00:00 PM ET",
                    hours_remaining=96,
                    category=candidate_market.theme,
                    outcomes=["Yes", "No"],
                    current_yes_odds=12,
                    current_no_odds=88,
                    market_url=candidate_market.market_url,
                    slug=candidate_market.slug,
                    polymarket_rules=(
                        'This market will resolve to "Yes" if candidate X wins by the deadline.'
                    ),
                )
            },
            question_runtime_by_market_id={candidate_market.market_id: {}},
            outputs_by_market_id={candidate_market.market_id: outputs},
            consensus_by_market_id={candidate_market.market_id: consensus},
            execution_options=BullpenLlmExecutionOptions(
                execution_mode="single_combined",
                events_per_prompt=20,
                target_count=4,
                prompt_template_hash="stage-2-attr-hash",
            ),
            runtime_outputs={
                "llm_execution_mode": "single_combined",
                "llm_events_per_prompt": 20,
                "llm_target_count": 4,
                "llm_provider_target_count": 4,
                "llm_selected_target_count": 4,
                "llm_started_provider_target_count": 4,
                "llm_completed_provider_target_count": 4,
                "llm_usable_provider_target_count": 1,
                "llm_passed_provider_target_count": 1,
                "llm_failed_provider_target_count": 3,
                "llm_prompt_template_hash": "stage-2-attr-hash",
                "llm_target_runs": [
                    {
                        "provider": "deepseek",
                        "model": "deepseek-v4-flash",
                        "status": "completed",
                        "usable_event_count": 1,
                        "response_text": "{\"markets\":[{\"llm_yes_odds\":91,\"llm_no_odds\":9}]}",
                        "event_outputs": [
                            {
                                "market_id": candidate_market.market_id,
                                "question_id": candidate_market.market_id,
                                "output": outputs[0].model_dump(mode="json"),
                            }
                        ],
                    },
                    {
                        "provider": "deepseek",
                        "model": "deepseek-reasoner",
                        "status": "failed",
                        "usable_event_count": 0,
                        "error": "Provider timeout",
                        "failure_category": "provider_failed",
                        "response_text": None,
                        "event_outputs": [
                            {
                                "market_id": candidate_market.market_id,
                                "question_id": candidate_market.market_id,
                                "output": outputs[1].model_dump(mode="json"),
                            }
                        ],
                    },
                    {
                        "provider": "deepseek",
                        "model": "deepseek-chat",
                        "status": "failed",
                        "usable_event_count": 0,
                        "error": "LLM response was not valid JSON.",
                        "failure_category": "invalid_json",
                        "response_text": "{not-json",
                        "event_outputs": [
                            {
                                "market_id": candidate_market.market_id,
                                "question_id": candidate_market.market_id,
                                "output": outputs[2].model_dump(mode="json"),
                            }
                        ],
                    },
                    {
                        "provider": "deepseek",
                        "model": "deepseek-coder",
                        "status": "failed",
                        "usable_event_count": 0,
                        "error": "Response schema validation failed.",
                        "failure_category": "invalid_schema",
                        "response_text": "{\"markets\":[{\"missing\":true}]}",
                        "event_outputs": [
                            {
                                "market_id": candidate_market.market_id,
                                "question_id": candidate_market.market_id,
                                "output": outputs[3].model_dump(mode="json"),
                            }
                        ],
                    },
                ],
            },
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
        lambda *_args, **_kwargs: 9.0,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.evaluate_market_rules",
        lambda *_args, **_kwargs: _fake_rules(hours_remaining=96),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_execution_quote",
        fake_refresh_execution_quote,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_balance",
        _fake_ready_balance,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine._execute_console_stage_two_shared_llm",
        fake_shared_review,
    )

    result = await BullpenAutoLiveEngine().execute(
        user_id=7,
        settings=BullpenAutoLiveSettings(
            strategy_profile=CONSOLE_PROFILE_ID,
            auto_live_enabled=True,
            dry_run=True,
            console_llm_targets=[
                BullpenAutoLiveLlmTarget(provider="openai", model="gpt-4o-mini")
            ],
        ),
        state=BullpenAutoLiveState(running=True),
        run=_run_snapshot(stage2_llm_targets_snapshot=frozen_targets),
        positions=[],
        historical_decisions=[],
    )

    llm_stage = next(
        stage
        for stage in result.run.stage_results
        if stage.outputs.get("workflow_stage_key") == "llm"
    )
    reviewed_row = llm_stage.outputs["llm_reviewed_candidates"][0]
    outputs_by_model = {
        output["model"]: output for output in reviewed_row["llm_outputs"]
    }

    assert llm_stage.outputs["phase_status"] == "partial"
    assert llm_stage.outputs["llm_selected_target_count"] == 4
    assert llm_stage.outputs["llm_usable_provider_target_count"] == 1
    assert llm_stage.outputs["llm_failed_provider_target_count"] == 3
    assert outputs_by_model["deepseek-reasoner"]["error"] == "Provider timeout"
    assert (
        outputs_by_model["deepseek-chat"]["invalid_reason"]
        == "LLM response was not valid JSON."
    )
    assert (
        outputs_by_model["deepseek-coder"]["invalid_reason"]
        == "Response schema validation failed."
    )
    assert result.run.status == "completed"
    assert any(
        stage.outputs.get("workflow_stage_key") == "invest"
        for stage in result.run.stage_results
    )


@pytest.mark.anyio
async def test_console_profile_stage_2_wrapper_completion_cannot_fake_success_or_start_stage3(
    monkeypatch,
):
    fixed_now = datetime(2026, 6, 21, 0, 0, tzinfo=UTC)
    candidate_market = _market(
        question="Will wrapper completion stay blocked without usable model outputs?",
        slug="wrapper-completion-cannot-fake-success",
        current_yes_odds=12,
        current_no_odds=88,
    )
    frozen_targets = [
        BullpenAutoLiveLlmTarget(provider="deepseek", model="deepseek-v4-flash"),
        BullpenAutoLiveLlmTarget(provider="deepseek", model="deepseek-reasoner"),
        BullpenAutoLiveLlmTarget(provider="deepseek", model="deepseek-chat"),
        BullpenAutoLiveLlmTarget(provider="deepseek", model="deepseek-coder"),
    ]

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

    async def fake_shared_review(
        *,
        llm_markets,
        rules_by_market_id,
        settings,
        now,
        target_progress_callback=None,
    ):
        assert now == fixed_now
        assert len(llm_markets) == 1
        assert rules_by_market_id[candidate_market.market_id].hours_remaining == 96
        assert [
            (target.provider, target.model)
            for target in settings.console_llm_targets
        ] == [
            (target.provider, target.model) for target in frozen_targets
        ]
        if target_progress_callback is not None:
            target_progress_callback(
                1,
                [{"status": "completed"}],
            )
        return ConsoleStageTwoSharedReview(
            prepared_payload_by_market_id={},
            question_runtime_by_market_id={candidate_market.market_id: {}},
            outputs_by_market_id={
                candidate_market.market_id: [
                    BullpenAutoLiveLlmOutput(
                        provider="deepseek",
                        model="deepseek-v4-flash",
                        error="Provider returned no usable probability.",
                        completed_at=fixed_now.isoformat(),
                    )
                ]
            },
            consensus_by_market_id={
                candidate_market.market_id: SimpleNamespace(
                    fair_yes_probability_pct=None,
                    fair_no_probability_pct=None,
                    disagreement_level=None,
                    disagreement_category=None,
                    adjudication_required=True,
                    confidence=None,
                    evidence_status=None,
                    event_state=None,
                )
            },
            execution_options=BullpenLlmExecutionOptions(
                execution_mode="single_combined",
                events_per_prompt=20,
                target_count=4,
                prompt_template_hash="wrapper-completion-hash",
            ),
            runtime_outputs={
                "llm_execution_mode": "single_combined",
                "llm_events_per_prompt": 20,
                "llm_target_count": 4,
                "llm_provider_target_count": 4,
                "llm_selected_target_count": 4,
                "llm_started_provider_target_count": 1,
                "llm_completed_provider_target_count": 1,
                "llm_usable_provider_target_count": 0,
                "llm_passed_provider_target_count": 0,
                "llm_failed_provider_target_count": 1,
                "llm_prompt_template_hash": "wrapper-completion-hash",
                "llm_target_runs": [{"status": "completed"}],
            },
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
        lambda *_args, **_kwargs: 9.0,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.evaluate_market_rules",
        lambda *_args, **_kwargs: _fake_rules(hours_remaining=96),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_execution_quote",
        fake_refresh_execution_quote,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_balance",
        _fake_ready_balance,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine._execute_console_stage_two_shared_llm",
        fake_shared_review,
    )

    result = await BullpenAutoLiveEngine().execute(
        user_id=7,
        settings=BullpenAutoLiveSettings(
            strategy_profile=CONSOLE_PROFILE_ID,
            auto_live_enabled=True,
            dry_run=True,
            console_llm_targets=[
                BullpenAutoLiveLlmTarget(provider="openai", model="gpt-4o-mini")
            ],
        ),
        state=BullpenAutoLiveState(running=True),
        run=_run_snapshot(stage2_llm_targets_snapshot=frozen_targets),
        positions=[],
        historical_decisions=[],
    )

    llm_stage = next(
        stage
        for stage in result.run.stage_results
        if stage.outputs.get("workflow_stage_key") == "llm"
    )

    assert result.run.status == "failed"
    assert llm_stage.outputs["phase_status"] == "failed"
    assert llm_stage.outputs["llm_selected_target_count"] == 4
    assert llm_stage.outputs["llm_completed_provider_target_count"] == 1
    assert llm_stage.outputs["llm_usable_provider_target_count"] == 0
    assert llm_stage.outputs["llm_failed_provider_target_count"] == 1
    assert "no selected llm target produced a usable probability estimate" in result.run.summary.lower()
    assert not any(
        stage.outputs.get("workflow_stage_key") == "invest"
        for stage in result.run.stage_results
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
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_balance",
        _fake_ready_balance,
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
async def test_console_profile_sizes_new_buys_from_cash_and_active_positions(
    monkeypatch,
):
    fixed_now = datetime(2026, 6, 21, 0, 0, tzinfo=UTC)
    candidate_market = _market(
        question="Will the dynamic console trade amount be used?",
        slug="dynamic-console-order-amount",
        current_yes_odds=12,
        current_no_odds=88,
    )

    async def fake_read_console_wallet_positions():
        return [
            _console_wallet_position(
                slug="existing-active-position",
                market_title="Existing active position",
                current_price_cents=61,
                exposure_usd=5.0,
            )
        ]

    async def fake_refresh_balance():
        return SimpleNamespace(
            status="ready",
            message="Balance ready",
            available_balance_usd=14.77,
        )

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
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_balance",
        fake_refresh_balance,
    )

    result = await BullpenAutoLiveEngine().execute(
        user_id=7,
        settings=BullpenAutoLiveSettings(
            strategy_profile=CONSOLE_PROFILE_ID,
            auto_live_enabled=True,
            dry_run=True,
            console_order_usd=12.75,
        ),
        state=BullpenAutoLiveState(running=True),
        run=_run_snapshot(),
        positions=[],
        historical_decisions=[],
    )

    buy_decision = next(
        decision for decision in result.decisions if decision.decision == "BUY_NEW"
    )
    stage5 = next(
        stage for stage in buy_decision.stage_results if stage.stage_number == 5
    )

    assert stage5.outputs["order_usd"] == 1.64
    assert stage5.outputs["cash_in_hand_usd"] == 14.77
    assert stage5.outputs["active_positions"] == 1
    assert stage5.outputs["available_slots"] == 9
    assert stage5.reason == (
        "Ranked candidate received a post-exit buy plan using fresh cash and occupied-slot counts."
    )
    assert buy_decision.target_exposure_usd == 1.64
    assert buy_decision.order_plan is not None
    assert buy_decision.order_plan.order_size_usd == 1.64
    assert result.state.last_console_trade_amount_usd == 1.64


@pytest.mark.anyio
async def test_console_profile_stage_3_progress_exposes_live_decision_rows_for_wide_spread_orders(
    monkeypatch,
):
    fixed_now = datetime(2026, 6, 21, 0, 0, tzinfo=UTC)
    candidate_market = _market(
        question="Will the Stage 3 popup surface the skip reason?",
        slug="stage-3-skip-reason-candidate",
        current_yes_odds=18,
        current_no_odds=82,
    )
    progress_runs: list[BullpenAutoLiveRun] = []
    executor_calls: list[dict[str, object]] = []

    class RecordingExecutor:
        async def buy_limit(self, **kwargs):
            executor_calls.append(kwargs)
            return "buy-limit-submitted"

        async def sell_limit(self, **_kwargs):
            raise AssertionError("sell_limit should not run for this buy-only scenario")

    async def fake_read_console_wallet_positions():
        return []

    async def fake_scan_console_profile_markets(**_kwargs):
        return SimpleNamespace(
            source_label="Bullpen console",
            source_url="https://example.com/bullpen",
            accepted=[candidate_market],
            rejected=[],
            total_candidates=1,
        )

    async def fake_refresh_live_controls(*, user_id: int):
        assert user_id == 7
        return _fake_live_controls()

    async def fake_refresh_balance():
        return SimpleNamespace(
            status="ready",
            message="Balance ready",
            available_balance_usd=50.0,
            account_value_usd=50.0,
        )

    async def fake_refresh_execution_quote(*, slug: str | None, side: str):
        assert slug == candidate_market.slug
        assert side == "NO"
        return SimpleNamespace(
            market=candidate_market,
            current_price_cents=82,
            spread_cents=9,
        )

    monkeypatch.setenv("BULLPEN_AUTO_LIVE_ALLOW_EXECUTION", "true")
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
        "app.domains.polymarket_auto_live.engine._should_use_legacy_console_stage_two_path",
        lambda: False,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine._execute_console_stage_two_shared_llm",
        _fake_console_stage_two_shared_review(
            fixed_now=fixed_now,
            fair_yes=8,
            fair_no=92,
        ),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_live_controls",
        fake_refresh_live_controls,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_execution_quote",
        fake_refresh_execution_quote,
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
        settings=BullpenAutoLiveSettings(
            strategy_profile=CONSOLE_PROFILE_ID,
            auto_live_enabled=True,
            dry_run=False,
            allow_live_execution=True,
            require_manual_confirmation=False,
            console_llm_targets=[
                BullpenAutoLiveLlmTarget(provider="openai", model="gpt-4o-mini")
            ],
        ),
        state=BullpenAutoLiveState(running=True),
        run=_run_snapshot(dry_run=False),
        positions=[],
        historical_decisions=[],
        progress_callback=lambda current_run, _state: progress_runs.append(
            current_run.model_copy(deep=True)
        ),
    )

    invest_running_stage_with_decision_rows = next(
        stage
        for snapshot in progress_runs
        for stage in snapshot.stage_results
        if stage.outputs.get("workflow_stage_key") == "invest"
        and stage.outputs.get("phase_status") == "running"
        and stage.outputs.get("orders_processed") == 1
    )

    decision_rows = invest_running_stage_with_decision_rows.outputs["decision_rows"]
    assert len(decision_rows) == 1
    assert decision_rows[0]["market_title"] == candidate_market.question
    assert decision_rows[0]["order_plan"]["status"] == "submitted"
    assert decision_rows[0]["order_plan"]["limit_price_cents"] == 99
    assert decision_rows[0]["order_plan"]["detail"] == "Limit order submitted successfully."

    invest_stage = next(
        stage
        for stage in result.run.stage_results
        if stage.outputs.get("workflow_stage_key") == "invest"
    )
    assert invest_stage.outputs["decision_rows"][0]["order_plan"]["status"] == "submitted"
    assert result.decisions[0].order_plan is not None
    assert result.decisions[0].order_plan.status == "submitted"
    assert executor_calls == [
        {
            "market_id": candidate_market.market_id,
            "outcome": "No",
            "amount_usd": 5.0,
            "max_price": 0.99,
        }
    ]


@pytest.mark.anyio
async def test_console_profile_stage_3_sells_before_buys_and_reports_step_counters(
    monkeypatch,
):
    fixed_now = datetime(2026, 6, 21, 0, 0, tzinfo=UTC)
    active_market = _market(
        question="Will the active position be sold first?",
        slug="active-position-market",
        current_yes_odds=21,
        current_no_odds=79,
    )
    candidate_market = _market(
        question="Will the replacement position be bought second?",
        slug="candidate-market-step-2",
        current_yes_odds=16,
        current_no_odds=84,
    )
    live_positions = [
        _console_wallet_position(
            slug=active_market.slug,
            market_title=active_market.question,
            current_price_cents=79,
            exposure_usd=6.0,
            shares=7.5,
            side="NO",
        )
    ]
    market_lookup = {
        active_market.slug: active_market,
        candidate_market.slug: candidate_market,
    }
    progress_runs: list[BullpenAutoLiveRun] = []
    executor_calls: list[str] = []
    sell_limit_kwargs: list[dict[str, object]] = []

    wallet_reads = [live_positions, []]

    async def fake_read_console_wallet_positions():
        return wallet_reads.pop(0) if wallet_reads else []

    async def fake_scan_console_profile_markets(**_kwargs):
        return SimpleNamespace(
            source_label="Bullpen console",
            source_url="https://example.com/bullpen",
            accepted=[active_market, candidate_market],
            rejected=[],
            total_candidates=2,
        )

    async def fake_refresh_live_controls(*, user_id: int):
        assert user_id == 7
        return _fake_live_controls()

    async def fake_refresh_execution_quote(*, slug: str | None, side: str):
        market = market_lookup[slug]
        return SimpleNamespace(
            market=market,
            current_price_cents=(
                market.current_yes_odds if side == "YES" else market.current_no_odds
            ),
            spread_cents=2,
        )

    async def fake_refresh_balance():
        return SimpleNamespace(
            status="ready",
            available_balance_usd=55.0,
            account_value_usd=55.0,
            message="Balance ready",
        )

    class RecordingExecutor:
        async def buy_limit(self, **_kwargs):
            executor_calls.append("buy_limit")
            return "buy-limit-submitted"

        async def sell_limit(self, **kwargs):
            executor_calls.append("sell_limit")
            sell_limit_kwargs.append(kwargs)
            return json.dumps({"orderId": "sell-order-1", "status": "submitted"})

        async def poll_order(self, **kwargs):
            assert kwargs["order_id"] == "sell-order-1"
            return {
                "orderId": "sell-order-1",
                "status": "filled",
                "filledShares": 7.5,
                "remainingShares": 0,
            }

    monkeypatch.setenv("BULLPEN_AUTO_LIVE_ALLOW_EXECUTION", "true")
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.CONSOLE_RANKED_EVENT_LIMIT",
        1,
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
        "app.domains.polymarket_auto_live.engine.position_returns_per_day",
        lambda position, now: 1.0 if position.slug == active_market.slug else 0.5,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.candidate_returns_per_day",
        lambda market, now: 9.0 if market.slug == candidate_market.slug else 0.5,
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
        "app.domains.polymarket_auto_live.engine._should_use_legacy_console_stage_two_path",
        lambda: False,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine._execute_console_stage_two_shared_llm",
        _fake_console_stage_two_shared_review(
            fixed_now=fixed_now,
            fair_yes=92,
            fair_no=8,
        ),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_live_controls",
        fake_refresh_live_controls,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_execution_quote",
        fake_refresh_execution_quote,
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
        settings=BullpenAutoLiveSettings(
            strategy_profile=CONSOLE_PROFILE_ID,
            auto_live_enabled=True,
            dry_run=False,
            allow_live_execution=True,
            require_manual_confirmation=False,
            console_llm_targets=[
                BullpenAutoLiveLlmTarget(provider="openai", model="gpt-4o-mini")
            ],
        ),
        state=BullpenAutoLiveState(running=True),
        run=_run_snapshot(dry_run=False),
        positions=[],
        historical_decisions=[],
        progress_callback=lambda current_run, _state: progress_runs.append(
            current_run.model_copy(deep=True)
        ),
    )

    assert executor_calls == ["sell_limit", "buy_limit"]

    running_invest_stages = [
        stage
        for snapshot in progress_runs
        for stage in snapshot.stage_results
        if stage.outputs.get("workflow_stage_key") == "invest"
        and stage.outputs.get("phase_status") == "running"
    ]
    assert any(stage.outputs.get("execution_step_key") == "sell" for stage in running_invest_stages)
    assert any(stage.outputs.get("execution_step_key") == "buy" for stage in running_invest_stages)
    latest_running_invest_stage = running_invest_stages[-1]
    execution_steps = latest_running_invest_stage.outputs["execution_steps"]
    assert isinstance(execution_steps, list)
    assert execution_steps[0]["status"] == "completed"
    assert execution_steps[1]["status"] == "completed"
    assert execution_steps[1]["planned_orders"] == 1
    assert execution_steps[1]["processed_orders"] == 1
    assert execution_steps[1]["submitted_orders"] == 1
    assert sell_limit_kwargs[0]["max_reprice_attempts"] == 2

    invest_stage = next(
        stage
        for stage in result.run.stage_results
        if stage.outputs.get("workflow_stage_key") == "invest"
    )
    assert invest_stage.outputs["sell_orders_planned"] == 1
    assert invest_stage.outputs["sell_orders_processed"] == 1
    assert invest_stage.outputs["sell_orders_submitted"] == 1
    assert invest_stage.outputs["buy_orders_planned"] == 1
    assert invest_stage.outputs["buy_orders_processed"] == 1
    assert invest_stage.outputs["buy_orders_submitted"] == 1
    assert invest_stage.reason == (
        "Rebalance, Event Exit processing, and investment planning/execution finished for the ranked Bullpen table."
    )
    assert result.run.orders_planned == 2
    assert result.run.orders_submitted == 2


@pytest.mark.anyio
async def test_console_profile_stage_3_marks_run_failed_when_event_exit_order_is_not_submitted(
    monkeypatch,
):
    fixed_now = datetime(2026, 6, 21, 0, 0, tzinfo=UTC)
    active_market = _market(
        question="Will the active position fail to exit first?",
        slug="active-position-failed-exit",
        current_yes_odds=21,
        current_no_odds=79,
    )
    candidate_market = _market(
        question="Will the replacement position still buy second?",
        slug="candidate-market-after-failed-exit",
        current_yes_odds=16,
        current_no_odds=84,
    )
    live_positions = [
        _console_wallet_position(
            slug=active_market.slug,
            market_title=active_market.question,
            current_price_cents=79,
            exposure_usd=6.0,
            shares=7.5,
            side="NO",
        )
    ]
    market_lookup = {
        active_market.slug: active_market,
        candidate_market.slug: candidate_market,
    }
    executor_calls: list[str] = []

    async def fake_read_console_wallet_positions():
        return live_positions

    async def fake_scan_console_profile_markets(**_kwargs):
        return SimpleNamespace(
            source_label="Bullpen console",
            source_url="https://example.com/bullpen",
            accepted=[active_market, candidate_market],
            rejected=[],
            total_candidates=2,
        )

    async def fake_refresh_live_controls(*, user_id: int):
        assert user_id == 7
        return _fake_live_controls()

    async def fake_refresh_execution_quote(*, slug: str | None, side: str):
        market = market_lookup[slug]
        return SimpleNamespace(
            market=market,
            current_price_cents=(
                market.current_yes_odds if side == "YES" else market.current_no_odds
            ),
            spread_cents=2,
        )

    class RecordingExecutor:
        async def buy_limit(self, **_kwargs):
            executor_calls.append("buy_limit")
            return "buy-limit-submitted"

        async def sell_limit(self, **_kwargs):
            executor_calls.append("sell_limit")
            raise RuntimeError("Bullpen rejected the Event Exit sell order.")

    monkeypatch.setenv("BULLPEN_AUTO_LIVE_ALLOW_EXECUTION", "true")
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.CONSOLE_RANKED_EVENT_LIMIT",
        1,
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
        "app.domains.polymarket_auto_live.engine.position_returns_per_day",
        lambda position, now: 1.0 if position.slug == active_market.slug else 0.5,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.candidate_returns_per_day",
        lambda market, now: 9.0 if market.slug == candidate_market.slug else 0.5,
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
        "app.domains.polymarket_auto_live.engine._should_use_legacy_console_stage_two_path",
        lambda: False,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine._execute_console_stage_two_shared_llm",
        _fake_console_stage_two_shared_review(
            fixed_now=fixed_now,
            fair_yes=92,
            fair_no=8,
        ),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_live_controls",
        fake_refresh_live_controls,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_execution_quote",
        fake_refresh_execution_quote,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.bullpen_module.BullpenLiveExecutor",
        lambda: RecordingExecutor(),
    )

    result = await BullpenAutoLiveEngine().execute(
        user_id=7,
        settings=BullpenAutoLiveSettings(
            strategy_profile=CONSOLE_PROFILE_ID,
            auto_live_enabled=True,
            dry_run=False,
            allow_live_execution=True,
            require_manual_confirmation=False,
            console_llm_targets=[
                BullpenAutoLiveLlmTarget(provider="openai", model="gpt-4o-mini")
            ],
        ),
        state=BullpenAutoLiveState(running=True),
        run=_run_snapshot(dry_run=False),
        positions=[],
        historical_decisions=[],
    )

    assert executor_calls == ["sell_limit"]
    assert result.run.status == "failed"
    assert result.run.orders_planned == 1
    assert result.run.orders_submitted == 0
    assert "Will the active position fail to exit first?" in result.run.summary
    assert "was not confirmed" in result.run.summary
    assert result.state.last_error == result.run.summary

    invest_stage = next(
        stage
        for stage in result.run.stage_results
        if stage.outputs.get("workflow_stage_key") == "invest"
    )
    assert invest_stage.status == "fail"
    assert invest_stage.reason == result.run.summary
    assert invest_stage.outputs["orders_unsubmitted"] == 1
    assert invest_stage.outputs["sell_orders_unsubmitted"] == 1
    assert invest_stage.outputs["buy_orders_unsubmitted"] == 0
    assert (
        invest_stage.outputs["execution_failure_message"] == result.run.summary
    )
    buy_decision = next(
        decision for decision in result.decisions if decision.decision == "BUY_NEW"
    )
    assert buy_decision.order_plan is None
    assert any(
        marker in buy_decision.reason.lower()
        for marker in ("capacity", "cash", "refresh")
    )


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
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_balance",
        _fake_ready_balance,
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
async def test_console_profile_redeems_claimable_positions_without_llm(monkeypatch):
    fixed_now = datetime(2026, 7, 8, 12, 0, tzinfo=UTC)
    long_market_slug = (
        "gpt-56-released-by-july-7-2026-with-an-extra-long-market-identifier-"
        "to-cover-stage-3-persistence"
    )
    claimable_position = _console_wallet_position(
        slug=long_market_slug,
        market_title="GPT-5.6 released by July 7, 2026?",
        current_price_cents=100,
        shares=2.353,
        average_price_cents=85,
        exposure_usd=2.35,
        close_time="2026-07-07T00:00:00+00:00",
        side="NO",
        is_claimable=True,
        condition_id="condition-123",
    )
    calls: list[tuple[str, dict[str, object]]] = []

    async def fake_read_console_wallet_positions():
        return [claimable_position]

    async def fake_scan_console_profile_markets(**_kwargs):
        return SimpleNamespace(
            source_label="test",
            source_url="https://example.com",
            accepted=[],
            rejected=[],
            total_candidates=0,
        )

    async def fake_refresh_live_controls(**_kwargs):
        return _fake_live_controls()

    class RecordingExecutor:
        async def claim(self, **kwargs):
            calls.append(("claim", kwargs))
            return "claim submitted"

    async def fake_submit_scoped_redeem(**kwargs):
        calls.append(("redeem", kwargs))
        return SimpleNamespace(
            submitted_condition_ids=["condition-123"],
            submission_response="redeem submitted",
            outcomes=[
                SimpleNamespace(
                    condition_id="condition-123",
                    status="pending",
                    detail="Bullpen still shows a positive redeemable payout after an earlier submit.",
                )
            ],
        )

    async def fail_llm(*_args, **_kwargs):
        raise AssertionError("claimable positions must not run Stage 2 LLM review")

    monkeypatch.setenv("BULLPEN_AUTO_LIVE_ALLOW_EXECUTION", "true")
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.utc_now", lambda: fixed_now
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
        "app.domains.polymarket_auto_live.engine.refresh_live_controls",
        fake_refresh_live_controls,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.run_llm_consensus", fail_llm
    )
    async def fake_fetch_market_by_slug(_slug):
        return None

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.fetch_market_by_slug",
        fake_fetch_market_by_slug,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.bullpen_module.BullpenLiveExecutor",
        lambda: RecordingExecutor(),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.submit_scoped_redeem",
        fake_submit_scoped_redeem,
    )

    result = await BullpenAutoLiveEngine().execute(
        user_id=7,
        settings=BullpenAutoLiveSettings(
            strategy_profile=CONSOLE_PROFILE_ID,
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

    redeem_decision = next(
        decision
        for decision in result.decisions
        if decision.order_plan is not None and decision.order_plan.action == "redeem"
    )

    assert [name for name, _kwargs in calls] == ["redeem", "claim"]
    assert calls[0][1]["condition_ids"] == ["condition-123"]
    assert result.run.stage_results[0].outputs["active_position_rows_before_llm"] == 1
    assert result.run.stage_results[1].outputs["llm_candidate_count"] == 0
    invest_stage = next(
        stage for stage in result.run.stage_results if "redeem_planned" in stage.outputs
    )
    assert invest_stage.outputs["redeem_planned"] == 1
    assert invest_stage.outputs["redeem_submitted"] == 1
    assert len(redeem_decision.id) <= 64
    assert len(redeem_decision.order_plan.id) <= 64
    assert redeem_decision.order_plan.status == "settlement_pending"


@pytest.mark.anyio
async def test_console_profile_excludes_zero_payout_residues_from_stage3_counts(
    monkeypatch,
):
    fixed_now = datetime(2026, 7, 8, 12, 0, tzinfo=UTC)
    zero_payout_positions = []
    for index in range(6):
        position = _console_wallet_position(
            slug=f"resolved-zero-{index}",
            market_title=f"Resolved zero payout {index}",
            current_price_cents=0,
            shares=2 + index,
            average_price_cents=70,
            exposure_usd=5,
            close_time="2026-07-01T00:00:00+00:00",
            side="NO",
            is_claimable=False,
            condition_id=f"condition-zero-{index}",
        )
        position.classification = "resolved_zero_payout"
        position.classification_reason = "Resolved payout is explicitly zero."
        position.expected_payout_usdc = 0
        zero_payout_positions.append(position)

    async def fake_read_console_wallet_positions():
        return zero_payout_positions

    async def fake_scan_console_profile_markets(**_kwargs):
        return SimpleNamespace(
            source_label="test",
            source_url="https://example.com",
            accepted=[],
            rejected=[],
            total_candidates=0,
        )

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.utc_now", lambda: fixed_now
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

    stage_one = result.run.stage_results[0]
    stage_three = next(
        (
            stage
            for stage in result.run.stage_results
            if "redeem_planned" in stage.outputs
        ),
        None,
    )

    assert stage_one.outputs["active_position_rows_before_llm"] == 0
    assert stage_one.outputs["claimable_wallet_positions"] == 0
    assert stage_one.outputs["resolved_zero_payout_count"] == 6
    if stage_three is not None:
        assert stage_three.outputs["redeem_planned"] == 0
        assert stage_three.outputs["orders_planned"] == 0


@pytest.mark.anyio
async def test_console_profile_stage1_keeps_only_open_trump_row_active_from_v0115_payload(
    monkeypatch,
):
    fixed_now = datetime(2026, 7, 19, 12, 0, tzinfo=UTC)
    parsed_positions = await read_console_wallet_positions(
        snapshot_payload={
            "positions": [
                {
                    "slug": "claude-fable-july-3",
                    "market": "Will Claude Fable 5 be restored for US customers by July 3, 2026?",
                    "outcome": "No",
                    "shares": 6.0975,
                    "avg_price": 0.92,
                    "current_price": 0,
                    "current_value": 0,
                    "expected_payout_usdc": 0,
                    "redeemable": False,
                    "upstream_redeemable": True,
                    "resolution_status": "unknown",
                    "end_date": "2026-07-03",
                },
                {
                    "slug": "claude-fable-july-2",
                    "market": "Will Claude Fable 5 be restored for US customers by July 2, 2026?",
                    "outcome": "No",
                    "shares": 5.4347,
                    "avg_price": 0.91,
                    "current_price": 0,
                    "current_value": 0,
                    "expected_payout_usdc": 0,
                    "redeemable": False,
                    "upstream_redeemable": True,
                    "resolution_status": "unknown",
                    "end_date": "2026-07-02",
                },
                {
                    "slug": "claude-fable-july-1",
                    "market": "Will Claude Fable 5 be restored for US customers by July 1, 2026?",
                    "outcome": "No",
                    "shares": 5.3763,
                    "avg_price": 0.9,
                    "current_price": 0,
                    "current_value": 0,
                    "expected_payout_usdc": 0,
                    "redeemable": False,
                    "upstream_redeemable": True,
                    "resolution_status": "unknown",
                    "end_date": "2026-07-01",
                },
                {
                    "slug": "project-alpha-june-26",
                    "market": "Will Project Alpha launch by June 26, 2026?",
                    "outcome": "No",
                    "shares": 5.2631,
                    "avg_price": 0.87,
                    "current_price": 0,
                    "current_value": 0,
                    "expected_payout_usdc": 0,
                    "redeemable": False,
                    "upstream_redeemable": True,
                    "resolution_status": "unknown",
                    "end_date": "2026-06-26",
                },
                {
                    "slug": "trump-netanyahu-july-24-2026",
                    "market": "Will Trump meet with Netanyahu by July 24, 2026?",
                    "outcome": "No",
                    "shares": 4.5,
                    "avg_price": 0.61,
                    "current_price": 0.64,
                    "current_value": 2.88,
                    "expected_payout_usdc": 0,
                    "redeemable": False,
                    "upstream_redeemable": False,
                    "resolution_status": "open",
                    "end_date": "2026-07-24",
                },
            ]
        }
    )

    async def fake_read_console_wallet_positions():
        return parsed_positions

    async def fake_scan_console_profile_markets(**_kwargs):
        return SimpleNamespace(
            source_label="test",
            source_url="https://example.com",
            accepted=[],
            rejected=[],
            total_candidates=0,
        )

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.utc_now", lambda: fixed_now
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

    stage_one = result.run.stage_results[0]
    stage_two = next(
        stage
        for stage in result.run.stage_results
        if stage.outputs["workflow_stage_key"] == "llm"
    )
    stage_three = next(
        (
            stage
            for stage in result.run.stage_results
            if stage.outputs["workflow_stage_key"] == "invest"
        ),
        None,
    )
    active_rows = stage_one.outputs["active_positions_found"]
    active_market_titles = {row["market_title"] for row in active_rows}
    excluded_titles = {
        "Will Claude Fable 5 be restored for US customers by July 3, 2026?",
        "Will Claude Fable 5 be restored for US customers by July 2, 2026?",
        "Will Claude Fable 5 be restored for US customers by July 1, 2026?",
        "Will Project Alpha launch by June 26, 2026?",
    }

    assert len(active_rows) == 1
    assert active_market_titles == {"Will Trump meet with Netanyahu by July 24, 2026?"}
    assert stage_one.outputs["active_position_rows_before_llm"] == 1
    assert stage_one.outputs["claimable_wallet_positions"] == 0
    assert len(stage_one.outputs["available_for_claim"]) == 0
    assert len(stage_one.outputs["settlement_pending_positions"]) == 0
    assert stage_one.outputs["resolved_zero_payout_count"] == 4
    assert stage_one.outputs["excluded_position_diagnostics_count"] == 4
    assert all(row["classification"] == "active" for row in active_rows)

    stage_two_payload = json.dumps(stage_two.outputs)
    for title in excluded_titles:
        assert title not in stage_two_payload
        if stage_three is not None:
            assert title not in json.dumps(stage_three.outputs)


@pytest.mark.anyio
async def test_console_profile_submits_buys_even_while_exit_settlement_is_pending(
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
    initial_positions = [
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
    executor_calls: list[tuple[str, dict[str, object]]] = []

    async def fake_read_console_wallet_positions():
        return initial_positions

    async def fake_scan_console_profile_markets(**_kwargs):
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

    balance_reads = [
        SimpleNamespace(
            status="ready",
            available_balance_usd=50.0,
            account_value_usd=50.0,
            message="Balance ready",
        ),
        SimpleNamespace(
            status="ready",
            available_balance_usd=50.0,
            account_value_usd=50.0,
            message="Balance ready",
        ),
    ]

    async def fake_refresh_balance():
        return balance_reads.pop(0) if len(balance_reads) > 1 else balance_reads[0]

    async def fake_refresh_live_controls(**_kwargs):
        return _fake_live_controls()

    class RecordingExecutor:
        async def buy_limit(self, **kwargs):
            executor_calls.append(("buy", kwargs))
            return "buy submitted"

        async def sell_limit(self, **kwargs):
            executor_calls.append(("sell", kwargs))
            return json.dumps({"orderId": "confirmed-sell-1", "status": "submitted"})

        async def poll_order(self, **kwargs):
            assert kwargs["order_id"] == "confirmed-sell-1"
            return {
                "orderId": "confirmed-sell-1",
                "status": "filled",
                "filledShares": 10,
                "remainingShares": 0,
            }

    monkeypatch.setenv("BULLPEN_AUTO_LIVE_ALLOW_EXECUTION", "true")
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.EXIT_SETTLEMENT_TIMEOUT_SECONDS", 0
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.EXIT_SETTLEMENT_POLL_INTERVAL_SECONDS",
        0,
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
        "app.domains.polymarket_auto_live.engine._should_use_legacy_console_stage_two_path",
        lambda: False,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine._execute_console_stage_two_shared_llm",
        _fake_console_stage_two_shared_review(
            fixed_now=fixed_now,
            fair_yes=10,
            fair_no=90,
        ),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_execution_quote",
        fake_refresh_execution_quote,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_balance",
        fake_refresh_balance,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_live_controls",
        fake_refresh_live_controls,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.bullpen_module.BullpenLiveExecutor",
        lambda: RecordingExecutor(),
    )

    result = await BullpenAutoLiveEngine().execute(
        user_id=7,
        settings=BullpenAutoLiveSettings(
            strategy_profile=CONSOLE_PROFILE_ID,
            auto_live_enabled=True,
            dry_run=False,
            allow_live_execution=True,
            require_manual_confirmation=False,
            console_llm_targets=[
                BullpenAutoLiveLlmTarget(provider="openai", model="gpt-4o-mini")
            ],
        ),
        state=BullpenAutoLiveState(running=True),
        run=_run_snapshot(dry_run=False),
        positions=[],
        historical_decisions=[],
    )

    buy_decisions = [
        decision for decision in result.decisions if decision.decision == "BUY_NEW"
    ]

    assert "buy" in [name for name, _kwargs in executor_calls]
    assert buy_decisions
    planned_buy_decisions = [
        decision
        for decision in buy_decisions
        if decision.order_plan is not None and decision.order_plan.action == "buy"
    ]
    assert planned_buy_decisions
    assert all(
        decision.order_plan.status == "submitted"
        for decision in planned_buy_decisions
    )
    assert all(
        decision.reason
        == "Ranked candidate received a post-exit buy plan using fresh cash and occupied-slot counts."
        for decision in planned_buy_decisions
    )


@pytest.mark.anyio
async def test_console_profile_executes_buys_after_exit_settlement_confirms(monkeypatch):
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
    initial_positions = [
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
    settled_positions = [initial_positions[0]]
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
    executor_calls: list[tuple[str, dict[str, object]]] = []
    wallet_reads = [initial_positions, settled_positions]

    async def fake_read_console_wallet_positions():
        return wallet_reads.pop(0) if wallet_reads else settled_positions

    async def fake_scan_console_profile_markets(**_kwargs):
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

    balance_reads = [
        SimpleNamespace(
            status="ready",
            available_balance_usd=50.0,
            account_value_usd=50.0,
            message="Balance ready",
        ),
        SimpleNamespace(
            status="ready",
            available_balance_usd=55.0,
            account_value_usd=55.0,
            message="Balance ready",
        ),
    ]

    async def fake_refresh_balance():
        return balance_reads.pop(0) if len(balance_reads) > 1 else balance_reads[0]

    async def fake_refresh_live_controls(**_kwargs):
        return _fake_live_controls()

    class RecordingExecutor:
        async def buy_limit(self, **kwargs):
            executor_calls.append(("buy", kwargs))
            return "buy submitted"

        async def sell_limit(self, **kwargs):
            executor_calls.append(("sell", kwargs))
            return json.dumps({"orderId": "confirmed-sell-1", "status": "submitted"})

        async def poll_order(self, **kwargs):
            assert kwargs["order_id"] == "confirmed-sell-1"
            return {
                "orderId": "confirmed-sell-1",
                "status": "filled",
                "filledShares": 10,
                "remainingShares": 0,
            }

    monkeypatch.setenv("BULLPEN_AUTO_LIVE_ALLOW_EXECUTION", "true")
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.EXIT_SETTLEMENT_TIMEOUT_SECONDS", 0
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.EXIT_SETTLEMENT_POLL_INTERVAL_SECONDS",
        0,
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
        "app.domains.polymarket_auto_live.engine._should_use_legacy_console_stage_two_path",
        lambda: False,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine._execute_console_stage_two_shared_llm",
        _fake_console_stage_two_shared_review(
            fixed_now=fixed_now,
            fair_yes=10,
            fair_no=90,
        ),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_execution_quote",
        fake_refresh_execution_quote,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_balance",
        fake_refresh_balance,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_live_controls",
        fake_refresh_live_controls,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.bullpen_module.BullpenLiveExecutor",
        lambda: RecordingExecutor(),
    )

    result = await BullpenAutoLiveEngine().execute(
        user_id=7,
        settings=BullpenAutoLiveSettings(
            strategy_profile=CONSOLE_PROFILE_ID,
            auto_live_enabled=True,
            dry_run=False,
            allow_live_execution=True,
            require_manual_confirmation=False,
            console_llm_targets=[
                BullpenAutoLiveLlmTarget(provider="openai", model="gpt-4o-mini")
            ],
        ),
        state=BullpenAutoLiveState(running=True),
        run=_run_snapshot(dry_run=False),
        positions=[],
        historical_decisions=[],
    )

    assert "buy" in [name for name, _kwargs in executor_calls]
    assert any(
        decision.order_plan is not None and decision.order_plan.action == "buy"
        and decision.order_plan.status == "submitted"
        for decision in result.decisions
    )


@pytest.mark.anyio
async def test_console_profile_defers_rate_limited_buy_without_fallback_write(
    monkeypatch,
):
    fixed_now = datetime(2026, 6, 21, 0, 0, tzinfo=UTC)
    candidate_market = _market(
        question="Will the rate-limited buy stay deferred?",
        slug="candidate-rate-limited-buy",
        current_yes_odds=14,
        current_no_odds=86,
    )
    executor_calls: list[str] = []

    async def fake_read_console_wallet_positions():
        return []

    async def fake_scan_console_profile_markets(**_kwargs):
        return SimpleNamespace(
            source_label="Bullpen console",
            source_url="https://example.com/bullpen",
            accepted=[candidate_market],
            rejected=[],
            total_candidates=1,
        )

    async def fake_refresh_live_controls(*, user_id: int):
        assert user_id == 7
        return _fake_live_controls()

    async def fake_refresh_execution_quote(*, slug: str | None, side: str):
        assert slug == candidate_market.slug
        return SimpleNamespace(
            market=candidate_market,
            current_price_cents=(
                candidate_market.current_yes_odds
                if side == "YES"
                else candidate_market.current_no_odds
            ),
            spread_cents=2,
        )

    class RateLimitedExecutor:
        async def buy_limit(self, **_kwargs):
            executor_calls.append("buy_limit")
            raise RuntimeError("HTTP 429 Too Many Requests. Retry-After: 2")

        async def sell_limit(self, **_kwargs):
            raise AssertionError("sell_limit should not run for a pure buy scenario")

    monkeypatch.setenv("BULLPEN_AUTO_LIVE_ALLOW_EXECUTION", "true")
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.CONSOLE_RANKED_EVENT_LIMIT",
        1,
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
        lambda market, now: 8.5 if market.slug == candidate_market.slug else 0.5,
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
        lambda *args, **kwargs: _fake_llm_consensus(fair_yes=88, fair_no=12),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_live_controls",
        fake_refresh_live_controls,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_execution_quote",
        fake_refresh_execution_quote,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_balance",
        _fake_ready_balance,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.bullpen_module.BullpenLiveExecutor",
        lambda: RateLimitedExecutor(),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.asyncio.sleep",
        AsyncMock(),
    )

    result = await BullpenAutoLiveEngine().execute(
        user_id=7,
        settings=BullpenAutoLiveSettings(
            strategy_profile=CONSOLE_PROFILE_ID,
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

    invest_stage = next(
        stage
        for stage in result.run.stage_results
        if stage.outputs.get("workflow_stage_key") == "invest"
    )
    buy_decision = next(
        decision
        for decision in result.decisions
        if decision.order_plan is not None and decision.order_plan.action == "buy"
    )

    assert executor_calls == ["buy_limit", "buy_limit"]
    assert result.run.status == "failed"
    assert result.run.orders_planned == 1
    assert result.run.orders_submitted == 0
    assert "rate limit" in result.run.summary.lower()
    assert buy_decision.order_plan.status == "rpc_rate_limited"
    assert invest_stage.outputs["buy_orders_unsubmitted"] == 1
    assert invest_stage.outputs["order_metrics"]["buy"]["rpc_rate_limited"] == 1


@pytest.mark.anyio
async def test_console_profile_retries_transient_rate_limited_buy_once(
    monkeypatch,
):
    fixed_now = datetime(2026, 6, 21, 0, 0, tzinfo=UTC)
    candidate_market = _market(
        question="Will the transient rate-limited buy recover?",
        slug="candidate-transient-rate-limit",
        current_yes_odds=14,
        current_no_odds=86,
    )
    executor_calls: list[str] = []

    async def fake_read_console_wallet_positions():
        return []

    async def fake_scan_console_profile_markets(**_kwargs):
        return SimpleNamespace(
            source_label="Bullpen console",
            source_url="https://example.com/bullpen",
            accepted=[candidate_market],
            rejected=[],
            total_candidates=1,
        )

    async def fake_refresh_live_controls(*, user_id: int):
        assert user_id == 7
        return _fake_live_controls()

    async def fake_refresh_execution_quote(*, slug: str | None, side: str):
        assert slug == candidate_market.slug
        return SimpleNamespace(
            market=candidate_market,
            current_price_cents=(
                candidate_market.current_yes_odds
                if side == "YES"
                else candidate_market.current_no_odds
            ),
            spread_cents=2,
        )

    class RetryThenSuccessExecutor:
        def __init__(self):
            self.buy_attempts = 0

        async def buy_limit(self, **_kwargs):
            executor_calls.append("buy_limit")
            self.buy_attempts += 1
            if self.buy_attempts == 1:
                raise RuntimeError("HTTP 429 Too Many Requests. Retry-After: 2")
            return "submitted-after-retry"

        async def sell_limit(self, **_kwargs):
            raise AssertionError("sell_limit should not run for a pure buy scenario")

    monkeypatch.setenv("BULLPEN_AUTO_LIVE_ALLOW_EXECUTION", "true")
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.CONSOLE_RANKED_EVENT_LIMIT",
        1,
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
        lambda market, now: 8.5 if market.slug == candidate_market.slug else 0.5,
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
        lambda *args, **kwargs: _fake_llm_consensus(fair_yes=88, fair_no=12),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_live_controls",
        fake_refresh_live_controls,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_execution_quote",
        fake_refresh_execution_quote,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_balance",
        _fake_ready_balance,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.bullpen_module.BullpenLiveExecutor",
        lambda: RetryThenSuccessExecutor(),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.asyncio.sleep",
        AsyncMock(),
    )

    result = await BullpenAutoLiveEngine().execute(
        user_id=7,
        settings=BullpenAutoLiveSettings(
            strategy_profile=CONSOLE_PROFILE_ID,
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

    buy_decision = next(
        decision
        for decision in result.decisions
        if decision.order_plan is not None and decision.order_plan.action == "buy"
    )

    assert executor_calls == ["buy_limit", "buy_limit"]
    assert result.run.status == "completed"
    assert result.run.orders_planned == 1
    assert result.run.orders_submitted == 1
    assert buy_decision.order_plan.status == "submitted"
    assert buy_decision.order_plan.execution_response == "submitted-after-retry"
    assert "rate limit" not in result.run.summary.lower()


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
async def test_console_wallet_positions_parse_top_level_positions_payload():
    positions = await read_console_wallet_positions(
        snapshot_payload={
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
    )

    assert len(positions) == 1
    assert positions[0].market_id == "candidate-x-win"
    assert positions[0].shares == 12
    assert positions[0].side == "NO"
    assert positions[0].current_no_odds == 39


@pytest.mark.anyio
async def test_console_wallet_positions_aggregate_duplicate_lots():
    positions = await read_console_wallet_positions(
        snapshot_payload={
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
    )

    assert len(positions) == 1
    assert positions[0].slug == "candidate-x-win"
    assert positions[0].condition_id == "0xabc"
    assert positions[0].shares == 12
    assert positions[0].exposure_usd == 5.5
    assert positions[0].average_price_cents == 45.8333
    assert positions[0].current_no_odds == 39


@pytest.mark.anyio
async def test_console_wallet_positions_do_not_treat_won_status_as_claimable():
    positions = await read_console_wallet_positions(
        snapshot_payload={
            "positions": [
                {
                    "slug": "closed-history-row",
                    "market": "Historical winning position",
                    "outcome": "No",
                    "shares": 6,
                    "avg_price": 0.92,
                    "status": "won",
                },
                {
                    "slug": "redeemable-row",
                    "market": "Redeemable position",
                    "outcome": "No",
                    "shares": 3,
                    "avg_price": 0.8,
                    "status": "won",
                    "redeemable": True,
                    "claimable_value": 3,
                },
            ]
        }
    )

    by_slug = {position.slug: position for position in positions}
    assert by_slug["closed-history-row"].is_claimable is False
    assert by_slug["redeemable-row"].is_claimable is True


@pytest.mark.anyio
async def test_console_wallet_positions_preserve_explicit_zero_payout_residues(
):
    positions = await read_console_wallet_positions(
        snapshot_payload={
            "positions": [
                {
                    "slug": "resolved-zero-payout",
                    "market": "Resolved zero payout position",
                    "outcome": "No",
                    "shares": 6.0975,
                    "avg_price": 0.92,
                    "current_price": 0,
                    "current_value": 0,
                    "expected_payout_usdc": 0,
                    "redeemable": True,
                    "end_date": "2026-07-03",
                }
            ]
        }
    )

    assert len(positions) == 1
    assert positions[0].current_price_cents == 0
    assert positions[0].classification == "resolved_zero_payout"
    assert positions[0].is_claimable is False


@pytest.mark.anyio
async def test_console_wallet_positions_v0115_expired_rows_stay_non_active_and_trump_row_stays_active():
    positions = await read_console_wallet_positions(
        snapshot_payload={
            "positions": [
                {
                    "slug": "claude-fable-july-3",
                    "market": "Will Claude Fable 5 be restored for US customers by July 3, 2026?",
                    "outcome": "No",
                    "shares": 6.0975,
                    "avg_price": 0.92,
                    "current_price": 0,
                    "current_value": 0,
                    "expected_payout_usdc": 0,
                    "redeemable": False,
                    "upstream_redeemable": True,
                    "resolution_status": "unknown",
                    "end_date": "2026-07-03",
                },
                {
                    "slug": "claude-fable-july-2",
                    "market": "Will Claude Fable 5 be restored for US customers by July 2, 2026?",
                    "outcome": "No",
                    "shares": 5.4347,
                    "avg_price": 0.91,
                    "current_price": 0,
                    "current_value": 0,
                    "expected_payout_usdc": 0,
                    "redeemable": False,
                    "upstream_redeemable": True,
                    "resolution_status": "unknown",
                    "end_date": "2026-07-02",
                },
                {
                    "slug": "claude-fable-july-1",
                    "market": "Will Claude Fable 5 be restored for US customers by July 1, 2026?",
                    "outcome": "No",
                    "shares": 5.3763,
                    "avg_price": 0.9,
                    "current_price": 0,
                    "current_value": 0,
                    "expected_payout_usdc": 0,
                    "redeemable": False,
                    "upstream_redeemable": True,
                    "resolution_status": "unknown",
                    "end_date": "2026-07-01",
                },
                {
                    "slug": "project-alpha-june-26",
                    "market": "Will Project Alpha launch by June 26, 2026?",
                    "outcome": "No",
                    "shares": 5.2631,
                    "avg_price": 0.87,
                    "current_price": 0,
                    "current_value": 0,
                    "expected_payout_usdc": 0,
                    "redeemable": False,
                    "upstream_redeemable": True,
                    "resolution_status": "unknown",
                    "end_date": "2026-06-26",
                },
                {
                    "slug": "trump-netanyahu-july-24-2026",
                    "market": "Will Trump meet with Netanyahu by July 24, 2026?",
                    "outcome": "No",
                    "shares": 4.5,
                    "avg_price": 0.61,
                    "current_price": 0.64,
                    "current_value": 2.88,
                    "expected_payout_usdc": 0,
                    "redeemable": False,
                    "upstream_redeemable": False,
                    "resolution_status": "open",
                    "end_date": "2026-07-24",
                },
            ]
        }
    )

    by_slug = {position.slug: position for position in positions}
    expired_slugs = {
        "claude-fable-july-3",
        "claude-fable-july-2",
        "claude-fable-july-1",
        "project-alpha-june-26",
    }

    assert all(by_slug[slug].classification == "resolved_zero_payout" for slug in expired_slugs)
    assert all(by_slug[slug].is_claimable is False for slug in expired_slugs)
    assert all(by_slug[slug].classification != "active" for slug in expired_slugs)
    assert by_slug["trump-netanyahu-july-24-2026"].classification == "active"
    assert by_slug["trump-netanyahu-july-24-2026"].market_title == (
        "Will Trump meet with Netanyahu by July 24, 2026?"
    )


@pytest.mark.anyio
async def test_console_wallet_positions_ignore_nested_history_claim_rows():
    positions = await read_console_wallet_positions(
        snapshot_payload={
            "data": {
                "positions": [
                    {
                        "slug": "active-open-row",
                        "market": "Active open position",
                        "outcome": "No",
                        "shares": 5,
                        "avg_price": 0.44,
                        "current_price": 0.41,
                        "invested_usd": 2.2,
                        "end_date": "2026-07-30T23:59:00+00:00",
                    }
                ],
                "history": [
                    {
                        "slug": "stale-history-claim",
                        "market": "Historical resolved position",
                        "outcome": "No",
                        "shares": 3,
                        "avg_price": 0.88,
                        "current_price": 1,
                        "status": "won",
                        "redeemable": True,
                    }
                ],
                "activities": [
                    {
                        "slug": "stale-activity-claim",
                        "market": "Historical activity row",
                        "outcome": "Yes",
                        "shares": 2,
                        "avg_price": 0.73,
                        "current_price": 1,
                        "action": "Redeem",
                    }
                ],
            }
        }
    )

    assert [position.slug for position in positions] == ["active-open-row"]
    assert positions[0].is_claimable is False


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


@pytest.mark.parametrize(
    ("description", "expected_method"),
    [
        (
            'This market will resolve to "Yes" if Iran keeps its airspace closed through July 20, 2026, 11:59 PM ET.',
            "pattern_resolves_to_yes_if",
        ),
        (
            "This market resolves Yes if the Israel x Iran ceasefire continues through July 20, 2026, 11:59 PM ET.",
            "pattern_resolves_yes_if",
        ),
        (
            "This market will be resolved as Yes if Iran's airspace remains closed through July 20, 2026, 11:59 PM ET.",
            "pattern_resolved_as_yes_if",
        ),
        (
            "If Iran's airspace remains closed through July 20, 2026, 11:59 PM ET, this market resolves to Yes.",
            "pattern_conditional_then_resolves_yes",
        ),
        (
            "In the event that the Israel x Iran ceasefire continues through July 20, 2026, 11:59 PM ET, the market resolves to Yes.",
            "pattern_in_event_that_resolves_yes",
        ),
    ],
)
def test_market_rules_support_common_yes_resolution_variants(
    description,
    expected_method,
):
    market = _market(
        question="Will the rule parser accept this market by July 20?",
        description=description,
        close_time="2026-07-21T03:59:00+00:00",
    )

    result = evaluate_market_rules(
        market,
        now=datetime(2026, 7, 19, 12, 0, tzinfo=UTC),
    )

    assert result.fail_reason is None
    assert result.rule_gate_result == "passed"
    assert result.yes_definition_extraction_method == expected_method
    assert result.yes_definition == (
        "Iran keeps its airspace closed through July 20, 2026, 11:59 PM ET"
        if "keeps its airspace closed" in description
        else "the Israel x Iran ceasefire continues through July 20, 2026, 11:59 PM ET"
        if "ceasefire" in description
        else "Iran's airspace remains closed through July 20, 2026, 11:59 PM ET"
    )


def test_market_rules_verified_binary_sentence_fallback_unblocks_variant_wording():
    market = _market(
        question="Will Iran's airspace remain closed through July 20?",
        description=(
            "According to Polymarket, this market resolves to Yes, if Iran's airspace "
            "remains closed through July 20, 2026, 11:59 PM ET."
        ),
        close_time="2026-07-21T03:59:00+00:00",
    )

    result = evaluate_market_rules(
        market,
        now=datetime(2026, 7, 19, 12, 0, tzinfo=UTC),
        exact_market_match_verified=True,
    )

    assert result.fail_reason is None
    assert result.rule_gate_result == "bypassed_verified_binary_rules"
    assert result.yes_definition_extraction_method == "sentence_fallback"
    assert result.yes_definition == (
        "Iran's airspace remains closed through July 20, 2026, 11:59 PM ET"
    )
    assert result.yes_definition_supporting_text == (
        "According to Polymarket, this market resolves to Yes, if Iran's airspace remains closed through July 20, 2026, 11:59 PM ET."
    )


def test_market_rules_prioritize_selected_question_deadline_over_background_rule_dates():
    market = _market(
        question="Will Iran announce withdrawal from MOU negotiations by July 24?",
        description=(
            "On June 14, 2026, the United States and Iran announced a memorandum "
            "of understanding. This market resolves to Yes if Iran announces its "
            "termination of participation by the specified date, 11:59 PM ET."
        ),
        # This reproduces a stale event-level endDate returned for a different
        # market in the same Polymarket event.
        close_time="2026-06-15T03:59:00+00:00",
    )

    result = evaluate_market_rules(
        market,
        now=datetime(2026, 7, 17, 12, 0, tzinfo=UTC),
    )

    assert result.deadline_et == "2026-07-24 11:59:00 PM ET"
    assert result.deadline_source == "question_title_by_date"
    assert result.expired is False


def test_market_rules_fail_without_resolution_criteria():
    result = evaluate_market_rules(
        _market(description=None),
        now=datetime(2026, 6, 21, 12, 0, tzinfo=UTC),
    )

    assert result.outcome_clear is False
    assert result.ambiguous is True
    assert result.fail_reason == "Resolution criteria are unavailable."


def test_manual_console_market_prefers_exact_rules_over_generic_event_description():
    row = BullpenAutoLiveConsoleCandidateInput(
        question_id="question-1",
        market_id="market-1",
        market_title="Will event one happen by July 24?",
        slug="event-one",
        market_url="https://example.com/event-one",
        close_time="2026-07-24T23:59:00Z",
        theme="Politics",
        current_yes_odds=18,
        current_no_odds=82,
        rules=(
            'This market resolves to "Yes" if event one is officially confirmed '
            'by July 24, 2026, 11:59 PM ET. Otherwise, it resolves to "No".'
        ),
        event_description="Generic background context about the broader story.",
        market_context="Background context.",
        resolution_source="Official source",
    )

    market = _manual_console_market(row)

    assert market.description == row.rules


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


def test_candidate_filter_reasons_block_halftime_markets_without_category_keywords():
    market = _market(
        question="Argentina leading at halftime?",
        theme="Uncategorized",
        slug="argentina-leading-at-halftime",
    )

    reasons = _evaluate_filter_reasons(market, min_liquidity_usd=0)

    assert "Excluded sports market." in reasons


def test_candidate_filter_reasons_block_uncategorized_esports_prop_markets():
    market = _market(
        question="Game 1: Any Player Rampage?",
        theme="Uncategorized",
        slug="game-1-any-player-rampage",
    )

    reasons = _evaluate_filter_reasons(market, min_liquidity_usd=0)

    assert "Excluded sports market." in reasons


def test_candidate_filter_reasons_block_uncategorized_player_prop_threshold_markets():
    for question, slug in (
        ("Achraf Hakimi: 1+ assists", "achraf-hakimi-1-assists"),
        ("Achraf Hakimi: 1+ goals + assists", "achraf-hakimi-1-goals-assists"),
        (
            "Achraf Hakimi: 2+ shots on target",
            "achraf-hakimi-2-shots-on-target",
        ),
        ("Achraf Hakimi: 5+ shots", "achraf-hakimi-5-shots"),
    ):
        market = _market(
            question=question,
            theme="Uncategorized",
            slug=slug,
        )

        reasons = _evaluate_filter_reasons(market, min_liquidity_usd=0)

        assert "Excluded sports market." in reasons, question


def test_candidate_filter_reasons_block_uncategorized_player_prop_ou_markets():
    for question, slug in (
        ("A'ja Wilson: Assists O/U 2.5", "aja-wilson-assists-ou-2-5"),
        ("Alyssa Thomas: Rebounds O/U 6.5", "alyssa-thomas-rebounds-ou-6-5"),
        ("Chelsea Gray: Points O/U 14.5", "chelsea-gray-points-ou-14-5"),
        ("Breanna Stewart: Over 2.5 assists", "breanna-stewart-over-2-5-assists"),
    ):
        market = _market(
            question=question,
            theme="Uncategorized",
            slug=slug,
        )

        reasons = _evaluate_filter_reasons(market, min_liquidity_usd=0)

        assert "Excluded sports market." in reasons, question


def test_candidate_filter_reasons_block_uncategorized_scoreline_win_markets():
    for question, slug in (
        ("Team Falcons to win 2-0?", "team-falcons-to-win-2-0"),
        ("Xtreme Gaming to win 2-0?", "xtreme-gaming-to-win-2-0"),
    ):
        market = _market(
            question=question,
            theme="Uncategorized",
            slug=slug,
        )

        reasons = _evaluate_filter_reasons(market, min_liquidity_usd=0)

        assert "Excluded sports market." in reasons, question


def test_candidate_filter_reasons_block_uncategorized_msi_league_markets():
    for question, slug in (
        (
            "Will a team from LCK (South Korea) win MSI 2026?",
            "team-from-lck-win-msi-2026",
        ),
        (
            "Will a team from LPL (China) win MSI 2026?",
            "team-from-lpl-win-msi-2026",
        ),
        ("Will Bilibili Gaming win MSI 2026?", "bilibili-gaming-win-msi-2026"),
    ):
        market = _market(
            question=question,
            theme="Uncategorized",
            slug=slug,
        )

        reasons = _evaluate_filter_reasons(market, min_liquidity_usd=0)

        assert "Excluded sports market." in reasons, question


def test_candidate_filter_reasons_block_uncategorized_win_on_date_markets():
    market = _market(
        question="Will Norway win on 2026-06-26?",
        description=None,
        theme="Uncategorized",
        slug="norway-win-2026-06-26",
    )

    reasons = _evaluate_filter_reasons(market, min_liquidity_usd=0)

    assert "Excluded sports market." in reasons


def test_candidate_filter_reasons_do_not_treat_political_win_on_date_markets_as_sports():
    market = _market(
        question="Will Donald Trump win the presidential election on 2028-11-07?",
        theme="Politics",
        slug="donald-trump-win-presidential-election-2028-11-07",
    )

    reasons = _evaluate_filter_reasons(market, min_liquidity_usd=0)

    assert "Excluded sports market." not in reasons


def test_console_market_filter_reasons_block_uncategorized_esports_objective_markets():
    market = _market(
        question="Game 1: Both Teams Beat Roshan?",
        theme="Uncategorized",
        slug="game-1-both-teams-beat-roshan",
    )

    reasons = console_market_filter_reasons(
        market,
        now=datetime(2026, 6, 21, 12, 0, tzinfo=UTC),
    )

    assert "Excluded sports market." in reasons


def test_console_market_filter_reasons_block_exact_score_markets_when_uncategorized():
    market = _market(
        question="Exact Score: Argentina 1 - 0 Egypt?",
        theme="Uncategorized",
        slug="argentina-egypt-exact-score",
    )

    reasons = console_market_filter_reasons(
        market,
        now=datetime(2026, 6, 21, 12, 0, tzinfo=UTC),
    )

    assert "Excluded sports market." in reasons


def test_console_market_filter_reasons_block_player_prop_ou_markets():
    market = _market(
        question="Alyssa Thomas: Rebounds O/U 6.5",
        theme="Uncategorized",
        slug="alyssa-thomas-rebounds-ou-6-5",
    )

    reasons = console_market_filter_reasons(
        market,
        now=datetime(2026, 6, 21, 12, 0, tzinfo=UTC),
    )

    assert "Excluded sports market." in reasons


def test_candidate_filter_reasons_block_trump_insult_markets():
    market = _market(
        question="Will Donald Trump publicly insult someone on June 27, 2026?",
        theme="Trump",
    )

    reasons = _evaluate_filter_reasons(market, min_liquidity_usd=0)

    assert "Excluded insult or name-calling market." in reasons


def test_candidate_filter_reasons_block_market_cap_leadership_markets():
    market = _market(
        question=(
            "Will Company A be the largest company in the world by market cap "
            "on July 31, 2026?"
        ),
        theme="AI",
    )

    reasons = _evaluate_filter_reasons(market, min_liquidity_usd=0)

    assert "Excluded market-prediction or finance market." in reasons


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

def test_resolve_auto_live_llm_targets_uses_only_saved_console_selection():
    settings = BullpenAutoLiveSettings(
        console_llm_targets=[
            BullpenAutoLiveLlmTarget(provider="deepseek", model="deepseek-v4-flash"),
            BullpenAutoLiveLlmTarget(provider="deepseek", model="deepseek-reasoner"),
            BullpenAutoLiveLlmTarget(provider="deepseek", model="deepseek-chat"),
            BullpenAutoLiveLlmTarget(provider="deepseek", model="deepseek-coder"),
        ]
    )

    assert resolve_auto_live_llm_targets(settings) == [
        ("deepseek", "deepseek-v4-flash"),
        ("deepseek", "deepseek-reasoner"),
        ("deepseek", "deepseek-chat"),
        ("deepseek", "deepseek-coder"),
    ]


def test_resolve_auto_live_llm_targets_does_not_fall_back_to_random_defaults():
    assert resolve_auto_live_llm_targets(BullpenAutoLiveSettings()) == []
    assert resolve_auto_live_llm_targets() == []


def _market(
    *,
    question: str = "Will candidate X win?",
    description: str | None = (
        'This market will resolve to "Yes" if candidate X wins. Otherwise, it resolves to No.'
    ),
    close_time: str | None = None,
    theme: str = "Politics",
    liquidity_usd: float | None = 5_000,
    slug: str | None = "candidate-x-win",
    outcome_labels: list[str] | None = None,
    current_yes_odds: float | None = 54,
    current_no_odds: float | None = 46,
) -> ScannedMarket:
    if close_time is None:
        close_time = (datetime.now(UTC) + timedelta(days=7)).isoformat()
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
    current_value_usd: float | None = None,
    close_time: str | None = None,
    side: str = "NO",
    is_claimable: bool = False,
    condition_id: str | None = None,
) -> ConsoleWalletPosition:
    if close_time is None:
        close_time = (datetime.now(UTC) + timedelta(days=7)).isoformat()
    return ConsoleWalletPosition(
        market_id=slug,
        slug=slug,
        condition_id=condition_id,
        market_title=market_title,
        market_url=f"https://polymarket.com/event/{slug}",
        side=side,
        shares=shares,
        average_price_cents=average_price_cents,
        exposure_usd=exposure_usd,
        current_price_cents=current_price_cents,
        current_value_usd=(
            current_value_usd
            if current_value_usd is not None
            else round((shares * current_price_cents) / 100, 4)
        ),
        current_yes_odds=round(100 - current_price_cents, 2),
        current_no_odds=round(current_price_cents, 2),
        close_time=close_time,
        theme="Politics",
        is_claimable=is_claimable,
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
    close_time: str | None = None,
) -> BullpenAutoLiveConsoleCandidateInput:
    if close_time is None:
        close_time = datetime(2026, 6, 28, 0, 0, tzinfo=UTC).isoformat()
    return BullpenAutoLiveConsoleCandidateInput(
        question_id=question_id,
        market_id=market_id,
        market_title=market_title,
        slug=slug,
        market_url=f"https://polymarket.com/event/{slug}",
        close_time=close_time,
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


def _fake_console_stage_two_shared_review(
    *,
    fixed_now: datetime,
    fair_yes: float,
    fair_no: float,
):
    async def fake_shared_review(
        *,
        llm_markets,
        rules_by_market_id,
        settings,
        now,
        target_progress_callback=None,
    ):
        targets = settings.console_llm_targets or [
            BullpenAutoLiveLlmTarget(provider="openai", model="gpt-4o-mini")
        ]
        if target_progress_callback is not None:
            target_progress_callback(
                len(targets),
                [
                    {
                        "provider": target.provider,
                        "model": target.model,
                        "status": "completed",
                        "usable_event_count": len(llm_markets),
                    }
                    for target in targets
                ],
            )
        _, consensus = _fake_llm_consensus(fair_yes=fair_yes, fair_no=fair_no)
        outputs_by_market_id: dict[str, list[BullpenAutoLiveLlmOutput]] = {}
        prepared_payload_by_market_id: dict[str, PolymarketEventQuestionPayload] = {}
        question_runtime_by_market_id: dict[str, dict[str, object]] = {}
        for llm_row in llm_markets:
            market = llm_row.get("market")
            if not isinstance(market, ScannedMarket):
                continue
            outputs_by_market_id[market.market_id] = [
                BullpenAutoLiveLlmOutput(
                    provider=target.provider,
                    model=target.model,
                    llm_yes_odds=fair_yes,
                    llm_no_odds=fair_no,
                    confidence="High",
                    evidence_status="Strong",
                    event_state="scheduled_not_occurred",
                    rationale="Shared review returned usable odds.",
                    completed_at=fixed_now.isoformat(),
                )
                for target in targets
            ]
            prepared_payload_by_market_id[market.market_id] = PolymarketEventQuestionPayload(
                question_ref=market.market_id,
                question_id=market.market_id,
                market_id=market.market_id,
                question=market.question,
                close_time=market.close_time,
                current_time_utc=fixed_now.isoformat(),
                current_time_et=fixed_now.isoformat(),
                deadline_et="2026-06-24 08:00:00 PM ET",
                hours_remaining=rules_by_market_id[market.market_id].hours_remaining,
                category=market.theme,
                outcomes=["Yes", "No"],
                current_yes_odds=market.current_yes_odds,
                current_no_odds=market.current_no_odds,
                market_url=market.market_url,
                slug=market.slug,
                polymarket_rules=(
                    'This market will resolve to "Yes" if the event occurs by the deadline.'
                ),
            )
            question_runtime_by_market_id[market.market_id] = {}
        return ConsoleStageTwoSharedReview(
            prepared_payload_by_market_id=prepared_payload_by_market_id,
            question_runtime_by_market_id=question_runtime_by_market_id,
            outputs_by_market_id=outputs_by_market_id,
            consensus_by_market_id={
                market.market_id: consensus
                for llm_row in llm_markets
                if isinstance((market := llm_row.get("market")), ScannedMarket)
            },
            execution_options=BullpenLlmExecutionOptions(
                execution_mode="single_combined",
                events_per_prompt=20,
                target_count=len(targets),
                prompt_template_hash="test-shared-review-hash",
            ),
            runtime_outputs={
                "llm_execution_mode": "single_combined",
                "llm_events_per_prompt": 20,
                "llm_target_count": len(targets),
                "llm_provider_target_count": len(targets),
                "llm_selected_target_count": len(targets),
                "llm_started_provider_target_count": len(targets),
                "llm_completed_provider_target_count": len(targets),
                "llm_usable_provider_target_count": len(targets),
                "llm_passed_provider_target_count": len(targets),
                "llm_failed_provider_target_count": 0,
                "llm_prompt_template_hash": "test-shared-review-hash",
                "llm_target_runs": [
                    {
                        "provider": target.provider,
                        "model": target.model,
                        "status": "completed",
                        "usable_event_count": len(llm_markets),
                    }
                    for target in targets
                ],
            },
        )

    return fake_shared_review


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
    available_balance_usd: float | None = 50.0,
):
    return SimpleNamespace(
        unlocked=unlocked,
        unlock_mode=unlock_mode,
        locked_reason=locked_reason,
        emergency_stopped=emergency_stopped,
        doctor=SimpleNamespace(ok=doctor_ok, message=doctor_message),
        balance=SimpleNamespace(
            status=balance_status,
            message=balance_message,
            available_balance_usd=available_balance_usd,
        ),
    )


async def _fake_ready_balance(amount: float = 50.0):
    return SimpleNamespace(
        status="ready",
        available_balance_usd=amount,
        account_value_usd=amount,
        message="Balance ready",
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
async def test_console_profile_plans_formula_sized_top10_buys_and_exits_lower_ranked_positions(
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

    async def fake_refresh_balance():
        return SimpleNamespace(
            status="ready",
            available_balance_usd=45.0,
            account_value_usd=45.0,
            message="Balance ready",
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
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_balance",
        fake_refresh_balance,
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
        close_time=(fixed_now + timedelta(days=7)).isoformat(),
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

    async def fake_refresh_balance():
        return SimpleNamespace(
            status="ready",
            available_balance_usd=50.0,
            account_value_usd=50.0,
            message="Balance ready",
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
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_balance",
        fake_refresh_balance,
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
            selected=False,
            close_time=(fixed_now + timedelta(days=7)).isoformat(),
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
            close_time=(fixed_now + timedelta(days=8)).isoformat(),
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

    async def fake_refresh_balance():
        return SimpleNamespace(
            status="ready",
            available_balance_usd=50.0,
            account_value_usd=50.0,
            message="Balance ready",
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
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_balance",
        fake_refresh_balance,
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
    first_stage3_rows = {
        decision.market_id: decision.stage_results[3].outputs["selected"]
        for decision in buy_decisions
    }
    assert first_stage3_rows["candidate-market-1"] is False
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
async def test_console_profile_manual_table_rows_treat_80_percent_llm_side_as_qualified(
    monkeypatch,
):
    fixed_now = datetime(2026, 6, 21, 12, 0, tzinfo=UTC)
    manual_row = _manual_console_candidate_row(
        market_id="candidate-market-80-threshold",
        question_id="candidate-market-80-threshold",
        market_title="Candidate market at the 80 threshold",
        slug="candidate-market-80-threshold",
        current_yes_odds=20,
        current_no_odds=80,
        llm_yes_odds=20,
        llm_no_odds=80,
        returns_per_day=8.8,
        selected=True,
        close_time=(fixed_now + timedelta(days=7)).isoformat(),
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

    async def fake_refresh_balance():
        return SimpleNamespace(
            status="ready",
            available_balance_usd=50.0,
            account_value_usd=50.0,
            message="Balance ready",
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
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_balance",
        fake_refresh_balance,
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
    assert buy_decisions[0].market_id == "candidate-market-80-threshold"
    assert buy_decisions[0].order_plan is not None
    assert buy_decisions[0].order_plan.side == "NO"
    assert buy_decisions[0].stage_results[3].outputs["strongest_llm_odds"] == 80
    assert result.run.diagnostics.qualified_candidate_rows == 1
    assert result.run.diagnostics.top_candidate_market_ids == [
        "candidate-market-80-threshold"
    ]


@pytest.mark.anyio
async def test_console_profile_manual_table_rows_reject_79_99_percent_llm_side(
    monkeypatch,
):
    fixed_now = datetime(2026, 6, 21, 12, 0, tzinfo=UTC)
    manual_row = _manual_console_candidate_row(
        market_id="candidate-market-79-99-threshold",
        question_id="candidate-market-79-99-threshold",
        market_title="Candidate market below the 80 threshold",
        slug="candidate-market-79-99-threshold",
        current_yes_odds=20.01,
        current_no_odds=79.99,
        llm_yes_odds=20.01,
        llm_no_odds=79.99,
        returns_per_day=8.8,
        selected=True,
        close_time=(fixed_now + timedelta(days=7)).isoformat(),
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
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_balance",
        _fake_ready_balance,
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
    skip_decisions = [decision for decision in result.decisions if decision.decision == "SKIP"]

    assert buy_decisions == []
    assert len(skip_decisions) == 1
    assert skip_decisions[0].market_id == "candidate-market-79-99-threshold"
    assert skip_decisions[0].reason == (
        "Candidate did not pass the Events to invest in table thresholds."
    )
    assert skip_decisions[0].stage_results[3].outputs["strongest_llm_odds"] == 79.99
    assert result.run.diagnostics.qualified_candidate_rows == 0
    assert result.run.diagnostics.top_candidate_market_ids == []


@pytest.mark.anyio
async def test_console_profile_nonqualifying_active_positions_do_not_displace_top10_candidate_metadata(
    monkeypatch,
):
    fixed_now = datetime(2026, 6, 21, 0, 0, tzinfo=UTC)
    active_market = _market(
        question="Will the non-qualifying active position resolve?",
        slug="active-low-llm",
        close_time="2026-06-25T00:00:00+00:00",
        current_yes_odds=90,
        current_no_odds=10,
    )
    live_positions = [
        _console_wallet_position(
            slug=active_market.slug,
            market_title=active_market.question,
            current_price_cents=10,
            side="NO",
        ),
    ]
    candidate_markets = [
        _market(
            question=f"Candidate market {index + 1}",
            slug=f"candidate-market-{index + 1}",
            close_time="2026-06-25T00:00:00+00:00",
            current_yes_odds=60 - (index * 3),
            current_no_odds=40 + (index * 3),
        )
        for index in range(10)
    ]
    market_lookup = {
        market.slug: market
        for market in [active_market, *candidate_markets]
        if market.slug
    }

    async def fake_read_console_wallet_positions():
        return live_positions

    async def fake_scan_console_profile_markets(**kwargs):
        return SimpleNamespace(
            source_label="test",
            source_url="https://example.com",
            accepted=[active_market, *candidate_markets],
            rejected=[],
            total_candidates=11,
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

    def fake_run_llm_consensus(market, *_args, **_kwargs):
        if market.market_id == active_market.market_id:
            return _fake_llm_consensus(fair_yes=79.99, fair_no=20.01)
        return _fake_llm_consensus(fair_yes=10, fair_no=90)

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
        fake_run_llm_consensus,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.position_returns_per_day",
        lambda *_args, **_kwargs: None,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_execution_quote",
        fake_refresh_execution_quote,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_balance",
        _fake_ready_balance,
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

    stage6 = next(
        stage
        for stage in result.run.stage_results
        if stage.stage_number == 6
    )
    buy_decisions = [decision for decision in result.decisions if decision.decision == "BUY_NEW"]
    exit_decisions = [decision for decision in result.decisions if decision.decision == "EXIT"]

    assert len(buy_decisions) == 10
    assert all(decision.order_plan is not None for decision in buy_decisions)
    assert exit_decisions[0].market_id == active_market.market_id
    assert exit_decisions[0].exit_state == "EVENT_EXIT_PLANNED"
    assert exit_decisions[0].order_plan is not None
    assert exit_decisions[0].order_plan.action == "sell"
    assert any(
        signal.reasonCode == "OUTSIDE_TOP_10_BY_RETURNS_DAY"
        for signal in exit_decisions[0].exit_signals
    )
    assert stage6.outputs["active_rows_ranked"] == 0
    assert stage6.outputs["top_active_keys"] == []
    assert set(stage6.outputs["top_candidate_market_ids"]) == {
        market.market_id for market in candidate_markets
    }
    assert result.run.diagnostics.top_candidate_market_ids == [
        market.market_id for market in candidate_markets
    ]


@pytest.mark.anyio
async def test_console_profile_manual_selected_rows_only_buy_ranked_top_10_candidates(
    monkeypatch,
):
    fixed_now = datetime(2026, 6, 21, 12, 0, tzinfo=UTC)
    manual_rows = [
        _manual_console_candidate_row(
            market_id=f"candidate-market-{index}",
            question_id=f"candidate-market-{index}",
            market_title=f"Candidate market {index}",
            slug=f"candidate-market-{index}",
            current_yes_odds=15,
            current_no_odds=85,
            llm_yes_odds=15,
            llm_no_odds=85,
            returns_per_day=20 - index,
            selected=True,
            close_time=(fixed_now + timedelta(days=7 + index)).isoformat(),
        )
        for index in range(1, 12)
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

    async def fake_refresh_balance():
        return SimpleNamespace(
            status="ready",
            available_balance_usd=50.0,
            account_value_usd=50.0,
            message="Balance ready",
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
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.refresh_balance",
        fake_refresh_balance,
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
                    total_candidates=len(manual_rows),
                    candidate_rows=manual_rows,
                )
            )
        ),
        positions=[],
        historical_decisions=[],
    )

    buy_decisions = [decision for decision in result.decisions if decision.decision == "BUY_NEW"]
    skipped_decisions = [decision for decision in result.decisions if decision.decision == "SKIP"]

    assert len(buy_decisions) == 10
    assert all(decision.stage3_result == "SELECTED" for decision in buy_decisions)
    assert all(
        decision.stage3_final_rank is not None and decision.stage3_final_rank <= 10
        for decision in buy_decisions
    )
    assert set(result.run.diagnostics.top_candidate_market_ids) == {
        f"candidate-market-{index}" for index in range(1, 11)
    }
    assert all(
        decision.market_id != "candidate-market-11" for decision in buy_decisions
    )
    assert any(
        decision.market_id == "candidate-market-11"
        and decision.reason == "Candidate qualified but did not make the top-10 returns/day table."
        and decision.stage3_result == "OUTSIDE_TOP_10"
        and decision.stage3_final_rank == 11
        for decision in skipped_decisions
    )


@pytest.mark.anyio
async def test_console_profile_manual_table_rows_skip_candidates_already_in_active_positions(
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
        return [
            _console_wallet_position(
                slug="candidate-market-1",
                market_title="Candidate market 1",
                current_price_cents=82,
                side="NO",
                exposure_usd=5,
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
                    total_candidates=2,
                    candidate_rows=manual_rows,
                )
            )
        ),
        positions=[],
        historical_decisions=[],
    )

    buy_decisions = [decision for decision in result.decisions if decision.decision == "BUY_NEW"]
    skipped_decisions = [decision for decision in result.decisions if decision.decision == "SKIP"]

    assert [decision.market_id for decision in buy_decisions] == ["candidate-market-2"]
    assert any(
        decision.market_id == "candidate-market-1"
        and "active Bullpen position" in decision.reason
        and decision.stage3_result == "BLOCKED"
        for decision in skipped_decisions
    )
    assert all(
        not (decision.decision == "BUY_NEW" and decision.market_id == "candidate-market-1")
        for decision in result.decisions
    )


@pytest.mark.anyio
async def test_console_profile_manual_rows_plan_only_one_buy_order_per_duplicate_market(
    monkeypatch,
):
    fixed_now = datetime(2026, 6, 21, 12, 0, tzinfo=UTC)
    manual_rows = [
        _manual_console_candidate_row(
            market_id="duplicate-market",
            question_id="duplicate-market-row-1",
            market_title="Duplicate market row 1",
            slug="duplicate-market",
            current_yes_odds=18,
            current_no_odds=82,
            llm_yes_odds=10,
            llm_no_odds=90,
            returns_per_day=9.5,
            selected=True,
        ),
        _manual_console_candidate_row(
            market_id="duplicate-market",
            question_id="duplicate-market-row-2",
            market_title="Duplicate market row 2",
            slug="duplicate-market",
            current_yes_odds=18,
            current_no_odds=82,
            llm_yes_odds=10,
            llm_no_odds=90,
            returns_per_day=9.4,
            selected=True,
        ),
    ]
    market_lookup = {
        "duplicate-market": _market(
            question="Duplicate market",
            slug="duplicate-market",
            close_time=(fixed_now + timedelta(days=7)).isoformat(),
            current_yes_odds=18,
            current_no_odds=82,
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
                    total_candidates=len(manual_rows),
                    candidate_rows=manual_rows,
                )
            )
        ),
        positions=[],
        historical_decisions=[],
    )

    buy_decisions = [decision for decision in result.decisions if decision.decision == "BUY_NEW"]
    skipped_decisions = [decision for decision in result.decisions if decision.decision == "SKIP"]

    assert len(buy_decisions) == 1
    assert buy_decisions[0].market_id == "duplicate-market"
    assert buy_decisions[0].stage3_result == "SELECTED"
    assert buy_decisions[0].order_plan is not None
    assert len(skipped_decisions) == 1
    assert skipped_decisions[0].market_id == "duplicate-market"
    assert skipped_decisions[0].stage3_result == "BLOCKED"
    assert skipped_decisions[0].reason == (
        "Candidate was not planned because another ranked row for the same market already exists in this run."
    )


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
async def test_console_profile_saved_manual_llm_rows_fall_back_to_a_full_review_when_live_active_positions_are_missing(
    monkeypatch,
):
    fixed_now = datetime(2026, 6, 21, 12, 0, tzinfo=UTC)
    manual_row = _manual_console_candidate_row(
        market_id="candidate-market-1",
        question_id="candidate-market-1",
        market_title="Candidate market 1",
        slug="candidate-market-1",
        current_yes_odds=8,
        current_no_odds=92,
        llm_yes_odds=11,
        llm_no_odds=89,
        returns_per_day=6.2,
        selected=True,
    )
    active_position = _console_wallet_position(
        slug="active-market-1",
        market_title="Active market 1",
        current_price_cents=88,
        side="NO",
    )
    market_lookup = {
        manual_row.slug: _market(
            question=manual_row.market_title,
            slug=manual_row.slug,
            close_time=manual_row.close_time,
            current_yes_odds=manual_row.current_yes_odds,
            current_no_odds=manual_row.current_no_odds,
        ),
        active_position.slug: _market(
            question=active_position.market_title,
            slug=active_position.slug,
            close_time=active_position.close_time,
            current_yes_odds=active_position.current_yes_odds,
            current_no_odds=active_position.current_no_odds,
        ),
    }
    llm_calls: list[str] = []

    async def fake_read_console_wallet_positions():
        return [active_position]

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
        return _fake_llm_consensus(fair_yes=10, fair_no=90)

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
            console_llm_targets=[
                BullpenAutoLiveLlmTarget(provider="openai", model="gpt-4o-mini")
            ],
        ),
        state=BullpenAutoLiveState(running=True),
        run=_run_snapshot(
            request_context=BullpenAutoLiveRunOnceRequest(
                console_profile=BullpenAutoLiveConsoleRunContext(
                    source_label="Bullpen CLI",
                    source_url="https://app.bullpen.fi/predictions/trending?ref=intrepid-crane-3",
                    scanned_at=fixed_now.isoformat(),
                    total_candidates=1,
                    reuse_saved_llm_outputs=True,
                    candidate_rows=[manual_row],
                )
            )
        ),
        positions=[],
        historical_decisions=[],
    )

    assert llm_calls == ["active-market-1", "candidate-market-1"]
    assert result.run.stage_results[1].outputs["workflow_stage_key"] == "llm"
    assert result.run.stage_results[1].outputs["llm_candidate_count"] == 2
    assert result.run.stage_results[1].outputs["stage2_reviewed_rows"] == 2
    assert result.run.stage_results[1].outputs["stage2_universe_complete"] is True
    assert not result.run.stage_results[1].outputs.get("reused_existing_llm_outputs")


@pytest.mark.anyio
async def test_console_profile_prefiltered_manual_rows_bypass_backend_filters(
    monkeypatch,
):
    fixed_now = datetime(2026, 6, 21, 12, 0, tzinfo=UTC)
    manual_row = _manual_console_candidate_row(
        market_id="candidate-market-1",
        question_id="candidate-market-1",
        market_title="Candidate market 1",
        slug="candidate-market-1",
        current_yes_odds=4,
        current_no_odds=96,
        llm_yes_odds=8,
        llm_no_odds=92,
        returns_per_day=4.1,
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
        raise AssertionError("Prefiltered Bullpen x AI rows should bypass the backend rescan.")

    async def fail_scan_console_profile_markets(**_kwargs):
        raise AssertionError("Prefiltered Bullpen x AI rows should bypass the console profile scan.")

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
        lambda *args, **kwargs: _fake_llm_consensus(fair_yes=8, fair_no=92),
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
                    candidate_rows_prefiltered=True,
                    reuse_saved_llm_outputs=False,
                    candidate_rows=[manual_row],
                )
            )
        ),
        positions=[],
        historical_decisions=[],
    )

    assert result.run.decisions_count == 1
    assert result.run.diagnostics.used_manual_console_rows is True
    assert result.run.stage_results[0].outputs["accepted_candidates_count"] == 1
    assert result.run.stage_results[0].outputs["rejected_candidates_count"] == 0
    assert result.run.stage_results[0].outputs["accepted_candidates"][0]["market_id"] == (
        "candidate-market-1"
    )
    assert result.run.stage_results[0].outputs["llm_candidate_count"] == 1


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


@pytest.mark.anyio
async def test_console_profile_stage2_failure_returns_empty_decisions(monkeypatch):
    fixed_now = datetime(2026, 6, 21, 12, 0, tzinfo=UTC)
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
            selected=True,
            llm_outputs=[],
        )
    ]
    failed_output = BullpenAutoLiveLlmOutput(
        provider="openai",
        model="gpt-4o-mini",
        error="provider unavailable",
        completed_at=fixed_now.isoformat(),
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
        AsyncMock(return_value=[]),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.build_evidence_packet",
        lambda *args, **kwargs: _fake_evidence_packet(),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.engine.run_llm_consensus",
        lambda *args, **kwargs: (
            [failed_output],
            SimpleNamespace(
                fair_yes_probability_pct=None,
                fair_no_probability_pct=None,
                average_yes=None,
                median_yes=None,
                trimmed_mean_yes=None,
                iqr_yes=None,
                trimmed_range_yes=None,
                min_yes=None,
                max_yes=None,
                spread_yes=None,
                disagreement_level="Unknown",
                disagreement_category="NO_USABLE_OUTPUTS",
                adjudication_required=False,
                consensus_method="none",
                rationale_mismatch_count=0,
                confidence=None,
                evidence_status=None,
                event_state=None,
                provider_error_rate=1.0,
            ),
        ),
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
                    scanned_at=fixed_now.isoformat(),
                    total_candidates=1,
                    candidate_rows=manual_rows,
                )
            )
        ),
        positions=[],
        historical_decisions=[],
    )

    assert result.decisions == []
    assert result.run.status == "failed"
    assert result.run.decisions_count == 0
    assert result.run.stage_results[1].outputs["phase_status"] == "failed"



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
    stage2_llm_targets_snapshot: list[BullpenAutoLiveLlmTarget] | None = None,
) -> BullpenAutoLiveRun:
    return BullpenAutoLiveRun(
        id="run-1",
        triggered_by="manual",
        status="running",
        dry_run=dry_run,
        started_at="2026-06-21T10:00:00+00:00",
        summary="Queued",
        request_context=request_context,
        stage2_llm_targets_snapshot=stage2_llm_targets_snapshot,
    )


def test_summarize_stage3_step2_buy_queue_tracks_transferred_rows_separately_from_buy_orders():
    timestamp = "2026-07-19T00:00:00+00:00"

    def build_buy_decision(
        market_id: str,
        *,
        stage3_result: str = "SELECTED",
        order_status: str | None = None,
    ) -> BullpenAutoLiveDecision:
        order_plan = (
            BullpenAutoLiveOrderPlan.model_construct(
                id=f"{market_id}-order",
                action="buy",
                side="YES",
                status=order_status,
                market_id=market_id,
                market_title=market_id,
                order_size_usd=5.0,
                shares=10.0,
                limit_price_cents=50.0,
                max_slippage_cents=2.0,
                dry_run=False,
                detail="Test order",
                created_at=timestamp,
            )
            if order_status is not None
            else None
        )
        return BullpenAutoLiveDecision.model_construct(
            id=f"{market_id}-decision",
            run_id="run-1",
            created_at=timestamp,
            updated_at=timestamp,
            market_id=market_id,
            market_title=market_id,
            side="YES",
            decision="BUY_NEW",
            reason="Test decision",
            summary="Test decision",
            stage3_result=stage3_result,
            stage_results=[],
            order_plan=order_plan,
            exit_signals=[],
        )

    counts = _summarize_stage3_step2_buy_queue(
        [
            build_buy_decision("market-queued"),
            build_buy_decision("market-blocked", stage3_result="BLOCKED"),
            build_buy_decision("market-submitted", order_status="submitted"),
            build_buy_decision("market-planned", order_status="planned"),
            BullpenAutoLiveDecision.model_construct(
                id="outside-queue-decision",
                run_id="run-1",
                created_at=timestamp,
                updated_at=timestamp,
                market_id="outside-queue",
                market_title="outside-queue",
                side="YES",
                decision="BUY_NEW",
                reason="Ignored",
                summary="Ignored",
                stage3_result="SELECTED",
                stage_results=[],
                order_plan=None,
                exit_signals=[],
            ),
        ],
        {"market-queued", "market-blocked", "market-submitted", "market-planned"},
    )

    assert counts == {"planned": 4, "processed": 2, "submitted": 1}


def test_stage3_capacity_override_sizes_from_live_and_current_run_markets_only():
    visible_market_ids = {"live-1", "live-2", "live-3"}
    historical_pending_market_ids = {
        f"historical-pending-{index}" for index in range(10)
    }
    current_run_submitted_market_ids = {"current-run-buy"}

    regular_ids = _stage3_capacity_sizing_market_ids(
        visible_active_market_ids=visible_market_ids,
        pending_submitted_buy_market_ids=historical_pending_market_ids,
        current_run_submitted_buy_market_ids=current_run_submitted_market_ids,
        capacity_override_enabled=False,
    )
    override_ids = _stage3_capacity_sizing_market_ids(
        visible_active_market_ids=visible_market_ids,
        pending_submitted_buy_market_ids=historical_pending_market_ids,
        current_run_submitted_buy_market_ids=current_run_submitted_market_ids,
        capacity_override_enabled=True,
    )

    assert len(regular_ids) == 13
    assert override_ids == visible_market_ids | current_run_submitted_market_ids
    assert build_console_trade_amount_breakdown(
        available_balance_usd=8.51,
        occupied_position_count=len(override_ids),
    )["order_usd"] == 1.42


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


def test_console_profile_discover_walks_nested_bullpen_payload_like_manual_scan():
    from app.domains.polymarket_auto_live.console_profile import (
        _build_cli_console_scan_result,
        _collect_console_discover_rows,
    )

    now = datetime(2026, 7, 7, tzinfo=UTC)
    payload = {
        "rows": [{"summary": "top-level placeholder"} for _ in range(100)],
        "payload": {
            "markets": [
                {
                    "id": f"market-{index}",
                    "question": f"Nested valid question {index}?",
                    "slug": f"nested-valid-question-{index}",
                    "endDate": "2026-07-08T00:00:00Z",
                    "outcomes": json.dumps(["Yes", "No"]),
                    "outcomePrices": json.dumps([0.55, 0.45]),
                }
                for index in range(125)
            ]
        },
    }

    rows = _collect_console_discover_rows(payload)
    result = _build_cli_console_scan_result(
        rows,
        now=now,
        scanned_at="2026-07-07T00:00:00+00:00",
    )

    assert len(rows) == 125
    assert result.total_candidates == 125
    assert len(result.accepted) == 125


def test_console_profile_discover_inherits_parent_category_context():
    from app.domains.polymarket_auto_live.console_profile import (
        _build_cli_console_scan_result,
        _collect_console_discover_rows,
    )

    now = datetime(2026, 7, 7, tzinfo=UTC)
    payload = {
        "sections": [
            {
                "categoryBreadcrumb": {
                    "categoryLabel": "Politics",
                    "subcategoryLabel": "Middle East",
                },
                "markets": [
                    {
                        "id": "market-iran-airspace",
                        "question": "Iran full airspace closure by July 15?",
                        "slug": "iran-full-airspace-closure-by-july-15",
                        "endDate": "2026-07-08T00:00:00Z",
                        "outcomes": json.dumps(["Yes", "No"]),
                        "outcomePrices": json.dumps([0.08, 0.92]),
                    }
                ],
            }
        ]
    }

    rows = _collect_console_discover_rows(payload)
    result = _build_cli_console_scan_result(
        rows,
        now=now,
        scanned_at="2026-07-07T00:00:00+00:00",
    )

    assert len(rows) == 1
    assert rows[0].context_theme == "Politics · Middle East"
    assert len(result.accepted) == 1
    assert result.accepted[0].theme == "Politics · Middle East"


def test_gamma_market_theme_matches_manual_scan_politics_inference():
    from app.domains.polymarket_auto_live.scanner import _normalize_market

    market = _normalize_market(
        {
            "id": "market-iran-gulf-state",
            "question": "Iran military action against a Gulf State on July 13?",
            "slug": "iran-military-action-against-a-gulf-state-on-july-13",
            "endDate": "2026-07-13T00:00:00Z",
            "outcomes": json.dumps(["Yes", "No"]),
            "outcomePrices": json.dumps([0.72, 0.28]),
        }
    )

    assert market is not None
    assert market.theme == "Politics"
