"""Fail-closed job fencing and resource admission for tagged rebalances.

All mutations flush, never commit. Callers must commit resource + spend admission
in one transaction BEFORE external I/O. Lock order is scope, execution, resource,
then spend attempt. A crash does not expire a fence or release a reservation.
Output counts MUST include hidden reasoning; unknown counts are not zero.
"""
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from sqlalchemy import select

from . import ledger
from .execution_models import RebalanceExecution, RebalanceResourceReservation
from .ledger import SpendCapBlocked
from .models import RebalanceSpendBinding, RebalanceSpendScope

JOB_OUTPUT_LIMIT = 48000
REQUEST_OUTPUT_LIMIT = 12000
JOB_TOOL_LIMIT = 32
RESPONSE_TOOL_LIMIT = 4
EXECUTION_SECONDS = 600


def _time(value=None):
    value = value or datetime.now(timezone.utc)
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value


def _count(value, *, positive=False):
    if isinstance(value, bool) or not isinstance(value, int) or value < int(positive):
        raise SpendCapBlocked("Verified nonnegative integer resource counts required")
    return value


def _lock(db, scope_id, job_id):
    scope = db.scalar(select(RebalanceSpendScope).where(
        RebalanceSpendScope.id == scope_id).with_for_update().execution_options(populate_existing=True))
    if scope is None:
        raise SpendCapBlocked("Execution spending scope is unavailable")
    row = db.scalar(select(RebalanceExecution).where(
        RebalanceExecution.job_id == job_id).with_for_update().execution_options(populate_existing=True))
    if row is not None and row.scope_id != scope_id:
        raise SpendCapBlocked("Job execution cannot replace its original spending scope")
    return scope, row


def _owned(row, token):
    if row is None or not token or row.fence_token != token:
        raise SpendCapBlocked("Execution fence is not owned by this worker")


def claim(db, *, scope_id, user_id, job_id, now=None):
    """Start at worker execution, not enqueue; never renew a retry's deadline."""
    scope, row = _lock(db, scope_id, job_id)
    if scope.user_id != user_id or scope.status != "open":
        raise SpendCapBlocked("Owned execution scope is unavailable or suspended")
    jobs = ledger.job_table()
    owned = db.scalar(select(jobs.c.id).join(RebalanceSpendBinding,
        (RebalanceSpendBinding.user_id == jobs.c.user_id)
        & (RebalanceSpendBinding.portfolio == jobs.c.auto_rebalance_portfolio)
        & (RebalanceSpendBinding.sequence == jobs.c.auto_rebalance_sequence)).where(
        jobs.c.id == job_id, jobs.c.user_id == user_id,
        RebalanceSpendBinding.scope_id == scope_id).limit(1))
    if owned is None:
        raise SpendCapBlocked("Job does not belong to its execution spending scope")
    instant = _time(now)
    if row is not None and (row.status != "idle" or row.fence_token is not None):
        raise SpendCapBlocked("Job already executing, completed or suspended; no lease renewal")
    if row is not None and instant >= _time(row.deadline_at):
        raise SpendCapBlocked("Original job execution deadline exhausted")
    token = str(uuid4())
    if row is None:
        row = RebalanceExecution(job_id=job_id, scope_id=scope_id, started_at=instant,
            deadline_at=instant + timedelta(seconds=EXECUTION_SECONDS), status="active", fence_token=token)
        db.add(row)
    else:
        row.status, row.fence_token = "active", token
    db.flush()
    return token


def remaining_seconds(db, *, scope_id, job_id, token, now=None):
    scope, row = _lock(db, scope_id, job_id)
    _owned(row, token)
    remaining = (_time(row.deadline_at) - _time(now)).total_seconds()
    if scope.status != "open" or row.status != "active" or remaining <= 0:
        raise SpendCapBlocked("Job execution is suspended or its deadline is exhausted")
    return remaining


