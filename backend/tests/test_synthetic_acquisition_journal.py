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

def test_prior_source_without_price_study_remains_byte_identical_and_is_not_backfilled(linked_env):
    from copy import deepcopy
    e=linked_env;scope,composition=setup(e)
    acquire(e.db,1,scope=scope,authorize=composition.authorize,key='legacy-source-study-compat',now=e.now);e.db.commit()
    row=e.db.scalar(select(OutboxMessage).where(OutboxMessage.topic==TOPIC))
    # Disposable fixture reconstructs the exact prior source format; no repair API.
    legacy=deepcopy(row.payload['source']);legacy.pop('price_history')
    legacy['content_hash']=digest({key:value for key,value in legacy.items() if key!='content_hash'})
    row.payload={**deepcopy(row.payload),'source':legacy,'source_hash':digest(legacy)};e.db.commit()
    before=deepcopy(row.payload)
    assert latest(e.db,1,scope=scope,now=e.now)==legacy
    assert row.payload==before and 'price_history' not in row.payload['source']


def test_rehashed_tampered_study_cannot_become_an_accepted_source_claim(linked_env):
    from copy import deepcopy
    e=linked_env;scope,composition=setup(e)
    acquire(e.db,1,scope=scope,authorize=composition.authorize,key='tampered-source-study',now=e.now);e.db.commit()
    row=e.db.scalar(select(OutboxMessage).where(OutboxMessage.topic==TOPIC))
    altered=deepcopy(row.payload['source']);altered['price_history']['study']['rsi_14']='99.00'
    history=altered['price_history'];history['history_hash']=digest({key:value for key,value in history.items() if key!='history_hash'})
    altered['content_hash']=digest({key:value for key,value in altered.items() if key!='content_hash'})
    row.payload={**deepcopy(row.payload),'source':altered,'source_hash':digest(altered)};e.db.commit()
    with pytest.raises(WorkflowDenied):latest(e.db,1,scope=scope,now=e.now)
