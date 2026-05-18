import json
from time import monotonic

from celery.exceptions import MaxRetriesExceededError
import redis as _sync_redis

from app.infrastructure.messaging.celery_app import celery
from app.infrastructure.database.sync_session import SyncSessionLocal
import app.infrastructure.database.all_models  # noqa: F401 — registers all ORM models with the mapper
from app.core.config import settings
from app.core.logging import WorkerLogHelper, get_logger
from app.domains.jobs.repository import SyncJobRepository
from app.domains.jobs.models import Job
from app.shared.types import JobStatus

logger = get_logger("app.domains.jobs.tasks")


def _publish_job_update(job: Job) -> None:
    """Publish job status change to Redis pub/sub for WebSocket relay. Fire-and-forget."""
    r: _sync_redis.Redis | None = None
    try:
        status_val = job.status.value if hasattr(job.status, "value") else str(job.status)
        payload = json.dumps({
            "type": "job.updated",
            "job_id": job.id,
            "status": status_val,
            "response": job.response,
            "error_message": job.error_message,
            "tokens_in": job.tokens_in,
            "tokens_out": job.tokens_out,
            "estimated_cost": job.estimated_cost,
        })
        
        redis_url = settings.redis_url
        logger.info("Publishing WS update for job_id=%s to Redis at %s", job.id, redis_url)
        
        r = _sync_redis.from_url(redis_url, decode_responses=True)
        
        # Publish to job-specific channel
        job_channel = f"job_updates:{job.id}"
        job_receivers = r.publish(job_channel, payload)
        logger.info("Published to %s: %s receiver(s)", job_channel, job_receivers)
        
        # Publish to user channel if user_id exists
        if job.user_id:
            user_channel = f"user_job_updates:{job.user_id}"
            user_receivers = r.publish(user_channel, payload)
            logger.info("Published to %s: %s receiver(s)", user_channel, user_receivers)
        else:
            logger.warning("job.user_id is None, skipping user_job_updates publish for job_id=%s", job.id)
            
    except Exception as e:
        logger.exception("Failed to publish WS update for job_id=%s: %s", job.id, e)
    finally:
        if r is not None:
            try:
                r.close()
            except Exception:
                pass

# ── Error classification ──────────────────────────────────────────────────────

def _classify_exc(exc: Exception, attempt: int = 0) -> tuple[bool, int]:
    """Return (retryable, countdown_seconds).

    Rate-limit errors use exponential backoff (60 / 120 / 240 s).
    Terminal client errors (bad request, auth) are not retried.
    Everything else retries after 30 s.
    """

    if attempt >= 3:
        return False, 0  # don't retry after max attempts

    try:
        from google.genai.errors import ClientError as GeminiClientError
        if isinstance(exc, GeminiClientError):
            code = getattr(exc, "status_code", None)
            if code == 429:
                return True, 60 * (2 ** attempt)   # 60 → 120 → 240 s
            if code in (400, 401, 403):
                return False, 0                     # bad request / auth — terminal
            return True, 30
    except ImportError:
        pass

    try:
        from openai import RateLimitError as OpenAIRateLimit, BadRequestError as OpenAIBadRequest
        if isinstance(exc, OpenAIRateLimit):
            return True, 60 * (2 ** attempt)
        if isinstance(exc, OpenAIBadRequest):
            return False, 0
    except ImportError:
        pass

    return True, 30  # default: retryable


def _redis_publish(channel: str, payload: dict) -> None:
    """Publish a single message to a Redis pub/sub channel. Fire-and-forget."""
    r: _sync_redis.Redis | None = None
    try:
        r = _sync_redis.from_url(settings.redis_url, decode_responses=True)
        r.publish(channel, json.dumps(payload))
    except Exception:
        logger.exception("Failed to publish to channel %s", channel)
    finally:
        if r is not None:
            try:
                r.close()
            except Exception:
                pass


def _publish_run_update(run_id: int, user_id: int | None, status: JobStatus, current_stage: int) -> None:
    """Broadcast a run status change to the user-level and per-run Redis channels."""
    status_val = status.value if hasattr(status, "value") else str(status)
    payload = {
        "type": "run.updated",
        "run_id": run_id,
        "status": status_val,
        "current_stage": current_stage,
    }
    # Per-run channel — consumed by the run detail page
    _redis_publish(f"run_updates:{run_id}", payload)
    # User-level channel — consumed by the dashboard list
    if user_id:
        _redis_publish(f"user_run_updates:{user_id}", payload)