def reserve_call(db, *, scope_id, job_id, token, attempt_key, output_tokens, tool_calls, now=None):
    """Reserve enforceable full-output and tool upper bounds before dispatch."""
    output_tokens, tool_calls = _count(output_tokens), _count(tool_calls)
    if (output_tokens == 0 and tool_calls == 0) or output_tokens > REQUEST_OUTPUT_LIMIT or tool_calls > RESPONSE_TOOL_LIMIT:
        raise SpendCapBlocked("Per-response resource ceiling exceeded")
    if not isinstance(attempt_key, str) or not attempt_key or len(attempt_key) > 128:
        raise SpendCapBlocked("Durable resource attempt identity required")
    remaining_seconds(db, scope_id=scope_id, job_id=job_id, token=token, now=now)
    _, row = _lock(db, scope_id, job_id)
    existing = db.scalar(select(RebalanceResourceReservation.id).where(
        RebalanceResourceReservation.job_id == job_id,
        RebalanceResourceReservation.attempt_key == attempt_key))
    if existing is not None:
        raise SpendCapBlocked("Resource attempt already admitted; reconcile instead of replaying")
    if (row.output_used + row.output_reserved + output_tokens > JOB_OUTPUT_LIMIT
            or row.tools_used + row.tools_reserved + tool_calls > JOB_TOOL_LIMIT):
        raise SpendCapBlocked("Whole-job resource allowance exhausted")
    row.output_reserved += output_tokens
    row.tools_reserved += tool_calls
    reservation = RebalanceResourceReservation(job_id=job_id, attempt_key=attempt_key,
        fence_token=token, status="reserved", output_bound=output_tokens, tools_bound=tool_calls)
    db.add(reservation)
    db.flush()
    return reservation.id


def settle_call(db, *, scope_id, job_id, token, resource_id, output_tokens=None, tool_calls=None, now=None):
    """Return status; caller commits even uncertain/breach results before raising.

    Late evidence may reconcile usage but cannot renew the deadline or resurrect a
    suspended execution. Only certified total-output/tool counts can release it.
    """
    _, row = _lock(db, scope_id, job_id)
    _owned(row, token)
    reservation = db.scalar(select(RebalanceResourceReservation).where(
        RebalanceResourceReservation.id == resource_id,
        RebalanceResourceReservation.job_id == job_id).with_for_update().execution_options(populate_existing=True))
    if reservation is None or reservation.fence_token != token:
        raise SpendCapBlocked("Resource reservation fence mismatch")
    if reservation.status in {"settled", "bound_breach"}:
        if output_tokens != reservation.output_actual or tool_calls != reservation.tools_actual:
            row.status = "suspended"
            db.flush()
            return "settlement_conflict"
        return reservation.status
    if output_tokens is None or tool_calls is None:
        reservation.status, row.status = "uncertain", "suspended"
    else:
        output_tokens, tool_calls = _count(output_tokens), _count(tool_calls)
        row.output_reserved -= reservation.output_bound
        row.tools_reserved -= reservation.tools_bound
        row.output_used += output_tokens
        row.tools_used += tool_calls
        reservation.output_actual, reservation.tools_actual = output_tokens, tool_calls
        reservation.status = "settled"
        if output_tokens > reservation.output_bound or tool_calls > reservation.tools_bound:
            reservation.status, row.status = "bound_breach", "suspended"
    db.flush()
    return reservation.status


def finish(db, *, scope_id, job_id, token, completed=False):
    """Release only matching, clean ownership; ambiguous work stays fenced."""
    _, row = _lock(db, scope_id, job_id)
    _owned(row, token)
    pending = db.scalar(select(RebalanceResourceReservation.id).where(
        RebalanceResourceReservation.job_id == job_id,
        RebalanceResourceReservation.status.in_(("reserved", "uncertain", "bound_breach"))).limit(1))
    if pending is not None or row.status == "suspended":
        row.status = "suspended"
    else:
        row.status = "completed" if completed else "idle"
        row.fence_token = None
    db.flush()
    return row.status


def remaining(db, *, scope_id, job_id, token, now=None):
    seconds = remaining_seconds(db, scope_id=scope_id, job_id=job_id, token=token, now=now)
    _, row = _lock(db, scope_id, job_id)
    return {"remaining_seconds": seconds,
            "output_tokens": max(0, JOB_OUTPUT_LIMIT - row.output_used - row.output_reserved),
            "tool_calls": max(0, JOB_TOOL_LIMIT - row.tools_used - row.tools_reserved)}
