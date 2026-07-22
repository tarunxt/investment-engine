"""Focused safety regressions for Auto-Live queueing and run ownership.

These tests deliberately use the real routing and lease helpers with small
in-memory fakes.  They prove the safety boundaries without depending on a
locally running broker, Celery worker, or PostgreSQL instance.
"""

from __future__ import annotations

import json
import os
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://test:test@localhost:5432/testdb",
)
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

import app.domains.polymarket_auto_live.bot as bot_module
import app.domains.polymarket_auto_live.run_lifecycle as lifecycle_module
import app.domains.polymarket_auto_live.run_recovery as recovery_module
import app.domains.polymarket_auto_live.tasks as tasks_module
from app.domains.polymarket_auto_live.run_lifecycle import (
    AUTO_LIVE_QUEUE,
    AutoLiveRunExecutionLeaseSnapshot,
    acquire_auto_live_run_execution_lease_sync,
    get_auto_live_run_execution_lease_sync,
    release_auto_live_run_execution_lease_sync,
    renew_auto_live_run_execution_lease_sync,
)
from app.domains.polymarket_auto_live.run_recovery import AutoLiveTaskRuntimeSnapshot
from app.domains.polymarket_auto_live.schemas import (
    BullpenAutoLiveRun,
    BullpenAutoLiveSettings,
    BullpenAutoLiveState,
    BullpenAutoLiveStageResult,
    BullpenAutoLiveTaskLifecycle,
)
from app.infrastructure.messaging.celery_app import celery


class _FakeRedis:
    """Enough Redis behavior to exercise token-fenced planning-run leases."""

    def __init__(self) -> None:
        self._items: dict[str, tuple[str, float | None]] = {}
        self._clock = 0.0

    def advance(self, seconds: float) -> None:
        self._clock += seconds

    def _value(self, key: str) -> str | None:
        value = self._items.get(key)
        if value is None:
            return None
        raw, expires_at = value
        if expires_at is not None and expires_at <= self._clock:
            self._items.pop(key, None)
            return None
        return raw

    def set(
        self,
        key: str,
        value: str,
        *,
        nx: bool = False,
        ex: int | None = None,
    ) -> bool:
        if nx and self._value(key) is not None:
            return False
        self._items[key] = (value, self._clock + ex if ex is not None else None)
        return True

    def get(self, key: str) -> str | None:
        return self._value(key)

    def eval(self, _script: str, _numkeys: int, key: str, *args: object) -> int:
        raw = self._value(key)
        if raw is None:
            return 0
        payload = json.loads(raw)

        # Release only accepts the current owner token.
        if len(args) == 1:
            if payload.get("token") != args[0]:
                return 0
            self._items.pop(key, None)
            return 1

        # Renewal receives token, rebuilt payload, and TTL.
        token, renewed_payload, ttl_seconds = args
        if payload.get("token") != token:
            return 0
        self.set(key, str(renewed_payload), ex=int(ttl_seconds))
        return 1

    def close(self) -> None:
        return None


def _install_fake_redis(monkeypatch: pytest.MonkeyPatch) -> _FakeRedis:
    fake_redis = _FakeRedis()
    monkeypatch.setattr(lifecycle_module, "_redis_client", lambda: fake_redis)
    return fake_redis


def _task_queue(task_name: str) -> str:
    route = celery.conf.task_routes[task_name]
    assert isinstance(route, dict)
    queue = route["queue"]
    assert isinstance(queue, str)
    return queue


