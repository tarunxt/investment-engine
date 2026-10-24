"""Explicit session-local simulation binding for the caller-owned UAT2 app.

No environment flag installs this binding. Every use checks the actual scope,
verified owner and current database state. Default applications remain closed.
"""
from datetime import datetime, timezone
from sqlalchemy import select
from fastapi import HTTPException
from app.domains.connections.models import IntegrationConnection
from app.domains.modules.registry import ModuleId, SimulationAvailability
from app.domains.runs.analysis_workflows.synthetic_sources import SimulationSourceScope
from app.domains.runs.analysis_workflows.contracts import WorkflowDenied, utc

SESSION = 'uat2.explicit_simulation_policy'


class SimulationPolicyBinding:
    def __init__(self, db, scope):
        if type(scope) is not SimulationSourceScope:
            raise WorkflowDenied('Explicit simulation policy scope required')
        self.db, self.scope = db, scope

    def availability(self, owner):
        self.scope.validate(self.db, owner)
        return SimulationAvailability(owner)

    def facts(self, owner, module):
        from app.domains.modules.policy import ModuleFacts
        self.scope.validate(self.db, owner)
        if module == ModuleId.INDMONEY_US:
            return ModuleFacts(jurisdiction='allowed', plan='allowed', connection='not_required', execution_capability=True)
        if module != ModuleId.ZERODHA_REBALANCE: return ModuleFacts()
        row = self.db.scalar(select(IntegrationConnection).where(
            IntegrationConnection.owner_id == owner, IntegrationConnection.provider == 'zerodha',
            IntegrationConnection.is_current.is_(True)).execution_options(populate_existing=True))
        ready = (row is not None and row.status == 'active' and row.credential_ref is None
            and (row.provider_account_id or '').startswith('FAKE') and row.token_expires_at is not None
            and utc(row.token_expires_at) > datetime.now(timezone.utc)
            and row.app_ownership_mode in {'user_owned', 'platform_managed'})
        return ModuleFacts(jurisdiction='allowed', plan='allowed',
            connection='ready' if ready else 'missing', execution_capability=bool(ready), action_confirmed=False)


def install_session_binding(db, scope):
    if (SESSION in db.info or 'public_service_reviewed_facts' in db.info
            or 'public_service_signup_context' in db.info):
        raise WorkflowDenied('Simulation session already bound or incompatible policy installed')
    binding = SimulationPolicyBinding(db, scope)
    db.info[SESSION] = binding
    return binding


def binding_for(db):
    info = getattr(db, 'info', None)
    if info is None: return None
    if type(info) is not dict: raise WorkflowDenied('Exact simulation session binding required')
    value = info.get(SESSION)
    if value is None: return None
    if type(value) is not SimulationPolicyBinding or value.db is not db:
        raise WorkflowDenied('Exact simulation session binding required')
    return value


def sync_availability(db, owner):
    value = binding_for(db)
    return value.availability(owner) if value else None


async def async_availability(db, owner):
    info = getattr(db, 'info', None)
    if type(info) is not dict or SESSION not in info: return None
    try: return await db.run_sync(lambda session: sync_availability(session, owner))
    except PermissionError: raise HTTPException(503, 'Current simulation policy unavailable') from None


class SimulationFactsResolver:
    def __init__(self, session): self.session = session
    async def resolve(self, owner_id, module_id):
        def resolve(db):
            binding = binding_for(db)
            if binding is None: raise WorkflowDenied('Simulation binding unavailable')
            return binding.facts(owner_id, module_id)
        return await self.session.run_sync(resolve)
