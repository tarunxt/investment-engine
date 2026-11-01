"""Passive execution evidence boundary; no broker, provider or DB imports.

A11-002/003 must supply a bounded aggregate snapshot before this can verify
progress. No process-active or Celery PENDING inference is accepted here.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Awaitable, Callable


@dataclass(frozen=True)
class ExecutionSnapshot:
    # None means unavailable, never zero. No IDs, payloads or worker names.
    consumer: str = "unknown"  # fresh, stale, missing, partial, unknown
    pending_count: int | None = None
    oldest_pending_age_seconds: float | None = None
    durable_claims_verified: bool | None = None
    dispatch_verified: bool | None = None
    exhausted_retry_count: int | None = None


async def unavailable_snapshot() -> ExecutionSnapshot:
    """Fail closed until the durable owner/dispatch integration is available."""
    return ExecutionSnapshot()


def summarize(snapshot: ExecutionSnapshot, *, recovery: bool) -> dict[str, object]:
    from math import isfinite

    def count(value):
        return value if type(value) is int and value >= 0 else None

    pending = count(snapshot.pending_count)
    exhausted = count(snapshot.exhausted_retry_count)
    age = snapshot.oldest_pending_age_seconds
    age = (float(age) if type(age) in (int, float) and isfinite(age) and age >= 0 else None)
    consumer = snapshot.consumer if snapshot.consumer in {
        "fresh", "stale", "missing", "partial", "unknown"
    } else "unknown"
    complete = (pending is not None and exhausted is not None
                and snapshot.durable_claims_verified is True
                and snapshot.dispatch_verified is True
                and (pending == 0 or age is not None))
    if exhausted is not None and exhausted > 0:
        state = "exhausted_retry"
    elif consumer == "stale":
        state = "stale_heartbeat"
    elif consumer == "missing":
        state = "consumer_unavailable"
    elif consumer == "partial":
        state = "partial_inspect"
    elif not complete or consumer != "fresh":
        state = "unavailable_metrics"
    elif pending == 0:
        state = "idle_empty"
    else:
        state = "queued_with_worker"
    return {
        "status": ("healthy" if complete and consumer == "fresh" and exhausted == 0
                   else "degraded" if state in {"exhausted_retry", "stale_heartbeat",
                                                 "consumer_unavailable"} else "unknown"),
        "policy": "advisory",
        "deployment_gate": False,
        "mode": "recovery" if recovery else "normal",
        "state": state,
        "progress": "verified" if complete and consumer == "fresh" else "unknown",
        "consumer": consumer,
        "pending_count": pending,
        "oldest_pending_age_seconds": age,
        "exhausted_retry_count": exhausted,
        "financial_services": "intentional_containment" if recovery else "not_assessed",
        "escalation_owner": None,
        "acceptance_threshold": None,
    }


async def execution_diagnostics(
    *, recovery: bool,
    reader: Callable[[], Awaitable[ExecutionSnapshot]] = unavailable_snapshot,
    timeout_seconds: float = 0.5,
) -> dict[str, object]:
    # Adapter must be cancellation-safe asynchronous reads with its own DB/Redis
    # connection/query limits; never wrap blocking work in an uncancellable thread.
    try:
        snapshot = await asyncio.wait_for(reader(), timeout=timeout_seconds)
        return summarize(snapshot, recovery=recovery)
    except Exception:
        # Do not return exception strings, topology, correlation input or payloads.
        return summarize(ExecutionSnapshot(), recovery=recovery)
