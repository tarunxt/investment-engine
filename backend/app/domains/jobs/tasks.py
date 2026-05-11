from time import monotonic

from celery.exceptions import MaxRetriesExceededError

from app.infrastructure.messaging.celery_app import celery
from app.infrastructure.database.sync_session import SyncSessionLocal
import app.infrastructure.database.all_models  # noqa: F401 — registers all ORM models with the mapper
from app.core.logging import WorkerLogHelper, get_logger
from app.domains.jobs.repository import SyncJobRepository
from app.domains.jobs.models import Job
from app.shared.types import JobStatus

logger = get_logger("app.domains.jobs.tasks")

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
            logger.info("Job updated");
            repo.update_status(job, JobStatus.FAILED, error_message=error)
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
        WorkerLogHelper.log_task_complete(
            "execute_ai_job", "n/a", (monotonic() - started_at) * 1000, job_id
        )

    except MaxRetriesExceededError:
        _mark_failed(db, repo, job_id, "Max retries exceeded")
        logger.error("Job %s exhausted all retries", job_id)

    except Exception as exc:
        WorkerLogHelper.log_task_error("execute_ai_job", "n/a", str(exc), job_id)
        logger.exception("Failed to execute AI job %s", job_id)

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
