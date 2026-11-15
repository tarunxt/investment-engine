from __future__ import annotations

import json
from types import SimpleNamespace

import app.domains.polymarket_auto_live.order_intent_lease as lease_module
import app.domains.polymarket_auto_live.tasks as tasks
from app.domains.polymarket_auto_live.order_intent_lease import (
    acquire_order_intent_operation_lease_sync,
    get_order_intent_operation_lease_sync,
    release_order_intent_operation_lease_sync,
    start_order_intent_operation_lease_sync,
)


class _FakeRedis:
    """Small Redis subset that exercises the Lua ownership transitions."""

    def __init__(self) -> None:
        self._items: dict[str, tuple[str, float | None]] = {}
        self._clock = 0.0

    def advance(self, seconds: float) -> None:
        self._clock += seconds

    def _value(self, key: str) -> str | None:
        entry = self._items.get(key)
        if entry is None:
            return None
        value, expires_at = entry
        if expires_at is not None and expires_at <= self._clock:
            self._items.pop(key, None)
            return None
        return value

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

    def eval(self, script: str, _numkeys: int, key: str, *args: object) -> int:
        raw = self._value(key)
        if raw is None:
            return 0
        payload = json.loads(raw)

        if "lease['state'] ~= 'QUEUED'" in script:
            dispatch_token, task_id, runtime_token, started_at, expires_at, ttl = args
            if (
                payload.get("state") != "QUEUED"
                or payload.get("dispatch_token") != dispatch_token
                or payload.get("task_id") != task_id
            ):
                return 0
            payload.update(
                {
                    "state": "STARTED",
                    "token": runtime_token,
                    "worker_started_at": started_at,
                    "last_heartbeat_at": started_at,
                    "expires_at": expires_at,
                }
            )
            self.set(key, json.dumps(payload), ex=int(ttl))
            return 1

        if "lease['state'] ~= 'STARTED'" in script:
            token, heartbeat_at, expires_at, ttl = args
            if payload.get("state") != "STARTED" or payload.get("token") != token:
                return 0
            payload.update(
                {
                    "last_heartbeat_at": heartbeat_at,
                    "expires_at": expires_at,
                }
            )
            self.set(key, json.dumps(payload), ex=int(ttl))
            return 1

        # The release script only carries the owner token.
        (token,) = args
        if payload.get("token") != token:
            return 0
        self._items.pop(key, None)
        return 1

    def close(self) -> None:
        return None


class _NoopSession:
    def __enter__(self) -> _NoopSession:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def commit(self) -> None:
        return None


def _install_fake_redis(monkeypatch) -> _FakeRedis:
    fake_redis = _FakeRedis()
    monkeypatch.setattr(lease_module, "_redis_client", lambda: fake_redis)
    return fake_redis


def test_operation_lease_keeps_queued_task_deduplicated_and_records_lifecycle(monkeypatch):
    _install_fake_redis(monkeypatch)

    first = acquire_order_intent_operation_lease_sync(
        intent_id="intent-1",
        task_id="task-1",
        operation="reconcile",
        source="periodic-pending-reconciliation",
        ttl_seconds=60,
    )
    second = acquire_order_intent_operation_lease_sync(
        intent_id="intent-1",
        task_id="task-2",
        operation="reconcile",
        source="operator-run-reconciliation",
        ttl_seconds=60,
    )

    assert first is not None
    assert second is None
    queued = get_order_intent_operation_lease_sync("intent-1")
    assert queued is not None
    assert queued["task_id"] == "task-1"
    assert queued["state"] == "QUEUED"
    assert queued["acquired_at"]
    assert queued["expires_at"]

    started = start_order_intent_operation_lease_sync(
        intent_id="intent-1",
        task_id="task-1",
        dispatch_token=first.dispatch_token,
        operation="reconcile",
        source="periodic-pending-reconciliation",
        ttl_seconds=60,
    )
    duplicate_delivery = start_order_intent_operation_lease_sync(
        intent_id="intent-1",
        task_id="task-1",
        dispatch_token=first.dispatch_token,
        operation="reconcile",
        source="periodic-pending-reconciliation",
        ttl_seconds=60,
    )

    assert started is not None
    assert duplicate_delivery is None
    active = get_order_intent_operation_lease_sync("intent-1")
    assert active is not None
    assert active["state"] == "STARTED"
    assert active["worker_started_at"]
    assert active["last_heartbeat_at"]


