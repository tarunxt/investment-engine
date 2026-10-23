"""Existing-outbox control records; no new registry/schema or relay binding."""
from uuid import uuid5,NAMESPACE_URL
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from app.infrastructure.database.outbox.models import OutboxMessage
from app.domains.auth.models import User
from app.domains.ai_limits.contracts import BoundaryDenied
CONTROL='public_service.control.v1'

def control(db,name):
    if name not in {'signup','queues','monitor'}:raise BoundaryDenied('UNKNOWN_CONTROL')
    id=uuid5(NAMESPACE_URL,'credx:public-service:'+name)
    insert={'postgresql':pg_insert,'sqlite':sqlite_insert}.get(db.get_bind().dialect.name)
    if insert is None:raise BoundaryDenied('CONTROL_DATABASE_UNSUPPORTED')
    # Upsert locks the existing row even on SQLite; never changes a conflicting
    # unrelated topic or overwrites payload. Lock order: control before owner.
    db.execute(insert(OutboxMessage).values(id=id,topic=CONTROL,payload={'schema':1,'name':name},attempts=0,execution_attempts=0).on_conflict_do_update(index_elements=[OutboxMessage.id],set_={'topic':CONTROL},where=OutboxMessage.topic==CONTROL))
    row=db.scalar(select(OutboxMessage).where(OutboxMessage.id==id).with_for_update().execution_options(populate_existing=True))
    if row is None or row.topic!=CONTROL or row.payload.get('name')!=name or row.payload.get('schema')!=1:raise BoundaryDenied('CONTROL_BINDING_CHANGED')
    return row

def owner(db,id,*,verified=False):
    if type(id)is not int or id<1:raise BoundaryDenied('ACTIVE_OWNER_REQUIRED')
    row=db.scalar(select(User).where(User.id==id).with_for_update().execution_options(populate_existing=True))
    if row is None or not row.is_active or (verified and not row.is_verified):raise BoundaryDenied('ACTIVE_OWNER_REQUIRED')
    return row
