import os
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://test:test@localhost:5432/testdb",
)
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

import pytest

from app.domains.polymarket_auto_live.bot import (
    BullpenAutoLiveBot,
    _auth_recovery_operator_resume_active,
    _stage3_intent_operator_resume_active,
)
from app.domains.polymarket_auto_live.run_recovery import (
    AutoLiveTaskRuntimeSnapshot,
    inspect_auto_live_run_task_sync,
    mark_historical_auth_error_recovered,
    mark_interrupted_run_for_restart,
    reconcile_running_auto_live_run,
)
from app.domains.polymarket_auto_live.schemas import (
    BullpenAutoLiveDecision,
    BullpenAutoLiveRun,
    BullpenAutoLiveRunOnceRequest,
    BullpenAutoLiveSettings,
    BullpenAutoLiveStageResult,
    BullpenAutoLiveState,
    BullpenAutoLiveTaskLifecycle,
)


def _stage_result(
    *,
    stage_number: int,
    workflow_stage_key: str,
    phase_status: str,
    reason: str,
    outputs: dict[str, object] | None = None,
    completed_at: str | None,
) -> BullpenAutoLiveStageResult:
    stage_outputs = {
        "workflow_stage_key": workflow_stage_key,
        "phase_status": phase_status,
    }
    if outputs:
        stage_outputs.update(outputs)
    return BullpenAutoLiveStageResult(
        stage_number=stage_number,
        stage_name=f"Stage {stage_number}",
        status="pass" if phase_status == "completed" else "warning",
        reason=reason,
        outputs=stage_outputs,
        started_at="2026-07-05T12:00:00+00:00",
        completed_at=completed_at,
    )


def _stage3_decision_row() -> dict[str, object]:
    return {
        "id": "decision-run-recovery-market-1",
        "run_id": "run-summary-backfill",
        "created_at": "2026-07-05T12:09:00+00:00",
        "updated_at": "2026-07-05T12:10:00+00:00",
        "market_id": "market-1",
        "market_title": "Will recovery backfill decisions?",
        "market_url": "https://example.com/market-1",
        "slug": "market-1",
        "close_time": "2026-07-08T12:00:00+00:00",
        "theme": "Macro",
        "side": "NO",
        "decision": "BUY_NEW",
        "risk_status": "Ready",
        "price_cents": 82.0,
        "current_yes_odds": 18.0,
        "current_no_odds": 82.0,
        "fair_probability_pct": 82.0,
        "fair_yes_probability_pct": 18.0,
        "fair_no_probability_pct": 82.0,
        "edge_pp": 0.0,
        "score": 5.0,
        "confidence": "High",
        "evidence_status": "Strong",
        "adjudication_required": False,
        "current_exposure_usd": 0.0,
        "target_exposure_usd": 5.0,
        "key_evidence": [],
        "red_flags": [],
        "reason": "Recovered from Stage 3 payload.",
        "summary": "Recovered from Stage 3 payload.",
        "stage3_result": "SELECTED",
        "stage3_result_reason": "Recovered from Stage 3 payload.",
        "stage3_final_rank": 1,
        "stage3_max_positions": 10,
        "order_plan": {
            "id": "order-run-recovery-market-1",
            "action": "buy",
            "side": "NO",
            "order_type": "limit",
            "status": "submitted",
            "market_id": "market-1",
            "market_title": "Will recovery backfill decisions?",
            "order_size_usd": 5.0,
            "shares": 6.097561,
            "limit_price_cents": 82.0,
            "max_slippage_cents": 2.0,
            "dry_run": False,
            "detail": "Limit order submitted successfully.",
            "execution_response": None,
            "created_at": "2026-07-05T12:09:00+00:00",
            "executed_at": "2026-07-05T12:09:05+00:00",
        },
        "exit_signals": [],
        "exit_state": "ACTIVE",
        "llm_outputs": [],
        "stage_results": [],
        "guardrail_checks": [],
    }


def test_reconcile_running_auto_live_run_completes_when_stage3_is_already_terminal():
    run = BullpenAutoLiveRun(
        id="run-complete-me",
        triggered_by="manual",
        status="running",
        dry_run=False,
        started_at="2026-07-05T12:00:00+00:00",
        summary="Stage 3 reviewed row 15 of 15. Latest: Final market",
        stage_results=[
            _stage_result(
                stage_number=1,
                workflow_stage_key="scan",
                phase_status="completed",
                reason="Stage 1 finished.",
                completed_at="2026-07-05T12:00:10+00:00",
            ),
            _stage_result(
                stage_number=2,
                workflow_stage_key="llm",
                phase_status="completed",
                reason="Stage 2 finished.",
                completed_at="2026-07-05T12:02:10+00:00",
            ),
            _stage_result(
                stage_number=3,
                workflow_stage_key="invest",
                phase_status="completed",
                reason="Rebalance and investment finished.",
                outputs={
                    "decisions_count": 15,
                    "orders_planned": 2,
                    "orders_submitted": 2,
                },
                completed_at="2026-07-05T12:10:10+00:00",
            ),
        ],
    )

    recovered = reconcile_running_auto_live_run(
        run,
        started_at=datetime(2026, 7, 5, 12, 0, tzinfo=UTC),
        updated_at=datetime(2026, 7, 5, 12, 10, 10, tzinfo=UTC),
        now=datetime(2026, 7, 5, 12, 12, tzinfo=UTC),
        task_snapshot=AutoLiveTaskRuntimeSnapshot(
            task_id="celery-task-1",
            state="PENDING",
            inspect_succeeded=False,
        ),
    )

    assert recovered is run
    assert recovered.status == "completed"
    assert recovered.completed_at == "2026-07-05T12:10:10+00:00"
    assert recovered.error_message is None
    assert (
        recovered.summary
        == "Auto-Live completed with 15 decisions, 2 planned orders, and 2 submitted orders."
    )


