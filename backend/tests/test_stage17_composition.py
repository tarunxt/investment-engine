"""Explicit in-process composition only; no brokers/listeners/tasks sent."""
from datetime import timedelta
from uuid import uuid4
import pytest
from celery import Celery
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.domains.ai_limits.contracts import BoundaryDenied
from app.domains.modules.policy import ModuleFacts
from app.domains.order_intents.service import Orders
from app.domains.order_intents.execution import ExecutionWorker
from app.domains.public_service.composition import PublicServiceServer, ServerBindings, IsolatedConsumerComposition
from app.domains.public_service.dispatch import SyntheticWorkBindings, TOPIC
from app.infrastructure.database.outbox.models import OutboxMessage
from test_stage17_reviewed_residency import setup as residency_setup, consent, issue, NOW as RESIDENCY_NOW
from test_stage15_execution import setup, env, NOW
from test_stage17_dispatch import queue

def test_default_server_composition_cannot_promote_supplied_jurisdiction_or_construct_privacy():
    server = PublicServiceServer()
    facts = ModuleFacts(jurisdiction='allowed', plan='allowed')
    assert server.module_facts(None, 1, facts).jurisdiction == 'unknown'
    assert server.onboarding(None, 1)['eligible'] is False
    with pytest.raises(BoundaryDenied): server.account_reader(None, None)
    with pytest.raises(BoundaryDenied): server.deletion_planner(None, None)

def test_configured_reviewed_evidence_changes_only_jurisdiction_and_revocation_denies(residency_setup):
    db, p = residency_setup; issue(db, p, consent(db, p)); db.commit()
    server = PublicServiceServer(bindings=ServerBindings(residency_policy=p.policy), keyring=p.keyring)
    facts = ModuleFacts(plan='unknown', connection='missing', execution_capability=False, action_confirmed=False)
    result = server.module_facts(db, 1, facts, now=RESIDENCY_NOW)
    assert result.jurisdiction == 'allowed'
    assert result.model_dump(exclude={'jurisdiction'}) == facts.model_dump(exclude={'jurisdiction'})
    assert server.onboarding(db, 1, now=RESIDENCY_NOW)['eligible'] is True
    assert server.onboarding(db, 3, now=RESIDENCY_NOW)['eligible'] is False
    p.revoke(db, 1, 1); db.commit()
    assert server.module_facts(db, 1, facts, now=RESIDENCY_NOW).jurisdiction == 'denied'

def test_real_unconfigured_bindings_cannot_be_replaced_with_request_dicts():
    with pytest.raises(BoundaryDenied): PublicServiceServer(bindings={'residency_policy': 'approved'})
    with pytest.raises(BoundaryDenied): PublicServiceServer().module_facts(None, 1, {'jurisdiction': 'allowed'})
    with pytest.raises(BoundaryDenied): IsolatedConsumerComposition(session_factory=lambda: None)

def test_explicit_registration_is_disabled_separately_routed_and_never_adds_schedule():
    app = Celery('fixture_' + uuid4().hex, broker='memory://', backend='cache+memory://')
    app.conf.task_routes = {'existing.task': {'queue': 'existing'}}
    app.conf.beat_schedule = {'existing': {'task': 'existing.task', 'schedule': 60}}
    before = dict(app.conf.beat_schedule); composition = IsolatedConsumerComposition()
    tasks = composition.register(app)
    try:
        assert app.conf.task_routes['existing.task'] == {'queue': 'existing'}
        assert app.conf.task_routes['public_service.consume.analysis']['queue'] == 'ai'
        assert app.conf.task_routes['public_service.consume.execution']['queue'] == 'financial_execution'
        assert app.conf.task_routes['public_service.consume.reconciliation']['queue'] == 'financial_reconciliation'
        assert app.conf.beat_schedule == before
        for name, task in tasks.items():
            assert task.run()['state'] == 'disabled'
            assert task.max_retries == 0 and task.acks_late is True and task.reject_on_worker_lost is True
            with pytest.raises(TypeError): task.run('analysis')
        assert composition.register(app) == tasks
        other = Celery('other_' + uuid4().hex, broker='memory://')
        try:
            with pytest.raises(BoundaryDenied): composition.register(other)
        finally: other.close()
    finally: app.close()

