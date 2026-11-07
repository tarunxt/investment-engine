"""Cancellation checks must observe writes made outside the worker session."""

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.domains.jobs.models import Job
from app.domains.jobs.repository import SyncJobRepository
from app.domains.jobs.tasks import _job_was_cancelled
from app.shared.types import JobStatus


def test_cancellation_refreshes_cached_worker_job_from_another_session():
    engine = create_engine("sqlite:///:memory:")
    Job.__table__.create(engine)
    try:
        with Session(engine) as worker, Session(engine) as caller:
            job = Job(
                prompt="Offline cancellation fixture",
                provider="test",
                model="test",
                status=JobStatus.PROCESSING,
            )
            worker.add(job)
            worker.commit()
            job_id = job.id
            assert job.status == JobStatus.PROCESSING

            cancelled = caller.get(Job, job_id)
            cancelled.status = JobStatus.FAILED
            cancelled.error_message = "Cancelled by user"
            caller.commit()

            # Session.get alone returns this stale identity-map entry.
            assert worker.get(Job, job_id).status == JobStatus.PROCESSING
            assert _job_was_cancelled(SyncJobRepository(worker), job_id)
            assert job.status == JobStatus.FAILED
            assert job.error_message == "Cancelled by user"
    finally:
        engine.dispose()


def test_stale_same_status_completion_cannot_replace_historical_output():
    engine = create_engine("sqlite:///:memory:")
    Job.__table__.create(engine)
    try:
        with Session(engine, expire_on_commit=False) as worker:
            job = Job(prompt="Synthetic frozen output", provider="test", model="test",
                      status=JobStatus.COMPLETED, response="original completed output",
                      tokens_in=7, runtime_metadata_json={"evidence": "original"})
            worker.add(job)
            worker.commit()
            SyncJobRepository(worker).update_status(
                job, JobStatus.COMPLETED, response="stale replacement", tokens_in=99,
                runtime_metadata_json={"evidence": "stale"},
            )
            worker.refresh(job)
            assert job.status == JobStatus.COMPLETED
            assert job.response == "original completed output" and job.tokens_in == 7
            assert job.runtime_metadata_json == {"evidence": "original"}
    finally:
        engine.dispose()
