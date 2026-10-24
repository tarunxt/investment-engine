"""Session-bound simulation policy on disposable SQL; no hosted acceptance."""
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from test_stage18_linked_analysis_preview import linked_env
from app.domains.auth.models import User, ActivityLog
from app.domains.connections.models import IntegrationConnection
from app.domains.modules.lifecycle import current_sync, WorkIdentity, ModuleLifecycleDenied
from app.domains.modules.policy import ModulePolicy
from app.domains.modules.registry import ModuleId, REGISTRY, platform_available, SimulationAvailability
from app.domains.modules.schemas import ModulePatch
from app.domains.modules.service import describe, patch_modules
from app.domains.runs.analysis_workflows.contracts import WorkflowDenied
from app.domains.runs.analysis_workflows.synthetic_sources import SimulationSourceScope
from app.uat2.policy_bindings import SESSION, install_session_binding


def test_uat2_default_stays_closed_and_scoped_binding_allows_only_simulated_modules(linked_env, monkeypatch):
    e = linked_env; monkeypatch.setenv('CREDX_UAT2', '1')
    identity = WorkIdentity(1, 'zerodha_rebalance', 1)
    with pytest.raises(ModuleLifecycleDenied): current_sync(e.db, identity)
    install_session_binding(e.db, SimulationSourceScope('preview'))
    assert current_sync(e.db, identity).allowed
    assert current_sync(e.db, WorkIdentity(1, 'indmoney_us', 1)).allowed
    with pytest.raises(ModuleLifecycleDenied): current_sync(e.db, identity, capability='execute', boundary='side_effect')
    for module in REGISTRY.values():
        assert not platform_available(module, uat2=True)[0]
        available = platform_available(module, uat2=True, simulation=SimulationAvailability(1), owner_id=1)[0]
        assert available == (module.id in {ModuleId.ZERODHA_REBALANCE, ModuleId.INDMONEY_US})
        assert not platform_available(module, uat2=True, simulation=SimulationAvailability(2), owner_id=1)[0]


@pytest.mark.parametrize('change', ['unverified', 'inactive', 'credentials', 'missing_binding', 'forged_binding', 'hosted_scope'])
def test_current_worker_policy_rechecks_scope_and_credentials(linked_env, monkeypatch, change):
    e = linked_env; monkeypatch.setenv('CREDX_UAT2', '1')
    install_session_binding(e.db, SimulationSourceScope('hosted' if change == 'hosted_scope' else 'preview'))
    if change == 'unverified': e.db.get(User, 1).is_verified = False
    elif change == 'inactive': e.db.get(User, 1).is_active = False
    elif change == 'credentials':
        e.db.scalar(select(IntegrationConnection).where(IntegrationConnection.owner_id == 1)).credential_ref = 'real-material-must-not-be-read'
    elif change == 'missing_binding': e.db.info.pop(SESSION)
    elif change == 'forged_binding': e.db.info[SESSION] = object()
    e.db.commit()
    with pytest.raises(ModuleLifecycleDenied):
        current_sync(e.db, WorkIdentity(1, 'zerodha_rebalance', 1))


@pytest.mark.asyncio
async def test_actual_async_preferences_and_policy_use_same_scoped_binding(linked_env, monkeypatch):
    e = linked_env; monkeypatch.setenv('CREDX_UAT2', '1')
    ActivityLog.__table__.create(e.engine, checkfirst=True)
    engine = create_async_engine('sqlite+aiosqlite:///' + str(e.path))
    try:
        async with AsyncSession(engine, expire_on_commit=False) as db:
            decision = await ModulePolicy(db).authorize(owner_id=1, resource_owner_id=1,
                module_id='indmoney_us', capability='import', boundary='http')
            assert not decision.allowed and 'MODULE_UNAVAILABLE' in decision.reasons
            await db.run_sync(lambda session: install_session_binding(session, SimulationSourceScope('preview')))
            result = await describe(db, 1)
            modules = {m['module_id']: m for m in result['modules']}
            assert modules['indmoney_us']['availability']['available']
            assert 'synthetic' in modules['zerodha_rebalance']['availability']['reason']
            assert not modules['bullpen_live']['availability']['available']
            decision = await ModulePolicy(db).authorize(owner_id=1, resource_owner_id=1,
                module_id='indmoney_us', capability='import', boundary='http')
            assert decision.allowed
            foreign = await ModulePolicy(db).authorize(owner_id=1, resource_owner_id=2,
                module_id='indmoney_us', capability='import', boundary='http')
            assert not foreign.allowed and 'OWNER_MISMATCH' in foreign.reasons
            patch = ModulePatch.model_validate({'expected_version': 1, 'updates': [
                {'module_id': 'indmoney_us', 'enabled': False}]})
            updated = await patch_modules(db, 1, patch)
            assert updated['version'] == 2
            assert not (await ModulePolicy(db).authorize(owner_id=1, resource_owner_id=1,
                module_id='indmoney_us', capability='import', boundary='http')).allowed
    finally: await engine.dispose()


def test_session_bindings_cannot_be_replaced_or_borrowed(linked_env):
    from sqlalchemy.orm import Session
    e = linked_env
    binding = install_session_binding(e.db, SimulationSourceScope('preview'))
    with pytest.raises(WorkflowDenied): install_session_binding(e.db, SimulationSourceScope('preview'))
    with Session(e.engine) as other:
        other.info[SESSION] = binding
        with pytest.raises(ModuleLifecycleDenied): current_sync(other, WorkIdentity(1, 'zerodha_rebalance', 1))