def compose(e, proof, clock=lambda: NOW):
    def factory(db):
        worker = ExecutionWorker(Orders(db, policy=e.env.policy, risk=e.env.risk, clock=clock), e.broker, e.source)
        return SyntheticWorkBindings(db, residency=proof, execution=worker)
    return IsolatedConsumerComposition(session_factory=lambda: Session(e.env.engine), bindings_factory=factory, clock=clock)

def test_registered_consumer_uses_existing_confirmed_fake_order_fences_and_no_redelivery_effect(setup):
    e = setup(); q, proof, _ = queue(e)
    q.enqueue(e.row.owner_id, 'execution', str(e.event.id), now=NOW); e.env.db.commit()
    consumer = compose(e, proof)
    assert consumer.consume('execution')['result']['status'] == 'filled'
    assert len(e.broker.calls) == 1
    assert consumer.consume('execution')['state'] == 'idle'
    assert len(e.broker.calls) == 1

def test_expired_claim_is_unknown_and_never_replayed_by_consumer(setup):
    e = setup(); q, proof, _ = queue(e)
    item = q.enqueue(e.row.owner_id, 'execution', str(e.event.id), now=NOW); e.env.db.commit()
    assert q.claim('execution', now=NOW)
    consumer = compose(e, proof, clock=lambda: NOW + timedelta(seconds=31))
    assert consumer.consume('execution')['state'] == 'idle' and not e.broker.calls
    stored = e.env.db.scalar(select(OutboxMessage).where(OutboxMessage.id == item.id).execution_options(populate_existing=True))
    assert stored.payload['state'] == 'uncertain'

def test_accepted_then_lost_response_cannot_trigger_financial_resubmission(setup):
    e = setup(['after_acceptance']); q, proof, _ = queue(e)
    q.enqueue(e.row.owner_id, 'execution', str(e.event.id), now=NOW); e.env.db.commit()
    consumer = compose(e, proof); result = consumer.consume('execution')
    assert result['state'] == 'uncertain' and len(e.broker.calls) == 1
    assert consumer.consume('execution')['state'] == 'idle' and len(e.broker.calls) == 1

def test_binding_factory_failure_rolls_back_without_claim_or_fake_effect(setup):
    e = setup(); q, proof, _ = queue(e)
    item = q.enqueue(e.row.owner_id, 'execution', str(e.event.id), now=NOW); e.env.db.commit()
    consumer = IsolatedConsumerComposition(session_factory=lambda: Session(e.env.engine), bindings_factory=lambda db: object())
    with pytest.raises(BoundaryDenied): consumer.consume('execution')
    stored = e.env.db.scalar(select(OutboxMessage).where(OutboxMessage.id == item.id).execution_options(populate_existing=True))
    assert stored.payload['state'] == 'queued' and not e.broker.calls

def test_consumer_tasks_are_app_local_even_after_unrelated_app_finalization():
    from celery import Celery
    from uuid import uuid4
    owned = Celery('owned_' + uuid4().hex, broker='memory://')
    other = Celery('other_' + uuid4().hex, broker='memory://')
    third = Celery('third_' + uuid4().hex, broker='memory://')
    try:
        one = IsolatedConsumerComposition(); registered = one.register(owned)
        assert not set(registered) & set(other.tasks)
        two = IsolatedConsumerComposition(); separate = two.register(other)
        assert all(registered[name] is not separate[name] for name in registered)
        assert not set(registered) & set(third.tasks)
        assert all(task.max_retries == 0 for task in registered.values())
    finally:
        owned.close(); other.close(); third.close()
