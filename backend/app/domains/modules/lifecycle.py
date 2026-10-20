"""Fresh SQL lifecycle checks; outbox delivery is a hint, never authorization.

The owner's selection-header row serializes disable with dispatch/effects. A
caller must hold that row lock through its bounded external operation. Disable
linearizes at commit. An already-started effect may finish before that commit;
no later phase may reuse its authorization. Nothing here liquidates positions.
"""
from contextlib import asynccontextmanager, contextmanager
from dataclasses import dataclass
from sqlalchemy import select, update,func
from fastapi import HTTPException
from app.domains.auth.models import User
from app.domains.jobs.models import Job
from app.domains.runs.models import Run,AutoRebalanceWorkflow
from app.infrastructure.database.outbox.models import OutboxMessage
from app.shared.types import JobStatus
from .models import UserModule, UserModulePreferences
from .policy import DefaultFactsResolver, ModuleFacts, ModulePolicy, decide
from .registry import ModuleId, ModuleConfigV1, REGISTRY
from .store import SelectionSnapshot

TOPIC='modules.selection.changed.v1'

class ModuleLifecycleDenied(PermissionError):
    pass

@dataclass(frozen=True)
class WorkIdentity:
    owner_id: int
    module_id: str
    version: int


def analysis_module(portfolio):
    if portfolio is not None and not isinstance(portfolio,str):raise ModuleLifecycleDenied('Unknown analysis consumer')
    if portfolio in {'zerodha','india'}:return ModuleId.ZERODHA_REBALANCE.value
    if portfolio in {'indmoney_us','us'}:return ModuleId.INDMONEY_US.value
    if portfolio is None:return ModuleId.AI_STUDIO.value
    raise ModuleLifecycleDenied('Unknown analysis consumer')


def sync_snapshot(session,owner_id):
    # Never retain ORM identity-map values across a different transaction's disable.
    header=session.scalar(select(UserModulePreferences).where(UserModulePreferences.user_id==owner_id)
        .execution_options(populate_existing=True))
    if header is None:return SelectionSnapshot(owner_id,0,{})
    rows=session.scalars(select(UserModule).where(UserModule.user_id==owner_id)
        .execution_options(populate_existing=True)).all()
    selections={}
    for row in rows:
        id=ModuleId(row.module_id)
        if id not in REGISTRY or not 0<row.version<=header.version:raise ModuleLifecycleDenied('Invalid module state')
        ModuleConfigV1.model_validate(row.config);selections[id]=row
    return SelectionSnapshot(owner_id,header.version,selections,persisted=True)


def current_sync(session,identity,*,capability='analyze',boundary='worker',scheduled=False,facts=None):
    from app.core.uat2 import uat2_mode
    snapshot=sync_snapshot(session,identity.owner_id)
    active=bool(session.scalar(select(User.is_active).where(User.id==identity.owner_id)))
    decision=decide(owner_id=identity.owner_id,resource_owner_id=identity.owner_id,
        active=active,module_id=identity.module_id,capability=capability,boundary=boundary,
        snapshot=snapshot,facts=facts or DefaultFactsResolver().resolve_sync(identity.owner_id,ModuleId(identity.module_id)),uat2=uat2_mode(),expected_version=None)
    if not decision.allowed:raise ModuleLifecycleDenied('Current module policy denied: '+','.join(decision.reasons))
    row=snapshot.rows.get(ModuleId(identity.module_id))
    if row is None or row.version != identity.version:raise ModuleLifecycleDenied("Module selection version changed")
    if scheduled and (row is None or row.schedules_paused):raise ModuleLifecycleDenied('Schedules require explicit resume')
    return decision


async def lock_owner(db,owner_id):
    if db.get_bind().dialect.name=='postgresql':
        await db.execute(select(func.set_config('lock_timeout','2000',True)))
        await db.execute(select(func.set_config('statement_timeout','5000',True)))
    await db.execute(select(UserModulePreferences.user_id).where(UserModulePreferences.user_id==owner_id).with_for_update())


async def admit_enqueue(db,owner_id,module_id,*,scheduled=False):
    # This lock remains held until the use case commits owned work + outbox.
    await lock_owner(db,owner_id)
    decision=await ModulePolicy(db).authorize(owner_id=owner_id,resource_owner_id=owner_id,
        module_id=module_id,capability='analyze',boundary='worker')
    if not decision.allowed:raise HTTPException(403,{'code':'MODULE_POLICY_DENIED','reasons':decision.reasons})
    if scheduled:
        paused=await db.scalar(select(UserModule.schedules_paused).where(UserModule.user_id==owner_id,UserModule.module_id==module_id))
        if paused is not False:raise HTTPException(409,{'code':'MODULE_SCHEDULE_PAUSED'})
    row_version=await db.scalar(select(UserModule.version).where(UserModule.user_id==owner_id,UserModule.module_id==module_id))
    return WorkIdentity(owner_id,module_id,row_version)


def disable_statements(owner_id,module_ids):
    for model in (Job,Run,AutoRebalanceWorkflow):
        owned=(model.user_id==owner_id)&model.module_id.in_(module_ids)
        values={'status':'cancelled' if model is AutoRebalanceWorkflow else JobStatus.FAILED,'module_cancel_requested':True}
        if model in (Job,AutoRebalanceWorkflow):values['error_message']='Cancelled: module disabled'
        yield update(model).where(owned,model.status.in_([JobStatus.PENDING,JobStatus.SCHEDULED,"queued"])).values(**values)
        yield update(model).where(owned,model.status.in_([JobStatus.PROCESSING,"running"])).values(module_cancel_requested=True)


