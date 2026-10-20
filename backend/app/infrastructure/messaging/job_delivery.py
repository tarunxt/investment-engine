"""PostgreSQL consumer exclusion, durable backoff and bounded execution attempts.

A dedicated transaction owns the lock across ordinary task status commits.
External provider effects after an ambiguous crash are not exactly-once.
"""
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import datetime, timedelta
from functools import wraps
from uuid import UUID
from sqlalchemy import func, select, update

from app.core.recovery import recovery_mode, require_equity_analysis
from app.domains.jobs.models import Job
from app.infrastructure.database.outbox.models import OutboxMessage
from app.shared.types import JobStatus

CRASH_RETRY_SECONDS = 180


@dataclass(frozen=True)
class Delivery:
    factory: object
    message_id: UUID
    job_id: int
    attempt: int


_delivery: ContextVar[Delivery | None] = ContextVar('durable_job_delivery', default=None)


def defer_retry(countdown: int) -> bool:
    """Use only the outbox for a durable retry; legacy producers keep Celery retry."""
    current = _delivery.get()
    if current is None:
        return False
    with current.factory() as session:
        changed = session.execute(update(Job).where(Job.id == current.job_id,
            Job.status.in_(JobStatus.active())).values(status=JobStatus.PENDING))
        if changed.rowcount:
            session.execute(update(OutboxMessage).where(OutboxMessage.id == current.message_id)
                .values(available_at=datetime.utcnow() + timedelta(seconds=max(1, countdown))))
        session.commit()
    return True


@contextmanager
def job_delivery_guard(factory, job_id: int, dispatch_id: str, *, now=None, max_attempts=4):
    try: message_id = UUID(dispatch_id)
    except (ValueError, TypeError, AttributeError):
        yield False
        return
    now = now or datetime.utcnow()
    with factory() as session:
        engine = session.get_bind()
    if engine.dialect.name != 'postgresql':
        raise RuntimeError('Durable job delivery requires PostgreSQL')
    with engine.connect() as connection, connection.begin():
        locked = connection.scalar(select(func.pg_try_advisory_xact_lock(1128943426, int(job_id))))
        if not locked:
            yield False
            return
        row = connection.execute(select(Job.status, Job.auto_rebalance_portfolio,
            Job.request_context_json, Job.scheduled_at, OutboxMessage.available_at, OutboxMessage.execution_attempts)
            .select_from(Job).join(OutboxMessage, OutboxMessage.payload['job_id'].as_integer() == Job.id)
            .where(Job.id == job_id, OutboxMessage.id == message_id,
                   OutboxMessage.topic == 'job.created.v2',
                   OutboxMessage.payload['user_id'].as_integer() == Job.user_id)).first()
        if (row is None or row.status in JobStatus.terminal()
                or row.scheduled_at and row.scheduled_at > now
                or row.available_at and row.available_at > now):
            yield False
            return
        if recovery_mode():
            require_equity_analysis(row.auto_rebalance_portfolio, row.request_context_json)
        if row.execution_attempts >= max_attempts:
            from app.domains.jobs.tasks import _mark_failed
            from app.domains.jobs.repository import SyncJobRepository
            with factory() as session:
                _mark_failed(session, SyncJobRepository(session), job_id,
                             'Durable delivery retry limit reached after interrupted execution')
            yield False
            return
        with factory() as session:
            session.execute(update(OutboxMessage).where(OutboxMessage.id == message_id)
                .values(execution_attempts=OutboxMessage.execution_attempts + 1,
                        available_at=now + timedelta(seconds=CRASH_RETRY_SECONDS)))
            session.commit()
        token = _delivery.set(Delivery(factory, message_id, job_id, row.execution_attempts))
        try:
            yield True
        finally:
            _delivery.reset(token)


def guarded_job_delivery(function):
    @wraps(function)
    def invoke(self, job_id, *, dispatch_id=None):
        if dispatch_id is None:
            return function(self, job_id)  # Existing run/operator producers.
        from app.domains.jobs.tasks import SyncSessionLocal
        with job_delivery_guard(SyncSessionLocal, job_id, dispatch_id,
                                max_attempts=self.max_retries + 1) as allowed:
            if allowed:
                original = self.request.retries
                self.request.retries = _delivery.get().attempt
                try:
                    return function(self, job_id)
                finally:
                    self.request.retries = original
    return invoke
