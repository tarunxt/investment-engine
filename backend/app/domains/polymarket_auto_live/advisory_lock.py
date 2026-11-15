"""PostgreSQL advisory-lock fencing for Auto-Live remote work.

Redis leases remain the fast, renewable queue ownership mechanism.  They are
not, however, a sufficient last line of defence for an irreversible Stage 3
operation: an eviction or a failed-over Redis node can make a healthy worker's
key disappear before that worker returns from a remote Bullpen call.

This module holds a *session-level* PostgreSQL advisory lock on a dedicated
SQLAlchemy connection for the whole remote operation.  It intentionally does
not use a transaction-level lock because both the planner and order-intent
services commit several independent transactions while the remote call is in
flight.  The connection is put in AUTOCOMMIT mode, so a long remote operation
does not leave an idle database transaction open.

PostgreSQL is the production implementation.  The small process-local
fallback is only for non-PostgreSQL unit-test engines; it is not a distributed
lock and must not be treated as a production deployment option.
"""

from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass, field
from threading import Lock
from typing import Literal

from sqlalchemy import text
from sqlalchemy.engine import Connection

from app.infrastructure.database.sync_session import sync_engine


logger = logging.getLogger(__name__)

AutoLiveAdvisoryLockScope = Literal["run", "order_intent", "account"]

_LOCK_NAMESPACE = "bullpen:auto-live:advisory-lock:v1"
_FALLBACK_GUARD = Lock()
_FALLBACK_HELD: set[tuple[str, str]] = set()


class AutoLiveAdvisoryLockUnavailable(RuntimeError):
    """PostgreSQL could not safely establish an Auto-Live fencing lock."""


def auto_live_advisory_lock_key(
    *,
    scope: AutoLiveAdvisoryLockScope,
    resource_id: str,
) -> int:
    """Return one stable signed 64-bit PostgreSQL advisory-lock key.

    A namespace and scope keep this key space independent from any other
    advisory locks in the application.  ``pg_try_advisory_lock(bigint)`` takes
    a signed bigint, hence ``signed=True`` rather than a Python hash (which is
    intentionally randomized across worker processes).
    """

    digest = hashlib.blake2b(
        f"{_LOCK_NAMESPACE}:{scope}:{resource_id}".encode("utf-8"),
        digest_size=8,
    ).digest()
    return int.from_bytes(digest, byteorder="big", signed=True)


@dataclass
class AutoLiveAdvisoryLock:
    """An acquired session-level PostgreSQL advisory lock.

    The connection must remain checked out for the duration of the protected
    remote call.  Closing it is also a server-side safety release if an
    explicit ``pg_advisory_unlock`` cannot be sent.
    """

    scope: AutoLiveAdvisoryLockScope
    resource_id: str
    lock_key: int
    connection: Connection | None = None
    _fallback_identity: tuple[str, str] | None = None
    _released: bool = field(default=False, init=False, repr=False)
    _healthy: bool = field(default=True, init=False, repr=False)

    @property
    def acquired(self) -> bool:
        return not self._released

    def is_healthy(self) -> bool:
        """Confirm this holder's dedicated lock session still exists.

        Call this only from the task's main thread.  A SQLAlchemy ``Connection``
        is not thread-safe, and the background Redis heartbeat must never use
        this held connection.  PostgreSQL does not transparently move a live
        ``Connection`` to a different backend; therefore a successful probe on
        the same session means the session-level advisory lock acquired by this
        object is still held.  A failed probe marks the fence unhealthy and
        callers must stop before another durable workflow mutation.
        """

        if self._released or not self._healthy:
            return False

        connection = self.connection
        if connection is not None:
            try:
                connection.execute(text("SELECT 1"))
            except Exception:
                self._healthy = False
                logger.error(
                    "Lost PostgreSQL advisory-lock session for %s %s.",
                    self.scope,
                    self.resource_id,
                    exc_info=True,
                )
                return False
            return True

        identity = self._fallback_identity
        if identity is None:
            return False
        with _FALLBACK_GUARD:
            return identity in _FALLBACK_HELD

    def release(self) -> None:
        """Release only this holder's lock and always return its connection.

        Release is deliberately idempotent.  A connection close releases a
        PostgreSQL session lock even if a transient error prevents the explicit
        unlock statement from reaching the database.
        """

        if self._released:
            return
        self._released = True

        connection = self.connection
        self.connection = None
        if connection is not None:
            try:
                unlocked = connection.execute(
                    text("SELECT pg_advisory_unlock(CAST(:lock_key AS bigint))"),
                    {"lock_key": self.lock_key},
                ).scalar()
                if not bool(unlocked):
                    logger.warning(
                        "PostgreSQL reported no %s advisory lock to release for %s.",
                        self.scope,
                        self.resource_id,
                    )
            except Exception:
                logger.warning(
                    "Could not explicitly release %s advisory lock for %s; "
                    "invalidating the dedicated PostgreSQL session instead.",
                    self.scope,
                    self.resource_id,
                    exc_info=True,
                )
                # ``Connection.close()`` normally returns a healthy DBAPI
                # connection to SQLAlchemy's pool.  If an unlock response was
                # lost, that could retain an unknown session lock in the pool;
                # invalidate first so the physical PostgreSQL session is
                # discarded and its advisory locks are released.
                try:
                    connection.invalidate()
                except Exception:  # pragma: no cover - defensive cleanup
                    logger.warning(
                        "Could not invalidate failed advisory-lock connection for "
                        "%s %s.",
                        self.scope,
                        self.resource_id,
                        exc_info=True,
                    )
            finally:
                try:
                    connection.close()
                except Exception:  # pragma: no cover - defensive pool cleanup
                    logger.warning(
                        "Could not close dedicated PostgreSQL advisory-lock "
                        "connection for %s %s.",
                        self.scope,
                        self.resource_id,
                        exc_info=True,
                    )

        identity = self._fallback_identity
        self._fallback_identity = None
        if identity is not None:
            with _FALLBACK_GUARD:
                _FALLBACK_HELD.discard(identity)

    def __enter__(self) -> AutoLiveAdvisoryLock:
        return self

    def __exit__(self, *_args: object) -> None:
        self.release()