def test_reconcile_running_auto_live_run_does_not_complete_from_completed_at_alone():
    run = BullpenAutoLiveRun(
        id="run-missing-stage3",
        triggered_by="manual",
        status="running",
        dry_run=False,
        started_at="2026-07-05T12:00:00+00:00",
        completed_at="2026-07-05T12:02:10+00:00",
        summary="Stage 2 finished.",
        stage_results=[
            _stage_result(
                stage_number=1,
                workflow_stage_key="scan",
                phase_status="completed",
                reason="Stage 1 finished.",
                completed_at="2026-07-05T12:00:10+00:00",
            ),
            _stage_result(
                stage_number=2,
                workflow_stage_key="llm",
                phase_status="completed",
                reason="Stage 2 finished.",
                completed_at="2026-07-05T12:02:10+00:00",
            ),
        ],
    )

    recovered = reconcile_running_auto_live_run(
        run,
        started_at=datetime(2026, 7, 5, 12, 0, tzinfo=UTC),
        updated_at=datetime(2026, 7, 5, 12, 2, 10, tzinfo=UTC),
        now=datetime(2026, 7, 5, 12, 25, tzinfo=UTC),
        task_snapshot=AutoLiveTaskRuntimeSnapshot(
            task_id="celery-task-missing-stage3",
            state="PENDING",
            inspect_succeeded=True,
        ),
    )

    # PENDING is ambiguous. A run with no explicit STARTED heartbeat must not
    # be terminalized merely because its stored workflow timestamp is old.
    assert recovered is None
    assert run.status == "running"


@pytest.mark.anyio
async def test_get_summary_backfills_completed_run_decisions_from_stage3_payload(
    monkeypatch,
):
    run = BullpenAutoLiveRun(
        id="run-summary-backfill",
        triggered_by="manual",
        status="completed",
        dry_run=False,
        started_at="2026-07-05T12:00:00+00:00",
        completed_at="2026-07-05T12:10:00+00:00",
        summary="Auto-Live completed with 1 decision.",
        stage_results=[
            _stage_result(
                stage_number=3,
                workflow_stage_key="invest",
                phase_status="completed",
                reason="Stage 3 finished.",
                outputs={
                    "decision_rows": [_stage3_decision_row()],
                    "decisions_count": 1,
                    "orders_planned": 1,
                    "orders_submitted": 1,
                },
                completed_at="2026-07-05T12:10:00+00:00",
            ),
        ],
    )
    settings = BullpenAutoLiveSettings(auto_live_enabled=True)
    state = BullpenAutoLiveState(status="stopped", mode="dry-run")
    stored_decisions: list[BullpenAutoLiveDecision] = []
    replace_calls: list[str] = []

    class _FakeSession:
        def __init__(self) -> None:
            self.commits = 0

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def commit(self) -> None:
            self.commits += 1

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

        async def get_run_for_user(self, user_id: int, run_id: str):
            assert user_id == 7
            assert run_id == "client-run-recovery"
            return None

        async def get_running_run_record(self, user_id: int):
            assert user_id == 7
            return None

        async def list_runs(self, user_id: int, *, limit: int | None = None):
            assert user_id == 7
            assert limit in {10, None}
            return [run]

        async def list_visible_decision_id_sets_by_run(
            self,
            user_id,
            expected_sizes_by_run,
        ):
            assert user_id == 7
            assert expected_sizes_by_run == {run.id: 1}
            return {
                run.id: {decision.id for decision in stored_decisions}
            }

        async def replace_run_decisions_from_stage3_payload(self, user_id: int, next_run):
            assert user_id == 7
            assert next_run.id == run.id
            replace_calls.append(next_run.id)
            stored_decisions[:] = next_run and [
                BullpenAutoLiveDecision.model_validate(_stage3_decision_row())
            ]
            return len(stored_decisions)

        async def list_decisions(self, user_id: int, *, limit: int | None = None):
            assert user_id == 7
            assert limit == 25
            return list(stored_decisions)

        async def save_state(self, user_id: int, next_state: BullpenAutoLiveState):
            assert user_id == 7
            assert next_state.last_run_id in {None, run.id}

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.bot.AsyncSessionLocal",
        lambda: fake_session,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.bot.AsyncPolymarketAutoLiveRepository",
        _FakeRepo,
    )

    summary = await BullpenAutoLiveBot(user_id=7).get_summary()

    assert replace_calls == [run.id]
    assert len(summary.recent_decisions) == 1
    assert summary.recent_decisions[0].run_id == run.id
    assert summary.recent_decisions[0].stage3_result == "SELECTED"
    assert summary.recent_decisions[0].stage3_final_rank == 1
    assert fake_session.commits >= 1


