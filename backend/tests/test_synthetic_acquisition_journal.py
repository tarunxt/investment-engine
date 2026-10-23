"""Immutable same-day provenance on disposable SQLite; no hosted DB evidence."""
from datetime import timedelta
import pytest
from sqlalchemy import select
from test_stage18_linked_analysis_preview import linked_env
from app.domains.connections.models import IntegrationConnection
from app.domains.runs.analysis_workflows.contracts import WorkflowDenied, digest
from app.domains.runs.analysis_workflows.runtime import policy
from app.domains.runs.analysis_workflows.service import Workflows
from app.domains.runs.analysis_workflows.synthetic_composition import SyntheticAnalysis
from app.domains.runs.analysis_workflows.synthetic_journal import acquire, latest, TOPIC
from app.domains.runs.analysis_workflows.synthetic_sources import SimulationSourceScope
from app.domains.zerodha.models import ZerodhaPortfolioSnapshot
from app.infrastructure.database.outbox.models import OutboxMessage
from app.uat2.policy_bindings import install_session_binding
from app.uat2.synthetic_connections import connect


def setup(e):
    scope = SimulationSourceScope('preview')
    install_session_binding(e.db, scope)
    return scope, SyntheticAnalysis(scope=scope, policy=policy, source_storage='journal')


@pytest.mark.parametrize('mode', ['user_owned', 'platform_managed'])
def test_same_day_reconnect_creates_new_receipt_preserving_old_bytes_and_workflow_fence(linked_env, mode):
    e = linked_env; scope, composition = setup(e)
    source = acquire(e.db, 1, scope=scope, authorize=composition.authorize, key='first-source-key', now=e.now)
    workflow = Workflows(e.db, composition.runtime).create(1, 'india', 'first-workflow-key')
    e.db.commit()
    prior = e.db.scalar(select(IntegrationConnection).where(IntegrationConnection.owner_id == 1,
        IntegrationConnection.is_current.is_(True)))
    before = digest(list(e.db.scalars(select(OutboxMessage).where(OutboxMessage.topic == TOPIC)))[0].payload)
    connect(e.db, 1, mode=mode, key='connection-new-key', expected_id=prior.id, expected_version=prior.version)
    e.db.commit()
    with pytest.raises(WorkflowDenied): latest(e.db, 1, scope=scope)
    with pytest.raises(WorkflowDenied):
        acquire(e.db, 1, scope=scope, authorize=composition.authorize, key='first-source-key', now=e.now)
    replacement = acquire(e.db, 1, scope=scope, authorize=composition.authorize, key='second-source-key', now=e.now)
    e.db.commit()
    assert source['source_receipt_id'] != replacement['source_receipt_id']
    assert replacement['connection']['mode'] == mode
    assert latest(e.db, 1, scope=scope) == replacement
    messages = list(e.db.scalars(select(OutboxMessage).where(OutboxMessage.topic == TOPIC)
        .order_by(OutboxMessage.payload['sequence'].as_integer())))
    assert len(messages) == 2 and digest(messages[0].payload) == before
    assert e.db.scalar(select(ZerodhaPortfolioSnapshot)) is None
    with pytest.raises(WorkflowDenied): Workflows(e.db, composition.runtime).validate_current(workflow)
    assert Workflows(e.db, composition.runtime).create(1, 'india', 'new-workflow-key').id != workflow.id


@pytest.mark.parametrize('case', ['missing', 'foreign', 'tamper', 'stale', 'expired', 'snapshot_id', 'unbound', 'bad_key'])
def test_journal_reads_and_acquisition_fail_closed(linked_env, case):
    e = linked_env; scope, composition = setup(e)
    if case != 'missing':
        acquire(e.db, 1, scope=scope, authorize=composition.authorize, key='source-journal-key', now=e.now)
        e.db.commit()
    owner, args = 1, {}
    if case == 'foreign': owner = 2
    if case == 'tamper':
        row = e.db.scalar(select(OutboxMessage).where(OutboxMessage.topic == TOPIC))
        row.payload = {**row.payload, 'source_hash': '0' * 64}; e.db.commit()
    if case == 'stale':
        args['now'] = e.now + timedelta(hours=49)
        e.db.scalar(select(IntegrationConnection).where(IntegrationConnection.owner_id == 1)).token_expires_at = e.now + timedelta(hours=72)
        e.db.commit()
    if case == 'expired':
        e.db.scalar(select(IntegrationConnection).where(IntegrationConnection.owner_id == 1)).token_expires_at = e.now - timedelta(minutes=1)
        e.db.commit()
    if case == 'snapshot_id': args['snapshot_id'] = 1
    if case == 'unbound':
        scope = SimulationSourceScope('hosted')
    if case == 'bad_key':
        with pytest.raises(WorkflowDenied): acquire(e.db, 1, scope=scope, authorize=composition.authorize, key='short')
        return
    with pytest.raises(WorkflowDenied): latest(e.db, owner, scope=scope, **args)


def test_hosted_composition_requires_journal_and_missing_key_cannot_acquire(linked_env):
    e = linked_env; scope, composition = setup(e)
    with pytest.raises(WorkflowDenied): SyntheticAnalysis(scope=SimulationSourceScope('hosted'), policy=policy, source_storage='snapshot')
    assert SyntheticAnalysis(scope=SimulationSourceScope('hosted'), policy=policy).source_storage == 'journal'
    with pytest.raises(WorkflowDenied): composition.acquire(e.db, 1)
    first = composition.acquire(e.db, 1, key='source-journal-key'); e.db.commit()
    assert first['snapshot_id'] is None and first['source_receipt_id']
    assert composition.acquire(e.db, 1, key='source-journal-key') == first
