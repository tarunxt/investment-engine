import os
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://test:test@localhost:5432/testdb",
)
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

import pytest

from app.domains.polymarket_auto_live.bot import BullpenAutoLiveBot
from app.domains.polymarket_auto_live.run_recovery import (
    AutoLiveTaskRuntimeSnapshot,
    reconcile_running_auto_live_run,
)
from app.domains.polymarket_auto_live.schemas import (
    BullpenAutoLiveRun,
    BullpenAutoLiveSettings,
    BullpenAutoLiveStageResult,
    BullpenAutoLiveState,
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


def test_reconcile_running_auto_live_run_marks_stalled_worker_failed():
    run = BullpenAutoLiveRun(
        id="run-stalled",
        triggered_by="manual",
        status="running",
        dry_run=False,
        started_at="2026-07-05T12:00:00+00:00",
        summary="Stage 2 started.",
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

    recovered = reconcile_running_auto_live_run(
        run,
        started_at=datetime(2026, 7, 5, 12, 0, tzinfo=UTC),
        updated_at=datetime(2026, 7, 5, 12, 20, tzinfo=UTC),
        now=datetime(2026, 7, 5, 12, 40, tzinfo=UTC),
        task_snapshot=AutoLiveTaskRuntimeSnapshot(
            task_id="celery-task-2",
            state="PENDING",
            inspect_succeeded=True,
        ),
    )

    assert recovered is run
    assert recovered.status == "failed"
    assert recovered.completed_at == "2026-07-05T12:40:00+00:00"
    assert recovered.error_message is not None
    assert "no longer active" in recovered.error_message
    assert recovered.summary.startswith("Auto-Live run failed during Stage 2 · Run LLM:")
    assert recovered.stage_results[-1].outputs["phase_status"] == "failed"


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
    delayed_runs: list[tuple[int, str]] = []
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

        async def save_state(self, user_id: int, next_state: BullpenAutoLiveState) -> None:
            assert user_id == 7
            saved_states.append(next_state.model_copy(deep=True))

    class _FakeExecuteTask:
        @staticmethod
        def delay(user_id: int, run_id: str):
            delayed_runs.append((user_id, run_id))
            return SimpleNamespace(id="celery-task-new")

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

    result = await BullpenAutoLiveBot(user_id=7).run_once()

    assert result.status == "running"
    assert result.id != stale_run.id
    assert fake_session.committed is True
    assert delayed_runs == [(7, result.id)]
    assert registered_tasks == [(result.id, "celery-task-new")]
    assert saved_runs == [recovered_run]
    assert saved_states[0].last_run_id == recovered_run.id
    assert saved_states[-1].last_run_id == result.id
    assert len(fake_session.added) == 1
    added_record = fake_session.added[0]
    assert added_record.id == result.id
    assert added_record.status == "running"
