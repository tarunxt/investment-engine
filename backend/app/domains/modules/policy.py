"""One default-deny policy contract for every transport and effect boundary.

Facts are server-resolved, never accepted from module preference requests.
A policy decision does not replace resource ownership, Stage05 operator gates,
provider approval or the order-specific confirmation lifecycle.
"""
import asyncio
import logging
from typing import Literal, Protocol
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from app.core.uat2 import uat2_mode
from app.domains.auth.models import User
from .registry import (CORE_CAPABILITIES, KNOWN_CAPABILITIES, INTERNAL_ANALYSIS_CAPABILITIES,
    INTERNAL_ANALYSIS_CONSUMERS, ModuleId, REGISTRY, platform_available)
from .schemas import ModuleDecision
from .store import SelectionSnapshot, read_snapshot

logger = logging.getLogger(__name__)
Boundary = Literal['http', 'stream', 'worker', 'side_effect', 'internal']


class ModuleFacts(BaseModel):
    model_config = ConfigDict(strict=True, frozen=True, extra="forbid", revalidate_instances="always")
    jurisdiction: Literal['allowed', 'denied', 'unknown'] = 'unknown'
    plan: Literal['allowed', 'denied', 'unknown'] = 'unknown'
    connection: Literal['ready', 'missing', 'unknown', 'not_required'] = 'unknown'
    execution_capability: bool = False
    action_confirmed: bool = False


class FactsResolver(Protocol):
    async def resolve(self, owner_id: int, module_id: ModuleId) -> ModuleFacts: ...


class DefaultFactsResolver:
    async def resolve(self, owner_id: int, module_id: ModuleId) -> ModuleFacts:
        # No verified residence/plan source exists yet. Do not infer it from
        # email/timezone, inspect credentials or call providers to discover it.
        spec = REGISTRY[module_id]
        return ModuleFacts(connection='not_required' if spec.connection in {'none', 'manual_import'} else 'unknown')


def decide(*, owner_id: int, resource_owner_id: int | None, active: bool,
           module_id: str | None, capability: str, boundary: Boundary,
           snapshot, facts: ModuleFacts, uat2: bool,
           expected_version: int | None = None) -> ModuleDecision:
    reasons = []
    if not active:
        reasons.append('ACTIVE_IDENTITY_REQUIRED')
    if owner_id != resource_owner_id:
        reasons.append('OWNER_MISMATCH')
    if boundary not in {'http', 'stream', 'worker', 'side_effect', 'internal'}:
        raise ValueError('Unknown policy boundary')
    if module_id is None:
        if capability not in CORE_CAPABILITIES:
            reasons.append('UNKNOWN_CAPABILITY')
    else:
        if expected_version is not None and expected_version != snapshot.version:
            reasons.append("MODULE_VERSION_CHANGED")
        try:
            id = ModuleId(module_id)
            spec = REGISTRY[id]
        except (ValueError, KeyError):
            reasons.append('UNKNOWN_MODULE')
        else:
            if capability not in KNOWN_CAPABILITIES or capability not in spec.capabilities:
                reasons.append('UNKNOWN_CAPABILITY')
            if not snapshot.selected(id):
                reasons.append('MODULE_NOT_SELECTED')
            if not platform_available(spec, uat2=uat2)[0]:
                reasons.append('MODULE_UNAVAILABLE')
            if facts.jurisdiction != 'allowed':
                reasons.append('JURISDICTION_NOT_ENTITLED')
            if facts.plan != 'allowed':
                reasons.append('PLAN_NOT_ENTITLED')
            if capability != 'view' and facts.connection not in {'ready', 'not_required'}:
                reasons.append('CONNECTION_NOT_READY')
            if (capability in {'execute', 'export', 'import'} or boundary == 'side_effect') and not facts.execution_capability:
                reasons.append('EXECUTION_CAPABILITY_REQUIRED')
            if capability == 'execute' and not facts.action_confirmed:
                reasons.append('EXPLICIT_ACTION_CONFIRMATION_REQUIRED')
            for dependency in spec.requires:
                if not snapshot.selected(dependency):
                    reasons.append('DEPENDENCY_NOT_SELECTED')
    return ModuleDecision(allowed=not reasons, reasons=reasons, owner_id=owner_id,
        module_id=module_id, capability=capability, boundary=boundary,
        selection_version=snapshot.version if module_id is not None else None)


class ModulePolicy:
    def __init__(self, db, resolver: FactsResolver | None = None):
        self.db = db
        self.resolver = resolver or DefaultFactsResolver()

    async def authorize(self, *, owner_id: int, resource_owner_id: int | None,
                        module_id: str | None, capability: str, boundary: Boundary,
                        expected_version: int | None = None) -> ModuleDecision:
        active = bool(await self.db.scalar(select(User.is_active).where(User.id == owner_id)))
        # Core account access is independent even of corrupt optional state.
        snapshot = (await read_snapshot(self.db, owner_id)) if module_id is not None else SelectionSnapshot(owner_id, 0, {})
        facts = ModuleFacts()
        try:
            id = ModuleId(module_id) if module_id is not None else None
        except ValueError:
            id = None
        preliminary = decide(owner_id=owner_id, resource_owner_id=resource_owner_id,
            active=active, module_id=module_id, capability=capability, boundary=boundary,
            snapshot=snapshot, facts=facts, uat2=uat2_mode(), expected_version=expected_version)
        structural_denials = {'ACTIVE_IDENTITY_REQUIRED', 'OWNER_MISMATCH', 'MODULE_VERSION_CHANGED',
            'UNKNOWN_MODULE', 'UNKNOWN_CAPABILITY', 'MODULE_NOT_SELECTED', 'MODULE_UNAVAILABLE', 'DEPENDENCY_NOT_SELECTED'}
        if id is not None and not structural_denials.intersection(preliminary.reasons):
            try:
                async with asyncio.timeout(1):
                    facts = ModuleFacts.model_validate(await self.resolver.resolve(owner_id, id))
            except Exception:
                logger.warning('module_policy_facts_unavailable actor=%s module=%s', owner_id, module_id)
                facts = ModuleFacts()
        decision = decide(owner_id=owner_id, resource_owner_id=resource_owner_id,
            active=active, module_id=module_id, capability=capability, boundary=boundary,
            snapshot=snapshot, facts=facts, uat2=uat2_mode(), expected_version=expected_version)
        logger.info('module_policy actor=%s module=%s capability=%s boundary=%s version=%s decision=%s reasons=%s',
            owner_id, module_id, capability, boundary, snapshot.version,
            'allow' if decision.allowed else 'deny', ','.join(decision.reasons))
        return decision

    async def internal_analysis(self, *, owner_id: int, resource_owner_id: int,
                                consumer: ModuleId, service_capability: str,
                                expected_version: int | None = None) -> ModuleDecision:
        if consumer not in INTERNAL_ANALYSIS_CONSUMERS or service_capability not in INTERNAL_ANALYSIS_CAPABILITIES:
            return ModuleDecision(allowed=False, reasons=['UNKNOWN_CAPABILITY'], owner_id=owner_id,
                module_id=str(consumer), capability=service_capability, boundary='internal', selection_version=0)
        # Authorize the consumer's analysis; optional AI Studio/Scanner UI
        # selections are intentionally not dependencies of internal services.
        return await self.authorize(owner_id=owner_id, resource_owner_id=resource_owner_id,
            module_id=consumer.value, capability='analyze', boundary='internal', expected_version=expected_version)
