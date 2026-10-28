"""In-memory Beat for the three existing bounded simulation control tasks.

No persistent schedule, default cleanup task, dynamic entry or arbitrary task
fallback is permitted. PostgreSQL outboxes remain the durable authority; a
scheduler restart only delays a tick and can never approve an order.
"""
from celery.beat import Scheduler
from app.domains.runs.analysis_workflows.contracts import WorkflowDenied
from app.uat2.analysis_worker import CONTROL_QUEUE, RELAY as ANALYSIS, OBSERVE
from app.uat2.order_worker import RELAY as ORDERS

ENTRIES = {
    'uat2-scoped-analysis-relay': (ANALYSIS, 5.0, 5),
    'uat2-scoped-orders-relay': (ORDERS, 5.0, 5),
    'uat2-scoped-operational-observation': (OBSERVE, 60.0, 30),
}


def validate_schedule(app):
    expected = {name: {'task': task, 'schedule': interval,
        'options': {'queue': CONTROL_QUEUE, 'expires': expires}}
        for name, (task, interval, expires) in ENTRIES.items()}
    if app.conf.beat_schedule != expected:
        raise WorkflowDenied('Exact bounded simulation schedule required')
    for task, _, _ in ENTRIES.values():
        if task not in app.tasks:
            raise WorkflowDenied('Registered simulation control task required')
    return expected


class SimulationScheduler(Scheduler):
    max_interval = 1.0

    def setup_schedule(self):
        self.data.clear()
        self.update_from_dict(validate_schedule(self.app))

    def apply_async(self, entry, producer=None, advance=True, **kwargs):
        # Validate again at dispatch. Never fall back to send_task for an
        # unknown or subsequently replaced schedule entry.
        validate_schedule(self.app)
        spec = ENTRIES.get(entry.name)
        if (spec is None or entry.task != spec[0] or entry.args or entry.kwargs
                or entry.schedule.run_every.total_seconds() != spec[1]
                or entry.options != {'queue': CONTROL_QUEUE, 'expires': spec[2]}):
            raise WorkflowDenied('Unrecognized simulation schedule entry')
        return super().apply_async(entry, producer=producer, advance=advance, **kwargs)
