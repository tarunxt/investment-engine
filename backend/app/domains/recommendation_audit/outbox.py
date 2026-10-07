"""Durable verification delivery/recovery inside the existing worker lifecycle.

No Beat entry, scheduled task, financial job or paid-I/O retry is introduced.
The enabled consumer runs a bounded relay service; CAS and worker leases allow
at-least-once delivery without two workers publishing a verification result.
"""
from datetime import timedelta
import logging
from threading import Event, Thread

from celery import bootsteps
from sqlalchemy import and_, or_, select, update, create_engine
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import NullPool

from app.core.recovery import recovery_mode
from .models import VerificationRecord, utcnow

logger=logging.getLogger(__name__)
RETRY_SECONDS=15
UNCLAIMED_SECONDS=180
MAX_BATCH=20


def relay_database(database_url):
    """Own an unpooled parent-only engine; never populate the task engine pool.

    Replacement/prefork children do not use this engine. NullPool closes every
    returned connection instead of leaving parent sockets available to children.
    PostgreSQL connects and statements are bounded independently of broker I/O.
    """
    url=make_url(database_url.replace("postgresql+asyncpg://","postgresql://",1))
    args={"connect_timeout":3,"options":"-c statement_timeout=3000 -c lock_timeout=1000"} if url.get_backend_name()=="postgresql" else {}
    engine=create_engine(url,poolclass=NullPool,connect_args=args)
    return engine,sessionmaker(bind=engine,autoflush=False,expire_on_commit=False)


def due(now):
    retryable=or_(VerificationRecord.last_dispatch_at.is_(None),VerificationRecord.last_dispatch_at < now-timedelta(seconds=RETRY_SECONDS))
    unpublished=and_(VerificationRecord.status=="queued",VerificationRecord.dispatch_pending.is_(True),retryable)
    unclaimed=and_(VerificationRecord.status=="queued",VerificationRecord.dispatch_pending.is_(False),VerificationRecord.last_dispatch_at < now-timedelta(seconds=UNCLAIMED_SECONDS))
    expired=and_(VerificationRecord.status=="processing",VerificationRecord.lease_until < now,retryable)
    return or_(unpublished,unclaimed,expired)


def dispatch_due(session, publisher, *, limit=MAX_BATCH, now=None, should_stop=lambda:False):
    """Commit delivery claims before broker I/O; ambiguous publishes stay pending."""
    if recovery_mode() or should_stop(): return {"claimed":0,"published":0,"failed":0,"blocked":True}
    now=now or utcnow()
    ids=list(session.scalars(select(VerificationRecord.id).where(due(now)).order_by(VerificationRecord.created_at,VerificationRecord.id).limit(max(1,min(limit,MAX_BATCH)))))
    counts={"claimed":0,"published":0,"failed":0,"blocked":False}
    for record_id in ids:
        if recovery_mode() or should_stop(): counts["blocked"]=True;break
        changed=session.execute(update(VerificationRecord).where(VerificationRecord.id==record_id,due(now)).values(last_dispatch_at=now,dispatch_pending=True).execution_options(synchronize_session=False))
        session.commit()
        if changed.rowcount!=1: continue
        counts["claimed"]+=1
        try:
            if recovery_mode() or should_stop(): raise RuntimeError("Relay shutdown or containment blocks dispatch")
            publisher(record_id)
            # A late publisher cannot erase a later dispatch claim or cancellation.
            session.execute(update(VerificationRecord).where(VerificationRecord.id==record_id,VerificationRecord.last_dispatch_at==now,VerificationRecord.status.in_(["queued","processing"])).values(dispatch_pending=False).execution_options(synchronize_session=False))
            session.commit();counts["published"]+=1
        except Exception:
            session.rollback();counts["failed"]+=1
            logger.exception("Audit outbox retains verification %s after delivery failure",record_id)
    return counts


def publish_verification(record_id):
    from .tasks import verify_reversal
    app=verify_reversal.app
    # Bound only this publisher's connection, leaving other workflows untouched.
    options={**app.conf.broker_transport_options,"socket_connect_timeout":3,"socket_timeout":3,"retry_on_timeout":False}
    with app.connection_for_write(connect_timeout=3,transport_options=options) as connection:
        verify_reversal.apply_async(args=[record_id],connection=connection,retry=False)


def relay_pass(session_factory, publisher, settings, *, should_stop=lambda:False):
    blocked=lambda:should_stop() or not settings.recommendation_audit_enabled
    if blocked() or recovery_mode(): return {"blocked":True}
    with session_factory() as session: return dispatch_due(session,publisher,should_stop=blocked)


class RelayService:
    def __init__(self, session_factory, publisher, settings):
        self.session_factory,self.publisher,self.settings=session_factory,publisher,settings
        self.stopped=Event();self.thread=None

    def start(self):
        if not self.settings.recommendation_audit_enabled or recovery_mode(): return
        stopped=self.stopped
        def run():
            while not stopped.is_set():
                try: relay_pass(self.session_factory,self.publisher,self.settings,should_stop=stopped.is_set)
                except Exception: logger.exception("Audit outbox recovery pass failed; committed rows retained")
                stopped.wait(RETRY_SECONDS)
        self.thread=Thread(target=run,name="recommendation-audit-outbox",daemon=True)
        self.thread.start()

    def stop(self):
        self.stopped.set()
        if self.thread: self.thread.join(timeout=1)


class AuditOutboxRelay(bootsteps.StartStopStep):
    """An advisory-only consumer service; flags/recovery are checked every pass."""
    requires=("celery.worker.consumer.connection:Connection",)

    def start(self, consumer):
        from app.core.config import settings
        if not settings.recommendation_audit_enabled or recovery_mode(): return
        self.engine,factory=relay_database(settings.database_url)
        self.service=RelayService(factory,publish_verification,settings)
        self.service.start()

    def stop(self, consumer):
        if hasattr(self,"service"): self.service.stop()
        if hasattr(self,"engine"): self.engine.dispose()
    shutdown=stop