def test_four_long_ai_reconciliations_cannot_reserve_the_auto_live_planning_queue():
    """The dedicated planner consumer remains runnable when ai is saturated.

    Four reconciliations model all four historical ``ai`` pool slots being
    blocked in Bullpen runtime calls.  Celery must publish the planning task to
    a different broker queue, which is consumed by the dedicated Auto-Live
    worker rather than that saturated pool.
    """

    reconcile_task = (
        "app.domains.polymarket_auto_live.tasks.reconcile_auto_live_order_intent"
    )
    planning_task = "app.domains.polymarket_auto_live.tasks.execute_polymarket_auto_live_run"

    ai_reservations = [_task_queue(reconcile_task) for _ in range(4)]
    planning_queue = _task_queue(planning_task)
    configured_queues = {queue.name for queue in celery.conf.task_queues}

    assert ai_reservations == ["ai", "ai", "ai", "ai"]
    assert planning_queue == AUTO_LIVE_QUEUE
    assert planning_queue != "ai"
    assert planning_queue in configured_queues

    # Deterministic broker-topology model: a full ai pool cannot consume a
    # message placed in the dedicated queue.  The auto_live worker has its
    # own consumer and therefore has a free planning slot.
    queued_by_broker_queue = {"ai": ["reconcile"] * 4, planning_queue: ["plan"]}
    assert queued_by_broker_queue["ai"] == ["reconcile"] * 4
    assert queued_by_broker_queue[planning_queue] == ["plan"]


def test_all_stage3_order_intent_operations_stay_on_ai_not_the_planning_queue():
    stage3_task_names = (
        "app.domains.polymarket_auto_live.tasks.execute_auto_live_order_intent",
        "app.domains.polymarket_auto_live.tasks.retry_auto_live_order_intent",
        "app.domains.polymarket_auto_live.tasks.reconcile_auto_live_order_intent",
    )

    assert {_task_queue(task_name) for task_name in stage3_task_names} == {"ai"}
    assert _task_queue(
        "app.domains.polymarket_auto_live.tasks.execute_polymarket_auto_live_run"
    ) == AUTO_LIVE_QUEUE


def test_worker_lost_redelivery_gets_one_new_run_lease_and_old_owner_is_fenced(
    monkeypatch: pytest.MonkeyPatch,
):
    """SIGTERM/WorkerLost recovery never gives two workers the run lease."""

    fake_redis = _install_fake_redis(monkeypatch)
    original = acquire_auto_live_run_execution_lease_sync(
        "run-worker-lost",
        task_id="celery-redelivery-id",
        ttl_seconds=5,
    )
    assert original is not None

    # A concurrent duplicate (including a same-id late delivery) is fenced
    # while the original healthy worker still owns the run.
    assert (
        acquire_auto_live_run_execution_lease_sync(
            "run-worker-lost",
            task_id="celery-redelivery-id",
            ttl_seconds=5,
        )
        is None
    )

    # Simulate systemd SIGTERM followed by WorkerLostError: no final release
    # or heartbeat occurs.  The late-ack redelivery may safely take ownership
    # only after lease expiry, retaining its Celery task id.
    fake_redis.advance(6)
    redelivered = acquire_auto_live_run_execution_lease_sync(
        "run-worker-lost",
        task_id="celery-redelivery-id",
        ttl_seconds=5,
    )
    assert redelivered is not None
    assert redelivered.token != original.token
    assert redelivered.task_id == original.task_id

    # A process that wakes up after its lease expired cannot extend or release
    # the redelivery's ownership.  Only the redelivery can continue Stage 1/2.
    assert renew_auto_live_run_execution_lease_sync(original) is False
    assert release_auto_live_run_execution_lease_sync(original) is False
    snapshot = get_auto_live_run_execution_lease_sync("run-worker-lost")
    assert snapshot is not None
    assert snapshot.task_id == "celery-redelivery-id"
    assert release_auto_live_run_execution_lease_sync(redelivered) is True