def _refresh_run_status(db, job_id: int) -> None:
    """Recalculate and persist Run.status when a child job reaches a terminal state."""
    try:
        from sqlalchemy import select as sa_select
        from app.domains.runs.models import RunJob
        from app.domains.runs.repository import SyncRunRepository

        run_repo = SyncRunRepository(db)

        rj_rows = db.execute(
            sa_select(RunJob).where(RunJob.job_id == job_id)
        ).scalars().all()

        for rj in rj_rows:
            run = run_repo.get(rj.run_id)
            if not run:
                continue

            pairs = run_repo.get_stage_run_jobs(rj.run_id, rj.stage)
            if not pairs:
                continue

            stage_jobs = [job for _, job in pairs]

            # Push the triggering job's full data to the per-run channel so the
            # detail page can update response text, tokens, and cost in real-time.
            updated_job = next((j for j in stage_jobs if j.id == job_id), None)
            if updated_job is not None:
                status_val = (
                    updated_job.status.value
                    if hasattr(updated_job.status, "value")
                    else str(updated_job.status)
                )
                _redis_publish(f"run_updates:{rj.run_id}", {
                    "type": "job.updated",
                    "run_id": rj.run_id,
                    "job_id": updated_job.id,
                    "status": status_val,
                    "response": updated_job.response,
                    "error_message": updated_job.error_message,
                    "tokens_in": updated_job.tokens_in,
                    "tokens_out": updated_job.tokens_out,
                    "estimated_cost": updated_job.estimated_cost,
                })

            statuses = {j.status for j in stage_jobs}
            active = {JobStatus.PENDING, JobStatus.PROCESSING, JobStatus.SCHEDULED}

            if statuses & active:
                # At least one child job is still running
                new_status = JobStatus.PROCESSING
            elif any(j.status == JobStatus.COMPLETED for j in stage_jobs):
                # All terminal, at least one succeeded
                new_status = JobStatus.COMPLETED
            else:
                # All terminal, all failed
                new_status = JobStatus.FAILED

            if run.status != new_status:
                # Snapshot before commit expires the ORM object
                run_id = run.id
                user_id = run.user_id
                current_stage = run.current_stage
                run_repo.update_status(run, new_status)
                _publish_run_update(run_id, user_id, new_status, current_stage)
                logger.info("Run %s status → %s", run_id, new_status.value)
    except Exception:
        logger.exception("Failed to refresh run status for job %s", job_id)


def _mark_failed(db, repo, job_id: int, error: str) -> None:
    try:
        db.rollback()
        job = repo.get(job_id)
        if job:
            repo.update_status(job, JobStatus.FAILED, error_message=error)
            _publish_job_update(job)
            _refresh_run_status(db, job_id)
    except Exception:
        logger.exception("Could not mark job %s as failed", job_id)


# ── Task ─────────────────────────────────────────────────────────────────────

@celery.task(
    name="app.domains.jobs.tasks.execute_ai_job",
    bind=True,
    max_retries=3,
    default_retry_delay=30,
    queue="ai",
)
def execute_ai_job(self, job_id: int) -> None:
    from app.domains.ai_providers.factory import ProviderFactory

    db = SyncSessionLocal()
    repo = SyncJobRepository(db)
    started_at = monotonic()

    try:
        job = repo.get(job_id)
        if not job:
            logger.warning("Job %s not found", job_id)
            return

        WorkerLogHelper.log_task_start("execute_ai_job", "n/a", job_id)
        repo.update_status(job, JobStatus.PROCESSING)
        _publish_job_update(job)

        provider = ProviderFactory.create(job.provider)
        result = provider.generate(prompt=job.prompt, model=job.model)

        repo.update_status(
            job,
            JobStatus.COMPLETED,
            response=result.content,
            tokens_in=result.tokens_in,
            tokens_out=result.tokens_out,
            estimated_cost=result.cost,
        )
        _publish_job_update(job)
        _refresh_run_status(db, job_id)
        WorkerLogHelper.log_task_complete(
            "execute_ai_job", "n/a", (monotonic() - started_at) * 1000, job_id
        )

    except MaxRetriesExceededError:
        _mark_failed(db, repo, job_id, "Max retries exceeded")
        logger.error("Job %s exhausted all retries", job_id)

    except Exception as exc:
        error_summary = str(exc).split('\n')[0][:200]
        WorkerLogHelper.log_task_error("execute_ai_job", "n/a", error_summary, job_id)

        retryable, countdown = _classify_exc(exc, attempt=self.request.retries)
        logger.info("Error classified as retryable=%s with countdown=%s seconds", retryable, countdown)
        if not retryable:
            _mark_failed(db, repo, job_id, str(exc))
            return

        try:
            raise self.retry(exc=exc, countdown=countdown, max_retries=self.max_retries)
        except MaxRetriesExceededError:
            _mark_failed(db, repo, job_id, str(exc))
            logger.error("Job %s exhausted all retries after: %s", job_id, exc)

    finally:
        db.close()
