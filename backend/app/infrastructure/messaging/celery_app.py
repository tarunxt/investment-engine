import logging

from celery import Celery
from celery.signals import worker_ready
from kombu import Queue
from celery.schedules import crontab, schedule

from app.core.config import settings

logger = logging.getLogger(__name__)

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
    "app.domains.polymarket_auto_live.tasks.execute_auto_live_order_intent": {"queue": "ai"},
    "app.domains.polymarket_auto_live.tasks.reconcile_auto_live_order_intent": {"queue": "ai"},
    "app.domains.polymarket_auto_live.tasks.retry_auto_live_order_intent": {"queue": "ai"},
    "app.domains.polymarket_auto_live.tasks.enqueue_due_polymarket_auto_live_runs": {"queue": "beat"},
    "app.domains.polymarket_auto_live.tasks.dispatch_due_auto_live_order_intents": {"queue": "beat"},
    "app.domains.polymarket_auto_live.tasks.watchdog_requeue_stale_auto_live_order_intents": {"queue": "beat"},
    "app.domains.polymarket_auto_live.tasks.reconcile_auto_live_run_orders": {"queue": "beat"},
    "app.domains.polymarket_auto_live.tasks.reconcile_all_pending_auto_live_orders": {"queue": "beat"},
    "app.domains.bullpen_run_audit.tasks.generate_bullpen_run_audit_feedback": {"queue": "ai"},
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
        # Auto-Live users can choose an exact start minute from the UI.  A
        # minute-only beat tick can miss that timestamp for almost a full minute
        # when the user starts just after the tick, so scan due runs frequently
        # while keeping the actual long-running work on the ai queue.
        "schedule": schedule(run_every=10.0),
    },
    "polymarket-auto-live-order-intent-dispatch": {
        "task": "app.domains.polymarket_auto_live.tasks.dispatch_due_auto_live_order_intents",
        "schedule": crontab(minute="*"),
    },
    "polymarket-auto-live-order-intent-watchdog": {
        "task": "app.domains.polymarket_auto_live.tasks.watchdog_requeue_stale_auto_live_order_intents",
        "schedule": schedule(run_every=30.0),
    },
    "polymarket-auto-live-order-intent-reconcile": {
        "task": "app.domains.polymarket_auto_live.tasks.reconcile_all_pending_auto_live_orders",
        "schedule": crontab(minute="*"),
    },
}

# Retry failed tasks with exponential backoff + jitter
celery.conf.task_acks_late = True          # ack only after task completes
celery.conf.task_reject_on_worker_lost = True  # requeue if worker crashes mid-task
celery.conf.task_track_started = True

celery.autodiscover_tasks([
    "app.domains.jobs",
    "app.domains.auth",
    "app.domains.runs",
    "app.domains.google_sheets",
    "app.domains.bullpen_run_audit",
    "app.domains.polymarket_auto_live",
    "app.domains.zerodha",
    "app.infrastructure.database.outbox",
])


@worker_ready.connect
def reconcile_interrupted_auto_live_runs_after_worker_restart(**_kwargs) -> None:
    """Freeze abandoned Stage 3 writes before a restarted worker consumes them."""

    from app.domains.polymarket_auto_live.tasks import (
        reconcile_interrupted_auto_live_runs_on_startup_sync,
    )

    try:
        reconcile_interrupted_auto_live_runs_on_startup_sync()
    except Exception:
        logger.exception(
            "Worker startup interrupted-run reconciliation failed; no automatic "
            "Stage 3 retry was requested."
        )
