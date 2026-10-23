"""Controlled cancel/completion interleavings using synthetic SQL and real routes."""
import pytest
from sqlalchemy.orm import Session
from test_stage07_lifecycle import eligible, owned_job
from test_stage06_modules import modules, private_api
from app.domains.jobs.models import Job
from app.domains.jobs.repository import SyncJobRepository
from app.domains.jobs.tasks import _job_was_cancelled
from app.domains.runs.models import Run, RunJob
from app.domains.runs.repository import SyncRunRepository
from app.domains.modules.lifecycle import ModuleLifecycleDenied
from app.shared.types import JobStatus

@pytest.mark.parametrize('route', ['job', 'run'])
@pytest.mark.parametrize('late_status', [JobStatus.COMPLETED, JobStatus.PARTIAL, JobStatus.FAILED])
def test_cancel_between_checkpoint_and_completion_remains_cancelled(eligible, route, late_status):
    a=eligible
    job=owned_job(a,JobStatus.PROCESSING)
    run=Run(user_id=job.user_id,prompt='synthetic',prompt_preview='synthetic',status=JobStatus.PROCESSING,
        module_id='ai_studio',module_version=1,auto_export_enabled=False)
    a.session.add(run);a.session.flush()
    a.session.add(RunJob(run_id=run.id,job_id=job.id));a.session.commit()
    with Session(a.session.get_bind(),expire_on_commit=False) as worker:
        repo=SyncJobRepository(worker);stale=repo.get_for_worker(job.id)
        assert not _job_was_cancelled(repo,job.id)
        response=a.client.post(f'/jobs/{job.id}/cancel' if route=='job' else f'/runs/{run.id}/cancel',headers=a.headers[0])
        assert response.status_code==200,response.text
        with pytest.raises(ModuleLifecycleDenied,match='cancellation'):
            repo.update_status(stale,late_status,response='late result',error_message='late failure')
        worker.rollback()
    a.session.expire_all();saved=a.session.get(Job,job.id)
    assert saved.status==JobStatus.FAILED and saved.error_message=='Cancelled by user'
    assert saved.response is None and saved.module_cancel_requested


def test_cancelled_run_cannot_be_recompleted_by_finished_child(eligible):
    a=eligible
    run=Run(user_id=a.users[0].id,prompt='synthetic',prompt_preview='synthetic',status=JobStatus.PROCESSING,
        module_id='ai_studio',module_version=1,auto_export_enabled=False)
    a.session.add(run);a.session.commit()
    with Session(a.session.get_bind(),expire_on_commit=False) as worker:
        repo=SyncRunRepository(worker);stale=repo.get(run.id)
        assert a.client.post(f'/runs/{run.id}/cancel',headers=a.headers[0]).status_code==200
        with pytest.raises(ModuleLifecycleDenied,match='cancellation'):
            repo.update_status(stale,JobStatus.COMPLETED)
        worker.rollback()
    a.session.expire_all();assert a.session.get(Run,run.id).status==JobStatus.FAILED


def test_completion_before_cancel_preserves_verified_outcome(eligible):
    a=eligible;job=owned_job(a,JobStatus.PROCESSING)
    with Session(a.session.get_bind(),expire_on_commit=False) as worker:
        repo=SyncJobRepository(worker)
        repo.update_status(repo.get_for_worker(job.id),JobStatus.COMPLETED,response='finished first')
    response=a.client.post(f'/jobs/{job.id}/cancel',headers=a.headers[0])
    assert response.status_code==200 and response.json()['status']=='completed'
    a.session.expire_all();saved=a.session.get(Job,job.id)
    assert saved.response=='finished first' and not saved.module_cancel_requested


def test_foreign_cancel_does_not_set_durable_flag(eligible):
    a=eligible;job=owned_job(a,JobStatus.PROCESSING)
    assert a.client.post(f'/jobs/{job.id}/cancel',headers=a.headers[1]).status_code==404
    a.session.expire_all();assert not a.session.get(Job,job.id).module_cancel_requested


def test_module_disable_still_allows_active_worker_failure_cleanup(eligible):
    a=eligible;job=owned_job(a,JobStatus.PROCESSING)
    job.module_cancel_requested=True;a.session.commit()
    with Session(a.session.get_bind(),expire_on_commit=False) as worker:
        repo=SyncJobRepository(worker)
        repo.update_status(repo.get_for_worker(job.id),JobStatus.FAILED,error_message='Module cancellation requested')
    a.session.expire_all();saved=a.session.get(Job,job.id)
    assert saved.status==JobStatus.FAILED and saved.module_cancel_requested
    assert saved.error_message=='Module cancellation requested'