def test_redelivery_executes_stages_once_and_same_id_duplicate_exits_while_owned(
    monkeypatch: pytest.MonkeyPatch,
):
    """The replacement executes once; a concurrent same-id copy is a no-op."""

    execution_calls: list[tuple[object, ...]] = []
    retry_calls: list[dict[str, object]] = []
    released_tokens: list[str] = []
    advisory_releases: list[str] = []
    leases = [
        lifecycle_module.AutoLiveRunExecutionLease(
            run_id="run-duplicate",
            task_id="celery-same-id",
            token="redelivery-token",
            acquired_at="2026-07-21T16:45:00+00:00",
            expires_at="2026-07-21T16:47:00+00:00",
            ttl_seconds=120,
        ),
        None,
    ]

    class _FakeTask:
        request = SimpleNamespace(id="celery-same-id", hostname="auto-live-worker@test")

        def retry(self, **kwargs: object):
            retry_calls.append(dict(kwargs))
            raise AssertionError("a healthy lease owner must not create retry backlog")

    class _FakeSession:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def commit(self) -> None:
            return None

    class _FakeHeartbeat:
        def __init__(self, **_kwargs: object) -> None:
            self.lease_lost = False

        def start(self) -> None:
            return None

        def stop(self) -> None:
            return None

    class _FakeAdvisoryLock:
        def is_healthy(self) -> bool:
            return True

        def release(self) -> None:
            advisory_releases.append("released")

    monkeypatch.setattr(
        tasks_module,
        "acquire_auto_live_run_execution_lease_sync",
        lambda _run_id, *, task_id: leases.pop(0),
    )
    monkeypatch.setattr(
        tasks_module,
        "get_auto_live_run_execution_lease_sync",
        lambda _run_id: AutoLiveRunExecutionLeaseSnapshot(
            run_id="run-duplicate",
            task_id="celery-same-id",
            acquired_at="2026-07-21T16:43:25+00:00",
            last_renewed_at="2026-07-21T16:44:00+00:00",
            expires_at="2026-07-21T16:45:00+00:00",
            ttl_seconds=120,
        ),
    )
    monkeypatch.setattr(
        tasks_module,
        "acquire_auto_live_run_execution_advisory_lock_sync",
        lambda _run_id: _FakeAdvisoryLock(),
    )
    monkeypatch.setattr(tasks_module, "SyncSessionLocal", _FakeSession)
    monkeypatch.setattr(
        tasks_module,
        "mark_auto_live_run_task_started_sync",
        lambda *_args, **_kwargs: SimpleNamespace(status="running"),
    )
    monkeypatch.setattr(tasks_module, "AutoLiveRunHeartbeat", _FakeHeartbeat)
    monkeypatch.setattr(
        tasks_module,
        "release_auto_live_run_execution_lease_sync",
        lambda lease: released_tokens.append(lease.token) or True,
    )
    monkeypatch.setattr(
        tasks_module,
        "_execute_polymarket_auto_live_run_with_lease",
        lambda *args, **kwargs: execution_calls.append(args),
    )

    # The first call models a post-WorkerLost redelivery which acquired the
    # expired lease. The second is a concurrent late delivery with the same
    # Celery id while that replacement owns it.
    tasks_module.execute_polymarket_auto_live_run.run.__func__(  # type: ignore[attr-defined]
        _FakeTask(),
        7,
        "run-duplicate",
    )
    tasks_module.execute_polymarket_auto_live_run.run.__func__(  # type: ignore[attr-defined]
        _FakeTask(),
        7,
        "run-duplicate",
    )

    assert len(execution_calls) == 1
    assert execution_calls[0][1:3] == (7, "run-duplicate")
    assert released_tokens == ["redelivery-token"]
    assert advisory_releases == ["released"]
    assert retry_calls == []


def test_broker_redelivery_waits_for_unexpired_lost_worker_lease(
    monkeypatch: pytest.MonkeyPatch,
):
    """A late-ack delivery is retained until it can safely own the run."""

    class _RetrySignal(Exception):
        pass

    retries: list[dict[str, object]] = []

    class _RedeliveredTask:
        request = SimpleNamespace(
            id="celery-worker-lost-id",
            hostname="auto-live-worker@test",
            delivery_info={"redelivered": True},
        )

        def retry(self, **kwargs: object):
            retries.append(dict(kwargs))
            raise _RetrySignal()

    monkeypatch.setattr(
        tasks_module,
        "acquire_auto_live_run_execution_lease_sync",
        lambda _run_id, *, task_id: None,
    )
    monkeypatch.setattr(
        tasks_module,
        "get_auto_live_run_execution_lease_sync",
        lambda _run_id: AutoLiveRunExecutionLeaseSnapshot(
            run_id="run-worker-lost-delivery",
            task_id="celery-worker-lost-id",
            acquired_at="2026-07-21T16:43:25+00:00",
            last_renewed_at="2026-07-21T16:44:00+00:00",
            expires_at="2026-07-21T16:46:00+00:00",
            ttl_seconds=120,
        ),
    )
    monkeypatch.setattr(
        tasks_module,
        "_mark_auto_live_task_lifecycle_best_effort",
        lambda **_kwargs: None,
    )

    with pytest.raises(_RetrySignal):
        tasks_module.execute_polymarket_auto_live_run.run.__func__(  # type: ignore[attr-defined]
            _RedeliveredTask(),
            7,
            "run-worker-lost-delivery",
        )

    assert retries == [
        {
            "args": (7, "run-worker-lost-delivery"),
            "countdown": lifecycle_module.AUTO_LIVE_RUN_REDELIVERY_RETRY_SECONDS,
            "kwargs": {"lease_observed_at": "2026-07-21T16:44:00+00:00"},
        }
    ]


