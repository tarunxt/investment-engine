from celery import Celery
from kombu import Queue
from celery.schedules import crontab

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
    "app.domains.runs.tasks.*": {"queue": "email"},
    "app.domains.polymarket_auto_live.tasks.execute_polymarket_auto_live_run": {"queue": "ai"},
    "app.domains.polymarket_auto_live.tasks.enqueue_due_polymarket_auto_live_runs": {"queue": "beat"},
    "app.domains.zerodha.tasks.*": {"queue": "ai"},
    "app.infrastructure.database.outbox.tasks.*": {"queue": "beat"},
}

celery.conf.task_serializer = "json"
celery.conf.result_serializer = "json"
celery.conf.accept_content = ["json"]
celery.conf.update(
    timezone="UTC",
    enable_utc=True
)
celery.conf.beat_schedule = {
    # 10:40 UTC == 16:10 IST, shortly after Indian market close.
    "zerodha-daily-portfolio-sync": {
        "task": "app.domains.zerodha.tasks.enqueue_daily_portfolio_sync",
        "schedule": crontab(minute=40, hour=10),
    },
    "polymarket-auto-live-due-run-scan": {
        "task": "app.domains.polymarket_auto_live.tasks.enqueue_due_polymarket_auto_live_runs",
        "schedule": crontab(minute="*"),
    },
}

# Retry failed tasks with exponential backoff + jitter
celery.conf.task_acks_late = True          # ack only after task completes
celery.conf.task_reject_on_worker_lost = True  # requeue if worker crashes mid-task

celery.autodiscover_tasks([
    "app.domains.jobs",
    "app.domains.auth",
    "app.domains.runs",
    "app.domains.google_sheets",
    "app.domains.polymarket_auto_live",
    "app.domains.zerodha",
    "app.infrastructure.database.outbox",
])
