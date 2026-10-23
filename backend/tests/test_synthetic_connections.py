"""Disposable connection lifecycle; no provider material or network allowed."""
from datetime import datetime, timezone
import pytest
from sqlalchemy import select
from test_stage18_linked_analysis_preview import linked_env
from app.domains.connections.models import IntegrationConnection
from app.domains.runs.analysis_workflows.contracts import WorkflowDenied
from app.domains.runs.analysis_workflows.synthetic_sources import SimulationSourceScope
from app.uat2.policy_bindings import install_session_binding
from app.uat2.synthetic_connections import connect, describe


@pytest.mark.parametrize('mode', ['user_owned', 'platform_managed'])
def test_keyless_reconnect_retains_prior_binding_and_replays_exact_request(linked_env, mode):
    e = linked_env; install_session_binding(e.db, SimulationSourceScope('preview'))
    prior = e.db.scalar(select(IntegrationConnection).where(IntegrationConnection.owner_id == 1))
    original = (prior.id, prior.version, prior.app_ownership_mode, prior.token_expires_at)
    row = connect(e.db, 1, mode=mode, key='fake-connect-key', expected_id=prior.id, expected_version=prior.version)
    e.db.commit()
    assert row.id != prior.id and row.credential_ref is None and not prior.is_current
    assert (prior.id, prior.version, prior.app_ownership_mode, prior.token_expires_at) == original
    assert describe(row)['provider_approval_verified'] is False
    assert describe(row)['financial_execution_granted'] is False
    assert connect(e.db, 1, mode=mode, key='fake-connect-key', expected_id=prior.id, expected_version=prior.version).id == row.id
    assert e.db.scalar(select(IntegrationConnection).where(IntegrationConnection.owner_id == 2)).is_current
    with pytest.raises(WorkflowDenied):
        connect(e.db, 1, mode=mode, key='fake-connect-key', expected_id=row.id, expected_version=1)


@pytest.mark.parametrize('case', ['unbound', 'foreign', 'stale', 'credentials', 'real_account', 'invalid_mode', 'invalid_clock'])
def test_connection_changes_fail_closed_and_rollback_preserves_current(linked_env, case):
    e = linked_env
    if case != 'unbound': install_session_binding(e.db, SimulationSourceScope('preview'))
    prior = e.db.scalar(select(IntegrationConnection).where(IntegrationConnection.owner_id == 1))
    if case == 'credentials': prior.credential_ref = 'do-not-read-material'
    if case == 'real_account': prior.provider_account_id = 'REAL_ACCOUNT'
    e.db.commit()
    args = dict(mode='user_owned', key='fake-connect-key', expected_id=prior.id, expected_version=prior.version)
    if case == 'foreign': args['expected_id'] = e.db.scalar(select(IntegrationConnection).where(IntegrationConnection.owner_id == 2)).id
    if case == 'stale': args['expected_version'] = 98
    if case == 'invalid_mode': args['mode'] = 'live'
    if case == 'invalid_clock': args['now'] = datetime.now()
    with pytest.raises(WorkflowDenied): connect(e.db, 1, **args)
    e.db.rollback(); e.db.expire_all()
    assert e.db.get(IntegrationConnection, prior.id).is_current
    assert len(list(e.db.scalars(select(IntegrationConnection)))) == 2