def test_old_terminal_result_cannot_terminalize_new_queued_lifecycle():
    """A terminal result for an old delivery is not evidence against a new one."""

    run = BullpenAutoLiveRun(
        id="run-new-delivery",
        triggered_by="scheduler",
        status="running",
        dry_run=False,
        started_at="2026-07-21T16:43:25+00:00",
        summary="Stage 1 is queued for the dedicated Auto-Live worker.",
        task_lifecycle=BullpenAutoLiveTaskLifecycle(
            state="QUEUED",
            task_id="celery-new-delivery",
            queue=AUTO_LIVE_QUEUE,
            enqueued_at="2026-07-21T16:43:25+00:00",
        ),
    )

    recovered = recovery_module.reconcile_running_auto_live_run(
        run,
        started_at=datetime(2026, 7, 21, 16, 43, 25, tzinfo=UTC),
        updated_at=datetime(2026, 7, 21, 16, 43, 25, tzinfo=UTC),
        now=datetime(2026, 7, 21, 17, 20, tzinfo=UTC),
        task_snapshot=AutoLiveTaskRuntimeSnapshot(
            task_id="celery-old-delivery",
            state="FAILURE",
            inspect_succeeded=True,
            inspect_complete=True,
        ),
    )

    assert recovered is None
    assert run.status == "running"
    assert run.task_lifecycle is not None
    assert run.task_lifecycle.task_id == "celery-new-delivery"


def test_matching_terminal_celery_failure_beats_a_stale_queued_label():
    """A real terminal result is stronger evidence than receipt bookkeeping."""

    run = BullpenAutoLiveRun(
        id="run-terminal-current-delivery",
        triggered_by="scheduler",
        status="running",
        dry_run=False,
        started_at="2026-07-21T16:43:25+00:00",
        summary="Stage 1 is queued for the dedicated Auto-Live worker.",
        task_lifecycle=BullpenAutoLiveTaskLifecycle(
            state="QUEUED",
            task_id="celery-terminal-delivery",
            queue=AUTO_LIVE_QUEUE,
            enqueued_at="2026-07-21T16:43:25+00:00",
        ),
    )

    recovered = recovery_module.reconcile_running_auto_live_run(
        run,
        started_at=datetime(2026, 7, 21, 16, 43, 25, tzinfo=UTC),
        updated_at=datetime(2026, 7, 21, 16, 43, 25, tzinfo=UTC),
        now=datetime(2026, 7, 21, 17, 20, tzinfo=UTC),
        task_snapshot=AutoLiveTaskRuntimeSnapshot(
            task_id="celery-terminal-delivery",
            state="FAILURE",
            result_error="worker initialization failed",
            inspect_succeeded=True,
            inspect_complete=True,
        ),
    )

    assert recovered is run
    assert recovered.status == "failed"
    assert recovered.task_lifecycle is not None
    assert recovered.task_lifecycle.state == "FAILURE"
    assert "ended with failure" in (recovered.error_message or "")


