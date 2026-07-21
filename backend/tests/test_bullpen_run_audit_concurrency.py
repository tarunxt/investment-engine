from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from threading import Barrier, Lock
import time
from types import SimpleNamespace

from sqlalchemy.dialects import postgresql

from app.domains.bullpen_run_audit import service
from app.domains.bullpen_run_audit.constants import BULLPEN_RUN_AUDIT_SCHEMA_VERSION
from app.domains.bullpen_run_audit.repository import BullpenRunAuditRepository
from app.domains.bullpen_run_audit import tasks as audit_tasks


class _ScalarResult:
    def scalar_one_or_none(self):
        return None


class _CapturingSession:
    def __init__(self) -> None:
        self.statement = None

    def execute(self, statement):
        self.statement = statement
        return _ScalarResult()


def test_run_parent_lock_compiles_to_postgresql_for_update():
    """The parent run is lockable even before a snapshot exists."""

    session = _CapturingSession()
    repository = BullpenRunAuditRepository(session)  # type: ignore[arg-type]

    assert repository.lock_run_record_for_audit_materialization(
        user_id=7,
        run_id="run-lock",
    ) is None

    assert session.statement is not None
    compiled = str(session.statement.compile(dialect=postgresql.dialect()))
    assert "FOR UPDATE" in compiled
    assert "polymarket_auto_live_runs" in compiled


class _ClearQuery:
    def __init__(self, events: list[str]) -> None:
        self._events = events

    def filter(self, *_args):
        return self

    def delete(self, **_kwargs) -> None:
        self._events.append("delete")


class _ClearSession:
    def __init__(self) -> None:
        self.events: list[str] = []

    def query(self, _model):
        return _ClearQuery(self.events)

    def flush(self) -> None:
        self.events.append("flush")


def test_force_rebuild_flushes_child_deletes_before_reinsertion():
    session = _ClearSession()
    repository = BullpenRunAuditRepository(session)  # type: ignore[arg-type]

    repository.clear_current_snapshot_children(snapshot_id=133)

    assert session.events == ["delete", "delete", "delete", "delete", "flush"]


class _BlobSession:
    def __init__(self) -> None:
        self.statement = None
        self.record = SimpleNamespace(id="blob-id")

    def get(self, _model, _key):
        # First lookup misses; the lookup after the upsert returns the row
        # selected from the content-addressed blob table.
        if self.statement is None:
            return None
        return self.record

    def get_bind(self):
        return SimpleNamespace(dialect=postgresql.dialect())

    def execute(self, statement):
        self.statement = statement

    def flush(self) -> None:
        return None


def test_content_addressed_blob_insert_is_postgresql_upsert():
    session = _BlobSession()
    repository = BullpenRunAuditRepository(session)  # type: ignore[arg-type]

    assert repository.create_blob(payload={"same": "payload"}, content_type="application/json")
    assert session.statement is not None
    compiled = str(session.statement.compile(dialect=postgresql.dialect()))
    assert "ON CONFLICT" in compiled
    assert "DO NOTHING" in compiled


class _ConcurrentMaterializationState:
    def __init__(self) -> None:
        self.run_lock = Lock()
        self.state_lock = Lock()
        self.events: set[str] = set()
        self.active_rebuilds = 0
        self.max_active_rebuilds = 0
        self.lock_calls = 0
        self.snapshot = SimpleNamespace(
            id=133,
            snapshot_schema_version=BULLPEN_RUN_AUDIT_SCHEMA_VERSION,
            source_run_updated_at=None,
        )
        now = datetime.now(UTC)
        self.run_record = SimpleNamespace(
            id="run-concurrent",
            user_id=7,
            started_at=now,
            completed_at=None,
            updated_at=now,
        )


class _ConcurrentSession:
    def __init__(self, state: _ConcurrentMaterializationState) -> None:
        self.state = state
        self.owns_run_lock = False

    def add(self, record) -> None:
        event_key = getattr(record, "event_key", None)
        if event_key is None:
            return
        with self.state.state_lock:
            # This is the production unique-key contract represented by the
            # event table's (snapshot_id, event_key) unique index.
            assert event_key not in self.state.events
            self.state.events.add(event_key)
            self.state.active_rebuilds -= 1

    def flush(self) -> None:
        return None

    def commit(self) -> None:
        if self.owns_run_lock:
            self.owns_run_lock = False
            self.state.run_lock.release()

    def rollback(self) -> None:
        self.commit()


