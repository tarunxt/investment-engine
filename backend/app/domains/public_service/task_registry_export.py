"""Read only exact owned job task-registry keys through a caller-owned client.

No Redis connection, wildcard scan, task revoke or deletion is performed here.
Redis is observed separately from SQL and is not an atomic account snapshot.
"""
from uuid import UUID
from sqlalchemy import select
from app.domains.jobs.models import Job
from app.domains.ai_limits.contracts import BoundaryDenied
from .store import owner


def export_job_registry(db, subject, client):
    owner(db, subject, verified=True)
    if db.get_bind().dialect.name == 'postgresql' and db.connection().get_isolation_level() not in {
            'REPEATABLE READ', 'SERIALIZABLE'}:
        raise BoundaryDenied('ACCOUNT_CACHE_SNAPSHOT_REQUIRED')
    identifiers = list(db.scalars(select(Job.id).where(Job.user_id == subject).order_by(Job.id).limit(1001)))
    if len(identifiers) > 1000 or any(type(item) is not int or item < 1 for item in identifiers):
        raise BoundaryDenied('ACCOUNT_CACHE_LIMIT')
    keys = ['celery:job-task:' + str(item) for item in identifiers]
    values = client.mget(keys) if keys else []
    if type(values) is not list or len(values) != len(keys):
        raise BoundaryDenied('ACCOUNT_CACHE_RESPONSE_INVALID')
    items=[]
    for identifier, value in zip(identifiers, values):
        if value is None:continue
        # Task IDs are generated UUIDs, not arbitrary text to export or revoke.
        try:
            if type(value) is not str or str(UUID(value)) != value:raise ValueError
        except (ValueError, TypeError, AttributeError):
            raise BoundaryDenied('ACCOUNT_CACHE_RESPONSE_INVALID') from None
        items.append({'job_id': identifier, 'task_id': value})
    return {'owner_id': subject, 'items': items, 'atomic_with_sql': False,
        'namespace': 'celery:job-task', 'other_namespaces_covered': False,
        'complete_account_export': False, 'deletable': False}
