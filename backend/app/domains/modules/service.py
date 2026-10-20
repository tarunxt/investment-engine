"""Read-only virtual defaults and owner-versioned atomic selection updates."""
import json
from fastapi import HTTPException
from app.core.uat2 import uat2_mode
from app.domains.auth.models import ActivityLog
from .models import UserModule
from .policy import DefaultFactsResolver, ModuleFacts, decide
from .registry import ModuleConfigV1, REGISTRY, platform_available
from .store import claim_version, conflict, read_snapshot
from .schemas import ModuleCollection


async def describe(db, owner_id: int, *, snapshot=None) -> dict:
    snapshot = snapshot or await read_snapshot(db, owner_id)
    resolver = DefaultFactsResolver()
    modules = []
    for id, spec in REGISTRY.items():
        row = snapshot.rows.get(id)
        facts = await resolver.resolve(owner_id, id)
        available, reason = platform_available(spec, uat2=uat2_mode())
        modules.append({'module_id': id.value, 'label': spec.label, 'category': spec.category,
            'selection': {'schedules_paused': row.schedules_paused if row else True, 'enabled': snapshot.selected(id), 'version': row.version if row else 0,
                'config': ModuleConfigV1.model_validate(row.config if row else {}).model_dump()},
            'availability': {'available': available, 'reason': reason},
            'entitlement': {'jurisdiction': facts.jurisdiction, 'plan': facts.plan},
            'connection': {'kind': spec.connection, 'state': facts.connection},
            'execution': {'capable': facts.execution_capability, 'action_confirmed': False},
            'requires': [dependency.value for dependency in spec.requires],
            'capabilities': {capability: decide(owner_id=owner_id, resource_owner_id=owner_id,
                active=True, module_id=id.value, capability=capability, boundary='http',
                snapshot=snapshot, facts=facts, uat2=uat2_mode()).model_dump()
                for capability in sorted(spec.capabilities)}})
    return {'schema_version': 1, 'owner_id': owner_id, 'version': snapshot.version,
        'modules': modules, 'operational_enforcement_complete': False}


def validate_selection(snapshot, patch):
    enabled = {id for id in REGISTRY if snapshot.selected(id)}
    for update in patch.updates:
        if update.enabled:
            if not platform_available(REGISTRY[update.module_id], uat2=uat2_mode())[0]:
                raise HTTPException(409, {'code': 'MODULE_UNAVAILABLE', 'module_id': update.module_id.value})
            enabled.add(update.module_id)
        else:
            enabled.discard(update.module_id)
    for id in enabled:
        if any(dependency not in enabled for dependency in REGISTRY[id].requires):
            raise HTTPException(409, {'code': 'MODULE_DEPENDENCY_REQUIRED', 'module_id': id.value})


async def patch_modules(db, owner_id: int, patch) -> dict:
    snapshot = await read_snapshot(db, owner_id)
    if snapshot.version != patch.expected_version:
        raise conflict()
    validate_selection(snapshot, patch)
    try:
        from .lifecycle import lock_owner
        await lock_owner(db,owner_id)
        version = await claim_version(db, snapshot, patch.expected_version)
        for change in patch.updates:
            row = snapshot.rows.get(change.module_id)
            if row is None:
                row = UserModule(user_id=owner_id, module_id=change.module_id.value)
                db.add(row)
            row.enabled = change.enabled
            row.config = change.config.model_dump()
            row.version = version
        db.add(ActivityLog(user_id=owner_id, action='module_preferences_updated',
            resource_type='user_modules', details=json.dumps({'version': version,
                'changes': [{'module_id': change.module_id.value, 'enabled': change.enabled} for change in patch.updates]}, sort_keys=True)))
        await db.flush()
        from .lifecycle import selection_changed
        await selection_changed(db, owner_id, version, patch.updates)
        await db.flush()
        # Form the response in the same transaction/version, not after a
        # concurrent next patch has committed. Commit only a valid response.
        result = ModuleCollection.model_validate(await describe(db, owner_id)).model_dump(mode="json")
        await db.commit()
        return result
    except Exception as exc:
        await db.rollback()
        from sqlalchemy.exc import DBAPIError
        if isinstance(exc,DBAPIError) and getattr(exc.orig,'sqlstate',getattr(exc.orig,'pgcode',None)) in {'55P03','57014'}:
            raise HTTPException(409,{'code':'MODULE_STATE_BUSY','message':'An already-started operation is finishing; reload and retry'}) from None
        raise


async def disable_impact(db, owner_id: int, request) -> dict:
    snapshot = await read_snapshot(db, owner_id)
    if snapshot.version != request.expected_version:
        raise conflict()
    requested = set(request.module_ids)
    affected = set(requested)
    while True:
        found = {id for id, spec in REGISTRY.items() if snapshot.selected(id)
            and any(dependency in affected for dependency in spec.requires)} - affected
        if not found:
            break
        affected.update(found)
    dependents = [id.value for id in REGISTRY if id in affected and id not in requested]
    from sqlalchemy import select,func
    from app.domains.jobs.models import Job
    from app.shared.types import JobStatus
    queued=await db.scalar(select(func.count()).select_from(Job).where(Job.user_id==owner_id,Job.module_id.in_([id.value for id in affected]),Job.status.in_([JobStatus.PENDING,JobStatus.SCHEDULED])))
    running=await db.scalar(select(func.count()).select_from(Job).where(Job.user_id==owner_id,Job.module_id.in_([id.value for id in affected]),Job.status==JobStatus.PROCESSING))
    return {'schema_version': 1, 'owner_id': owner_id, 'version': snapshot.version,
        'modules': [{'module_id': id.value, 'currently_enabled': snapshot.selected(id),
            'capabilities_disabled_by_policy': sorted(REGISTRY[id].capabilities)} for id in request.module_ids],
        'dependent_modules': dependents,
        'data_and_connections_retained': True, 'changes_applied': False,
        'active_work': {'status': 'not_inspected', 'analysis_inspected': True, 'reason': 'Owned version-bound analysis counts are inspected; this is not a complete accepted-order or legacy-runtime audit. Disable cancels queued analysis, requests running stop and pauses schedules; already-started effects may finish before disable commits', 'queued_analysis': queued, 'running_analysis': running, 'schedules_will_pause': True},
        'core_account_features_retained': True}