class _ConcurrentRepository:
    def __init__(self, session: _ConcurrentSession) -> None:
        self.session = session
        self.state = session.state

    def lock_run_record_for_audit_materialization(self, **_kwargs):
        self.state.run_lock.acquire()
        self.session.owns_run_lock = True
        with self.state.state_lock:
            self.state.lock_calls += 1
        return self.state.run_record

    def get_current_snapshot(self, **_kwargs):
        return self.state.snapshot

    def get_run_decision_records(self, **_kwargs):
        return []

    def clear_current_snapshot_children(self, _snapshot_id: int) -> None:
        with self.state.state_lock:
            self.state.events.clear()
            self.state.active_rebuilds += 1
            self.state.max_active_rebuilds = max(
                self.state.max_active_rebuilds,
                self.state.active_rebuilds,
            )
        # Give the second request a chance to contend for the parent lock.  If
        # the lock disappeared, both threads would enter this rebuild region
        # and the duplicate deterministic event assertion above would fail.
        time.sleep(0.03)

    def create_blob(self, **_kwargs):
        return SimpleNamespace(id="canonical-bundle")

    def latest_feedback_for_snapshot_any(self, **_kwargs):
        return None

    def list_manual_checks(self, **_kwargs):
        return []


class _FakeRun:
    status = "running"
    triggered_by = "manual"
    dry_run = True
    live_execution_requested = False
    live_execution_attempted = False
    started_at = "2026-07-21T16:43:25+00:00"
    completed_at = None
    execution_version = None
    stage_results: list[object] = []

    def model_dump(self, **_kwargs):
        return {
            "id": "run-concurrent",
            "status": self.status,
            "triggered_by": self.triggered_by,
            "dry_run": self.dry_run,
            "started_at": self.started_at,
            "completed_at": self.completed_at,
            "summary": "test",
            "audit_metadata": {},
            "stage_results": [],
        }


def _minimal_bundle() -> dict[str, object]:
    return {
        "metadata": {},
        "overview": {
            "missing_fields": [],
            "code_provenance": {},
            "stage_statuses": {},
            "diagnostics": {},
        },
        "stage_2": {
            "llm_runtime": {},
            "llm_invocations": [],
            "qualified_candidate_market_ids": [],
        },
        "stage_3": {"decision_rows": [], "decisions": []},
        "raw": {},
    }


def test_concurrent_force_materializations_serialize_and_keep_one_run_started_event(
    monkeypatch,
):
    """Two force rebuilds cannot interleave clear + deterministic event insert."""

    state = _ConcurrentMaterializationState()
    monkeypatch.setattr(
        service,
        "BullpenRunAuditRepository",
        lambda session: _ConcurrentRepository(session),
    )
    monkeypatch.setattr(service, "record_to_run", lambda _record: _FakeRun())
    monkeypatch.setattr(
        service,
        "summarize_run_orders_sync",
        lambda *_args, **_kwargs: SimpleNamespace(
            model_dump=lambda **_dump_kwargs: {"orders": [], "order_funnel": {}}
        ),
    )
    monkeypatch.setattr(service, "_build_bundle", lambda **_kwargs: _minimal_bundle())
    monkeypatch.setattr(service, "_snapshot_completeness", lambda _bundle: (100.0, []))
    monkeypatch.setattr(service, "_serialize_stage_records", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(
        service,
        "_serialize_event_records",
        lambda *_args, **_kwargs: [SimpleNamespace(event_key="run-started")],
    )
    monkeypatch.setattr(service, "_build_formula_records", lambda **_kwargs: [])
    monkeypatch.setattr(
        service,
        "_event_record_to_summary",
        lambda record: {"event_key": record.event_key},
    )
    monkeypatch.setattr(service, "build_deterministic_findings", lambda _bundle: [])
    monkeypatch.setattr(service, "_ensure_default_manual_checks", lambda *_args, **_kwargs: None)

    start = Barrier(2)

    def materialize_once() -> None:
        start.wait(timeout=2)
        session = _ConcurrentSession(state)
        try:
            service.materialize_run_audit_snapshot_sync(
                session,  # type: ignore[arg-type]
                user_id=7,
                run_id="run-concurrent",
                force=True,
            )
            session.commit()
        finally:
            session.rollback()

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(materialize_once) for _ in range(2)]
        for future in futures:
            future.result(timeout=5)

    assert state.lock_calls == 2
    assert state.max_active_rebuilds == 1
    assert state.events == {"run-started"}


