"""Synthetic-only fake consumer around the actual outbox relay and Job rows.

SQLite preview execution is deliberately not PostgreSQL consumer verification.
The real distributed guard is exercised only in the disposable PostgreSQL gate.
"""
import os
from datetime import datetime
from pathlib import Path

if os.environ.get('STAGE01_PREVIEW') != 'synthetic-only':
    raise RuntimeError('Synthetic preview only')

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from app.domains.ai_providers.factory import ProviderFactory
from app.domains.jobs.models import Job
from app.infrastructure.database.outbox.job_dispatch import dispatch_due
from app.infrastructure.database.outbox.models import OutboxMessage
from app.shared.types import JobStatus

ROOT=Path(__file__).resolve().parents[2]
DB=ROOT/'.runtime/stage01-preview/preview.sqlite3'
ProviderFactory.supports=classmethod(lambda cls,provider:provider=='synthetic')
ProviderFactory.is_configured=classmethod(lambda cls,provider:provider=='synthetic')
engine=create_engine(f'sqlite:///{DB}',connect_args={'timeout':5})
factory=sessionmaker(bind=engine,expire_on_commit=False)


def publish_fake_in_session(session,job_id,dispatch_id):
    from uuid import UUID
    from app.domains.modules.lifecycle import WorkIdentity,current_sync
    job=session.get(Job,job_id,populate_existing=True)
    if job is None or job.status in JobStatus.terminal():return
    if job.provider!='synthetic' or job.model!='offline':
        raise RuntimeError('Only synthetic/offline preview execution permitted')
    current_sync(session,WorkIdentity(job.user_id,job.module_id,job.module_version))
    job.status=JobStatus.PROCESSING
    job.runtime_metadata_json={'synthetic_phase':'running','fake_started_at':datetime.utcnow().isoformat()}
    message=session.get(OutboxMessage,UUID(dispatch_id));message.execution_attempts=1;message.available_at=None
    session.flush()


def tick():
    from sqlalchemy import select
    from app.domains.modules.lifecycle import WorkIdentity,current_sync,ModuleLifecycleDenied
    with factory() as session:
        for job in session.scalars(select(Job).where(Job.status==JobStatus.PROCESSING,Job.provider=='synthetic')):
            try:
                if job.module_cancel_requested:raise ModuleLifecycleDenied('Cancellation requested')
                current_sync(session,WorkIdentity(job.user_id,job.module_id,job.module_version))
            except ModuleLifecycleDenied:
                job.status=JobStatus.FAILED;job.module_cancel_requested=True;job.error_message='Cancelled: module disabled';continue
            started=(job.runtime_metadata_json or {}).get('fake_started_at')
            if started and (datetime.utcnow()-datetime.fromisoformat(started)).total_seconds()>=5:
                job.status=JobStatus.COMPLETED
                job.response='SYNTHETIC OFFLINE Stage07 result; no provider was contacted.'
                job.tokens_in=job.tokens_out=0;job.estimated_cost=0
        session.commit()
        # SQLite has no distributed row locks. Keep the fake publisher in this
        # same session; the separate PostgreSQL gate proves actual contention.
        return dispatch_due(session,lambda id,message:publish_fake_in_session(session,id,message))


# Trusted facts exist only in this tightly guarded no-egress local harness.
# Production imports never load this file; all other modules retain unknown facts.
from app.domains.modules.policy import DefaultFactsResolver,ModuleFacts
from app.domains.modules.registry import ModuleId
from app.domains.auth.models import User
_original_facts=DefaultFactsResolver.resolve_sync

def synthetic_facts(self,owner,module):
    from sqlalchemy import select
    with factory() as session:email=session.scalar(select(User.email).where(User.id==owner))
    if module in {ModuleId.AI_STUDIO,ModuleId.ZERODHA_REBALANCE,ModuleId.INDMONEY_US,ModuleId.SHEETS_EXPORT} and email in {name+'@stage01.example.com' for name in ('usera','userb','admin')}:
        return ModuleFacts(jurisdiction='allowed',plan='allowed',connection='ready',execution_capability=True)
    return _original_facts(self,owner,module)
DefaultFactsResolver.resolve_sync=synthetic_facts
