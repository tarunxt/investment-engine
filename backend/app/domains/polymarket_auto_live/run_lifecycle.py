"""Durable execution-lifecycle and lease helpers for Auto-Live planning runs.

The Celery broker can report a task as received/reserved long before a pool
process starts it.  The run record therefore owns the user-visible lifecycle,
while Redis owns a short, renewable execution lease that prevents duplicate or
redelivered tasks from executing the same Stage 1/2/3 planning workflow.

The lease is deliberately separate from Stage 3 order-intent leases: it only
serializes the planning task for a *run*.  Durable order intents and their
idempotency keys remain the authority for order submission safety.
"""

from __future__ import annotations

import json
import os
import threading
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal
from uuid import uuid4

import redis as sync_redis
from sqlalchemy import select
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from app.core.logging import get_logger
from app.core.config import settings
from app.domains.polymarket_auto_live.models import PolymarketAutoLiveRunRecord
from app.domains.polymarket_auto_live.repository import (
    apply_run_to_record,
    record_to_run,
)
from app.domains.polymarket_auto_live.schemas import (
    AUTO_LIVE_TASK_LIFECYCLE_DETAILS,
    AutoLiveTaskLifecycleState,
    BullpenAutoLiveRun,
    BullpenAutoLiveTaskLifecycle,
)
from app.infrastructure.database.sync_session import SyncSessionLocal

logger = get_logger("app.domains.polymarket_auto_live.run_lifecycle")

# This is used by both the Celery route and the dedicated worker launcher.
# Normalizing it in one module means an intentional non-default production
# queue cannot strand planning messages on a hard-coded routing key.
AUTO_LIVE_QUEUE = os.getenv("CELERY_AUTO_LIVE_WORKER_QUEUE", "auto_live").strip() or "auto_live"
AUTO_LIVE_FALLBACK_QUEUE = (
    os.getenv("CELERY_AUTO_LIVE_FALLBACK_QUEUE", "ai").strip() or "ai"
)


def _positive_int_env(name: str, default: int, *, minimum: int = 1) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return max(minimum, int(raw.strip()))
    except (TypeError, ValueError):
        logger.warning("Ignoring invalid %s=%r; using %s", name, raw, default)
        return default


# The lease is intentionally much shorter than the worker-loss grace.  A
# killed process loses its lease promptly, while the periodic heartbeat keeps a
# healthy long-running planning task owned throughout Stage 1/2 execution.
AUTO_LIVE_RUN_EXECUTION_LEASE_TTL_SECONDS = _positive_int_env(
    "AUTO_LIVE_RUN_EXECUTION_LEASE_TTL_SECONDS", 120
)


