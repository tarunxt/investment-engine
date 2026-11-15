"""Same Redis connection, independent recovery queues/reservations/results."""
from celery import Celery, Task
from kombu import Queue
from app.core.recovery import (
    ANALYSIS_TASK, RECOVERY_TASKS, ANALYSIS_QUEUE, TRANSPORT_PREFIX, RecoveryBlocked,
    recovery_mode, require_task_allowed, recovery_tasks, stored_audit_recovery_enabled,
)


def require_isolated_transport(app, options):
    if (app.conf.broker_transport_options.get("global_keyprefix") != TRANSPORT_PREFIX
            or app.conf.result_backend_transport_options.get("global_keyprefix") != TRANSPORT_PREFIX):
        raise RecoveryBlocked("Unisolated analysis transport")
    if options.get("producer") is not None or options.get("publisher") is not None:
        raise RecoveryBlocked("External producer override")
    connection = options.get("connection")
    if connection is not None:
        try:
            canonical = (
                connection.transport_options.get("global_keyprefix") == TRANSPORT_PREFIX
                and connection.as_uri(include_password=True) == app.connection_for_write().as_uri(include_password=True)
            )
        except Exception:
            canonical = False
        if not canonical: raise RecoveryBlocked("External connection override")


class RecoveryTask(Task):
    def apply_async(self, args=None, kwargs=None, **options):
        require_task_allowed(self.name)
        if recovery_mode():
            require_isolated_transport(self.app, options)
            options.update(queue=ANALYSIS_QUEUE, routing_key=ANALYSIS_QUEUE,
                           exchange=ANALYSIS_QUEUE)
        return super().apply_async(args=args, kwargs=kwargs, **options)

    def before_start(self, task_id, args, kwargs):
        require_task_allowed(self.name)
        return super().before_start(task_id, args, kwargs)

    def __call__(self, *args, **kwargs):
        require_task_allowed(self.name)
        return super().__call__(*args, **kwargs)


class RecoveryCelery(Celery):
    def send_task(self, name, args=None, kwargs=None, **options):
        require_task_allowed(name)
        if recovery_mode():
            require_isolated_transport(self, options)
            options.update(queue=ANALYSIS_QUEUE, routing_key=ANALYSIS_QUEUE,
                           exchange=ANALYSIS_QUEUE)
        return super().send_task(name, args=args, kwargs=kwargs, **options)


def configure_recovery_queue(app):
    if not recovery_mode():
        return
    from urllib.parse import urlsplit
    if any(urlsplit(str(url or "")).scheme not in {"redis", "rediss"}
           for url in (app.conf.broker_url, app.conf.result_backend)):
        raise RecoveryBlocked("Recovery requires Redis broker and result backend")
    # Redis transport reservation keys are global unless explicitly prefixed.
    app.conf.update(
        task_queues=(Queue(ANALYSIS_QUEUE, exchange=ANALYSIS_QUEUE,
                          routing_key=ANALYSIS_QUEUE),),
        task_default_queue=ANALYSIS_QUEUE,
        task_default_exchange=ANALYSIS_QUEUE,
        task_default_routing_key=ANALYSIS_QUEUE,
        task_routes={name: {"queue": ANALYSIS_QUEUE} for name in recovery_tasks()},
        task_create_missing_queues=False,
        broker_transport_options={"global_keyprefix": TRANSPORT_PREFIX},
        result_backend_transport_options={"global_keyprefix": TRANSPORT_PREFIX},
        beat_schedule={},
        task_always_eager=False,
        worker_enable_remote_control=False,
        imports=("app.domains.jobs.tasks", "app.domains.zerodha.tasks") + (("app.domains.recommendation_audit.tasks",) if stored_audit_recovery_enabled() else ()),
    )
