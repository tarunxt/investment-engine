"""SQLite journal and real execution-state-machine evidence, no hosted claim."""
from copy import deepcopy

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from test_stage14_order_intents import env, approve, order, NOW
from test_stage15_execution import market
from app.infrastructure.database.outbox.models import OutboxMessage
from app.domains.order_intents.contracts import OrderDenied, digest
from app.domains.order_intents.execution import ExecutionWorker, venue_binding
from app.domains.order_intents.execution_fake import MarketDataFake
from app.domains.order_intents.execution_models import ExecutionFence, ExecutionRun, ExecutionAttempt
from app.domains.order_intents.journal_fake import JournalBrokerFake, TOPIC
from app.domains.order_intents.service import Orders


@pytest.fixture
def journal(tmp_path):
    engine = create_engine('sqlite:///' + str(tmp_path / 'venue.sqlite'))
    OutboxMessage.__table__.create(engine)
    try:
        yield engine
    finally:
        engine.dispose()


@pytest.mark.parametrize('outcome', ['filled', 'partial', 'acknowledged', 'rejected', 'after_acceptance'])
def test_acceptance_survives_adapter_restart(journal, outcome):
    binding, reference, leg = digest('owner1'), digest('intent1'), order()['legs'][0]
    broker = JournalBrokerFake(journal, binding, [outcome])
    if outcome == 'after_acceptance':
        with pytest.raises(TimeoutError): broker.submit(leg, reference, binding)
    else:
        value = broker.submit(leg, reference, binding)
        value['state'] = 'tampered-caller-copy'
    restarted = JournalBrokerFake(journal, binding)
    result = restarted.reconcile(reference, binding)
    assert result['matches'][0]['state'] == ('filled' if outcome == 'after_acceptance' else outcome)
    assert not restarted.calls and len(broker.calls) == 1
    with pytest.raises(OrderDenied, match='NO_SUBMISSION_REPLAY'):
        restarted.submit(leg, reference, binding)


@pytest.mark.parametrize('outcome', ['before_acceptance', 'rate_limit'])
def test_preacceptance_uncertainty_has_no_invented_receipt(journal, outcome):
    binding, reference = digest('owner1'), digest('intent1')
    broker = JournalBrokerFake(journal, binding, [outcome])
    with pytest.raises(TimeoutError): broker.submit(order()['legs'][0], reference, binding)
    assert JournalBrokerFake(journal, binding).reconcile(reference, binding) == {
        'matches': [], 'trades': [], 'ambiguous': False}


@pytest.mark.parametrize('change', ['topic', 'binding', 'receipt', 'trades', 'schema', 'digest'])
def test_tampered_journal_is_not_reconciliation_evidence(journal, change):
    binding, reference = digest('owner1'), digest('intent1')
    broker = JournalBrokerFake(journal, binding)
    broker.submit(order()['legs'][0], reference, binding)
    with Session(journal) as db:
        row = db.scalar(select(OutboxMessage))
        if change == 'topic': row.topic = 'job.created.v2'
        else:
            value = deepcopy(row.payload)
            value[change] = {'state': 'filled'} if change == 'receipt' else 'tampered'
            row.payload = value
        db.commit()
    with pytest.raises(OrderDenied): broker.reconcile(reference, binding)


def test_cross_binding_cannot_read_or_repeat_reference(journal):
    binding, reference = digest('owner1'), digest('intent1')
    broker = JournalBrokerFake(journal, binding)
    broker.submit(order()['legs'][0], reference, binding)
    foreign = JournalBrokerFake(journal, digest('owner2'))
    with pytest.raises(OrderDenied): foreign.reconcile(reference, foreign.binding)
    with pytest.raises(OrderDenied): foreign.submit(order()['legs'][0], reference, foreign.binding)
    with pytest.raises(OrderDenied): broker.reconcile(reference, foreign.binding)
    with Session(journal) as db: assert db.scalar(select(OutboxMessage)).topic == TOPIC


@pytest.mark.parametrize('outcome', ['filled', 'partial', 'after_acceptance', 'before_acceptance'])
def test_actual_execution_restarts_reconcile_without_resubmission(env, journal, outcome):
    for model in (ExecutionFence, ExecutionRun, ExecutionAttempt): model.__table__.create(env.engine)
    row, event = approve(env)
    owner, intent, event_id = row.owner_id, row.id, event.id
    broker = JournalBrokerFake(journal, venue_binding(row), [outcome])
    source = MarketDataFake(market(row))
    worker = ExecutionWorker(env.service, broker, source)
    if outcome in {'after_acceptance', 'before_acceptance'}:
        with pytest.raises(TimeoutError): worker.dispatch(event_id)
    else: worker.dispatch(event_id)
    env.db.close()
    restarted = JournalBrokerFake(journal, broker.binding)
    with Session(env.engine, expire_on_commit=False) as db:
        service = Orders(db, policy=env.policy, risk=env.risk, clock=lambda: NOW)
        worker = ExecutionWorker(service, restarted, source)
        expected = {'after_acceptance': 'filled', 'before_acceptance': 'unknown'}.get(outcome, outcome)
        assert worker.reconcile(owner, intent).state == expected
        with pytest.raises(OrderDenied): worker.dispatch(event_id)
        db.rollback()
    assert not restarted.calls and len(broker.calls) == 1


def test_same_engine_is_denied(env):
    with pytest.raises(OrderDenied, match='SEPARATE_SYNTHETIC_VENUE_REQUIRED'):
        ExecutionWorker(env.service, JournalBrokerFake(env.engine, digest('owner')), None)


@pytest.mark.parametrize('outcome', [['live'], ['filled'] * 21, [None]])
def test_unknown_or_unbounded_scenarios_fail_before_io(journal, outcome):
    with pytest.raises(OrderDenied): JournalBrokerFake(journal, digest('owner'), outcome)