def _safe_heartbeat_interval_seconds(*, requested: int, lease_ttl: int) -> int:
    """Keep a healthy worker well inside its renewable-lease deadline.

    A configuration typo such as a 120-second heartbeat on a 120-second
    lease must not create a silent split-brain window.  Use at most a third
    of the lease TTL, leaving room for a transient Redis or database delay.
    """

    maximum = max(1, int(lease_ttl) // 3)
    if requested > maximum:
        logger.warning(
            "AUTO_LIVE_RUN_HEARTBEAT_INTERVAL_SECONDS=%s exceeds the safe "
            "maximum for a %s-second execution lease; using %s seconds.",
            requested,
            lease_ttl,
            maximum,
        )
    return min(maximum, max(1, int(requested)))


AUTO_LIVE_RUN_HEARTBEAT_INTERVAL_SECONDS = _safe_heartbeat_interval_seconds(
    requested=_positive_int_env("AUTO_LIVE_RUN_HEARTBEAT_INTERVAL_SECONDS", 20),
    lease_ttl=AUTO_LIVE_RUN_EXECUTION_LEASE_TTL_SECONDS,
)
AUTO_LIVE_RUN_WORKER_LOSS_GRACE_SECONDS = _positive_int_env(
    "AUTO_LIVE_RUN_WORKER_LOSS_GRACE_SECONDS", 300
)
AUTO_LIVE_RUN_STARTUP_RECOVERY_GRACE_SECONDS = _positive_int_env(
    "AUTO_LIVE_RUN_STARTUP_RECOVERY_GRACE_SECONDS", 300
)
AUTO_LIVE_RUN_REDELIVERY_RETRY_SECONDS = _positive_int_env(
    "AUTO_LIVE_RUN_REDELIVERY_RETRY_SECONDS", 15
)
AUTO_LIVE_PRIMARY_HANDOFF_TIMEOUT_SECONDS = _positive_int_env(
    "AUTO_LIVE_PRIMARY_HANDOFF_TIMEOUT_SECONDS", 30
)
AUTO_LIVE_FALLBACK_HANDOFF_TIMEOUT_SECONDS = _positive_int_env(
    "AUTO_LIVE_FALLBACK_HANDOFF_TIMEOUT_SECONDS", 180
)

_RELEASE_SCRIPT = (
    "local current = redis.call('get', KEYS[1]); "
    "if not current then return 0 end; "
    "local decoded = cjson.decode(current); "
    "if decoded['token'] ~= ARGV[1] then return 0 end; "
    "return redis.call('del', KEYS[1])"
)
_RENEW_SCRIPT = (
    "local current = redis.call('get', KEYS[1]); "
    "if not current then return 0 end; "
    "local decoded = cjson.decode(current); "
    "if decoded['token'] ~= ARGV[1] then return 0 end; "
    "redis.call('set', KEYS[1], ARGV[2], 'EX', ARGV[3]); "
    "return 1"
)


class AutoLiveRunLeaseUnavailable(RuntimeError):
    """Redis could not safely establish the planning-run execution lease."""


@dataclass(frozen=True)
class AutoLiveRunExecutionLease:
    run_id: str
    task_id: str
    token: str
    acquired_at: str
    expires_at: str
    ttl_seconds: int


@dataclass(frozen=True)
class AutoLiveRunExecutionLeaseSnapshot:
    run_id: str
    task_id: str | None
    acquired_at: str | None
    last_renewed_at: str | None
    expires_at: str | None
    ttl_seconds: int | None


def _utc_now() -> datetime:
    return datetime.now(UTC)


def utc_now_iso() -> str:
    return _utc_now().isoformat()


def _execution_lease_key(run_id: str) -> str:
    return f"celery:auto-live-run-execution-lease:{run_id}"


def auto_live_run_execution_lease_key(run_id: str) -> str:
    """Public key helper for operator diagnostics and focused tests."""

    return _execution_lease_key(run_id)


def _redis_client() -> sync_redis.Redis:
    return sync_redis.from_url(settings.redis_url, decode_responses=True)


def _lease_payload(
    *,
    task_id: str,
    token: str,
    acquired_at: str,
    renewed_at: str,
    ttl_seconds: int,
) -> str:
    expires_at = datetime.fromisoformat(renewed_at)  # normalized local value
    expires_at = expires_at.timestamp() + ttl_seconds
    return json.dumps(
        {
            "task_id": task_id,
            "token": token,
            "acquired_at": acquired_at,
            "last_renewed_at": renewed_at,
            "expires_at": datetime.fromtimestamp(expires_at, tz=UTC).isoformat(),
            "ttl_seconds": ttl_seconds,
        },
        separators=(",", ":"),
        sort_keys=True,
    )


def acquire_auto_live_run_execution_lease_sync(
    run_id: str,
    *,
    task_id: str,
    ttl_seconds: int = AUTO_LIVE_RUN_EXECUTION_LEASE_TTL_SECONDS,
) -> AutoLiveRunExecutionLease | None:
    """Atomically acquire the only planning-worker lease for ``run_id``.

    ``None`` means another task currently owns a healthy lease.  Redis errors
    are raised so callers fail/retry rather than executing a live workflow
    without duplicate protection.
    """

    now = utc_now_iso()
    token = str(uuid4())
    ttl = max(1, int(ttl_seconds))
    value = _lease_payload(
        task_id=task_id,
        token=token,
        acquired_at=now,
        renewed_at=now,
        ttl_seconds=ttl,
    )
    client: sync_redis.Redis | None = None
    try:
        client = _redis_client()
        acquired = client.set(_execution_lease_key(run_id), value, nx=True, ex=ttl)
        if not acquired:
            return None
        payload = json.loads(value)
        return AutoLiveRunExecutionLease(
            run_id=run_id,
            task_id=task_id,
            token=token,
            acquired_at=now,
            expires_at=str(payload["expires_at"]),
            ttl_seconds=ttl,
        )
    except Exception as exc:  # pragma: no cover - exact Redis failures vary
        raise AutoLiveRunLeaseUnavailable(
            f"Could not acquire Auto-Live execution lease for run {run_id}."
        ) from exc
    finally:
        if client is not None:
            client.close()


def get_auto_live_run_execution_lease_sync(
    run_id: str,
) -> AutoLiveRunExecutionLeaseSnapshot | None:
    """Return lease metadata without exposing its ownership token."""

    client: sync_redis.Redis | None = None
    try:
        client = _redis_client()
        raw = client.get(_execution_lease_key(run_id))
        if not isinstance(raw, str) or not raw.strip():
            return None
        payload = json.loads(raw)
        if not isinstance(payload, dict):
            return None
        ttl_raw = payload.get("ttl_seconds")
        ttl = int(ttl_raw) if isinstance(ttl_raw, (int, float, str)) else None
        return AutoLiveRunExecutionLeaseSnapshot(
            run_id=run_id,
            task_id=(str(payload.get("task_id")) if payload.get("task_id") else None),
            acquired_at=(
                str(payload.get("acquired_at")) if payload.get("acquired_at") else None
            ),
            last_renewed_at=(
                str(payload.get("last_renewed_at"))
                if payload.get("last_renewed_at")
                else None
            ),
            expires_at=(str(payload.get("expires_at")) if payload.get("expires_at") else None),
            ttl_seconds=ttl,
        )
    except Exception:
        logger.warning(
            "Could not read Auto-Live execution lease for run %s.", run_id, exc_info=True
        )
        return None
    finally:
        if client is not None:
            client.close()


def auto_live_run_execution_lease_is_live_sync(run_id: str) -> bool | None:
    """Return whether Redis still has a valid execution owner for ``run_id``.

    ``None`` deliberately means the Redis read itself was unavailable.  Stale
    recovery treats that as unknown rather than using an infrastructure outage
    as proof that a Stage 1/2 worker died.  A lease owned by any task is
    concrete redelivery/worker liveness evidence for the run.
    """

    client: sync_redis.Redis | None = None
    try:
        client = _redis_client()
        raw = client.get(_execution_lease_key(run_id))
        if not isinstance(raw, str) or not raw.strip():
            return False
        payload = json.loads(raw)
        if not isinstance(payload, dict):
            return None
        return True if (payload.get("task_id") and payload.get("token")) else None
    except Exception:
        logger.warning(
            "Could not read Auto-Live execution lease liveness for run %s.",
            run_id,
            exc_info=True,
        )
        return None
    finally:
        if client is not None:
            client.close()


def renew_auto_live_run_execution_lease_sync(
    lease: AutoLiveRunExecutionLease,
) -> bool:
    """Renew only when this task still owns the lease token."""

    now = utc_now_iso()
    value = _lease_payload(
        task_id=lease.task_id,
        token=lease.token,
        acquired_at=lease.acquired_at,
        renewed_at=now,
        ttl_seconds=lease.ttl_seconds,
    )
    client: sync_redis.Redis | None = None
    try:
        client = _redis_client()
        renewed = client.eval(
            _RENEW_SCRIPT,
            1,
            _execution_lease_key(lease.run_id),
            lease.token,
            value,
            lease.ttl_seconds,
        )
        return int(renewed or 0) == 1
    except Exception:
        logger.warning(
            "Could not renew Auto-Live execution lease for run %s.",
            lease.run_id,
            exc_info=True,
        )
        return False
    finally:
        if client is not None:
            client.close()


def release_auto_live_run_execution_lease_sync(
    lease: AutoLiveRunExecutionLease,
) -> bool:
    """Release only the caller's own lease token."""

    client: sync_redis.Redis | None = None
    try:
        client = _redis_client()
        released = client.eval(
            _RELEASE_SCRIPT,
            1,
            _execution_lease_key(lease.run_id),
            lease.token,
        )
        return int(released or 0) == 1
    except Exception:
        logger.warning(
            "Could not release Auto-Live execution lease for run %s.",
            lease.run_id,
            exc_info=True,
        )
        return False
    finally:
        if client is not None:
            client.close()


_TERMINAL_LIFECYCLE_STATES = frozenset({"SUCCESS", "FAILURE", "REVOKED", "WORKER_LOST"})


def lifecycle_detail_for_state(state: AutoLiveTaskLifecycleState) -> str:
    return AUTO_LIVE_TASK_LIFECYCLE_DETAILS[state]


def queued_auto_live_task_lifecycle(
    *,
    task_id: str,
    enqueued_at: str | None = None,
    queue: str = AUTO_LIVE_QUEUE,
) -> BullpenAutoLiveTaskLifecycle:
    return BullpenAutoLiveTaskLifecycle(
        state="QUEUED",
        task_id=task_id,
        queue=queue,
        enqueued_at=enqueued_at or utc_now_iso(),
        detail=lifecycle_detail_for_state("QUEUED"),
    )


def _timestamp_is_newer(candidate: str | None, baseline: str | None) -> bool:
    if not candidate:
        return False
    if not baseline:
        return True
    try:
        return datetime.fromisoformat(candidate) > datetime.fromisoformat(baseline)
    except ValueError:
        return candidate > baseline


def _redelivery_count(payload: dict[str, object]) -> int:
    raw_value = payload.get("redelivery_count")
    try:
        return max(0, int(raw_value))
    except (TypeError, ValueError):
        return 0


def merge_task_lifecycle_payload(
    existing: object,
    incoming: object,
) -> object:
    """Retain a newer heartbeat during a concurrent workflow progress write.

    A long-running task keeps a SQLAlchemy session while its heartbeat thread
    uses short independent sessions.  Progress persists a full run payload,
    so without this merge it could overwrite a newer heartbeat with an older
    in-memory copy.  Terminal lifecycle transitions intentionally win.
    """

    if not isinstance(existing, dict) or not isinstance(incoming, dict):
        return incoming
    existing_task_id = existing.get("task_id")
    incoming_task_id = incoming.get("task_id")
    if not existing_task_id:
        return incoming
    if incoming_task_id and existing_task_id != incoming_task_id:
        # A normal worker progress save must never let a stale in-memory run
        # replace the lifecycle of a newer redelivery. Explicit lifecycle
        # transitions increment redelivery_count in _update_lifecycle, so the
        # sole safe cross-task replacement is a demonstrably newer delivery.
        if _redelivery_count(incoming) > _redelivery_count(existing):
            return incoming
        return existing
    if not incoming_task_id:
        return existing
    existing_state = str(existing.get("state") or "").upper()
    incoming_state = str(incoming.get("state") or "").upper()
    if incoming_state in _TERMINAL_LIFECYCLE_STATES:
        return incoming
    if existing_state in _TERMINAL_LIFECYCLE_STATES:
        return existing
    merged = dict(incoming)
    if _timestamp_is_newer(
        str(existing.get("last_heartbeat_at") or "") or None,
        str(incoming.get("last_heartbeat_at") or "") or None,
    ):
        merged["last_heartbeat_at"] = existing.get("last_heartbeat_at")
        merged["state"] = existing.get("state") or incoming.get("state")
        merged["detail"] = existing.get("detail") or incoming.get("detail")
        if existing.get("worker_hostname"):
            merged["worker_hostname"] = existing.get("worker_hostname")
        if existing.get("worker_started_at"):
            merged["worker_started_at"] = existing.get("worker_started_at")
    return merged


def _update_lifecycle(
    lifecycle: BullpenAutoLiveTaskLifecycle | None,
    *,
    state: AutoLiveTaskLifecycleState,
    task_id: str | None,
    queue: str | None = None,
    worker_hostname: str | None = None,
    detail: str | None = None,
    heartbeat_at: str | None = None,
    started_at: str | None = None,
    increment_redelivery: bool = False,
) -> BullpenAutoLiveTaskLifecycle:
    current = lifecycle or BullpenAutoLiveTaskLifecycle()
    # A database-heartbeat thread can return after the task body has already
    # persisted its terminal lifecycle.  Terminal evidence is monotonic: a
    # late STARTED/RETRYING write must never make a completed or failed task
    # appear alive again.
    if current.state in _TERMINAL_LIFECYCLE_STATES:
        return current
    current_task_id = current.task_id
    effective_task_id = task_id or current_task_id
    task_changed = bool(task_id and current_task_id and task_id != current_task_id)
    if task_changed:
        current = BullpenAutoLiveTaskLifecycle(
            task_id=task_id,
            queue=queue or current.queue,
            enqueued_at=current.enqueued_at,
            redelivery_count=current.redelivery_count + 1,
        )
    # A changed Celery task id is already a new delivery above.  Do not count
    # it twice when the caller also knows it arrived through broker redelivery.
    redelivery_count = current.redelivery_count + (
        1 if increment_redelivery and not task_changed else 0
    )
    now = heartbeat_at or utc_now_iso()
    return current.model_copy(
        update={
            "state": state,
            "task_id": effective_task_id,
            "queue": queue or current.queue,
            "enqueued_at": current.enqueued_at
            or (now if state == "QUEUED" else None),
            "worker_hostname": worker_hostname or current.worker_hostname,
            "worker_started_at": started_at
            or current.worker_started_at
            or (now if state == "STARTED" else None),
            "last_heartbeat_at": (
                now
                if state in {"STARTED", "RETRYING"}
                else current.last_heartbeat_at
            ),
            "detail": detail or lifecycle_detail_for_state(state),
            "redelivery_count": redelivery_count,
        }
    )


def update_auto_live_run_task_lifecycle_sync(
    session: Session,
    *,
    run_id: str,
    state: AutoLiveTaskLifecycleState,
    task_id: str | None = None,
    queue: str | None = None,
    worker_hostname: str | None = None,
    detail: str | None = None,
    heartbeat_at: str | None = None,
    started_at: str | None = None,
    expected_task_id: str | None = None,
    increment_redelivery: bool = False,
    lock_nowait: bool = False,
) -> BullpenAutoLiveRun | None:
    """Lock, update, and return a run's lifecycle without terminalizing it.

    ``expected_task_id`` prevents an old/redelivered task from overwriting the
    lifecycle of a newer delivery.  Callers commit their surrounding session.
    """

    record = (
        session.execute(
            select(PolymarketAutoLiveRunRecord)
            .where(PolymarketAutoLiveRunRecord.id == run_id)
            # Heartbeat writes intentionally use NOWAIT.  Audit
            # materialization serializes on this same parent row; a blocked
            # observability update must never delay the independent Redis
            # lease renewal long enough for a healthy planner to lose it.
            .with_for_update(nowait=lock_nowait)
            .execution_options(populate_existing=True)
        )
        .scalar_one_or_none()
    )
    if record is None:
        return None
    run = record_to_run(record)
    current_task_id = run.task_lifecycle.task_id if run.task_lifecycle else None
    if expected_task_id and current_task_id and current_task_id != expected_task_id:
        return None
    run.task_lifecycle = _update_lifecycle(
        run.task_lifecycle,
        state=state,
        task_id=task_id,
        queue=queue,
        worker_hostname=worker_hostname,
        detail=detail,
        heartbeat_at=heartbeat_at,
        started_at=started_at,
        increment_redelivery=increment_redelivery,
    )
    apply_run_to_record(record, run, user_id=record.user_id)
    session.flush()
    return run


def mark_auto_live_run_task_queued_sync(
    session: Session,
    *,
    run_id: str,
    task_id: str,
    enqueued_at: str | None = None,
) -> BullpenAutoLiveRun | None:
    return update_auto_live_run_task_lifecycle_sync(
        session,
        run_id=run_id,
        state="QUEUED",
        task_id=task_id,
        queue=AUTO_LIVE_QUEUE,
        heartbeat_at=enqueued_at or utc_now_iso(),
    )


def mark_auto_live_run_task_started_sync(
    session: Session,
    *,
    run_id: str,
    task_id: str,
    worker_hostname: str | None,
    queue: str | None = None,
    increment_redelivery: bool = False,
) -> BullpenAutoLiveRun | None:
    return update_auto_live_run_task_lifecycle_sync(
        session,
        run_id=run_id,
        state="STARTED",
        task_id=task_id,
        queue=queue,
        worker_hostname=worker_hostname,
        heartbeat_at=utc_now_iso(),
        started_at=utc_now_iso(),
        increment_redelivery=increment_redelivery,
    )


def heartbeat_auto_live_run_task_sync(
    *,
    run_id: str,
    task_id: str,
    worker_hostname: str | None,
) -> bool:
    """Persist heartbeat in a short independent transaction."""

    try:
        with SyncSessionLocal() as session:
            run = update_auto_live_run_task_lifecycle_sync(
                session,
                run_id=run_id,
                state="STARTED",
                task_id=task_id,
                worker_hostname=worker_hostname,
                heartbeat_at=utc_now_iso(),
                expected_task_id=task_id,
                lock_nowait=True,
            )
            if run is None:
                session.rollback()
                return False
            session.commit()
            return True
    except OperationalError as exc:
        # PostgreSQL's lock_not_available is the expected NOWAIT outcome when
        # audit materialization owns the parent run row.  Other operational
        # failures remain visible as warnings instead of being misclassified
        # as harmless contention.
        if getattr(exc.orig, "pgcode", None) == "55P03":
            logger.debug(
                "Auto-Live worker heartbeat row is temporarily locked for run %s.",
                run_id,
            )
        else:
            logger.warning(
                "Could not persist Auto-Live worker heartbeat for run %s.",
                run_id,
                exc_info=True,
            )
        return False
    except Exception:
        logger.warning(
            "Could not persist Auto-Live worker heartbeat for run %s.",
            run_id,
            exc_info=True,
        )
        return False


class AutoLiveRunHeartbeat:
    """Renew the lease independently from best-effort DB heartbeat writes.

    Audit materialization intentionally serializes on the same run row used
    for lifecycle persistence.  A row lock, connection-pool delay, or database
    hiccup must not postpone Redis lease renewal and create a second planner.
    """

    def __init__(
        self,
        *,
        lease: AutoLiveRunExecutionLease,
        worker_hostname: str | None,
        interval_seconds: int = AUTO_LIVE_RUN_HEARTBEAT_INTERVAL_SECONDS,
    ) -> None:
        self._lease = lease
        self._worker_hostname = worker_hostname
        self._interval_seconds = _safe_heartbeat_interval_seconds(
            requested=max(1, int(interval_seconds)),
            lease_ttl=lease.ttl_seconds,
        )
        self._stop_event = threading.Event()
        self._lease_thread: threading.Thread | None = None
        self._database_thread: threading.Thread | None = None
        self.lease_lost = False

    def start(self) -> None:
        if self._lease_thread is not None:
            return
        self._lease_thread = threading.Thread(
            target=self._renew_lease_loop,
            name=f"auto-live-lease-{self._lease.run_id[:8]}",
            daemon=True,
        )
        self._database_thread = threading.Thread(
            target=self._persist_heartbeat_loop,
            name=f"auto-live-db-heartbeat-{self._lease.run_id[:8]}",
            daemon=True,
        )
        self._lease_thread.start()
        self._database_thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        for worker_thread in (self._lease_thread, self._database_thread):
            if worker_thread is not None:
                worker_thread.join(timeout=max(1, self._interval_seconds * 2))

    def ensure_ownership(self) -> bool:
        """Fence a mutating workflow boundary with a synchronous lease check.

        The background renewal keeps a healthy planning run alive, but each
        progress/final-persistence boundary must also fail closed if Redis no
        longer confirms this task's token.  A caller that receives ``False``
        must not write an old in-memory run or enqueue Stage 3 work.
        """

        if self.lease_lost:
            return False
        if renew_auto_live_run_execution_lease_sync(self._lease):
            return True
        self.lease_lost = True
        logger.error(
            "Auto-Live execution lease ownership was lost for run %s.",
            self._lease.run_id,
        )
        return False

    def _renew_lease_loop(self) -> None:
        while not self._stop_event.wait(self._interval_seconds):
            if not renew_auto_live_run_execution_lease_sync(self._lease):
                self.lease_lost = True
                logger.error(
                    "Auto-Live execution lease ownership was lost for run %s.",
                    self._lease.run_id,
                )
                return

    def _persist_heartbeat_loop(self) -> None:
        while not self._stop_event.wait(self._interval_seconds):
            heartbeat_auto_live_run_task_sync(
                run_id=self._lease.run_id,
                task_id=self._lease.task_id,
                worker_hostname=self._worker_hostname,
            )


def task_lifecycle_is_queue_waiting(run: BullpenAutoLiveRun) -> bool:
    lifecycle = run.task_lifecycle
    return bool(lifecycle and lifecycle.state in {"QUEUED", "RESERVED", "RETRYING"})


def task_lifecycle_heartbeat_at(run: BullpenAutoLiveRun) -> str | None:
    lifecycle = run.task_lifecycle
    if lifecycle is None:
        return None
    return lifecycle.last_heartbeat_at or lifecycle.worker_started_at


def task_lifecycle_has_redelivery_evidence(
    run: BullpenAutoLiveRun,
    registered_task_id: str | None,
) -> bool:
    lifecycle = run.task_lifecycle
    return bool(
        lifecycle
        and lifecycle.task_id
        and registered_task_id
        and lifecycle.task_id != registered_task_id
    )
