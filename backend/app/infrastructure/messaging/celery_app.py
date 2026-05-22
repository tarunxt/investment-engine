from celery import Celery
from kombu import Queue

from app.core.config import settings

_broker = settings.celery_broker_url or settings.redis_url
_backend = settings.celery_result_backend or settings.redis_url

celery = Celery("worker", broker=_broker, backend=_backend)

# ── Queue definitions ────────────────────────────────────────────────────────
# Separate queues prevent long AI tasks from starving short email/beat tasks.
celery.conf.task_queues = (
    Queue("ai"),       # AI job execution — auto-scaled by queue depth
    Queue("email"),    # Transactional email — fixed 2 replicas
    Queue("beat"),     # Periodic / outbox relay — fixed 1 replica
)
celery.conf.task_default_queue = "ai"

celery.conf.task_routes = {
    "app.domains.jobs.tasks.*": {"queue": "ai"},
    "app.domains.auth.tasks.*": {"queue": "email"},
    "app.infrastructure.database.outbox.tasks.*": {"queue": "beat"},
}

celery.conf.task_serializer = "json"
celery.conf.result_serializer = "json"
celery.conf.accept_content = ["json"]
celery.conf.update(
    timezone="UTC",
    enable_utc=True
)

# Retry failed tasks with exponential backoff + jitter
celery.conf.task_acks_late = True          # ack only after task completes
celery.conf.task_reject_on_worker_lost = True  # requeue if worker crashes mid-task

celery.autodiscover_tasks([
    "app.domains.jobs",
    "app.domains.auth",
    "app.domains.google_sheets",
    "app.infrastructure.database.outbox",
])