@pytest.mark.anyio
@pytest.mark.parametrize(
    "stored_ids",
    [
        # Same count but a stale row replaced the canonical decision.
        {"decision-stale-same-count"},
        # An over-count used to be incorrectly treated as already repaired.
        {
            "decision-run-recovery-market-1",
            "decision-stale-extra",
        },
    ],
)
async def test_terminal_decision_reconciliation_compares_exact_canonical_ids(
    stored_ids,
):
    run = BullpenAutoLiveRun(
        id="run-summary-backfill",
        triggered_by="manual",
        status="completed",
        dry_run=False,
        started_at="2026-07-05T12:00:00+00:00",
        completed_at="2026-07-05T12:10:00+00:00",
        summary="Completed.",
        stage_results=[
            _stage_result(
                stage_number=3,
                workflow_stage_key="invest",
                phase_status="completed",
                reason="Stage 3 finished.",
                outputs={"decision_rows": [_stage3_decision_row()]},
                completed_at="2026-07-05T12:10:00+00:00",
            )
        ],
    )
    replacement_calls: list[str] = []

    class _Repository:
        async def list_visible_decision_id_sets_by_run(
            self,
            user_id: int,
            expected_sizes_by_run,
        ):
            assert user_id == 7
            assert expected_sizes_by_run == {run.id: 1}
            return {run.id: set(stored_ids)}

        async def replace_run_decisions_from_stage3_payload(
            self,
            user_id: int,
            next_run: BullpenAutoLiveRun,
        ):
            assert user_id == 7
            replacement_calls.append(next_run.id)
            return 1

    reconciled = await BullpenAutoLiveBot(
        user_id=7
    )._reconcile_terminal_stage3_decisions(
        _Repository(),  # type: ignore[arg-type]
        [run],
    )

    assert reconciled is True
    assert replacement_calls == [run.id]


def test_task_inspection_reuses_a_recent_snapshot(monkeypatch):
    calls = {"query_task": 0}

    class _FakeAsyncResult:
        state = "STARTED"

    class _FakeInspector:
        def query_task(self, task_id: str):
            calls["query_task"] += 1
            return {"worker": {"id": task_id}}

        def reserved(self):
            return {}

        def scheduled(self):
            return {}

    class _FakeControl:
        def inspect(self, *, timeout: float):
            assert timeout == 1.0
            return _FakeInspector()

    class _FakeCelery:
        control = _FakeControl()

        @staticmethod
        def AsyncResult(task_id: str):
            assert task_id == "task-cache-test"
            return _FakeAsyncResult()

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.run_recovery.get_registered_auto_live_run_task_id_sync",
        lambda run_id: "task-cache-test",
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.run_recovery.celery",
        _FakeCelery(),
    )

    first = inspect_auto_live_run_task_sync("run-cache-test")
    second = inspect_auto_live_run_task_sync("run-cache-test")

    assert first is second
    assert first.is_active is True
    assert calls == {"query_task": 1}


def test_task_inspection_uses_persisted_lifecycle_id_when_registry_is_missing(monkeypatch):
    """An evicted task-registry key is never absence evidence for recovery."""

    class _FakeAsyncResult:
        state = "STARTED"

    class _FakeInspector:
        def active(self):
            return {"auto-live-worker@example": [{"id": "persisted-task-id"}]}

        def query_task(self, task_id: str):
            assert task_id == "persisted-task-id"
            return {"auto-live-worker@example": {"id": task_id}}

        def reserved(self):
            return {"auto-live-worker@example": []}

        def scheduled(self):
            return {"auto-live-worker@example": []}

        def ping(self):
            return {"auto-live-worker@example": {"ok": "pong"}}

    class _FakeControl:
        @staticmethod
        def inspect(*, timeout: float):
            assert timeout == 1.0
            return _FakeInspector()

    class _FakeCelery:
        control = _FakeControl()

        @staticmethod
        def AsyncResult(task_id: str):
            assert task_id == "persisted-task-id"
            return _FakeAsyncResult()

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.run_recovery.get_registered_auto_live_run_task_id_sync",
        lambda _run_id: None,
    )
    monkeypatch.setattr("app.domains.polymarket_auto_live.run_recovery.celery", _FakeCelery())

    snapshot = inspect_auto_live_run_task_sync(
        "run-registry-evicted",
        lifecycle_task_id="persisted-task-id",
    )

    assert snapshot.task_id == "persisted-task-id"
    assert snapshot.is_active is True
    assert snapshot.inspect_complete is True


def test_registry_eviction_does_not_mark_active_lifecycle_delivery_worker_lost(monkeypatch):
    """Recovery must inspect the persisted delivery when the Redis registry expires."""

    inspected_task_ids: list[str] = []

    class _FakeAsyncResult:
        state = "STARTED"

    class _FakeInspector:
        def active(self):
            return {"auto-live-worker@example": [{"id": "persisted-active-task"}]}

        def query_task(self, task_id: str):
            inspected_task_ids.append(task_id)
            return {"auto-live-worker@example": {"id": task_id}}

        def reserved(self):
            return {"auto-live-worker@example": []}

        def scheduled(self):
            return {"auto-live-worker@example": []}

        def ping(self):
            return {"auto-live-worker@example": {"ok": "pong"}}

    class _FakeControl:
        @staticmethod
        def inspect(*, timeout: float):
            assert timeout == 1.0
            return _FakeInspector()

    class _FakeCelery:
        control = _FakeControl()

        @staticmethod
        def AsyncResult(task_id: str):
            assert task_id == "persisted-active-task"
            return _FakeAsyncResult()

    run = BullpenAutoLiveRun(
        id="run-registry-evicted-active",
        triggered_by="scheduler",
        status="running",
        dry_run=False,
        started_at="2026-07-05T12:00:00+00:00",
        summary="Stage 1 is running.",
        task_lifecycle=BullpenAutoLiveTaskLifecycle(
            state="STARTED",
            task_id="persisted-active-task",
            queue="auto_live",
            worker_started_at="2026-07-05T12:00:00+00:00",
            last_heartbeat_at="2026-07-05T12:00:00+00:00",
        ),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.run_recovery.get_registered_auto_live_run_task_id_sync",
        lambda _run_id: None,
    )
    monkeypatch.setattr("app.domains.polymarket_auto_live.run_recovery.celery", _FakeCelery())

    recovered = reconcile_running_auto_live_run(
        run,
        started_at=datetime(2026, 7, 5, 12, 0, tzinfo=UTC),
        updated_at=datetime(2026, 7, 5, 12, 0, tzinfo=UTC),
        now=datetime(2026, 7, 5, 12, 40, tzinfo=UTC),
    )

    assert recovered is None
    assert run.status == "running"
    assert inspected_task_ids == ["persisted-active-task"]