def test_late_database_heartbeat_cannot_reopen_terminal_task_lifecycle():
    """Stopping the split heartbeat threads cannot regress SUCCESS to STARTED."""

    terminal = BullpenAutoLiveTaskLifecycle(
        state="SUCCESS",
        task_id="celery-terminal-heartbeat",
        queue=AUTO_LIVE_QUEUE,
        worker_started_at="2026-07-21T16:43:25+00:00",
        last_heartbeat_at="2026-07-21T16:50:00+00:00",
    )

    updated = lifecycle_module._update_lifecycle(
        terminal,
        state="STARTED",
        task_id="celery-terminal-heartbeat",
        queue=AUTO_LIVE_QUEUE,
        heartbeat_at="2026-07-21T16:51:00+00:00",
    )

    assert updated.state == "SUCCESS"
    assert updated.last_heartbeat_at == "2026-07-21T16:50:00+00:00"


def test_stale_progress_payload_cannot_replace_a_newer_redelivery_lifecycle():
    """A pre-redelivery worker must not overwrite the current task ID."""

    newer_delivery = {
        "state": "STARTED",
        "task_id": "celery-new-delivery",
        "redelivery_count": 1,
        "last_heartbeat_at": "2026-07-21T16:50:00+00:00",
    }
    stale_progress = {
        "state": "STARTED",
        "task_id": "celery-old-delivery",
        "redelivery_count": 0,
        "last_heartbeat_at": "2026-07-21T16:43:25+00:00",
    }

    merged = lifecycle_module.merge_task_lifecycle_payload(
        newer_delivery,
        stale_progress,
    )

    assert merged == newer_delivery


def test_explicit_new_redelivery_lifecycle_can_replace_the_old_delivery():
    """The fenced lifecycle transition increments delivery generation."""

    old_delivery = {
        "state": "STARTED",
        "task_id": "celery-old-delivery",
        "redelivery_count": 0,
    }
    new_delivery = {
        "state": "STARTED",
        "task_id": "celery-new-delivery",
        "redelivery_count": 1,
    }

    merged = lifecycle_module.merge_task_lifecycle_payload(
        old_delivery,
        new_delivery,
    )

    assert merged == new_delivery


def test_changed_task_id_counts_one_redelivery_even_when_broker_marks_it_redelivered():
    """A new delivery generation is observable without double-counting it."""

    updated = lifecycle_module._update_lifecycle(
        BullpenAutoLiveTaskLifecycle(
            state="STARTED",
            task_id="celery-old-delivery",
            queue=AUTO_LIVE_QUEUE,
            redelivery_count=2,
        ),
        state="STARTED",
        task_id="celery-new-delivery",
        queue=AUTO_LIVE_QUEUE,
        increment_redelivery=True,
    )

    assert updated.task_id == "celery-new-delivery"
    assert updated.redelivery_count == 3


