"""Redis-backed, token-fenced leases for durable Stage 3 intent operations.

The order-intent row remains the source of truth for an order's state.  This
module only prevents the queue from creating concurrent remote operations for
that row.  It deliberately uses Redis because it is already the durable Celery
broker dependency, has atomic ``SET NX`` semantics, and naturally releases a
lease after a worker is killed.

An enqueue lease begins in ``QUEUED`` state.  The Celery task atomically
transitions it to ``STARTED`` with a new runtime token before it performs any
remote operation.  This second token prevents duplicate delivery of the same
Celery task from executing concurrently.  Every renewal and release compares
the runtime token, so an old worker can never extend or release a newer
worker's lease.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from threading import Event, Thread
from typing import Literal
from uuid import uuid4

import redis as sync_redis

from app.core.config import settings


logger = logging.getLogger(__name__)

OrderIntentOperation = Literal["execute", "reconcile", "retry"]

_LEASE_KEY_PREFIX = "bullpen:auto-live:order-intent:operation-lease:"
_DEFAULT_QUEUED_LEASE_SECONDS = 60 * 60
_MIN_CONFIGURED_QUEUED_LEASE_SECONDS = 45 * 60
# Production reconciliations have historically taken up to ~18 minutes while
# blocked on the Bullpen runtime lock.  The heartbeat renews this lease every
# minute, but the base TTL must also be long enough that a brief process pause
# cannot let a second worker enter the same remote reconciliation concurrently.
_DEFAULT_ACTIVE_LEASE_SECONDS = 30 * 60
_MIN_CONFIGURED_ACTIVE_LEASE_SECONDS = 20 * 60


_START_SCRIPT = """
local raw = redis.call('get', KEYS[1])
if not raw then return 0 end
local ok, lease = pcall(cjson.decode, raw)
if not ok or type(lease) ~= 'table' then return 0 end
if lease['state'] ~= 'QUEUED' then return 0 end
if lease['dispatch_token'] ~= ARGV[1] then return 0 end
if lease['task_id'] ~= ARGV[2] then return 0 end
lease['state'] = 'STARTED'
lease['token'] = ARGV[3]
lease['worker_started_at'] = ARGV[4]
lease['last_heartbeat_at'] = ARGV[4]
lease['expires_at'] = ARGV[5]
redis.call('set', KEYS[1], cjson.encode(lease), 'EX', ARGV[6])
return 1
"""

_REFRESH_SCRIPT = """
local raw = redis.call('get', KEYS[1])
if not raw then return 0 end
local ok, lease = pcall(cjson.decode, raw)
if not ok or type(lease) ~= 'table' then return 0 end
if lease['state'] ~= 'STARTED' then return 0 end
if lease['token'] ~= ARGV[1] then return 0 end
lease['last_heartbeat_at'] = ARGV[2]
lease['expires_at'] = ARGV[3]
redis.call('set', KEYS[1], cjson.encode(lease), 'EX', ARGV[4])
return 1
"""

_RELEASE_SCRIPT = """
local raw = redis.call('get', KEYS[1])
if not raw then return 0 end
local ok, lease = pcall(cjson.decode, raw)
if not ok or type(lease) ~= 'table' then return 0 end
if lease['token'] ~= ARGV[1] then return 0 end
return redis.call('del', KEYS[1])
"""


class OrderIntentLeaseBackendUnavailable(RuntimeError):
    """Raised when Redis cannot safely arbitrate a Stage 3 operation."""


@dataclass(frozen=True)
class OrderIntentOperationLease:
    """The ownership data needed to transition, renew, and release a lease."""

    intent_id: str
    task_id: str
    dispatch_token: str
    token: str
    operation: OrderIntentOperation
    source: str
    state: Literal["QUEUED", "STARTED"]
    acquired_at: datetime
    expires_at: datetime
    ttl_seconds: int
    worker_started_at: datetime | None = None

    @property
    def key(self) -> str:
        return order_intent_operation_lease_key(self.intent_id)


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _iso(value: datetime) -> str:
    return _as_utc(value).isoformat()


def _configured_queued_lease_seconds() -> int:
    raw_value = os.getenv(
        "AUTO_LIVE_ORDER_INTENT_OPERATION_LEASE_SECONDS",
        str(_DEFAULT_QUEUED_LEASE_SECONDS),
    )
    try:
        configured = int(raw_value)
    except (TypeError, ValueError):
        logger.warning(
            "Invalid AUTO_LIVE_ORDER_INTENT_OPERATION_LEASE_SECONDS=%r; "
            "using %s seconds.",
            raw_value,
            _DEFAULT_QUEUED_LEASE_SECONDS,
        )
        configured = _DEFAULT_QUEUED_LEASE_SECONDS
    if configured < _MIN_CONFIGURED_QUEUED_LEASE_SECONDS:
        logger.warning(
            "AUTO_LIVE_ORDER_INTENT_OPERATION_LEASE_SECONDS=%s is below the "
            "safe queued-task minimum; using %s seconds.",
            configured,
            _MIN_CONFIGURED_QUEUED_LEASE_SECONDS,
        )
    return max(_MIN_CONFIGURED_QUEUED_LEASE_SECONDS, configured)


def _configured_active_lease_seconds() -> int:
    raw_value = os.getenv(
        "AUTO_LIVE_ORDER_INTENT_OPERATION_ACTIVE_LEASE_SECONDS",
        str(_DEFAULT_ACTIVE_LEASE_SECONDS),
    )
    try:
        configured = int(raw_value)
    except (TypeError, ValueError):
        logger.warning(
            "Invalid AUTO_LIVE_ORDER_INTENT_OPERATION_ACTIVE_LEASE_SECONDS=%r; "
            "using %s seconds.",
            raw_value,
            _DEFAULT_ACTIVE_LEASE_SECONDS,
        )
        configured = _DEFAULT_ACTIVE_LEASE_SECONDS
    if configured < _MIN_CONFIGURED_ACTIVE_LEASE_SECONDS:
        logger.warning(
            "AUTO_LIVE_ORDER_INTENT_OPERATION_ACTIVE_LEASE_SECONDS=%s is below "
            "the safe long-reconciliation minimum; using %s seconds.",
            configured,
            _MIN_CONFIGURED_ACTIVE_LEASE_SECONDS,
        )
    return max(_MIN_CONFIGURED_ACTIVE_LEASE_SECONDS, configured)


def order_intent_operation_lease_key(intent_id: str) -> str:
    return f"{_LEASE_KEY_PREFIX}{intent_id}"


def _redis_client() -> sync_redis.Redis:
    try:
        return sync_redis.from_url(settings.redis_url, decode_responses=True)
    except Exception as exc:  # pragma: no cover - defensive around client construction
        raise OrderIntentLeaseBackendUnavailable(
            "Could not create the Redis client for the Stage 3 operation lease."
        ) from exc


def _close_client(client: sync_redis.Redis) -> None:
    try:
        client.close()
    except Exception:  # pragma: no cover - close failures must not mask task work
        logger.debug("Failed to close Stage 3 operation-lease Redis client.", exc_info=True)


def _lease_payload(
    *,
    intent_id: str,
    task_id: str,
    token: str,
    operation: OrderIntentOperation,
    source: str,
    acquired_at: datetime,
    expires_at: datetime,
) -> str:
    return json.dumps(
        {
            "intent_id": intent_id,
            "task_id": task_id,
            "dispatch_token": token,
            "token": token,
            "operation": operation,
            "source": source,
            "state": "QUEUED",
            "acquired_at": _iso(acquired_at),
            "worker_started_at": None,
            "last_heartbeat_at": None,
            "expires_at": _iso(expires_at),
        },
        separators=(",", ":"),
        sort_keys=True,
    )


def acquire_order_intent_operation_lease_sync(
    *,
    intent_id: str,
    task_id: str,
    operation: OrderIntentOperation,
    source: str,
    ttl_seconds: int | None = None,
    now: datetime | None = None,
) -> OrderIntentOperationLease | None:
    """Atomically reserve one intent operation before publishing its task.

    A ``None`` result means another queued or running operation owns the
    intent.  Redis failures are deliberately surfaced to callers so they can
    fail closed rather than enqueue un-fenced remote work.
    """

    ttl = max(
        1,
        int(
            ttl_seconds
            if ttl_seconds is not None
            else _configured_queued_lease_seconds()
        ),
    )
    acquired_at = _as_utc(now or _utc_now())
    expires_at = acquired_at + timedelta(seconds=ttl)
    dispatch_token = str(uuid4())
    client = _redis_client()
    try:
        acquired = client.set(
            order_intent_operation_lease_key(intent_id),
            _lease_payload(
                intent_id=intent_id,
                task_id=task_id,
                token=dispatch_token,
                operation=operation,
                source=source,
                acquired_at=acquired_at,
                expires_at=expires_at,
            ),
            nx=True,
            ex=ttl,
        )
    except Exception as exc:
        raise OrderIntentLeaseBackendUnavailable(
            f"Could not acquire Stage 3 {operation} lease for intent {intent_id}."
        ) from exc
    finally:
        _close_client(client)
    if not acquired:
        return None
    return OrderIntentOperationLease(
        intent_id=intent_id,
        task_id=task_id,
        dispatch_token=dispatch_token,
        token=dispatch_token,
        operation=operation,
        source=source,
        state="QUEUED",
        acquired_at=acquired_at,
        expires_at=expires_at,
        ttl_seconds=ttl,
    )


def start_order_intent_operation_lease_sync(
    *,
    intent_id: str,
    task_id: str,
    dispatch_token: str,
    operation: OrderIntentOperation,
    source: str,
    ttl_seconds: int | None = None,
    now: datetime | None = None,
) -> OrderIntentOperationLease | None:
    """Atomically move this task's queued lease to an active worker lease."""

    # A queued task must tolerate pool starvation.  A started operation also
    # receives a deliberately long base lease because remote reconciliation
    # has exceeded 15 minutes in production; the heartbeat renews it much
    # earlier while preserving safe WorkerLost expiry if the process dies.
    ttl = max(
        1,
        int(
            ttl_seconds
            if ttl_seconds is not None
            else _configured_active_lease_seconds()
        ),
    )
    worker_started_at = _as_utc(now or _utc_now())
    expires_at = worker_started_at + timedelta(seconds=ttl)
    runtime_token = str(uuid4())
    client = _redis_client()
    try:
        started = client.eval(
            _START_SCRIPT,
            1,
            order_intent_operation_lease_key(intent_id),
            dispatch_token,
            task_id,
            runtime_token,
            _iso(worker_started_at),
            _iso(expires_at),
            ttl,
        )
    except Exception as exc:
        raise OrderIntentLeaseBackendUnavailable(
            f"Could not start Stage 3 operation lease for intent {intent_id}."
        ) from exc
    finally:
        _close_client(client)
    if int(started or 0) != 1:
        return None
    return OrderIntentOperationLease(
        intent_id=intent_id,
        task_id=task_id,
        dispatch_token=dispatch_token,
        token=runtime_token,
        operation=operation,
        source=source,
        state="STARTED",
        acquired_at=worker_started_at,
        expires_at=expires_at,
        ttl_seconds=ttl,
        worker_started_at=worker_started_at,
    )


