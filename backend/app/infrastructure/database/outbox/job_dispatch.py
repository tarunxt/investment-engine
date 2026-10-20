"""One at-least-once dispatch contract for durable job creation.

Only versioned bound rows are eligible. Legacy outbox rows remain untouched.
An uncertain broker publish is retried; consumers arbitrate with PostgreSQL.
"""
from datetime import datetime, timedelta
import logging
from threading import Event, Thread

from celery import bootsteps
from sqlalchemy import create_engine, or_, select, update
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import NullPool

from app.core.recovery import recovery_mode, require_equity_analysis, RecoveryBlocked
from app.domains.jobs.models import Job
from app.infrastructure.database.outbox.models import OutboxMessage
from app.shared.types import JobStatus

TOPIC = 'job.created.v2'
RETRY_SECONDS = 30
POLL_SECONDS = 5
MAX_BATCH = 10
logger = logging.getLogger(__name__)


def dispatch_due(session, publisher, *, now=None, limit=MAX_BATCH, should_stop=lambda: False):
    now = now or datetime.utcnow()
    due = or_(OutboxMessage.published_at.is_(None), OutboxMessage.published_at <= now - timedelta(seconds=RETRY_SECONDS))
    joined = (OutboxMessage.payload['job_id'].as_integer() == Job.id) & (OutboxMessage.payload['user_id'].as_integer() == Job.user_id)
    rows = list(session.execute(select(OutboxMessage, Job).join(Job, joined).where(
        OutboxMessage.topic == TOPIC, due, Job.status.in_(JobStatus.active()),
        or_(OutboxMessage.available_at.is_(None), OutboxMessage.available_at <= now),
        or_(Job.scheduled_at.is_(None), Job.scheduled_at <= now),
    ).order_by(OutboxMessage.created_at, OutboxMessage.id).limit(max(1, min(limit, MAX_BATCH)))))
    counts = {'claimed': 0, 'published': 0, 'failed': 0}
    for message, job in rows:
        if should_stop(): break
        if recovery_mode():
            try: require_equity_analysis(job.auto_rebalance_portfolio, job.request_context_json)
            except RecoveryBlocked: continue
        changed = session.execute(update(OutboxMessage).where(
            OutboxMessage.id == message.id, OutboxMessage.topic == TOPIC, due,
        ).values(published_at=now, attempts=OutboxMessage.attempts + 1).execution_options(synchronize_session=False))
        session.commit()  # Durable claim before ambiguous network I/O.
        if changed.rowcount != 1: continue
        counts['claimed'] += 1
        try:
            if should_stop(): break
            publisher(job.id, str(message.id))
            counts['published'] += 1
        except Exception:
            # No prompt, key, broker URL or exception text is needed here.
            logger.warning('Durable job %s dispatch deferred', job.id)
            counts['failed'] += 1
    return counts


def publish_job(job_id, dispatch_id):
    from app.domains.jobs.tasks import execute_ai_job
    app = execute_ai_job.app
    options = {**app.conf.broker_transport_options, 'socket_connect_timeout': 3,
               'socket_timeout': 3, 'retry_on_timeout': False}
    with app.connection_for_write(connect_timeout=3, transport_options=options) as connection:
        execute_ai_job.apply_async(args=[job_id], kwargs={'dispatch_id': dispatch_id},
                                  connection=connection, retry=False)


class JobOutboxRelay(bootsteps.StartStopStep):
    """Bounded consumer-parent relay; no Beat/global financial queue change."""
    requires = ('celery.worker.consumer.connection:Connection',)

    def start(self, consumer):
        from app.core.config import settings
        url = settings.database_url.replace('postgresql+asyncpg://', 'postgresql://', 1)
        self.engine = create_engine(url, poolclass=NullPool,
            connect_args={'connect_timeout': 3, 'options': '-c statement_timeout=3000 -c lock_timeout=1000'})
        factory = sessionmaker(bind=self.engine, expire_on_commit=False)
        self.stopped = Event()
        def run():
            while not self.stopped.is_set():
                try:
                    with factory() as session:
                        dispatch_due(session, publish_job, should_stop=self.stopped.is_set)
                except Exception:
                    logger.warning('Durable job relay pass deferred')
                self.stopped.wait(POLL_SECONDS)
        self.thread = Thread(target=run, name='job-outbox-relay', daemon=True)
        self.thread.start()

    def stop(self, consumer):
        if hasattr(self, 'stopped'): self.stopped.set()
        if hasattr(self, 'thread'): self.thread.join(timeout=1)
        if hasattr(self, 'engine'): self.engine.dispose()
    shutdown = stop