def test_fence_loss_before_final_handoff_commit_cannot_strand_confirming_run(
    monkeypatch: pytest.MonkeyPatch,
):
    """The durable Stage 3 handoff rolls back as one transaction.

    A planner can lose its PostgreSQL fence after Stage 1/2 completed but
    before it commits.  The next redelivery must see the original ``running``
    record, rather than a committed ``confirming`` run with no durable intents
    for periodic dispatch to recover.
    """

    class _RetryRequested(Exception):
        pass

    initial_run = BullpenAutoLiveRun(
        id="run-atomic-handoff",
        triggered_by="manual",
        status="running",
        dry_run=False,
        started_at="2026-07-21T16:43:25+00:00",
        summary="Stage 1 is running.",
    )
    completed_run = initial_run.model_copy(
        update={
            "status": "confirming",
            "summary": "Stage 3 durable handoff is ready.",
            "live_execution_requested": True,
            "stage_results": [
                BullpenAutoLiveStageResult(
                    stage_number=3,
                    stage_name="Stage 3 · Exit and Invest",
                    status="warning",
                    reason="Durable intents are ready.",
                    started_at="2026-07-21T16:44:00+00:00",
                    completed_at="2026-07-21T16:45:00+00:00",
                    outputs={"workflow_stage_key": "invest"},
                )
            ],
        }
    )
    final_state = BullpenAutoLiveState(last_run_id=initial_run.id)

    class _TransactionalSession:
        def __init__(self) -> None:
            self.events: list[str] = []
            self.pending_run_status: str | None = None
            self.pending_intent_ids: list[str] = []
            self.persisted_run_status = initial_run.status
            self.persisted_intent_ids: list[str] = []

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def flush(self) -> None:
            self.events.append("flush")

        def commit(self) -> None:
            self.events.append("commit")
            if self.pending_run_status is not None:
                self.persisted_run_status = self.pending_run_status
            self.persisted_intent_ids.extend(self.pending_intent_ids)
            self.pending_run_status = None
            self.pending_intent_ids.clear()

        def rollback(self) -> None:
            self.events.append("rollback")
            self.pending_run_status = None
            self.pending_intent_ids.clear()

    session = _TransactionalSession()

    class _Repo:
        def __init__(self, supplied_session) -> None:
            assert supplied_session is session

        def get_run(self, run_id: str):
            assert run_id == initial_run.id
            return initial_run

        def list_open_position_records(self, _user_id: int):
            return []

        def list_decisions(self, _user_id: int):
            return []

        def save_run(self, _user_id: int, run: BullpenAutoLiveRun) -> None:
            session.events.append("save-run")
            session.pending_run_status = run.status

        def replace_run_decisions(self, _user_id: int, _run_id: str, _decisions) -> None:
            session.events.append("save-decisions")

        def replace_positions(self, _user_id: int, _positions) -> None:
            session.events.append("save-positions")

        def save_state(self, _user_id: int, _state) -> None:
            session.events.append("save-state")

    class _Engine:
        def execute(self, **_kwargs):
            return SimpleNamespace(
                run=completed_run,
                decisions=[],
                state=final_state,
                positions=[],
            )

    class _Task:
        request = SimpleNamespace(retries=0, hostname="auto-live-worker@test")

        def retry(self, **_kwargs):
            raise _RetryRequested()

    # The first three checks fence workflow work/final persistence, the
    # fourth permits intent creation, and the final check refuses its commit.
    fence_results = iter((True, True, True, True, True, False))
    queued_runs: list[str] = []

    monkeypatch.setattr(tasks_module, "SyncSessionLocal", lambda: session)
    monkeypatch.setattr(tasks_module, "SyncPolymarketAutoLiveRepository", _Repo)
    monkeypatch.setattr(tasks_module, "register_auto_live_run_task_sync", lambda *_args: None)
    monkeypatch.setattr(tasks_module, "_synchronize_state", lambda *_args: (object(), final_state))
    monkeypatch.setattr(tasks_module, "BullpenAutoLiveEngine", _Engine)
    monkeypatch.setattr(tasks_module, "run_with_bullpen_runtime_cleanup", lambda value: value)
    monkeypatch.setattr(tasks_module, "auto_live_execution_v2_enabled", lambda: True)
    monkeypatch.setattr(tasks_module, "_run_was_cancelled_by_user", lambda *_args, **_kwargs: False)
    monkeypatch.setattr(
        tasks_module,
        "materialize_run_audit_snapshot_sync",
        lambda *_args, **_kwargs: session.events.append("materialize-audit"),
    )
    monkeypatch.setattr(
        tasks_module,
        "create_or_refresh_run_order_intents_sync",
        lambda *_args, **_kwargs: (
            session.events.append("create-intents"),
            session.pending_intent_ids.append("intent-atomic-handoff"),
            [
                SimpleNamespace(
                    id="intent-atomic-handoff",
                    action="buy",
                    execution_metadata_json={},
                )
            ],
        )[2],
    )
    monkeypatch.setattr(
        tasks_module,
        "sync_run_and_decisions_from_intents_sync",
        lambda *_args, **_kwargs: SimpleNamespace(
            id=initial_run.id,
            status="confirming",
            summary="Waiting for durable intent confirmation.",
            completed_at=None,
        ),
    )
    monkeypatch.setattr(
        tasks_module,
        "_queue_due_order_intents_for_run_sync",
        lambda run_id: queued_runs.append(run_id) or 0,
    )
    monkeypatch.setattr(
        tasks_module,
        "sync_auto_live_position_snapshots_sync",
        lambda **_kwargs: None,
    )
    monkeypatch.setattr(
        tasks_module,
        "_mark_auto_live_task_lifecycle_best_effort",
        lambda **_kwargs: None,
    )
    monkeypatch.setattr(
        tasks_module,
        "_run_execution_fence_is_owned",
        lambda _advisory_lock: next(fence_results),
    )

    with pytest.raises(_RetryRequested):
        tasks_module._execute_polymarket_auto_live_run_with_lease(
            _Task(),
            7,
            initial_run.id,
            task_id="celery-atomic-handoff",
            heartbeat=SimpleNamespace(),
            advisory_lock=SimpleNamespace(),
        )

    # The initial audit commit is unrelated to the final planner transaction.
    # No second commit means the run stayed runnable and no intent handoff was
    # half-persisted when ownership was lost.
    assert session.events.count("commit") == 1
    assert session.events[-1] == "rollback"
    assert session.persisted_run_status == "running"
    assert session.persisted_intent_ids == []
    assert queued_runs == []


