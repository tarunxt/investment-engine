"""Version-fenced task locators in the EXISTING transactional outbox.

The header is only a locator. All authority is re-derived from persisted owned
resources, exact request digest, original module version and current policy.
"""
from contextlib import contextmanager
from datetime import datetime
from uuid import UUID
from sqlalchemy import select,update
from app.infrastructure.database.outbox.models import OutboxMessage
from app.infrastructure.messaging.idempotency import canonical_digest
from .models import UserModulePreferences
from .lifecycle import WorkIdentity,ModuleLifecycleDenied,current_sync
TOPIC='modules.task.bound.v1'
HEADER='module_dispatch_id'


def request_digest(name,args,kwargs):
    try:return canonical_digest({'task':name,'args':list(args or()),'kwargs':kwargs or {}})
    except (TypeError,ValueError):raise ModuleLifecycleDenied('Task request cannot be bound') from None


def resource_locator(name,args,kwargs):
    """Persist only a typed authoritative locator, never task arguments."""
    args=args or ();kwargs=kwargs or {}
    domain=name.split('.')[2] if name.startswith('app.domains.') else None
    if domain=='google_sheets' and 'export_job' in name:
        kind='job';value=kwargs.get('job_id',args[1] if len(args)>1 else None)
    elif domain=='google_sheets' and 'export_run' in name:
        kind='run';value=kwargs.get('run_id',args[1] if len(args)>1 else None)
    elif domain=='zerodha' and name.endswith('sync_portfolio_snapshot_task'):
        kind='user';value=kwargs.get('user_id',args[0] if args else None)
    else:raise ModuleLifecycleDenied('Typed task resource unavailable')
    if type(value) is not int or value<1:raise ModuleLifecycleDenied('Typed owned task resource required')
    return {'kind':kind,'id':value}


def load_binding(session,id,name,args,kwargs):
    try:id=UUID(str(id))
    except (ValueError,TypeError):raise ModuleLifecycleDenied('Persisted task binding required') from None
    row=session.get(OutboxMessage,id,populate_existing=True)
    if row is None or row.topic!=TOPIC:raise ModuleLifecycleDenied('Task binding unavailable')
    p=row.payload
    if p.get('schema_version')!=1 or p.get('task')!=name or p.get('request_digest')!=request_digest(name,args,kwargs):
        raise ModuleLifecycleDenied('Task binding mismatch')
    if 'resource' in p and p['resource']!=resource_locator(name,args,kwargs):raise ModuleLifecycleDenied('Task resource mismatch')
    if p.get('state') in {'cancelled','completed'} or p.get('cancel_requested'):raise ModuleLifecycleDenied('Task already stopped')
    if type(p.get('user_id'))is not int or type(p.get('module_version'))is not int:raise ModuleLifecycleDenied('Invalid task binding')
    return row,WorkIdentity(p['user_id'],p['module_id'],p['module_version'])


def prepare_dispatch(name,args,kwargs,options,*,factory=None):
    from .tasks import SAFETY_TASKS,RECONCILIATION_TASKS,SCHEDULERS,task_identity
    if name in SAFETY_TASKS|RECONCILIATION_TASKS|SCHEDULERS:return options
    if factory is None:
        from app.infrastructure.database.sync_session import SyncSessionLocal
        factory=SyncSessionLocal
    kwargs=kwargs or {};args=args or ()
    headers=dict(options.get('headers') or {})
    with factory() as session:
        identity=task_identity(session,name,args,kwargs)
        if name in {'app.domains.jobs.tasks.execute_ai_job','app.domains.runs.tasks.advance_analysis_workflow'}:
            current_sync(session,identity);return options # Job is already durable/versioned.
        session.execute(select(UserModulePreferences.user_id).where(UserModulePreferences.user_id==identity.owner_id).with_for_update())
        if headers.get(HEADER):
            _,bound=load_binding(session,headers[HEADER],name,args,kwargs)
            if bound!=identity:raise ModuleLifecycleDenied('Stale task cannot be rebound')
        else:
            row=OutboxMessage(topic=TOPIC,payload={'schema_version':1,'task':name,'request_digest':request_digest(name,args,kwargs),
                'user_id':identity.owner_id,'module_id':identity.module_id,'module_version':identity.version,'state':'queued','cancel_requested':False,
                'resource':resource_locator(name,args,kwargs)})
            session.add(row);session.flush();headers[HEADER]=str(row.id)
        current_sync(session,identity,scheduled=kwargs.get('source')=='scheduled' or 'scheduled' in args)
        session.commit()
    return {**options,'headers':headers}


@contextmanager
def bound_execution(factory,id,name,args,kwargs):
    with factory() as session:
        row,identity=load_binding(session,id,name,args,kwargs)
        session.execute(select(UserModulePreferences.user_id).where(UserModulePreferences.user_id==identity.owner_id).with_for_update())
        current_sync(session,identity,scheduled=kwargs.get('source')=='scheduled' or 'scheduled' in args)
        claim=session.execute(update(OutboxMessage).where(OutboxMessage.id==row.id,
            OutboxMessage.execution_attempts==row.execution_attempts,
            OutboxMessage.payload['state'].as_string().in_(['queued','failed']))
            .values(payload={**row.payload,'state':'running'},execution_attempts=OutboxMessage.execution_attempts+1)
            .execution_options(synchronize_session=False))
        if claim.rowcount!=1:raise ModuleLifecycleDenied('Task is already running or stopped')
        session.commit()
    outcome='completed'
    try:yield identity
    except BaseException:
        outcome='failed';raise
    finally:
        with factory() as session:
            row=session.get(OutboxMessage,UUID(str(id)))
            if row is not None:
                row.payload={**row.payload,'state':'cancelled' if row.payload.get('cancel_requested') else outcome}
                session.commit()