class _FakeRedis:
    def __init__(self) -> None:
        self.values: dict[str, str] = {}
        self.closed = 0
        self.eval_calls: list[tuple[str, tuple[object, ...]]] = []

    def get(self, key: str) -> str | None:
        return self.values.get(key)

    def set(self, key: str, value: str, *, nx: bool = False, ex: int | None = None):
        del ex
        if nx and key in self.values:
            return False
        self.values[key] = value
        return True

    def eval(self, script: str, _keys: int, key: str, *args: object) -> int:
        self.eval_calls.append((key, args))
        if "expire" in script:
            token, _ttl_seconds = args
            return int(self.values.get(key) == token)
        (token,) = args
        if self.values.get(key) != token:
            return 0
        del self.values[key]
        return 1

    def close(self) -> None:
        self.closed += 1


class _RefreshSession:
    def __init__(self, commits: list[str]) -> None:
        self.commits = commits

    def __enter__(self):
        return self

    def __exit__(self, *_args) -> None:
        return None

    def commit(self) -> None:
        self.commits.append("commit")


def test_repeated_audit_refresh_requests_coalesce_to_one_task_and_rebuild(monkeypatch):
    redis_client = _FakeRedis()
    queued: list[dict[str, object]] = []
    materializations: list[dict[str, object]] = []
    commits: list[str] = []

    monkeypatch.setattr(
        audit_tasks,
        "_audit_refresh_redis_client",
        lambda: redis_client,
    )
    monkeypatch.setattr(
        audit_tasks.refresh_bullpen_run_audit_snapshot,
        "apply_async",
        lambda **kwargs: queued.append(kwargs),
    )
    monkeypatch.setattr(
        audit_tasks,
        "SyncSessionLocal",
        lambda: _RefreshSession(commits),
    )
    monkeypatch.setattr(
        audit_tasks,
        "materialize_run_audit_snapshot_sync",
        lambda _session, **kwargs: materializations.append(kwargs),
    )

    assert audit_tasks.request_bullpen_run_audit_refresh_sync(
        user_id=7,
        run_id="run-refresh",
    )
    assert not audit_tasks.request_bullpen_run_audit_refresh_sync(
        user_id=7,
        run_id="run-refresh",
    )
    assert len(queued) == 1

    task_kwargs = queued[0]["kwargs"]
    assert audit_tasks.refresh_bullpen_run_audit_snapshot.run(**task_kwargs) == "materialized"
    # A redelivered task carrying the first marker token is superseded after
    # the owner cleans up; it cannot trigger a second force rebuild.
    assert audit_tasks.refresh_bullpen_run_audit_snapshot.run(**task_kwargs) == "superseded"

    assert materializations == [
        {
            "user_id": 7,
            "run_id": "run-refresh",
            "force": True,
            "freeze": None,
        }
    ]
    assert commits == ["commit"]


def test_audit_refresh_heartbeat_renews_pending_and_run_lease_tokens():
    """A slow force rebuild cannot outlive its initial coalescing lease."""

    redis_client = _FakeRedis()
    token = "refresh-owner"
    pending_key = audit_tasks._audit_refresh_key("pending", "run-slow-refresh")
    lease_key = audit_tasks._audit_refresh_key("lease", "run-slow-refresh")
    redis_client.values[pending_key] = token
    redis_client.values[lease_key] = token

    class _OneRenewalThenStop:
        def __init__(self) -> None:
            self.calls = 0

        def wait(self, _interval: float) -> bool:
            self.calls += 1
            return self.calls > 1

        def set(self) -> None:
            return None

    heartbeat = audit_tasks._AuditRefreshLeaseHeartbeat(
        redis_client=redis_client,
        pending_key=pending_key,
        lease_key=lease_key,
        token=token,
        lease_ttl_seconds=300,
        pending_ttl_seconds=365,
    )
    heartbeat._stop_event = _OneRenewalThenStop()  # type: ignore[assignment]
    heartbeat._run()

    assert not heartbeat.ownership_lost
    assert redis_client.values[pending_key] == token
    assert redis_client.values[lease_key] == token
    assert [key for key, _args in redis_client.eval_calls] == [lease_key, pending_key]
