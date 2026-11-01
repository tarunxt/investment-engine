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


@dataclass(frozen=True)
class DurableProjection:
    """Safe fields projected by the future scoped SQLAlchemy reader.

    Excludes IDs, payload, owner/claim tokens, provider metadata and errors.
    Epoch values must be normalized to UTC by that reader.
    """
    dispatch_state: str | None = None
    created_at: float | None = None
    claim_state: str | None = None
    claim_expires_at: float | None = None
    terminal: bool = False


def summarize_durable(rows, *, now: float, complete: bool = False) -> dict[str, object]:
    """Bounded projection of A11-003 outbox/A11-002 claim evidence.

    `complete` asserts caller scope/query completeness, never heartbeat freshness.
    At most 101 rows are consumed; a 101st row marks a truncated sample. Counts
    from incomplete samples remain unknown (sample counts are named explicitly).
    Dead letters include policy failures, so never infer exhausted retry counts.
    """
    from itertools import islice
    from math import isfinite

    sample = list(islice(rows, 101))
    truncated = len(sample) > 100
    sample = sample[:100]
    counters = {name: 0 for name in (
        "pending", "uncertain", "delivered", "suppressed", "dead_letter",
        "owned", "expired_claim", "reconciliation_needed", "unknown_dispatch",
    )}
    ages = []
    valid_now = type(now) in (int, float) and isfinite(now)
    valid = valid_now and not truncated and complete is True
    for row in sample:
        state = row.dispatch_state
        if state in {"pending", "uncertain", "delivered", "suppressed", "dead_letter"}:
            counters[state] += 1
        else:
            counters["unknown_dispatch"] += 1
            valid = False
        if state in {"pending", "uncertain"} and not row.terminal:
            created = row.created_at
            if (valid_now and type(created) in (int, float)
                    and isfinite(created) and created <= now):
                ages.append(now - created)
            else:
                valid = False
        if row.claim_state == "reconciliation_needed":
            counters["reconciliation_needed"] += 1
        elif row.claim_state == "owned":
            expires = row.claim_expires_at
            if valid_now and type(expires) in (int, float) and isfinite(expires):
                counters["owned" if expires > now else "expired_claim"] += 1
            else:
                valid = False
        elif row.claim_state is not None:
            valid = False
    return {
        "scope_complete": valid,
        "sample_size": len(sample),
        "truncated": truncated,
        "sample_counts": counters,
        "oldest_unresolved_age_seconds": max(ages) if valid and ages else None,
        "consumer": "unknown",
        "receipt": "unknown",
        "service_state": "unknown",
        "exhausted_retry_count": None,
    }
