"""Shared acquisition seam; SQLite evidence, never hosted PostgreSQL proof."""
import pytest
from sqlalchemy import select
from test_stage18_linked_analysis_preview import linked_env
from app.domains.auth.models import User
from app.domains.connections.models import IntegrationConnection
from app.domains.modules.models import UserModule
from app.domains.zerodha.models import ZerodhaPortfolioSnapshot
from app.domains.runs.analysis_workflows.synthetic_sources import acquire, SimulationSourceScope
from app.domains.runs.analysis_workflows.contracts import WorkflowDenied
from app.domains.runs.analysis_workflows.synthetic_composition import SyntheticAnalysis
from app.domains.modules.lifecycle import WorkIdentity


@pytest.mark.parametrize('owner,mode', [(1, 'user_owned'), (2, 'platform_managed')])
def test_shared_source_preserves_actual_mode_and_provenance(linked_env, owner, mode):
    e = linked_env
    row = acquire(e.db, owner, scope=SimulationSourceScope('preview'), authorize=e.runtime.policy, now=e.now)
    e.db.commit()
    assert row.acquisition_json['app_mode'] == mode
    assert row.acquisition_json['owner_id'] == owner
    assert row.acquisition_json['simulation'] is True
    assert acquire(e.db, owner, scope=SimulationSourceScope('preview'), authorize=e.runtime.policy, now=e.now).id == row.id


@pytest.mark.parametrize('change', ['credentials', 'disabled', 'unverified', 'foreign_email', 'module', 'environment', 'missing_scope', 'hosted_scope'])
def test_source_denial_never_creates_or_relabels_data(linked_env, monkeypatch, change):
    e = linked_env
    scope = SimulationSourceScope('preview')
    if change == 'credentials':
        row = e.db.scalar(select(IntegrationConnection).where(IntegrationConnection.owner_id == 1))
        row.credential_ref = 'must-not-be-read'
    elif change == 'disabled': e.db.get(User, 1).is_active = False
    elif change == 'unverified': e.db.get(User, 1).is_verified = False
    elif change == 'foreign_email': e.db.get(User, 1).email = 'outside@example.invalid'
    elif change == 'module': e.db.scalar(select(UserModule).where(UserModule.user_id == 1, UserModule.module_id == 'zerodha_rebalance')).enabled = False
    elif change == 'environment': monkeypatch.setenv('ENVIRONMENT', 'production')
    elif change == 'missing_scope': scope = None
    else: scope = SimulationSourceScope('hosted')
    e.db.commit()
    with pytest.raises(WorkflowDenied):
        acquire(e.db, 1, scope=scope, authorize=e.runtime.policy, now=e.now)
    e.db.commit()
    assert not list(e.db.scalars(select(ZerodhaPortfolioSnapshot)))


def test_source_rejects_noncanonical_authorization_before_source_write(linked_env):
    e = linked_env
    with pytest.raises(WorkflowDenied, match='canonical'):
        acquire(e.db, 1, scope=SimulationSourceScope('preview'), authorize=lambda *args: True, now=e.now)
    e.db.commit()
    assert not list(e.db.scalars(select(ZerodhaPortfolioSnapshot)))


def test_scoped_analysis_rejects_forged_module_identity_and_changed_credentials(linked_env):
    e = linked_env
    analysis = SyntheticAnalysis(scope=SimulationSourceScope('preview'),
        policy=lambda *args, **kwargs: WorkIdentity(1, 'indmoney_us', 1))
    with pytest.raises(WorkflowDenied, match='canonical'):
        analysis.runtime.policy(e.db, 1, 'india')
    e.preview.synthetic_acquire(e.db, 1, now=e.now); e.db.commit()
    connection = e.db.scalar(select(IntegrationConnection).where(IntegrationConnection.owner_id == 1))
    connection.credential_ref = 'never-read-this-material'; e.db.commit()
    with pytest.raises(WorkflowDenied, match='synthetic'):
        e.preview.source(e.db, 1, 'india')


@pytest.mark.parametrize('scope,policy', [(None, lambda: None), (SimulationSourceScope('hosted'), None)])
def test_analysis_has_no_implicit_scope_or_policy(scope, policy):
    with pytest.raises(WorkflowDenied): SyntheticAnalysis(scope=scope, policy=policy)
