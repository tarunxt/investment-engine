import logging
import os

from celery import Celery
from celery.signals import task_received, worker_ready
from kombu import Queue
from celery.schedules import crontab, schedule

from app.core.config import settings
from app.domains.polymarket_auto_live.run_lifecycle import AUTO_LIVE_QUEUE

logger = logging.getLogger(__name__)

_broker = settings.celery_broker_url or settings.redis_url
_backend = settings.celery_result_backend or settings.redis_url

celery = Celery("worker", broker=_broker, backend=_backend)

# ── Queue definitions ────────────────────────────────────────────────────────
# Separate queues prevent long AI tasks from starving short email/beat tasks.
celery.conf.task_queues = (
    Queue("ai"),       # AI job execution — auto-scaled by queue depth
    # Auto-Live Stage 1/2 planning has a dedicated consumer.  Long-running
    # Stage 3 reconciliation stays on ai and can no longer reserve all pool
    # slots ahead of a scheduled planning task.
    Queue(AUTO_LIVE_QUEUE),
    Queue("email"),    # Transactional email — fixed 2 replicas
    Queue("beat"),     # Periodic / outbox relay — fixed 1 replica
)
celery.conf.task_default_queue = "ai"

celery.conf.task_routes = {
    "app.domains.jobs.tasks.*": {"queue": "ai"},
    "app.domains.auth.tasks.*": {"queue": "email"},
    "app.domains.runs.tasks.*": {"queue": "email"},
    "app.domains.polymarket_auto_live.tasks.execute_polymarket_auto_live_run": {"queue": AUTO_LIVE_QUEUE},
    "app.domains.polymarket_auto_live.tasks.execute_auto_live_order_intent": {"queue": "ai"},
    "app.domains.polymarket_auto_live.tasks.reconcile_auto_live_order_intent": {"queue": "ai"},
    "app.domains.polymarket_auto_live.tasks.retry_auto_live_order_intent": {"queue": "ai"},
    "app.domains.polymarket_auto_live.tasks.enqueue_due_polymarket_auto_live_runs": {"queue": "beat"},
    "app.domains.polymarket_auto_live.tasks.dispatch_due_auto_live_order_intents": {"queue": "beat"},
    "app.domains.polymarket_auto_live.tasks.watchdog_requeue_stale_auto_live_order_intents": {"queue": "beat"},
    "app.domains.polymarket_auto_live.tasks.reconcile_auto_live_run_orders": {"queue": "beat"},
    "app.domains.polymarket_auto_live.tasks.reconcile_all_pending_auto_live_orders": {"queue": "beat"},
    "app.domains.polymarket_auto_live.tasks.reconcile_interrupted_auto_live_runs_after_startup_grace": {"queue": AUTO_LIVE_QUEUE},
    "app.domains.bullpen_run_audit.tasks.generate_bullpen_run_audit_feedback": {"queue": "ai"},
    "app.domains.bullpen_run_audit.tasks.refresh_bullpen_run_audit_snapshot": {"queue": "ai"},
    "app.domains.bullpen_trade_analysis.tasks.refresh_bullpen_trade_analysis_history": {"queue": "ai"},
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
        # while the actual planning work stays isolated on ``auto_live``.
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
# A prefork process must not reserve a hidden backlog of long-lived AI tasks.
# The no-Docker worker scripts expose the same setting as an explicit CLI
# flag; this configuration keeps Docker/local workers safe as well.
try:
    _prefetch_multiplier = max(1, int(os.getenv("CELERY_WORKER_PREFETCH_MULTIPLIER", "1")))
except ValueError:
    logger.warning("Invalid CELERY_WORKER_PREFETCH_MULTIPLIER; using 1")
    _prefetch_multiplier = 1
celery.conf.worker_prefetch_multiplier = _prefetch_multiplier

celery.autodiscover_tasks([
    "app.domains.jobs",
    "app.domains.auth",
    "app.domains.runs",
    "app.domains.google_sheets",
    "app.domains.bullpen_run_audit",
    "app.domains.bullpen_trade_analysis",
    "app.domains.polymarket_auto_live",
    "app.domains.zerodha",
    "app.infrastructure.database.outbox",
])


@task_received.connect
def mark_received_auto_live_planning_task(**kwargs) -> None:
    """Record broker receipt before a prefork pool slot starts the task.

    Celery's main consumer receives/reserves a message before the child process
    invokes the task body.  Persisting ``RESERVED`` here is what lets the UI
    correctly say "Received — waiting for pool slot" instead of declaring a
    healthy queued task dead because Stage 1 has not started yet.
    """

    request = kwargs.get("request")
    sender = kwargs.get("sender")
    task_name = str(getattr(sender, "name", "") or getattr(request, "name", ""))
    if task_name != "app.domains.polymarket_auto_live.tasks.execute_polymarket_auto_live_run":
        return
    args = getattr(request, "args", ()) or ()
    if len(args) < 2:
        return
    run_id = str(args[1])
    task_id = getattr(request, "id", None)
    if not isinstance(task_id, str) or not task_id:
        return
    try:
        from app.domains.polymarket_auto_live.run_lifecycle import (
            AUTO_LIVE_QUEUE,
            update_auto_live_run_task_lifecycle_sync,
        )
        from app.infrastructure.database.sync_session import SyncSessionLocal

        with SyncSessionLocal() as session:
            updated = update_auto_live_run_task_lifecycle_sync(
                session,
                run_id=run_id,
                state="RESERVED",
                task_id=task_id,
                queue=AUTO_LIVE_QUEUE,
                worker_hostname=getattr(request, "hostname", None),
                expected_task_id=task_id,
            )
            if updated is None:
                session.rollback()
                return
            session.commit()
    except Exception:
        # Receipt accounting is observability only. The task's run-level lease
        # remains the duplicate-execution safety boundary.
        logger.exception(
            "Failed to persist RESERVED lifecycle state for Auto-Live task %s.",
            task_id,
        )


@worker_ready.connect
def reconcile_interrupted_auto_live_runs_after_worker_restart(**_kwargs) -> None:
    """Schedule, rather than immediately perform, destructive restart recovery.

    Late-acknowledged tasks can be redelivered several seconds after systemd
    sends SIGTERM.  An immediate worker-ready sweep used to mark their parent
    runs failed before the new consumer had a chance to reserve/start them.
    The delayed task applies lifecycle/heartbeat/inspect checks again.
    """

    sender = _kwargs.get("sender")
    worker_hostname = str(getattr(sender, "hostname", "") or "")
    # This signal is emitted by every Celery consumer.  Only the dedicated
    # planner worker should schedule restart recovery; otherwise an ordinary
    # ai/beat worker restart creates redundant destructive recovery sweeps.
    if not worker_hostname.startswith("auto-live-worker@"):
        return

    from app.domains.polymarket_auto_live.tasks import (
        reconcile_interrupted_auto_live_runs_after_startup_grace,
    )
    from app.domains.polymarket_auto_live.run_lifecycle import (
        AUTO_LIVE_RUN_STARTUP_RECOVERY_GRACE_SECONDS,
    )

    try:
        reconcile_interrupted_auto_live_runs_after_startup_grace.apply_async(
            countdown=AUTO_LIVE_RUN_STARTUP_RECOVERY_GRACE_SECONDS,
            queue=AUTO_LIVE_QUEUE,
        )
    except Exception:
        logger.exception(
            "Could not schedule delayed Auto-Live restart recovery; no automatic "
            "Stage 3 retry was requested."
        )
