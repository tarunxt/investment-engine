"""Per-child analysis dispatch; no service/Beat activation in this module.

An uncertain broker outcome is never treated as delivery or automatically retried.
The independently reviewed consumer fence is required before reconciliation.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from uuid import uuid4

from sqlalchemy import or_, select

from app.core.recovery import ANALYSIS_QUEUE, ANALYSIS_TASK, TRANSPORT_PREFIX, recovery_mode, require_equity_analysis
from app.domains.jobs.models import Job
from app.infrastructure.database.outbox.models import OutboxMessage
from app.shared.types import JobStatus

TOPIC = "analysis.dispatch.v1"
MAX_ATTEMPTS = 5


def utcnow():
    return datetime.now(timezone.utc)


def obligation(job, eta=None):
    return OutboxMessage(
        id=uuid4(), topic=TOPIC, job_id=job.id, state="pending",
        payload={"job_id": job.id, "eta": eta.isoformat() if eta else None},
    )


def celery_publisher(job_id, task_id, eta):
    from app.infrastructure.messaging.celery_app import celery
    options = {"task_id": task_id, "eta": eta}
    if recovery_mode():
        # Refuse to publish into an uncontained broker configuration.
        configured = celery.conf.broker_transport_options or {}
        if configured.get("global_keyprefix") != TRANSPORT_PREFIX:
            raise RuntimeError("Recovery broker namespace is not isolated")
        options["queue"] = ANALYSIS_QUEUE
    celery.send_task(ANALYSIS_TASK, args=[job_id], **options)


async def dispatch_one(session, message_id, publisher=celery_publisher, *,
                       reconcile=False, consumer_fence_verified=False, now=None):
    """Claim, commit uncertainty before I/O, then acknowledge under the claim token.

    The row lock prevents concurrent first publication. A lost process leaves an
    uncertain record, never a misleading pending/success response. Stable broker
    identity pairs with A11-002; Celery task IDs alone are not deduplication.
    """
    now = now or utcnow()
    row = (await session.execute(select(OutboxMessage).where(
        OutboxMessage.id == message_id, OutboxMessage.topic == TOPIC,
    ).with_for_update(skip_locked=True))).scalar_one_or_none()
    if row is None or row.state in {"delivered", "suppressed", "dead_letter"}:
        await session.rollback()
        return False
    if row.state != "pending" and not (reconcile and consumer_fence_verified):
        await session.rollback()
        return False
    due = row.next_attempt_at
    if due is not None and due.replace(tzinfo=timezone.utc) > now:
        await session.rollback()
        return False
    job = (await session.execute(select(Job).where(Job.id == row.job_id))).scalar_one_or_none()
    if job is None or job.status not in JobStatus.active():
        row.state = "suppressed"
        row.last_error_type = "MissingOrTerminalJob"
        await session.commit()
        return False
    try:
        require_equity_analysis(job.auto_rebalance_portfolio, job.request_context_json)
    except Exception:
        row.state = "dead_letter"
        row.last_error_type = "RecoveryPolicyBlocked"
        await session.commit()
        raise
    if row.attempts >= MAX_ATTEMPTS:
        row.state = "dead_letter"
        row.last_error_type = "AttemptLimit"
        await session.commit()
        return False
    token = str(uuid4())
    row.claim_token = token
    row.state = "uncertain"
    row.attempts += 1
    row.next_attempt_at = now + timedelta(seconds=min(300, 15 * 2 ** (row.attempts - 1)))
    job_id, task_id = row.job_id, str(row.id)
    eta = datetime.fromisoformat(row.payload["eta"]) if row.payload.get("eta") else None
    await session.commit()  # No broker call unless uncertainty is durable.
    error = None
    try:
        publisher(job_id, task_id, eta)
    except Exception as exc:
        error = exc
    row = (await session.execute(select(OutboxMessage).where(
        OutboxMessage.id == message_id,
    ).with_for_update())).scalar_one()
    if row.claim_token == token:
        row.state = "uncertain" if error else "delivered"
        row.published_at = None if error else now.replace(tzinfo=None)
        row.last_error_type = type(error).__name__ if error else None
        await session.commit()
    else:
        await session.rollback()
    if error:
        raise error
    # The DB obligation remains authoritative if optional Redis registration fails.
    try:
        from app.infrastructure.messaging.task_registry import register_job_task
        await register_job_task(job_id, task_id)
    except Exception:
        import logging
        logging.getLogger(__name__).warning("Optional task registration unavailable for job %s", job_id)
    return True


async def relay_pass(session, publisher=celery_publisher, *, enabled=False,
                     consumer_fence_verified=False, limit=20, now=None):
    """Explicit bounded integration seam; deliberately not registered with Beat.

    Caller must obtain exact-release activation approval and consumer fencing
    review. This function never scans legacy topics or manufactures obligations.
    """
    if not enabled or not consumer_fence_verified:
        return {"blocked": True}
    now = now or utcnow()
    ids = list((await session.execute(select(OutboxMessage.id).where(
        OutboxMessage.topic == TOPIC,
        OutboxMessage.state.in_(["pending", "uncertain"]),
        or_(OutboxMessage.next_attempt_at.is_(None),
            OutboxMessage.next_attempt_at <= now),
    ).order_by(OutboxMessage.created_at, OutboxMessage.id).limit(max(1, min(limit, 100))))).scalars())
    await session.rollback()
    result = {"delivered": 0, "uncertain": 0}
    for message_id in ids:
        try:
            result["delivered"] += bool(await dispatch_one(
                session, message_id, publisher, reconcile=True,
                consumer_fence_verified=True, now=now,
            ))
        except Exception:
            await session.rollback()
            result["uncertain"] += 1
    return result