def _acquire_test_fallback(
    *,
    scope: AutoLiveAdvisoryLockScope,
    resource_id: str,
    lock_key: int,
) -> AutoLiveAdvisoryLock | None:
    """Provide non-blocking in-process semantics for SQLite/unit tests only."""

    identity = (scope, resource_id)
    with _FALLBACK_GUARD:
        if identity in _FALLBACK_HELD:
            return None
        _FALLBACK_HELD.add(identity)
    return AutoLiveAdvisoryLock(
        scope=scope,
        resource_id=resource_id,
        lock_key=lock_key,
        _fallback_identity=identity,
    )


def acquire_auto_live_advisory_lock_sync(
    *,
    scope: AutoLiveAdvisoryLockScope,
    resource_id: str,
) -> AutoLiveAdvisoryLock | None:
    """Try to acquire the distributed fence without waiting.

    ``None`` means another worker has the live lock and callers must exit
    before touching a remote provider.  Backend errors are raised separately
    so callers fail closed instead of silently falling back to unfenced work.
    """

    normalized_resource_id = str(resource_id)
    lock_key = auto_live_advisory_lock_key(
        scope=scope,
        resource_id=normalized_resource_id,
    )
    dialect_name = getattr(getattr(sync_engine, "dialect", None), "name", None)
    if dialect_name != "postgresql":
        return _acquire_test_fallback(
            scope=scope,
            resource_id=normalized_resource_id,
            lock_key=lock_key,
        )

    connection: Connection | None = None
    try:
        # Session-level advisory locks survive normal transaction boundaries.
        # AUTOCOMMIT prevents this long-held connection from being left idle in
        # an implicit transaction while a remote provider call is in progress.
        connection = sync_engine.connect()
        connection = connection.execution_options(isolation_level="AUTOCOMMIT")
        acquired = connection.execute(
            text("SELECT pg_try_advisory_lock(CAST(:lock_key AS bigint))"),
            {"lock_key": lock_key},
        ).scalar()
        if not bool(acquired):
            connection.close()
            return None
        return AutoLiveAdvisoryLock(
            scope=scope,
            resource_id=normalized_resource_id,
            lock_key=lock_key,
            connection=connection,
        )
    except Exception as exc:
        if connection is not None:
            try:
                # A network failure can occur after PostgreSQL acquired the
                # lock but before the response reached this worker.  Returning
                # that session to the pool would retain an unknown lock, so
                # discard the physical session before closing it.
                connection.invalidate()
            except Exception:  # pragma: no cover - preserve root cause
                logger.debug("Failed to invalidate unavailable advisory-lock connection.")
            try:
                connection.close()
            except Exception:  # pragma: no cover - preserve root cause
                logger.debug("Failed to close unavailable advisory-lock connection.")
        raise AutoLiveAdvisoryLockUnavailable(
            f"Could not acquire PostgreSQL advisory lock for {scope} "
            f"{normalized_resource_id}."
        ) from exc


def acquire_auto_live_run_execution_advisory_lock_sync(
    run_id: str,
) -> AutoLiveAdvisoryLock | None:
    """Acquire the Stage 1/2 planner fence for one durable run."""

    return acquire_auto_live_advisory_lock_sync(scope="run", resource_id=run_id)


def acquire_order_intent_operation_advisory_lock_sync(
    intent_id: str,
) -> AutoLiveAdvisoryLock | None:
    """Acquire the Stage 3 remote-operation fence for one durable intent."""

    return acquire_auto_live_advisory_lock_sync(
        scope="order_intent",
        resource_id=intent_id,
    )


def acquire_bullpen_account_execution_advisory_lock_sync(
    account_identity: str,
) -> AutoLiveAdvisoryLock | None:
    """Serialize 008 remote writes with one account-wide PostgreSQL fence.

    Existing 007 run and order-intent scopes remain byte-for-byte unchanged;
    this additive scope is used only by Bullpen 008 Stage 6.
    """

    return acquire_auto_live_advisory_lock_sync(
        scope="account",
        resource_id=account_identity,
    )


def auto_live_run_execution_advisory_lock_is_live_sync(run_id: str) -> bool | None:
    """Return whether another session currently owns a planner fence.

    This is a recovery probe, not an ownership acquisition.  It safely tries
    the same non-blocking lock and immediately releases it when available:

    * ``True``: another worker owns the PostgreSQL planning fence;
    * ``False``: no owner was observed at probe time;
    * ``None``: PostgreSQL was unavailable, so recovery must retain ambiguity.

    Recovery still needs its grace and Celery-evidence checks because a lock
    can be released just after this instantaneous probe.
    """

    try:
        probe_lock = acquire_auto_live_run_execution_advisory_lock_sync(run_id)
    except AutoLiveAdvisoryLockUnavailable:
        logger.warning(
            "Could not inspect PostgreSQL Auto-Live execution fence for run %s.",
            run_id,
            exc_info=True,
        )
        return None
    if probe_lock is None:
        return True
    probe_lock.release()
    return False