def test_live_execution_lease_prevents_worker_lost_verdict_when_db_heartbeat_is_stale(
    monkeypatch: pytest.MonkeyPatch,
):
    """A Redis-owned live execution lease is stronger evidence than inspect miss."""

    run = BullpenAutoLiveRun(
        id="run-redis-heartbeat",
        triggered_by="manual",
        status="running",
        dry_run=False,
        started_at="2026-07-21T16:00:00+00:00",
        summary="Stage 2 is running.",
        task_lifecycle=BullpenAutoLiveTaskLifecycle(
            state="STARTED",
            task_id="celery-running",
            queue=AUTO_LIVE_QUEUE,
            worker_started_at="2026-07-21T16:00:00+00:00",
            last_heartbeat_at="2026-07-21T16:00:00+00:00",
        ),
    )
    monkeypatch.setattr(
        recovery_module,
        "auto_live_run_execution_lease_is_live_sync",
        lambda run_id: run_id == run.id,
    )

    recovered = recovery_module.reconcile_running_auto_live_run(
        run,
        started_at=datetime(2026, 7, 21, 16, 0, tzinfo=UTC),
        updated_at=datetime(2026, 7, 21, 16, 0, tzinfo=UTC),
        now=datetime(2026, 7, 21, 16, 25, tzinfo=UTC),
        task_snapshot=AutoLiveTaskRuntimeSnapshot(
            task_id="celery-running",
            state="PENDING",
            inspect_succeeded=True,
            inspect_complete=True,
        ),
    )

    assert recovered is None
    assert run.status == "running"


def test_live_advisory_fence_prevents_worker_lost_when_redis_lease_was_evicted(
    monkeypatch: pytest.MonkeyPatch,
):
    """A PostgreSQL planner fence is liveness evidence after Redis eviction."""

    run = BullpenAutoLiveRun(
        id="run-advisory-heartbeat",
        triggered_by="manual",
        status="running",
        dry_run=False,
        started_at="2026-07-21T16:00:00+00:00",
        summary="Stage 2 is running.",
        task_lifecycle=BullpenAutoLiveTaskLifecycle(
            state="STARTED",
            task_id="celery-advisory-running",
            queue=AUTO_LIVE_QUEUE,
            worker_started_at="2026-07-21T16:00:00+00:00",
            last_heartbeat_at="2026-07-21T16:00:00+00:00",
        ),
    )
    monkeypatch.setattr(
        recovery_module,
        "auto_live_run_execution_lease_is_live_sync",
        lambda _run_id: False,
    )
    monkeypatch.setattr(
        recovery_module,
        "auto_live_run_execution_advisory_lock_is_live_sync",
        lambda run_id: run_id == run.id,
    )

    recovered = recovery_module.reconcile_running_auto_live_run(
        run,
        started_at=datetime(2026, 7, 21, 16, 0, tzinfo=UTC),
        updated_at=datetime(2026, 7, 21, 16, 0, tzinfo=UTC),
        now=datetime(2026, 7, 21, 16, 25, tzinfo=UTC),
        task_snapshot=AutoLiveTaskRuntimeSnapshot(
            task_id="celery-advisory-running",
            state="PENDING",
            inspect_succeeded=True,
            inspect_complete=True,
        ),
    )

    assert recovered is None
    assert run.status == "running"


