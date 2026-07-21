"""Regression coverage for PostgreSQL fencing beyond Redis Auto-Live leases."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

import app.domains.polymarket_auto_live.advisory_lock as advisory_lock_module
import app.domains.polymarket_auto_live.tasks as tasks_module


class _FakeResult:
    def __init__(self, value: bool) -> None:
        self._value = value

    def scalar(self) -> bool:
        return self._value


class _FakePostgresConnection:
    def __init__(self, engine: _FakePostgresEngine) -> None:
        self._engine = engine
        self.closed = False
        self.invalidated = False
        self.execution_options_calls: list[dict[str, object]] = []

    def execution_options(self, **kwargs: object) -> _FakePostgresConnection:
        self.execution_options_calls.append(kwargs)
        return self

    def execute(
        self,
        statement,  # noqa: ANN001
        parameters: dict[str, object] | None = None,
    ):
        sql = str(statement)
        if sql.strip() == "SELECT 1":
            self._engine.statements.append((sql, 0))
            return _FakeResult(True)
        assert parameters is not None
        key = int(parameters["lock_key"])
        self._engine.statements.append((sql, key))
        if "pg_try_advisory_lock" in sql:
            if key in self._engine.held:
                return _FakeResult(False)
            self._engine.held.add(key)
            return _FakeResult(True)
        if "pg_advisory_unlock" in sql:
            if self._engine.fail_unlock:
                raise RuntimeError("simulated unlock response loss")
            self._engine.held.discard(key)
            return _FakeResult(True)
        raise AssertionError(f"Unexpected advisory-lock SQL: {sql}")

    def close(self) -> None:
        self.closed = True

    def invalidate(self) -> None:
        self.invalidated = True


class _FakePostgresEngine:
    dialect = SimpleNamespace(name="postgresql")

    def __init__(self) -> None:
        self.held: set[int] = set()
        self.connections: list[_FakePostgresConnection] = []
        self.statements: list[tuple[str, int]] = []
        self.fail_unlock = False

    def connect(self) -> _FakePostgresConnection:
        connection = _FakePostgresConnection(self)
        self.connections.append(connection)
        return connection


def test_postgresql_order_intent_lock_serializes_after_redis_eviction(
    monkeypatch: pytest.MonkeyPatch,
):
    """A second worker cannot enter Stage 3 while first holds PostgreSQL lock."""

    engine = _FakePostgresEngine()
    monkeypatch.setattr(advisory_lock_module, "sync_engine", engine)

    first = advisory_lock_module.acquire_order_intent_operation_advisory_lock_sync(
        "intent-redis-evicted"
    )
    duplicate = advisory_lock_module.acquire_order_intent_operation_advisory_lock_sync(
        "intent-redis-evicted"
    )

    assert first is not None
    assert duplicate is None
    assert first.is_healthy()
    assert engine.connections[0].execution_options_calls == [
        {"isolation_level": "AUTOCOMMIT"}
    ]

    first.release()
    replacement = advisory_lock_module.acquire_order_intent_operation_advisory_lock_sync(
        "intent-redis-evicted"
    )
    assert replacement is not None
    replacement.release()

    assert not engine.held
    assert all(connection.closed for connection in engine.connections)
    assert sum("pg_try_advisory_lock" in sql for sql, _key in engine.statements) == 3
    assert sum("pg_advisory_unlock" in sql for sql, _key in engine.statements) == 2


def test_run_lock_liveness_probe_does_not_take_or_leak_the_planner_fence(
    monkeypatch: pytest.MonkeyPatch,
):
    engine = _FakePostgresEngine()
    monkeypatch.setattr(advisory_lock_module, "sync_engine", engine)

    owner = advisory_lock_module.acquire_auto_live_run_execution_advisory_lock_sync(
        "run-liveness-probe"
    )
    assert owner is not None
    assert (
        advisory_lock_module.auto_live_run_execution_advisory_lock_is_live_sync(
            "run-liveness-probe"
        )
        is True
    )

    owner.release()
    assert (
        advisory_lock_module.auto_live_run_execution_advisory_lock_is_live_sync(
            "run-liveness-probe"
        )
        is False
    )
    assert not engine.held


def test_unlock_response_failure_invalidates_the_dedicated_postgresql_session(
    monkeypatch: pytest.MonkeyPatch,
):
    engine = _FakePostgresEngine()
    engine.fail_unlock = True
    monkeypatch.setattr(advisory_lock_module, "sync_engine", engine)

    lock = advisory_lock_module.acquire_order_intent_operation_advisory_lock_sync(
        "intent-unlock-response-loss"
    )
    assert lock is not None
    lock.release()

    assert engine.connections[0].invalidated
    assert engine.connections[0].closed


def test_non_postgresql_test_fallback_has_matching_nonblocking_semantics(
    monkeypatch: pytest.MonkeyPatch,
):
    """SQLite-focused tests retain deterministic lock contention behavior."""

    monkeypatch.setattr(
        advisory_lock_module,
        "sync_engine",
        SimpleNamespace(dialect=SimpleNamespace(name="sqlite")),
    )

    first = advisory_lock_module.acquire_auto_live_run_execution_advisory_lock_sync(
        "run-unit-test-fallback"
    )
    duplicate = advisory_lock_module.acquire_auto_live_run_execution_advisory_lock_sync(
        "run-unit-test-fallback"
    )
    different_scope = advisory_lock_module.acquire_order_intent_operation_advisory_lock_sync(
        "run-unit-test-fallback"
    )

    assert first is not None
    assert duplicate is None
    assert different_scope is not None
    first.release()
    different_scope.release()

    replacement = advisory_lock_module.acquire_auto_live_run_execution_advisory_lock_sync(
        "run-unit-test-fallback"
    )
    assert replacement is not None
    replacement.release()


def test_stage3_duplicate_exits_before_remote_reconciliation_when_pg_lock_is_held(
    monkeypatch: pytest.MonkeyPatch,
):
    """Redis re-acquisition cannot make a duplicate reconcile remote-call."""

    class _Heartbeat:
        ownership_lost = False

        def __init__(self, _lease: object) -> None:
            pass

        def start(self) -> None:
            return None

        def stop(self) -> None:
            return None

        def ensure_ownership(self) -> bool:
            return True

    remote_calls: list[str] = []
    released: list[object] = []
    fake_lease = SimpleNamespace(intent_id="intent-db-fenced")

    # This models a fresh Redis lease after an eviction while another worker
    # still owns the database-backed operation fence.
    monkeypatch.setattr(
        tasks_module,
        "_begin_order_intent_operation",
        lambda *_args, **_kwargs: fake_lease,
    )
    monkeypatch.setattr(tasks_module, "OrderIntentOperationLeaseHeartbeat", _Heartbeat)
    monkeypatch.setattr(
        tasks_module,
        "acquire_order_intent_operation_advisory_lock_sync",
        lambda _intent_id: None,
    )
    monkeypatch.setattr(
        tasks_module,
        "reconcile_order_intent_sync",
        lambda intent_id: remote_calls.append(intent_id) or "CONFIRMING",
    )
    monkeypatch.setattr(
        tasks_module,
        "_finish_order_intent_operation",
        lambda lease: released.append(lease),
    )

    task = SimpleNamespace(
        request=SimpleNamespace(id="duplicate-reconcile", hostname="worker@test")
    )
    tasks_module.reconcile_auto_live_order_intent.run.__func__(  # type: ignore[attr-defined]
        task,
        "intent-db-fenced",
    )

    assert remote_calls == []
    assert released == [fake_lease]


def test_planner_duplicate_exits_before_stage_execution_when_pg_lock_is_held(
    monkeypatch: pytest.MonkeyPatch,
):
    """A Redis-evicted planning task cannot split-brain Stage 1/2 execution."""

    fake_run_lease = SimpleNamespace(token="redis-token")
    released: list[object] = []
    planner_calls: list[object] = []

    monkeypatch.setattr(
        tasks_module,
        "acquire_auto_live_run_execution_lease_sync",
        lambda _run_id, *, task_id: fake_run_lease,
    )
    monkeypatch.setattr(
        tasks_module,
        "acquire_auto_live_run_execution_advisory_lock_sync",
        lambda _run_id: None,
    )
    monkeypatch.setattr(
        tasks_module,
        "release_auto_live_run_execution_lease_sync",
        lambda lease: released.append(lease) or True,
    )
    monkeypatch.setattr(
        tasks_module,
        "_execute_polymarket_auto_live_run_with_lease",
        lambda *args, **kwargs: planner_calls.append((args, kwargs)),
    )

    task = SimpleNamespace(
        request=SimpleNamespace(id="duplicate-planner", hostname="auto-live@test")
    )
    tasks_module.execute_polymarket_auto_live_run.run.__func__(  # type: ignore[attr-defined]
        task,
        9,
        "run-db-fenced",
    )

    assert planner_calls == []
    assert released == [fake_run_lease]
