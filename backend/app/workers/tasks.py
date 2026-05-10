from time import monotonic

from app.workers.celery_app import celery

from app.db.database import SessionLocal
from app.core.logging import WorkerLogHelper, get_logger
from app.models.job import Job
from app.providers.factory import ProviderFactory

logger = get_logger("app.workers.tasks")


@celery.task(name="execute_ai_job")
def execute_ai_job(job_id: int):
    db = SessionLocal()
    job = db.query(Job).filter(Job.id == job_id).first()
    started_at = monotonic()
    
    try:
        if not job:
            logger.warning("Job %s not found for execution", job_id)
            return

        WorkerLogHelper.log_task_start("execute_ai_job", "n/a", job_id)
        job.status = "processing"

        db.commit()

        provider = ProviderFactory.create(job.provider)
        result = provider.generate(prompt=job.prompt, model=job.model)

        job.response = result.content
        job.tokens_in = result.tokens_in
        job.tokens_out = result.tokens_out
        job.estimated_cost = result.cost
        job.status = "completed"
        job.error_message = None

        db.commit()
        WorkerLogHelper.log_task_complete(
            "execute_ai_job",
            "n/a",
            (monotonic() - started_at) * 1000,
            job_id,
        )

    except Exception as exc:
        db.rollback()

        if job:
            job.status = "failed"
            job.error_message = str(exc)
            db.commit()

        WorkerLogHelper.log_task_error("execute_ai_job", "n/a", str(exc), job_id)
        logger.exception("Failed to execute AI job %s", job_id)

    finally:
        db.close()


@celery.task(
    bind=True,
    max_retries=3,
    default_retry_delay=60,
    name="send_reset_password_email_task"
)
def send_reset_password_email_task(self, email: str, token: str):
    """Celery task to send reset password email."""
    from app.services.email import EmailService
    
    try:
        success = EmailService.send_reset_password_email(email, token)
        if not success:
            raise Exception("Failed to send email")
    except Exception as exc:
        raise self.retry(exc=exc)