def test_reconcile_running_auto_live_run_marks_stalled_worker_failed(monkeypatch):
    run = BullpenAutoLiveRun(
        id="run-stalled",
        triggered_by="manual",
        status="running",
        dry_run=False,
        started_at="2026-07-05T12:00:00+00:00",
        summary="Stage 2 started.",
        task_lifecycle=BullpenAutoLiveTaskLifecycle(
            state="STARTED",
            task_id="celery-task-2",
            queue="auto_live",
            worker_started_at="2026-07-05T12:00:00+00:00",
            last_heartbeat_at="2026-07-05T12:20:00+00:00",
        ),
        stage_results=[
            _stage_result(
                stage_number=1,
                workflow_stage_key="scan",
                phase_status="completed",
                reason="Stage 1 finished.",
                completed_at="2026-07-05T12:00:20+00:00",
            ),
            _stage_result(
                stage_number=2,
                workflow_stage_key="llm",
                phase_status="running",
                reason="Stage 2 reviewed 3 of 15 events.",
                completed_at=None,
            ),
        ],
    )
    # A WorkerLost verdict requires positive absence evidence.  In production
    # an unreadable Redis lease is intentionally treated as unknown/liveness
    # evidence, so model the confirmed missing lease explicitly here.
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.run_recovery.auto_live_run_execution_lease_is_live_sync",
        lambda _run_id: False,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.run_recovery.auto_live_run_execution_advisory_lock_is_live_sync",
        lambda _run_id: False,
    )

    recovered = reconcile_running_auto_live_run(
        run,
        started_at=datetime(2026, 7, 5, 12, 0, tzinfo=UTC),
        updated_at=datetime(2026, 7, 5, 12, 20, tzinfo=UTC),
        now=datetime(2026, 7, 5, 12, 40, tzinfo=UTC),
        task_snapshot=AutoLiveTaskRuntimeSnapshot(
            task_id="celery-task-2",
            state="PENDING",
            inspect_succeeded=True,
            inspect_complete=True,
        ),
    )

    assert recovered is run
    assert recovered.status == "failed"
    assert recovered.completed_at == "2026-07-05T12:40:00+00:00"
    assert recovered.error_message is not None
    assert "Worker heartbeat lost" in recovered.error_message
    assert recovered.summary.startswith("Auto-Live run failed during Stage 2 · Run LLM:")
    assert recovered.stage_results[-1].outputs["phase_status"] == "failed"
    assert recovered.task_lifecycle is not None
    assert recovered.task_lifecycle.state == "WORKER_LOST"


def test_reconcile_running_auto_live_run_keeps_healthy_worker_running():
    run = BullpenAutoLiveRun(
        id="run-healthy",
        triggered_by="manual",
        status="running",
        dry_run=False,
        started_at="2026-07-05T12:00:00+00:00",
        summary="Stage 2 started.",
        stage_results=[
            _stage_result(
                stage_number=2,
                workflow_stage_key="llm",
                phase_status="running",
                reason="Stage 2 reviewed 1 of 15 events.",
                completed_at=None,
            )
        ],
    )

    recovered = reconcile_running_auto_live_run(
        run,
        started_at=datetime(2026, 7, 5, 12, 0, tzinfo=UTC),
        updated_at=datetime(2026, 7, 5, 12, 39, tzinfo=UTC),
        now=datetime(2026, 7, 5, 12, 40, tzinfo=UTC),
        task_snapshot=AutoLiveTaskRuntimeSnapshot(
            task_id="celery-task-3",
            state="STARTED",
            is_active=True,
            inspect_succeeded=True,
        ),
    )

    assert recovered is None
    assert run.status == "running"


def test_reconcile_keeps_queued_task_waiting_past_progress_timeout():
    run = BullpenAutoLiveRun(
        id="run-queued-pool-wait",
        triggered_by="scheduler",
        status="running",
        dry_run=False,
        started_at="2026-07-05T12:00:00+00:00",
        summary="Stage 1 started.",
        task_lifecycle=BullpenAutoLiveTaskLifecycle(
            state="QUEUED",
            task_id="celery-queued",
            queue="auto_live",
            enqueued_at="2026-07-05T12:00:00+00:00",
        ),
    )

    recovered = reconcile_running_auto_live_run(
        run,
        started_at=datetime(2026, 7, 5, 12, 0, tzinfo=UTC),
        updated_at=datetime(2026, 7, 5, 12, 0, tzinfo=UTC),
        now=datetime(2026, 7, 5, 12, 23, tzinfo=UTC),
        task_snapshot=AutoLiveTaskRuntimeSnapshot(
            task_id="celery-queued",
            state="PENDING",
            inspect_succeeded=True,
            inspect_complete=True,
        ),
    )

    assert recovered is None
    assert run.status == "running"
    assert run.task_lifecycle is not None
    assert run.task_lifecycle.detail == "Queued — waiting for Auto-Live worker"


