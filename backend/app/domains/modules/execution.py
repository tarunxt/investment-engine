"""Trusted in-process execution context and fresh stage/effect checks.

No context may be reconstructed from task headers, browser config or cached
allows. Task adapters resolve persisted resource ownership before constructing it.
"""
from contextvars import ContextVar
from contextlib import contextmanager
from dataclasses import dataclass
from functools import wraps
import inspect
from .lifecycle import WorkIdentity, ModuleLifecycleDenied, current_sync, effect_guard
from .registry import ModuleId

@dataclass(frozen=True)
class Execution:
    identity: WorkIdentity
    factory: object

_current:ContextVar[Execution|None]=ContextVar('module_execution',default=None)

@contextmanager
def execution_scope(identity,factory):
    token=_current.set(Execution(identity,factory))
    try:
        checkpoint()
        yield
        checkpoint()
    finally:_current.reset(token)


def checkpoint():
    context=_current.get()
    if context is None:raise ModuleLifecycleDenied('Trusted module execution context required')
    with context.factory() as session:current_sync(session,context.identity)
    return context



def resolve_effect_identity(context,module):
    from .lifecycle import sync_snapshot
    with context.factory() as session:
        row=sync_snapshot(session,context.identity.owner_id).rows.get(ModuleId(module))
        if row is None:raise ModuleLifecycleDenied('Effect module is not selected')
        return WorkIdentity(context.identity.owner_id,module,row.version)


def guarded_effect(function,*,capability='analyze',module=None):
    """Recheck immediately before every adapter call, including direct callers."""
    @wraps(function)
    def sync(*args,**kwargs):
        context=checkpoint()
        identity=context.identity
        if module is not None:identity=resolve_effect_identity(context,module)
        with effect_guard(context.factory,identity,capability=capability):return function(*args,**kwargs)
    @wraps(function)
    async def asynchronous(*args,**kwargs):
        context=checkpoint()
        # Holding the short synchronous row-lock transaction spans this bounded
        # adapter await; no separate DB operation is made on that connection.
        with effect_guard(context.factory,context.identity,capability=capability):
            return await function(*args,**kwargs)
    return asynchronous if inspect.iscoroutinefunction(function) else sync


def require_bullpen_context(args):
    """Close legacy CLI/background paths; reconciliation permits known reads only."""
    from .tasks import _reconciliation_read
    from app.domains.polymarket.runtime_broker import _parse_command_category
    category,is_write,_=_parse_command_category(args)
    if _reconciliation_read.get():
        if not is_write and category in {'status','balance','positions','orders-read','history'}:return
        raise ModuleLifecycleDenied('Reconciliation permits only known read commands')
    context=checkpoint()
    if context.identity.module_id not in {'bullpen_research','bullpen_live','copy_trader','prediction_direct'}:
        raise ModuleLifecycleDenied('Bullpen consumer context required')
    with context.factory() as session:
        current_sync(session,context.identity,capability='execute' if is_write else 'view',boundary='side_effect' if is_write else 'worker')