def refresh_order_intent_operation_lease_sync(
    lease: OrderIntentOperationLease,
    *,
    now: datetime | None = None,
) -> bool:
    """Renew a running lease only while the same worker still owns it."""

    if lease.state != "STARTED":
        return False
    heartbeat_at = _as_utc(now or _utc_now())
    expires_at = heartbeat_at + timedelta(seconds=lease.ttl_seconds)
    client = _redis_client()
    try:
        refreshed = client.eval(
            _REFRESH_SCRIPT,
            1,
            lease.key,
            lease.token,
            _iso(heartbeat_at),
            _iso(expires_at),
            lease.ttl_seconds,
        )
    except Exception as exc:
        raise OrderIntentLeaseBackendUnavailable(
            f"Could not refresh Stage 3 {lease.operation} lease for intent {lease.intent_id}."
        ) from exc
    finally:
        _close_client(client)
    return int(refreshed or 0) == 1


def release_order_intent_operation_lease_sync(
    lease: OrderIntentOperationLease,
) -> bool:
    """Release only the matching task/worker token; never delete a newer lease."""

    client = _redis_client()
    try:
        released = client.eval(_RELEASE_SCRIPT, 1, lease.key, lease.token)
    except Exception as exc:
        raise OrderIntentLeaseBackendUnavailable(
            f"Could not release Stage 3 {lease.operation} lease for intent {lease.intent_id}."
        ) from exc
    finally:
        _close_client(client)
    return int(released or 0) == 1