def test_worker_lost_failure_waits_for_redelivery_grace_before_terminalizing():
    """Late-ack WorkerLostError is not final before a same-ID redelivery."""

    run = BullpenAutoLiveRun(
        id="run-worker-lost-redelivery-grace",
        triggered_by="scheduler",
        status="running",
        dry_run=False,
        started_at="2026-07-05T12:00:00+00:00",
        summary="Stage 1 is running.",
        task_lifecycle=BullpenAutoLiveTaskLifecycle(
            state="STARTED",
            task_id="celery-worker-lost",
            queue="auto_live",
            worker_started_at="2026-07-05T12:00:00+00:00",
            last_heartbeat_at="2026-07-05T12:05:00+00:00",
        ),
    )

    recovered = reconcile_running_auto_live_run(
        run,
        started_at=datetime(2026, 7, 5, 12, 0, tzinfo=UTC),
        updated_at=datetime(2026, 7, 5, 12, 5, tzinfo=UTC),
        # Nineteen minutes is beyond the normal heartbeat timeout but still
        # inside the five-minute worker-loss/redelivery grace window.
        now=datetime(2026, 7, 5, 12, 24, tzinfo=UTC),
        task_snapshot=AutoLiveTaskRuntimeSnapshot(
            task_id="celery-worker-lost",
            state="FAILURE",
            result_error="billiard.exceptions.WorkerLostError: Worker exited prematurely",
            inspect_succeeded=True,
            inspect_complete=True,
        ),
    )

    assert recovered is None
    assert run.status == "running"
    assert run.task_lifecycle is not None
    assert run.task_lifecycle.state == "STARTED"


def test_reconcile_keeps_fresh_started_heartbeat_when_inspect_misses_task():
    run = BullpenAutoLiveRun(
        id="run-heartbeat-inspect-miss",
        triggered_by="manual",
        status="running",
        dry_run=False,
        started_at="2026-07-05T12:00:00+00:00",
        summary="Stage 2 started.",
        task_lifecycle=BullpenAutoLiveTaskLifecycle(
            state="STARTED",
            task_id="celery-heartbeat",
            queue="auto_live",
            worker_started_at="2026-07-05T12:00:00+00:00",
            last_heartbeat_at="2026-07-05T12:39:00+00:00",
        ),
    )

    recovered = reconcile_running_auto_live_run(
        run,
        started_at=datetime(2026, 7, 5, 12, 0, tzinfo=UTC),
        updated_at=datetime(2026, 7, 5, 12, 0, tzinfo=UTC),
        now=datetime(2026, 7, 5, 12, 40, tzinfo=UTC),
        task_snapshot=AutoLiveTaskRuntimeSnapshot(
            task_id="celery-heartbeat",
            state="PENDING",
            inspect_succeeded=True,
            inspect_complete=False,
        ),
    )

    assert recovered is None
    assert run.status == "running"


def test_reconcile_keeps_stale_heartbeat_within_worker_loss_grace():
    run = BullpenAutoLiveRun(
        id="run-heartbeat-grace",
        triggered_by="manual",
        status="running",
        dry_run=False,
        started_at="2026-07-05T12:00:00+00:00",
        summary="Stage 2 started.",
        task_lifecycle=BullpenAutoLiveTaskLifecycle(
            state="STARTED",
            task_id="celery-grace",
            queue="auto_live",
            worker_started_at="2026-07-05T12:00:00+00:00",
            last_heartbeat_at="2026-07-05T12:20:00+00:00",
        ),
    )

    recovered = reconcile_running_auto_live_run(
        run,
        started_at=datetime(2026, 7, 5, 12, 0, tzinfo=UTC),
        updated_at=datetime(2026, 7, 5, 12, 0, tzinfo=UTC),
        # 19 minutes is beyond the normal 15 minute heartbeat timeout but
        # within its five minute worker-loss/redelivery grace.
        now=datetime(2026, 7, 5, 12, 39, tzinfo=UTC),
        task_snapshot=AutoLiveTaskRuntimeSnapshot(
            task_id="celery-grace",
            state="PENDING",
            inspect_succeeded=True,
            inspect_complete=True,
        ),
    )

    assert recovered is None
    assert run.status == "running"


def test_reconcile_running_auto_live_run_terminates_active_worker_at_maximum_runtime(
    monkeypatch,
):
    run = BullpenAutoLiveRun(
        id="run-over-limit",
        triggered_by="manual",
        status="running",
        dry_run=False,
        started_at="2026-07-05T12:00:00+00:00",
        summary="Stage 2 started.",
        stage_results=[
            _stage_result(
                stage_number=2,
                workflow_stage_key="llm",
                phase_status="running",
                reason="Stage 2 reviewed 1 of 15 events.",
                completed_at=None,
            )
        ],
    )
    revoked_task_ids: list[str] = []
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.run_recovery.revoke_auto_live_run_task_sync",
        revoked_task_ids.append,
    )

    recovered = reconcile_running_auto_live_run(
        run,
        started_at=datetime(2026, 7, 5, 12, 0, tzinfo=UTC),
        updated_at=datetime(2026, 7, 5, 14, 1, tzinfo=UTC),
        now=datetime(2026, 7, 5, 14, 1, tzinfo=UTC),
        task_snapshot=AutoLiveTaskRuntimeSnapshot(
            task_id="celery-task-over-limit",
            state="STARTED",
            is_active=True,
            inspect_succeeded=True,
        ),
    )

    assert recovered is run
    assert revoked_task_ids == ["celery-task-over-limit"]
    assert recovered.status == "failed"
    assert recovered.error_message is not None
    assert "120-minute maximum runtime" in recovered.error_message
    assert "termination was requested" in recovered.error_message
    assert recovered.stage_results[-1].outputs["phase_status"] == "failed"


