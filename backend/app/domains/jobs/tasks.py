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

    return False, 0  # TEMP: disable retries while debugging

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


def _mark_failed(db, repo, job_id: int, error: str) -> None:
    try:
        db.rollback()
        job = repo.get(job_id)
        if job:
            repo.update_status(job, JobStatus.FAILED, error_message=error)
            _publish_job_update(job)
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
        WorkerLogHelper.log_task_complete(
            "execute_ai_job", "n/a", (monotonic() - started_at) * 1000, job_id
        )

    except MaxRetriesExceededError:
        _mark_failed(db, repo, job_id, "Max retries exceeded")
        logger.error("Job %s exhausted all retries", job_id)

    except Exception as exc:
        error_summary = str(exc).split('\n')[0][:200]
        WorkerLogHelper.log_task_error("execute_ai_job", "n/a", error_summary, job_id)

        retryable, countdown = _classify_exc(exc)
        logger.info("Error classified as retryable=%s with countdown=%s seconds", retryable, countdown)
        if not retryable:
            _mark_failed(db, repo, job_id, str(exc))
            return

        try:
            raise self.retry(exc=exc, countdown=countdown)
        except MaxRetriesExceededError:
            _mark_failed(db, repo, job_id, str(exc))
            logger.error("Job %s exhausted all retries after: %s", job_id, exc)

    finally:
        db.close()
