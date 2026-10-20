"""Celery producer/start/transition guard, including direct task.run calls."""
from contextlib import contextmanager
from contextvars import ContextVar
from functools import wraps
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from .lifecycle import ModuleLifecycleDenied, WorkIdentity, current_sync, sync_snapshot
from .execution import execution_scope
from .transports import DOMAIN_MODULES
from .registry import ModuleId

# Explicit infrastructure/safety jobs retain their own existing auth/recovery
# gates. No optional analysis, export, notification or ADMIN blanket exception.
_reconciliation_read=ContextVar("module_accepted_order_reconciliation",default=False)

SAFETY_TASKS=frozenset({
 'app.domains.auth.tasks.send_reset_password_email_task',
 'app.domains.fx_rates.tasks.refresh_usd_inr_rate',
 'app.domains.bullpen_run_audit.tasks.prune_unreferenced_bullpen_run_audit_blobs',
})
# Reconciliation never retries/submits an order. Existing functions additionally
# require accepted/pending order records and retain operator/recovery restrictions.
RECONCILIATION_TASKS=frozenset({
 'app.domains.polymarket_auto_live.tasks.reconcile_auto_live_order_intent',
 'app.domains.polymarket_auto_live.tasks.reconcile_auto_live_run_orders',
 'app.domains.polymarket_auto_live.tasks.reconcile_all_pending_auto_live_orders',
})
SCHEDULERS=frozenset({
 'app.domains.zerodha.tasks.enqueue_daily_portfolio_sync',
 'app.domains.trading_bots.tasks.enqueue_due_universal_polymarket_scans',
 'app.domains.bullpen008.tasks.enqueue_due_bullpen008_runs',
 'app.domains.polymarket_auto_live.tasks.enqueue_due_polymarket_auto_live_runs',
 'app.domains.dashboard.tasks.capture_daily_dashboard_portfolios',
 'app.domains.sports_rankings.tasks.dispatch_refresh',
 'app.domains.mails.tasks.recover_completion_emails',
})


def task_identity(session,name,args,kwargs):
    from app.domains.jobs.models import Job
    from app.domains.runs.models import Run
    domain=name.split('.')[2] if name.startswith('app.domains.') else None
    module=DOMAIN_MODULES.get(domain)
    if name=='app.domains.jobs.tasks.execute_ai_job':
        record=session.get(Job,kwargs.get('job_id',args[0] if args else None),populate_existing=True)
        if record is None or record.module_cancel_requested or not record.module_id or record.module_version is None:
            raise ModuleLifecycleDenied('Unbound or cancelled job')
        return WorkIdentity(record.user_id,record.module_id,record.module_version)
    # Generic legacy task payloads do not establish module ownership. Specific
    # resolvers below dereference the authoritative owned row, never headers.
    record=None
    first=args[0] if args else None
    resource=args[1] if len(args)>1 else None
    if domain=='google_sheets' and 'export_job' in name:record=session.get(Job,kwargs.get('job_id',resource),populate_existing=True)
    elif domain=='google_sheets' and 'export_run' in name:record=session.get(Run,kwargs.get('run_id',resource),populate_existing=True)
    elif domain in {'bullpen008','polymarket_auto_live'}:
        if domain=='bullpen008':
            from app.domains.bullpen008.models import Bullpen008RunRecord as Model
        else:
            from app.domains.polymarket_auto_live.models import PolymarketAutoLiveRunRecord as Model
        record=session.get(Model,kwargs.get('run_id',first),populate_existing=True)
    elif domain=='zerodha' and name.endswith('sync_portfolio_snapshot_task'):
        from app.domains.auth.models import User
        record=session.get(User,kwargs.get('user_id',first),populate_existing=True)
    if record is None or module is None:raise ModuleLifecycleDenied('No verified module work binding')
    if domain=='google_sheets' and kwargs.get('user_id',first)!=record.user_id:raise ModuleLifecycleDenied('Export owner mismatch')
    owner=record.id if domain=='zerodha' else record.user_id
    if type(owner)is not int:raise ModuleLifecycleDenied('Owned work identity required')
    row=sync_snapshot(session,owner).rows.get(ModuleId(module))
    if row is None:raise ModuleLifecycleDenied('Module selection required')
    # Legacy unversioned optional runtime work is deliberately not revived.
    if domain in {'bullpen008','polymarket_auto_live'}:raise ModuleLifecycleDenied('Legacy optional runtime has no module-version binding')
    return WorkIdentity(owner,module,row.version)


@contextmanager
def task_scope(name,args=(),kwargs=None,*,factory=None,dispatch_id=None):
    kwargs=kwargs or {}
    if name in RECONCILIATION_TASKS:
        token=_reconciliation_read.set(True)
        try:yield
        finally:_reconciliation_read.reset(token)
        return
    if name in SAFETY_TASKS or name in SCHEDULERS:
        yield
        return
    if name.startswith('celery.'):
        raise ModuleLifecycleDenied('Unclassified infrastructure task')
    if factory is None:
        from app.infrastructure.database.sync_session import SyncSessionLocal
        factory=SyncSessionLocal
    if name!='app.domains.jobs.tasks.execute_ai_job':
        from .dispatch import bound_execution
        with bound_execution(factory,dispatch_id,name,args,kwargs) as identity:
            with execution_scope(identity,factory):yield
        return
    try:
        with factory() as session:
            identity=task_identity(session,name,args,kwargs)
            current_sync(session,identity,boundary='worker',scheduled=kwargs.get('source')=='scheduled' or 'scheduled' in args)
    except SQLAlchemyError:
        raise ModuleLifecycleDenied('Current module policy unavailable') from None
    with execution_scope(identity,factory):yield


def closed_scheduler(name):
    return name in SCHEDULERS and name!='app.domains.zerodha.tasks.enqueue_daily_portfolio_sync'


def wrap_task(task):
    if getattr(task,'module_lifecycle_wrapped',False):return task
    original=task.run
    def admitted_call(function,args,kwargs,request=None):
        from app.core.recovery import require_task_allowed
        require_task_allowed(task.name)
        if closed_scheduler(task.name):
            return {'status':'paused','reason':'module_policy','queued':0}
        headers=getattr(request if request is not None else task.request,'headers',None) or {}
        if not isinstance(headers,dict):raise ModuleLifecycleDenied('Invalid task headers')
        with task_scope(task.name,args,kwargs,dispatch_id=headers.get('module_dispatch_id')):return function(*args,**kwargs)
    @wraps(original)
    def invoke(*args,**kwargs):return admitted_call(original,args,kwargs)
    import inspect
    from types import MethodType
    if inspect.ismethod(original):
        @wraps(original.__func__)
        def bound(_self,*args,**kwargs):
            return admitted_call(lambda *a,**kw:original.__func__(_self,*a,**kw),args,kwargs,getattr(_self,"request",None))
        task.run=MethodType(bound,task)
    else:task.run=invoke
    task.module_lifecycle_wrapped=True
    return task

# A narrow runtime marker permits only existing accepted-order reconciliation
# reads. Financial submission still requires its independent module/effect fence.