def test_reconcile_running_auto_live_run_keeps_successful_stage3_handoff_confirming():
    run = BullpenAutoLiveRun(
        id="run-stage3-handoff",
        triggered_by="manual",
        status="running",
        dry_run=False,
        started_at="2026-07-05T12:00:00+00:00",
        summary="Stage 3 queued candidate rows for execution.",
        stage_results=[
            _stage_result(
                stage_number=1,
                workflow_stage_key="scan",
                phase_status="completed",
                reason="Stage 1 finished.",
                completed_at="2026-07-05T12:05:00+00:00",
            ),
            _stage_result(
                stage_number=2,
                workflow_stage_key="llm",
                phase_status="completed",
                reason="Stage 2 finished.",
                completed_at="2026-07-05T12:15:00+00:00",
            ),
            _stage_result(
                stage_number=3,
                workflow_stage_key="invest",
                phase_status="queued",
                reason="Stage 3 queued 2 durable rows.",
                outputs={
                    "orders_queued": 2,
                    "orders_planned": 0,
                    "decision_rows": [_stage3_decision_row(), _stage3_decision_row()],
                },
                completed_at=None,
            ),
        ],
    )

    recovered = reconcile_running_auto_live_run(
        run,
        started_at=datetime(2026, 7, 5, 12, 0, tzinfo=UTC),
        updated_at=datetime(2026, 7, 5, 12, 20, tzinfo=UTC),
        now=datetime(2026, 7, 5, 12, 21, tzinfo=UTC),
        task_snapshot=AutoLiveTaskRuntimeSnapshot(
            task_id="celery-task-success",
            state="SUCCESS",
            inspect_succeeded=True,
        ),
    )

    assert recovered is run
    assert recovered.status == "confirming"
    assert recovered.completed_at is None
    assert recovered.error_message is None
    assert "awaiting asynchronous execution reconciliation" in recovered.summary
    assert recovered.stage_results[-1].completed_at is None
    assert recovered.stage_results[-1].outputs["phase_status"] == "confirming"
    assert (
        recovered.stage_results[-1].outputs["worker_handoff_completed_at"]
        == "2026-07-05T12:21:00+00:00"
    )


def test_reconcile_running_auto_live_run_surfaces_terminal_celery_failure_detail():
    run = BullpenAutoLiveRun(
        id="run-terminal-failure",
        triggered_by="manual",
        status="running",
        dry_run=False,
        started_at="2026-07-05T12:00:00+00:00",
        summary="Stage 3 is submitting planned orders.",
        stage_results=[
            _stage_result(
                stage_number=3,
                workflow_stage_key="invest",
                phase_status="running",
                reason="Stage 3 submitted 2 of 5 orders.",
                completed_at=None,
            )
        ],
    )

    recovered = reconcile_running_auto_live_run(
        run,
        started_at=datetime(2026, 7, 5, 12, 0, tzinfo=UTC),
        updated_at=datetime(2026, 7, 5, 12, 5, tzinfo=UTC),
        now=datetime(2026, 7, 5, 12, 6, tzinfo=UTC),
        task_snapshot=AutoLiveTaskRuntimeSnapshot(
            task_id="celery-task-failed",
            state="FAILURE",
            result_error="Future attached to a different loop",
            result_traceback="Traceback (most recent call last):\nRuntimeError: Future attached to a different loop",
            inspect_succeeded=True,
        ),
    )

    assert recovered is run
    assert recovered.status == "failed"
    assert recovered.error_message is not None
    assert "Failure detail: Future attached to a different loop" in recovered.error_message
    assert "No persisted Celery exception detail" not in recovered.error_message
    assert recovered.stage_results[-1].outputs["failure_message"] == recovered.error_message
    assert recovered.stage_results[-1].outputs["phase_status"] == "aborted"
    assert recovered.stage_results[-1].outputs["recovery_required"] is True
    assert recovered.audit_metadata["stage3_recovery"]["automatic_resubmission"] is False


def test_service_restart_aborts_stage3_without_resubmitting_orders():
    run = BullpenAutoLiveRun(
        id="run-stage3-restart",
        triggered_by="scheduler",
        status="confirming",
        dry_run=False,
        started_at="2026-07-20T12:00:00+00:00",
        summary="Stage 3 submitted 1 of 3 planned orders.",
        orders_planned=3,
        orders_submitted=1,
        stage_results=[
            _stage_result(
                stage_number=3,
                workflow_stage_key="invest",
                phase_status="running",
                reason="Stage 3 submitted 1 of 3 planned orders.",
                outputs={
                    "orders_planned": 3,
                    "orders_processed": 1,
                    "orders_submitted": 1,
                },
                completed_at=None,
            )
        ],
    )

    recovered = mark_interrupted_run_for_restart(
        run,
        interrupted_at="2026-07-20T12:05:00+00:00",
    )

    assert recovered is run
    assert recovered.status == "failed"
    assert recovered.completed_at == "2026-07-20T12:05:00+00:00"
    assert recovered.orders_planned == 3
    assert recovered.orders_submitted == 1
    assert recovered.stage_results[-1].outputs["phase_status"] == "aborted"
    assert recovered.stage_results[-1].outputs["recovery_required"] is True
    assert recovered.stage_results[-1].outputs["automatic_resubmission"] is False
    assert recovered.audit_metadata["stage3_recovery"] == {
        "required": True,
        "status": "aborted_recovery_required",
        "interrupted_at": "2026-07-20T12:05:00+00:00",
        "automatic_resubmission": False,
    }
    assert "no order was automatically resubmitted" in recovered.summary


