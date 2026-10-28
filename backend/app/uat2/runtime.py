"""Explicit worker-plus-Beat launcher; native activation needs reviewed ExecStart.

No command-line override or environment-provided task/scheduler is accepted.
The existing worker entrypoint remains a consumer-only entrypoint.
"""
from app.uat2.scheduler import validate_schedule

WORKER_ARGS = (
    'worker', '--queues=uat2_simulation,uat2_analysis,uat2_orders,uat2_reconcile',
    '--concurrency=1', '--prefetch-multiplier=1', '--max-tasks-per-child=25',
    '--loglevel=warning', '--beat',
    '--scheduler=app.uat2.scheduler:SimulationScheduler',
)


def main():
    from app.uat2.worker import celery, analysis_worker
    analysis_worker.check_transport(celery)
    validate_schedule(celery)
    celery.worker_main(list(WORKER_ARGS))


if __name__ == '__main__':
    import sys
    if len(sys.argv) != 1:
        raise SystemExit('Dedicated simulation runtime takes no arguments')
    main()