class _FakeAsyncSession:
    def __init__(self) -> None:
        self.commits = 0

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def commit(self) -> None:
        self.commits += 1


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("lifecycle", "snapshot"),
    [
        (
            BullpenAutoLiveTaskLifecycle(
                state="QUEUED",
                task_id="celery-queued-poll",
                queue=AUTO_LIVE_QUEUE,
                enqueued_at="2026-07-21T16:43:25+00:00",
            ),
            AutoLiveTaskRuntimeSnapshot(
                task_id="celery-queued-poll",
                state="PENDING",
                inspect_succeeded=True,
                inspect_complete=True,
            ),
        ),
        (
            BullpenAutoLiveTaskLifecycle(
                state="STARTED",
                task_id="celery-running-poll",
                queue=AUTO_LIVE_QUEUE,
                worker_started_at="2026-07-21T16:43:25+00:00",
                last_heartbeat_at="2026-07-21T17:05:00+00:00",
            ),
            AutoLiveTaskRuntimeSnapshot(
                task_id="celery-running-poll",
                state="PENDING",
                inspect_succeeded=True,
                inspect_complete=False,
            ),
        ),
    ],
    ids=["queued", "running-heartbeat"],
)
async def test_state_and_summary_polls_do_not_terminalize_healthy_active_run(
    monkeypatch: pytest.MonkeyPatch,
    lifecycle: BullpenAutoLiveTaskLifecycle,
    snapshot: AutoLiveTaskRuntimeSnapshot,
):
    """HTTP polling is observational for a healthy queued or running task."""

    run = BullpenAutoLiveRun(
        id=f"run-poll-{lifecycle.state.lower()}",
        triggered_by="scheduler",
        status="running",
        dry_run=True,
        started_at="2026-07-21T16:43:25+00:00",
        summary="Stage 1 is waiting for the Auto-Live worker.",
        task_lifecycle=lifecycle,
    )
    settings = BullpenAutoLiveSettings(auto_live_enabled=False)
    state = BullpenAutoLiveState(status="stopped", mode="dry-run")
    record = SimpleNamespace(
        started_at=datetime(2026, 7, 21, 16, 43, 25, tzinfo=UTC),
        updated_at=datetime(2026, 7, 21, 16, 43, 25, tzinfo=UTC),
    )
    fake_session = _FakeAsyncSession()
    saved_runs: list[BullpenAutoLiveRun] = []

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
            return record

        async def save_run(self, user_id: int, candidate: BullpenAutoLiveRun) -> None:
            assert user_id == 7
            saved_runs.append(candidate.model_copy(deep=True))

        async def save_state(self, user_id: int, next_state: BullpenAutoLiveState) -> None:
            assert user_id == 7
            assert next_state.last_error is None

        async def list_runs(self, user_id: int, *, limit: int | None = None):
            assert user_id == 7
            assert limit == 10
            return [run]

        async def list_decisions(self, user_id: int, *, limit: int | None = None):
            assert user_id == 7
            assert limit == 25
            return []

        async def count_decisions_by_run(self, run_ids):
            pytest.fail(f"healthy active run must not be treated as terminal: {run_ids}")

    def _safe_reconcile(
        candidate: BullpenAutoLiveRun,
        *,
        started_at: datetime,
        updated_at: datetime,
    ) -> BullpenAutoLiveRun | None:
        return recovery_module.reconcile_running_auto_live_run(
            candidate,
            started_at=started_at,
            updated_at=updated_at,
            now=datetime(2026, 7, 21, 17, 6, tzinfo=UTC),
            task_snapshot=snapshot,
        )

    monkeypatch.setattr(bot_module, "AsyncSessionLocal", lambda: fake_session)
    monkeypatch.setattr(bot_module, "AsyncPolymarketAutoLiveRepository", _FakeRepo)
    monkeypatch.setattr(bot_module, "record_to_run", lambda _record: run)
    monkeypatch.setattr(bot_module, "reconcile_running_auto_live_run", _safe_reconcile)

    bot = bot_module.BullpenAutoLiveBot(user_id=7)
    observed_state = await bot.get_state()
    summary = await bot.get_summary()

    assert observed_state.last_error is None
    assert summary.latest_run is run
    assert run.status == "running"
    assert saved_runs == []
    assert fake_session.commits >= 3