def test_healthy_active_auth_marks_historical_run_error_stale():
    run = BullpenAutoLiveRun(
        id="run-auth-recovered",
        triggered_by="manual",
        status="running",
        dry_run=False,
        started_at="2026-07-20T12:00:00+00:00",
        summary="Failed: AUTH_REFRESH_REJECTED_LOGIN_REQUIRED",
        error_message="Session expired. Run: bullpen login",
        stage_results=[
            _stage_result(
                stage_number=3,
                workflow_stage_key="invest",
                phase_status="running",
                reason="Bullpen login required.",
                completed_at=None,
            )
        ],
    )

    recovered = mark_historical_auth_error_recovered(
        run,
        recovered_at="2026-07-20T12:06:00+00:00",
    )

    assert recovered.status == "failed"
    assert recovered.error_message is None
    assert recovered.stage_results[-1].outputs["phase_status"] == "aborted"
    assert recovered.stage_results[-1].outputs["historical_auth_error_stale"] is True
    assert recovered.audit_metadata["auth_recovery"] == {
        "historical_error_stale": True,
        "active_auth_healthy": True,
        "recovered_at": "2026-07-20T12:06:00+00:00",
    }
    assert "does not block a new run" in recovered.summary


def test_operator_resumed_auth_recovery_is_not_treated_as_historical_block():
    run = BullpenAutoLiveRun(
        id="run-auth-operator-resume",
        triggered_by="manual",
        status="running",
        dry_run=False,
        started_at="2026-07-20T12:00:00+00:00",
        summary="Earlier session expired before the explicit retry.",
        audit_metadata={
            "auth_recovery": {
                "historical_error_stale": True,
                "operator_resume_at": "2026-07-20T12:06:00+00:00",
            }
        },
    )

    assert _auth_recovery_operator_resume_active(run) is True


def test_operator_resumed_stage3_intents_own_the_running_lifecycle():
    run = BullpenAutoLiveRun(
        id="run-stage3-operator-resume",
        triggered_by="manual",
        status="running",
        dry_run=False,
        started_at="2026-07-20T12:00:00+00:00",
        summary="Seven durable intents are ready.",
        order_intent_ids=["intent-1", "intent-2"],
        audit_metadata={
            "stage3_recovery": {
                "required": False,
                "resolved_at": "2026-07-20T12:06:00+00:00",
                "resolution": "operator_retry",
            },
            "stage3_resume_action": {
                "action": "Retry failed exits and continue buys",
                "at": "2026-07-20T12:06:00+00:00",
                "same_run": True,
                "llm_analysis_rerun": False,
            },
        },
    )

    assert _stage3_intent_operator_resume_active(run) is True


@pytest.mark.anyio
async def test_active_stage3_intent_resume_skips_stale_parent_task_recovery(monkeypatch):
    settings = BullpenAutoLiveSettings(auto_live_enabled=True, dry_run=False)
    state = BullpenAutoLiveState(
        running=True,
        status="error",
        last_error="Stale parent task verdict",
    )
    resumed_run = BullpenAutoLiveRun(
        id="run-stage3-intent-resume",
        triggered_by="manual",
        status="running",
        dry_run=False,
        started_at="2026-07-20T12:00:00+00:00",
        summary="Stage 3 has 7 durable intents in progress.",
        order_intent_ids=["intent-1"],
        audit_metadata={
            "stage3_recovery": {
                "required": False,
                "resolved_at": "2026-07-20T12:06:00+00:00",
                "resolution": "operator_retry",
            },
            "stage3_resume_action": {
                "same_run": True,
                "llm_analysis_rerun": False,
            },
        },
    )
    running_record = SimpleNamespace(
        started_at=datetime(2026, 7, 20, 12, 0, tzinfo=UTC),
        updated_at=datetime(2026, 7, 20, 12, 6, tzinfo=UTC),
    )

    class _FakeRepo:
        async def get_running_run_record(self, user_id: int):
            assert user_id == 7
            return running_record

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.bot.record_to_run",
        lambda _record: resumed_run,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.bot.reconcile_running_auto_live_run",
        lambda *args, **kwargs: pytest.fail(
            "the stale parent task must not recover an intent-resumed run"
        ),
    )

    active_run, resumed_state = await BullpenAutoLiveBot(
        user_id=7
    )._get_active_run_or_recover(_FakeRepo(), settings, state)  # type: ignore[arg-type]

    assert active_run is resumed_run
    assert resumed_state.last_error is None
    assert resumed_state.last_action == resumed_run.summary


