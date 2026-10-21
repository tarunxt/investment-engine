"""Trusted in-process execution context and fresh stage/effect checks.

No context may be reconstructed from task headers, browser config or cached
allows. Task adapters resolve persisted resource ownership before constructing it.
"""
from contextvars import ContextVar
from contextlib import contextmanager,asynccontextmanager
from dataclasses import dataclass
from functools import wraps
import inspect
import asyncio
from .lifecycle import WorkIdentity, ModuleLifecycleDenied, current_sync, effect_guard,async_effect_guard
from .registry import ModuleId

@dataclass(frozen=True)
class Execution:
    identity: WorkIdentity
    factory: object
    async_factory: object | None = None

_current:ContextVar[Execution|None]=ContextVar('module_execution',default=None)
_safety_owner:ContextVar[int|None]=ContextVar('module_safety_owner',default=None)

@contextmanager
def execution_scope(identity,factory,*,async_factory=None):
    token=_current.set(Execution(identity,factory,async_factory))
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
        with effect_guard(context.factory,context.identity,capability=capability,module=module):return function(*args,**kwargs)
    @wraps(function)
    async def asynchronous(*args,**kwargs):
        context=_current.get()
        if context is None:raise ModuleLifecycleDenied('Trusted module execution context required')
        factory=context.async_factory
        if factory is None:
            from app.infrastructure.database.session import AsyncSessionLocal
            factory=AsyncSessionLocal
        async with async_effect_guard(factory,context.identity,capability=capability,module=module):
            async with asyncio.timeout(30):return await function(*args,**kwargs)
    return asynchronous if inspect.iscoroutinefunction(function) else sync


def require_bullpen_context(args):
    """Close legacy CLI/background paths; reconciliation permits known reads only."""
    from .tasks import _reconciliation_read
    from app.domains.polymarket.runtime_broker import _parse_command_category
    category,is_write,_=_parse_command_category(args)
    if _reconciliation_read.get():
        if not is_write and category in {'status','balance','positions','orders-read','history'}:return
        raise ModuleLifecycleDenied('Reconciliation permits only known read commands')
    context=_current.get()
    if context is None:raise ModuleLifecycleDenied('Trusted module execution context required')
    if context.identity.module_id not in {'bullpen_research','bullpen_live','copy_trader','prediction_direct'}:
        raise ModuleLifecycleDenied('Bullpen consumer context required')
    # Structural admission only. The authoritative SQL check/fence occurs at
    # actual process creation, after every broker/auth/semaphore wait.


@asynccontextmanager
async def bullpen_process_fence(args):
    from app.domains.polymarket.runtime_broker import _parse_command_category
    _,write,_=_parse_command_category(args)
    if write:
        from app.domains.order_intents.contracts import require_live_financial_disabled
        require_live_financial_disabled()
    require_bullpen_context(args)
    from .tasks import _reconciliation_read
    if _reconciliation_read.get():
        owner=_safety_owner.get()
        if type(owner)is not int:raise ModuleLifecycleDenied('Verified reconciliation owner required')
        from app.infrastructure.database.session import AsyncSessionLocal
        from app.domains.auth.models import User,UserRole
        from sqlalchemy import select,func
        async with AsyncSessionLocal() as db:
            async with db.begin():
                if db.get_bind().dialect.name=='postgresql':
                    await db.execute(select(func.set_config('lock_timeout','2000',True)))
                    await db.execute(select(func.set_config('statement_timeout','5000',True)))
                row=(await db.execute(select(User.role,User.is_active).where(User.id==owner).with_for_update())).first()
                if row is None or not row.is_active or row.role!=UserRole.ADMIN:raise ModuleLifecycleDenied('Current reconciliation owner denied')
                yield
        return
    context=_current.get()
    from app.domains.polymarket.runtime_broker import _parse_command_category
    _,write,_=_parse_command_category(args)
    factory=context.async_factory
    if factory is None:
        from app.infrastructure.database.session import AsyncSessionLocal
        factory=AsyncSessionLocal
    async with async_effect_guard(factory,context.identity,capability='execute' if write else 'view'):
        yield