def test_expired_worker_lease_can_be_recovered_but_old_worker_cannot_release_new_owner(monkeypatch):
    fake_redis = _install_fake_redis(monkeypatch)
    queued = acquire_order_intent_operation_lease_sync(
        intent_id="intent-2",
        task_id="task-lost",
        operation="reconcile",
        source="periodic-pending-reconciliation",
        ttl_seconds=5,
    )
    assert queued is not None
    old_worker = start_order_intent_operation_lease_sync(
        intent_id="intent-2",
        task_id="task-lost",
        dispatch_token=queued.dispatch_token,
        operation="reconcile",
        source="periodic-pending-reconciliation",
        ttl_seconds=5,
    )
    assert old_worker is not None

    # Simulate SIGTERM/WorkerLostError: the process cannot release or renew.
    fake_redis.advance(6)
    replacement = acquire_order_intent_operation_lease_sync(
        intent_id="intent-2",
        task_id="task-redelivered",
        operation="reconcile",
        source="redelivery",
        ttl_seconds=5,
    )
    assert replacement is not None
    new_worker = start_order_intent_operation_lease_sync(
        intent_id="intent-2",
        task_id="task-redelivered",
        dispatch_token=replacement.dispatch_token,
        operation="reconcile",
        source="redelivery",
        ttl_seconds=5,
    )
    assert new_worker is not None

    assert release_order_intent_operation_lease_sync(old_worker) is False
    assert get_order_intent_operation_lease_sync("intent-2") is not None
    assert release_order_intent_operation_lease_sync(new_worker) is True


def test_duplicate_scheduler_requests_publish_only_one_reconciliation_task(monkeypatch):
    _install_fake_redis(monkeypatch)
    queued_tasks: list[tuple[tuple[object, ...], dict[str, object]]] = []
    monkeypatch.setattr(tasks, "SyncSessionLocal", _NoopSession)
    monkeypatch.setattr(tasks, "annotate_intent_dispatch_sync", lambda *_args, **_kwargs: None)

    def publish(*args: object, **kwargs: object):
        queued_tasks.append((args, kwargs))
        return SimpleNamespace(id=kwargs["task_id"])

    monkeypatch.setattr(tasks.reconcile_auto_live_order_intent, "apply_async", publish)

    assert tasks._enqueue_reconcile_order_intent(
        "intent-3", source="periodic-pending-reconciliation"
    )
    assert not tasks._enqueue_reconcile_order_intent(
        "intent-3", source="operator-run-reconciliation"
    )
    assert len(queued_tasks) == 1
    assert queued_tasks[0][0] == ()
    assert queued_tasks[0][1]["args"][0] == "intent-3"


def test_unattempted_ready_intent_is_safely_redispatched_after_worker_restart(monkeypatch):
    """A stranded queued delivery has not entered SUBMITTING or touched Bullpen."""

    fake_redis = _install_fake_redis(monkeypatch)
    queued_tasks: list[tuple[tuple[object, ...], dict[str, object]]] = []
    monkeypatch.setattr(tasks, "SyncSessionLocal", _NoopSession)
    monkeypatch.setattr(tasks, "annotate_intent_dispatch_sync", lambda *_args, **_kwargs: None)

    def publish(*args: object, **kwargs: object):
        queued_tasks.append((args, kwargs))
        return SimpleNamespace(id=kwargs["task_id"])

    # This models an intent still READY with attempt_count=0: the original
    # worker never consumed the message, so no task began remote submission.
    stranded_delivery = acquire_order_intent_operation_lease_sync(
        intent_id="intent-ready-attempt-zero",
        task_id="stranded-worker-task",
        operation="execute",
        source="initial-stage3-dispatch",
        ttl_seconds=5,
    )
    assert stranded_delivery is not None

    # After the worker restart and lease expiry, canonical dispatch can issue
    # one fresh execute delivery. A still-live fresh lease fences duplicates.
    fake_redis.advance(6)
    monkeypatch.setattr(tasks.execute_auto_live_order_intent, "apply_async", publish)

    assert tasks._enqueue_execute_order_intents(
        ["intent-ready-attempt-zero"], source="worker-restart-recovery"
    ) == 1
    assert len(queued_tasks) == 1
    assert queued_tasks[0][1]["queue"] == "ai"
    assert queued_tasks[0][1]["args"][0] == "intent-ready-attempt-zero"

    fresh_delivery = tasks._begin_order_intent_operation(
        SimpleNamespace(request=SimpleNamespace(id=queued_tasks[0][1]["task_id"])),
        intent_id="intent-ready-attempt-zero",
        operation="execute",
        lease_token=queued_tasks[0][1]["args"][1],
        source="execute-auto-live-order-intent",
    )
    assert fresh_delivery is not None
    assert not tasks._enqueue_execute_order_intents(
        ["intent-ready-attempt-zero"], source="duplicate-restart-dispatch"
    )
    assert len(queued_tasks) == 1
    assert release_order_intent_operation_lease_sync(fresh_delivery)


