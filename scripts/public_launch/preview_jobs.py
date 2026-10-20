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


def publish_fake(job_id, dispatch_id):
    from uuid import UUID
    with factory() as session:
        job=session.get(Job,job_id)
        if job is None or job.status in JobStatus.terminal():return
        if job.provider!='synthetic' or job.model!='offline':
            raise RuntimeError('Only synthetic/offline preview execution permitted')
        job.status=JobStatus.COMPLETED
        job.response=f'SYNTHETIC OFFLINE Stage04 result for owned job {job_id}; no provider was contacted.'
        job.tokens_in=job.tokens_out=0
        job.estimated_cost=0
        message=session.get(OutboxMessage,UUID(dispatch_id))
        message.execution_attempts=1
        message.available_at=None
        session.commit()


def tick():
    with factory() as session:return dispatch_due(session,publish_fake)
