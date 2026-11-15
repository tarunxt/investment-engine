from app.core.config import settings
from app.core.recovery import audit_recovery_blocked
from app.infrastructure.messaging.celery_app import celery


@celery.task(name="app.domains.recommendation_audit.tasks.verify_reversal", acks_late=True, reject_on_worker_lost=True, max_retries=0, soft_time_limit=90, time_limit=120)
def verify_reversal(record_id: str):
    if not settings.recommendation_audit_enabled or audit_recovery_blocked(settings): return {"status": "blocked"}
    from app.infrastructure.database.sync_session import SyncSessionLocal
    from .worker import run_verification
    with SyncSessionLocal() as session:
        return {"updated": run_verification(session, record_id, settings)}