def test_periodic_execution_and_reconciliation_scanners_have_disjoint_status_sets(monkeypatch):
    """Beat may run both tasks in one minute without overlapping one intent."""

    monkeypatch.setattr(tasks, "SyncSessionLocal", _NoopSession)
    monkeypatch.setattr(tasks, "watchdog_requeue_stale_order_intents_sync", lambda *_args, **_kwargs: [])
    scanned_statuses: list[tuple[str, ...]] = []
    execution_requests: list[tuple[list[str], str]] = []
    reconciliation_requests: list[tuple[str, str]] = []

    def list_due(_session, *, statuses, **_kwargs):
        scanned_statuses.append(tuple(statuses))
        return ["intent-executable"] if "READY" in statuses else ["intent-reconcilable"]

    monkeypatch.setattr(tasks, "list_due_order_intent_ids_sync", list_due)
    monkeypatch.setattr(
        tasks,
        "_enqueue_execute_order_intents",
        lambda ids, *, source: execution_requests.append((list(ids), source)),
    )
    monkeypatch.setattr(
        tasks,
        "_enqueue_reconcile_order_intent",
        lambda intent_id, *, source: reconciliation_requests.append((intent_id, source)),
    )

    tasks.dispatch_due_auto_live_order_intents.run(limit=10)
    tasks.reconcile_all_pending_auto_live_orders.run(limit=10)

    assert execution_requests == [(["intent-executable"], "periodic-execution-dispatch")]
    assert reconciliation_requests == [
        ("intent-reconcilable", "periodic-pending-reconciliation")
    ]
    assert set(scanned_statuses[0]).isdisjoint(set(scanned_statuses[1]))
    assert "WAITING_FOR_EXIT" not in scanned_statuses[0]


def test_immediate_run_dispatch_is_run_scoped_and_reports_actual_publish_count(
    monkeypatch,
):
    class _SessionContext:
        def __enter__(self):
            return object()

        def __exit__(self, *_args):
            return False

    due_requests: list[dict[str, object]] = []
    enqueue_requests: list[tuple[list[str], str]] = []

    monkeypatch.setattr(tasks, "SyncSessionLocal", _SessionContext)

    def list_due(_session, **kwargs):
        due_requests.append(kwargs)
        return ["intent-current-run-1", "intent-current-run-2"]

    monkeypatch.setattr(tasks, "list_due_order_intent_ids_sync", list_due)
    monkeypatch.setattr(
        tasks,
        "_enqueue_execute_order_intents",
        lambda ids, *, source: (
            enqueue_requests.append((list(ids), source)),
            1,
        )[1],
    )

    queued = tasks._queue_due_order_intents_for_run_sync("run-current", limit=10)

    assert queued == 1
    assert due_requests[0]["run_id"] == "run-current"
    assert due_requests[0]["limit"] == 10
    assert "WAITING_FOR_EXIT" not in due_requests[0]["statuses"]
    assert enqueue_requests == [
        (
            ["intent-current-run-1", "intent-current-run-2"],
            "immediate-run-execution",
        )
    ]


def test_worker_entry_lease_serializes_reconciliation_with_submission(monkeypatch):
    _install_fake_redis(monkeypatch)
    execution_task = SimpleNamespace(request=SimpleNamespace(id="execute-task"))
    reconciliation_task = SimpleNamespace(request=SimpleNamespace(id="reconcile-task"))

    execution_lease = tasks._begin_order_intent_operation(
        execution_task,
        intent_id="intent-4",
        operation="execute",
        lease_token=None,
        source="test-execution",
    )
    reconciliation_lease = tasks._begin_order_intent_operation(
        reconciliation_task,
        intent_id="intent-4",
        operation="reconcile",
        lease_token=None,
        source="test-reconciliation",
    )

    assert execution_lease is not None
    assert reconciliation_lease is None
    assert release_order_intent_operation_lease_sync(execution_lease)


def test_stale_fenced_broker_delivery_cannot_reacquire_after_newer_reconciliation(
    monkeypatch,
):
    """An old message must not replay work after its original lease expired."""

    fake_redis = _install_fake_redis(monkeypatch)
    old_dispatch = acquire_order_intent_operation_lease_sync(
        intent_id="intent-stale-delivery",
        task_id="old-task",
        operation="reconcile",
        source="periodic-pending-reconciliation",
        ttl_seconds=5,
    )
    assert old_dispatch is not None

    # The original queued reservation dies before it gets a pool slot.  A
    # later canonical scanner handles the same durable intent with a fresh,
    # distinct dispatch token and completes it.
    fake_redis.advance(6)
    fresh_dispatch = acquire_order_intent_operation_lease_sync(
        intent_id="intent-stale-delivery",
        task_id="fresh-task",
        operation="reconcile",
        source="periodic-pending-reconciliation",
        ttl_seconds=5,
    )
    assert fresh_dispatch is not None
    fresh_worker = start_order_intent_operation_lease_sync(
        intent_id="intent-stale-delivery",
        task_id="fresh-task",
        dispatch_token=fresh_dispatch.dispatch_token,
        operation="reconcile",
        source="periodic-pending-reconciliation",
        ttl_seconds=5,
    )
    assert fresh_worker is not None
    assert release_order_intent_operation_lease_sync(fresh_worker)

    stale_task = SimpleNamespace(request=SimpleNamespace(id="old-task"))
    assert (
        tasks._begin_order_intent_operation(
            stale_task,
            intent_id="intent-stale-delivery",
            operation="reconcile",
            lease_token=old_dispatch.dispatch_token,
            source="reconcile-auto-live-order-intent",
        )
        is None
    )