def get_order_intent_operation_lease_sync(intent_id: str) -> dict[str, object] | None:
    """Return lease diagnostics for operations and production verification."""

    client = _redis_client()
    try:
        raw = client.get(order_intent_operation_lease_key(intent_id))
    except Exception as exc:
        raise OrderIntentLeaseBackendUnavailable(
            f"Could not inspect Stage 3 operation lease for intent {intent_id}."
        ) from exc
    finally:
        _close_client(client)
    if not isinstance(raw, str) or not raw:
        return None
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        logger.warning("Ignoring malformed Stage 3 operation lease for intent %s", intent_id)
        return None
    return parsed if isinstance(parsed, dict) else None


class OrderIntentOperationLeaseHeartbeat:
    """Refresh a worker-owned lease while blocking Bullpen I/O is in flight."""

    def __init__(self, lease: OrderIntentOperationLease) -> None:
        self._lease = lease
        self._stop = Event()
        self._thread: Thread | None = None
        self.ownership_lost = False

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = Thread(
            target=self._run,
            name=f"auto-live-intent-lease-{self._lease.intent_id[:16]}",
            daemon=True,
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)

    def ensure_ownership(self) -> bool:
        """Synchronously verify ownership before beginning remote Bullpen I/O."""

        if self.ownership_lost:
            return False
        try:
            if refresh_order_intent_operation_lease_sync(self._lease):
                return True
        except OrderIntentLeaseBackendUnavailable:
            logger.exception(
                "Unable to verify Stage 3 %s lease ownership for intent %s",
                self._lease.operation,
                self._lease.intent_id,
            )
        self.ownership_lost = True
        logger.error(
            "Lost ownership of Stage 3 %s lease for intent %s; refusing to "
            "start another remote operation.",
            self._lease.operation,
            self._lease.intent_id,
        )
        return False

    def _run(self) -> None:
        # Redis work can legitimately take many minutes.  Sixty seconds gives
        # enough retry time while keeping a long reconciliation safely alive.
        interval = max(5.0, min(60.0, self._lease.ttl_seconds / 3))
        while not self._stop.wait(interval):
            try:
                if refresh_order_intent_operation_lease_sync(self._lease):
                    continue
            except OrderIntentLeaseBackendUnavailable:
                logger.exception(
                    "Unable to refresh Stage 3 %s lease for intent %s",
                    self._lease.operation,
                    self._lease.intent_id,
                )
            self.ownership_lost = True
            logger.error(
                "Lost ownership of Stage 3 %s lease for intent %s; no further "
                "operation should be started by this worker.",
                self._lease.operation,
                self._lease.intent_id,
            )
            return
