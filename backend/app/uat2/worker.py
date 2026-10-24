"""Dedicated bounded queue; does not import production tasks or schedulers."""
import os
from celery import Celery
from app.uat2.adapters import FakeAI

celery = Celery('credx-uat2', broker=os.environ['REDIS_URL'], backend=os.environ['REDIS_URL'])
celery.conf.update(task_default_queue='uat2_simulation', task_serializer='json',
                   result_serializer='json', accept_content=['json'], worker_prefetch_multiplier=1,
                   task_time_limit=15, task_soft_time_limit=10, result_expires=3600,
                   beat_schedule={}, broker_connection_retry_on_startup=True)
# Beat publishes only bounded control hints. Transport loss must not block a
# scheduler indefinitely; durable outboxes recover on a later tick.
celery.conf.update(task_publish_retry=False, broker_connection_timeout=3,
                   broker_transport_options={'socket_connect_timeout': 3,
                       'socket_timeout': 3, 'retry_on_timeout': False})


@celery.task(name='uat2.fake_ai', autoretry_for=(OSError,), retry_backoff=True,
             max_retries=1, acks_late=True)
def fake_ai(prompt, *, job_id=None):
    from app.domains.modules.tasks import task_scope
    from app.domains.modules.lifecycle import ModuleLifecycleDenied
    if type(job_id) is not int:raise ModuleLifecycleDenied('Persisted module work required')
    # Resolve current owner/module/version from stored Job; payload permissions
    # never authorize work. Restricted UAT2 currently keeps optional work closed.
    with task_scope('app.domains.jobs.tasks.execute_ai_job',[job_id]):
        return FakeAI().generate(prompt)


def install_workflow_workers():
    from sqlalchemy import create_engine
    from app.core.uat2 import uat2_mode, validate_uat2_startup
    from app.core.config import settings
    from app.domains.public_service.security import validate_public_startup
    from app.infrastructure.database.sync_session import SyncSessionLocal
    from app.domains.runs.analysis_workflows.synthetic_sources import SimulationSourceScope
    from app.uat2.analysis_worker import SimulationAnalysisWorker
    from app.uat2.order_worker import SimulationOrderWorker
    if not uat2_mode(): raise RuntimeError('Dedicated UAT2 task entrypoint required')
    validate_uat2_startup(); validate_public_startup(settings)
    analysis = SimulationAnalysisWorker(SyncSessionLocal, scope=SimulationSourceScope('hosted'))
    analysis.schedule(celery)
    # Same dedicated database, independent transaction/pool for fake acceptance.
    # Existing schema only; startup never creates tables or acquires credentials.
    venue = create_engine(settings.database_url, pool_size=2, max_overflow=0,
        pool_pre_ping=True, pool_timeout=5)
    orders = SimulationOrderWorker(analysis, venue)
    orders.schedule(celery)
    return analysis, orders, venue


analysis_worker, order_worker, venue_engine = install_workflow_workers()