def disable_owned_work(session,owner_id,module_ids):
    """Same transaction as selection CAS: missed events cannot bypass disable."""
    for statement in disable_statements(owner_id,module_ids):session.execute(statement)


async def selection_changed(db,owner_id,version,changes):
    disabled=[c.module_id.value for c in changes if not c.enabled]
    if disabled:
        await db.execute(update(UserModule).where(UserModule.user_id==owner_id,UserModule.module_id.in_(disabled)).values(schedules_paused=True))
        for statement in disable_statements(owner_id,disabled):await db.execute(statement)
        from .dispatch import TOPIC as TASK_TOPIC
        bound=(await db.execute(select(OutboxMessage).where(OutboxMessage.topic==TASK_TOPIC,
            OutboxMessage.payload['user_id'].as_integer()==owner_id))).scalars().all()
        for message in bound:
            if message.payload.get('module_id') in disabled and message.payload.get('state') in {'queued','running'}:
                message.payload={**message.payload,'cancel_requested':True,
                    'state':'cancelled' if message.payload['state']=='queued' else 'running'}
    db.add(OutboxMessage(topic=TOPIC,payload={'schema_version':1,'user_id':owner_id,'version':version,
        'disabled':disabled,'changed':[c.module_id.value for c in changes]}))


def apply_selection_event(session,message):
    """Idempotent current-state repair. Reordered enable events never resume work."""
    if message.topic!=TOPIC or message.payload.get('schema_version')!=1:return False
    owner=message.payload.get('user_id');version=message.payload.get('version')
    if type(owner)is not int or type(version)is not int:return False
    header=session.scalar(select(UserModulePreferences).where(UserModulePreferences.user_id==owner).with_for_update())
    if header is None or version>header.version:return False
    disabled=session.scalars(select(UserModule.module_id).where(UserModule.user_id==owner,UserModule.enabled.is_(False))).all()
    disable_owned_work(session,owner,list(disabled))
    return True


@contextmanager
def effect_guard(factory,identity,*,capability='analyze',facts=None):
    """Bounded synchronous effect under same owner-row fence used by disable."""
    with factory() as session:
        with session.begin():
            header=session.scalar(select(UserModulePreferences.user_id).where(UserModulePreferences.user_id==identity.owner_id).with_for_update())
            if header is None:raise ModuleLifecycleDenied('No current selection')
            current_sync(session,identity,capability=capability,boundary='side_effect',facts=facts)
            yield


def eligible_scheduled_user_ids(session,module_id):
    """Enumerate opted-in active users first; never enumerate stored tokens."""
    rows=session.execute(select(UserModule.user_id,UserModule.version).join(User,User.id==UserModule.user_id)
        .where(UserModule.module_id==module_id,UserModule.enabled.is_(True),UserModule.schedules_paused.is_(False),User.is_active.is_(True))).all()
    result=[]
    for owner,version in rows:
        try:current_sync(session,WorkIdentity(owner,module_id,version),scheduled=True)
        except ModuleLifecycleDenied:continue
        result.append(owner)
    return result


def relay_selection_events(session,limit=10):
    from datetime import datetime
    rows=session.scalars(select(OutboxMessage).where(OutboxMessage.topic==TOPIC,
        OutboxMessage.published_at.is_(None)).order_by(OutboxMessage.created_at).limit(min(max(limit,1),10)).with_for_update(skip_locked=True)).all()
    for message in rows:
        if apply_selection_event(session,message):
            message.published_at=datetime.utcnow();message.attempts+=1
    session.commit()
    return len(rows)


def guard_job_transition(session,job):
    """Hold the selection fence in the SAME transaction as the state write."""
    if not job.module_id or job.module_version is None:raise ModuleLifecycleDenied('Unbound worker transition')
    session.execute(select(UserModulePreferences.user_id).where(UserModulePreferences.user_id==job.user_id).with_for_update())
    cancelled=session.scalar(select(Job.module_cancel_requested).where(Job.id==job.id))
    if cancelled:raise ModuleLifecycleDenied('Module cancellation requested')
    current_sync(session,WorkIdentity(job.user_id,job.module_id,job.module_version))


async def resume_schedules(db,owner_id,module_id,expected_version):
    """Explicit owner action; only analysis schedules, never trading restart."""
    from .store import read_snapshot,conflict
    if module_id not in {'ai_studio','zerodha_rebalance','indmoney_us'}:
        raise HTTPException(403,{'code':'MODULE_SCHEDULE_RESUME_UNAVAILABLE'})
    await lock_owner(db,owner_id)
    snapshot=await read_snapshot(db,owner_id)
    if snapshot.version!=expected_version:raise conflict()
    await admit_enqueue(db,owner_id,module_id)
    await db.execute(update(UserModule).where(UserModule.user_id==owner_id,UserModule.module_id==module_id).values(schedules_paused=False))
    db.add(OutboxMessage(topic='modules.schedules.resumed.v1',payload={'schema_version':1,'user_id':owner_id,'module_id':module_id,'version':snapshot.version}))
    await db.commit()
    return {'module_id':module_id,'version':snapshot.version,'schedules_paused':False,'work_dispatched':False}


async def admit_workflow_transition(db,owner_id,workflow):
    if workflow.user_id!=owner_id or not workflow.module_id or workflow.module_cancel_requested:
        raise HTTPException(409,{'code':'MODULE_WORK_CANCELLED'})
    identity=await admit_enqueue(db,owner_id,workflow.module_id)
    if identity.version!=workflow.module_version:raise HTTPException(409,{'code':'MODULE_VERSION_CHANGED'})
    return identity