@pytest.mark.anyio
async def test_healthy_active_auth_recovery_removes_running_run_block(monkeypatch):
    settings = BullpenAutoLiveSettings(auto_live_enabled=True, dry_run=True)
    state = BullpenAutoLiveState(running=False, paused=False, status="stopped")
    historical_run = BullpenAutoLiveRun(
        id="run-auth-block",
        triggered_by="manual",
        status="running",
        dry_run=True,
        started_at="2026-07-20T12:00:00+00:00",
        summary="Failed: AUTH_REFRESH_REJECTED_LOGIN_REQUIRED",
    )
    running_record = SimpleNamespace(
        started_at=datetime(2026, 7, 20, 12, 0, tzinfo=UTC),
        updated_at=datetime(2026, 7, 20, 12, 5, tzinfo=UTC),
    )
    saved_runs: list[BullpenAutoLiveRun] = []
    saved_states: list[BullpenAutoLiveState] = []
    revoked_runs: list[str] = []
    replaced_decision_runs: list[str] = []

    class _FakeRepo:
        async def get_running_run_record(self, user_id: int):
            assert user_id == 7
            return running_record

        async def save_run(self, user_id: int, run: BullpenAutoLiveRun) -> None:
            assert user_id == 7
            saved_runs.append(run.model_copy(deep=True))

        async def replace_run_decisions_from_stage3_payload(
            self, user_id: int, run: BullpenAutoLiveRun
        ) -> int:
            assert user_id == 7
            replaced_decision_runs.append(run.id)
            return 0

        async def save_state(self, user_id: int, next_state: BullpenAutoLiveState) -> None:
            assert user_id == 7
            saved_states.append(next_state.model_copy(deep=True))

    class _HealthyBroker:
        async def resolve_latest_active_auth_result(self, *, refresh_if_stale: bool):
            assert refresh_if_stale is True
            return SimpleNamespace(
                healthy=True,
                checked_at="2026-07-20T12:06:00+00:00",
            )

    async def _fake_revoke(run_id: str) -> None:
        revoked_runs.append(run_id)

    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.bot.record_to_run",
        lambda _record: historical_run,
    )
    monkeypatch.setattr(
        "app.domains.polymarket.runtime_broker.get_bullpen_runtime_broker",
        lambda: _HealthyBroker(),
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.bot.revoke_registered_auto_live_run_task",
        _fake_revoke,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.bot.reconcile_running_auto_live_run",
        lambda *args, **kwargs: pytest.fail("stale worker recovery should not run"),
    )

    active_run, recovered_state = await BullpenAutoLiveBot(
        user_id=7
    )._get_active_run_or_recover(_FakeRepo(), settings, state)  # type: ignore[arg-type]

    assert active_run is None
    assert revoked_runs == [historical_run.id]
    assert saved_runs[0].status == "failed"
    assert saved_runs[0].audit_metadata["auth_recovery"]["historical_error_stale"] is True
    assert recovered_state.last_error is None
    assert saved_states[-1].last_run_id == historical_run.id
    assert replaced_decision_runs == []


@pytest.mark.anyio
async def test_run_once_queues_new_run_after_recovering_stale_running_record(monkeypatch):
    settings = BullpenAutoLiveSettings(auto_live_enabled=True, dry_run=True)
    state = BullpenAutoLiveState(running=False, paused=False, status="stopped")
    stale_run = BullpenAutoLiveRun(
        id="stale-run",
        triggered_by="manual",
        status="running",
        dry_run=True,
        started_at="2026-07-05T12:00:00+00:00",
        summary="Stage 3 reviewed row 15 of 15. Latest: Final market",
    )
    recovered_run = stale_run.model_copy(
        update={
            "status": "completed",
            "completed_at": "2026-07-05T12:10:10+00:00",
            "summary": "Auto-Live completed with 15 decisions, 2 planned orders, and 2 submitted orders.",
        }
    )
    running_record = SimpleNamespace(
        started_at=datetime(2026, 7, 5, 12, 0, tzinfo=UTC),
        updated_at=datetime(2026, 7, 5, 12, 20, tzinfo=UTC),
    )

    saved_runs: list[BullpenAutoLiveRun] = []
    saved_states: list[BullpenAutoLiveState] = []
    queued_runs: list[tuple[tuple[int, str], str, str]] = []
    registered_tasks: list[tuple[str, str]] = []

    class _FakeSession:
        def __init__(self) -> None:
            self.added: list[object] = []
            self.committed = False

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        def add(self, record) -> None:
            self.added.append(record)

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
            return running_record

        async def save_run(self, user_id: int, next_run: BullpenAutoLiveRun) -> None:
            assert user_id == 7
            saved_runs.append(next_run.model_copy(deep=True))

        async def replace_run_decisions_from_stage3_payload(
            self,
            user_id: int,
            next_run: BullpenAutoLiveRun,
        ) -> int:
            assert user_id == 7
            assert next_run.id == recovered_run.id
            return 0

        async def save_state(self, user_id: int, next_state: BullpenAutoLiveState) -> None:
            assert user_id == 7
            saved_states.append(next_state.model_copy(deep=True))

    class _FakeExecuteTask:
        @staticmethod
        def apply_async(*, args, task_id: str, queue: str):
            queued_runs.append((args, task_id, queue))
            return SimpleNamespace(id=task_id)

    async def _fake_register_auto_live_run_task(run_id: str, task_id: str) -> None:
        registered_tasks.append((run_id, task_id))

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
        lambda _record: stale_run,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.bot.reconcile_running_auto_live_run",
        lambda run, *, started_at, updated_at: recovered_run,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.bot.register_auto_live_run_task",
        _fake_register_auto_live_run_task,
    )
    monkeypatch.setattr(
        "app.domains.polymarket_auto_live.tasks.execute_polymarket_auto_live_run",
        _FakeExecuteTask(),
    )

    result = await BullpenAutoLiveBot(user_id=7).run_once(
        request=BullpenAutoLiveRunOnceRequest(
            client_run_id="client-run-recovery"
        )
    )

    assert result.status == "running"
    assert result.id == "client-run-recovery"
    assert fake_session.committed is True
    assert result.task_lifecycle is not None
    assert queued_runs == [((7, result.id), result.task_lifecycle.task_id, "auto_live")]
    assert registered_tasks == [(result.id, result.task_lifecycle.task_id)]
    assert saved_runs == [recovered_run]
    assert saved_states[0].last_run_id == recovered_run.id
    assert saved_states[-1].last_run_id == result.id
    assert len(fake_session.added) == 1
    added_record = fake_session.added[0]
    assert added_record.id == result.id
    assert added_record.status == "running"
    assert result.task_lifecycle.state == "QUEUED"
    assert result.task_lifecycle.queue == "auto_live"
