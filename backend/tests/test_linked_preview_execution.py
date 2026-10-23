"""Changed preview seam only: actual approval HTTP to durable fake execution.

In-process ASGI, disposable application and venue SQLite. No live transport,
PostgreSQL concurrency claim, UI browser acceptance or automatic consent.
"""
import os
from pathlib import Path
from datetime import datetime, timezone, timedelta
from types import SimpleNamespace
import pytest
from sqlalchemy import create_engine, select, func
from sqlalchemy.orm import Session
from test_stage14_order_intents import env, order

os.environ['STAGE01_PREVIEW'] = 'synthetic-only'
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from scripts.public_launch import preview_stage16 as preview, preview_execution
from app.domains.auth.models import User
from app.domains.connections.models import IntegrationConnection
from app.domains.modules.lifecycle import WorkIdentity
from app.domains.modules.models import UserModule
from app.domains.order_intents.service import Orders, MODULE, TOPIC
from app.domains.order_intents.models import OrderIntent
from app.domains.order_intents.contracts import OrderDenied
from app.domains.order_intents.execution_fake import VenueBase, FakeVenueOrder
from app.domains.order_intents.execution_models import ExecutionAttempt
from app.infrastructure.database.outbox.models import OutboxMessage


@pytest.mark.asyncio
@pytest.mark.parametrize('mode', ['user_owned', 'platform_managed'])
@pytest.mark.parametrize('outcome', ['partial', 'after_acceptance'])
async def test_http_confirmation_durable_unknown_restart_and_owner_scope(env, tmp_path, monkeypatch, mode, outcome):
    import httpx
    from fastapi import FastAPI
    from app.domains.order_intents.router import router, get_runtime, get_read_runtime
    from app.domains.auth.dependencies import get_current_user
    from app.infrastructure.database.session import get_async_db
    from app.domains.modules.policy import DefaultFactsResolver, ModuleFacts
    from app.domains.modules.transports import install_route_policy
    now = datetime.now(timezone.utc)
    for table in preview_execution.TABLES: table.create(env.engine, checkfirst=True)
    venue = create_engine('sqlite:///' + str(tmp_path / 'venue.sqlite'))
    VenueBase.metadata.create_all(venue)
    connection = env.db.get(IntegrationConnection, 'connection1')
    connection.app_ownership_mode = mode
    connection.token_expires_at = now + timedelta(hours=1)
    env.db.commit()
    service = Orders(env.db, policy=preview.policy, risk=preview.risk)
    row = service.create(WorkIdentity(env.owners[0], MODULE, 1), 'linked-preview', connection.id, order(2), now=now)
    service.validate(row.owner_id, row.id, now=now)
    service.review(row.owner_id, row.id, now=now)
    env.db.commit()
    class Bridge:
        async def run_sync(self, fn): return fn(env.db)
        async def commit(self): env.db.commit()
        async def rollback(self): env.db.rollback()
        async def scalar(self, q): return env.db.scalar(q)
        async def execute(self, q): return env.db.execute(q)
        def get_bind(self): return env.db.get_bind()
    owner = [env.owners[0]]
    app = FastAPI(); app.include_router(router)
    app.dependency_overrides[get_async_db] = lambda: Bridge()
    app.dependency_overrides[get_current_user] = lambda: env.db.get(User, owner[0])
    app.dependency_overrides[get_runtime] = lambda: preview.runtime
    app.dependency_overrides[get_read_runtime] = lambda: preview.runtime
    monkeypatch.setattr(DefaultFactsResolver, 'resolve_sync', lambda *_: ModuleFacts(jurisdiction='allowed', plan='allowed', connection='ready', execution_capability=True))
    install_route_policy(app)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://synthetic.invalid') as client:
        view = (await client.get('/order-intents/reviews/' + row.id)).json()['intents'][0]
        assert view['state'] == 'awaiting_approval' and view['actions']['confirm']
        assert env.db.scalar(select(func.count()).select_from(OutboxMessage)) == 0
        path = '/order-intents/' + row.id + '/approve'
        body = dict(displayed_digest=view['review_digest'], action='confirm_exact_order_or_basket')
        owner[0] = env.owners[1]
        assert (await client.get('/order-intents/reviews/' + row.id)).status_code == 404
        assert (await client.post(path, json=body)).status_code in (403,409)
        owner[0] = env.owners[0]
        assert (await client.post(path, json={**body, 'displayed_digest': '0'*64})).status_code == 409
        assert (await client.post(path, json=body)).status_code == 200
        assert (await client.post(path, json=body)).status_code == 409
        preview.advance(env.db, engine=venue, now=now+timedelta(seconds=1), outcomes=[outcome])
        env.db.commit()
        state = 'partial' if outcome == 'partial' else 'unknown'
        observed = (await client.get('/order-intents/reviews/' + row.id)).json()['intents'][0]
        assert observed['state'] == state and observed['integrity_checked']
        assert not any(observed['actions'].values())
    intent, user = row.id, row.owner_id
    env.db.close()
    # A new application session and fake broker use the same durable stores.
    with Session(env.engine, expire_on_commit=False) as db:
        saved = db.get(OrderIntent, intent)
        runner = preview_execution.worker(db, saved, policy=preview.policy, risk=preview.risk, engine=venue, now=now+timedelta(seconds=2))
        result = runner.reconcile(user, intent)
        assert result.state == ('partial' if outcome == 'partial' else 'submitting')
        assert runner.broker.calls == []
        event = db.scalar(select(OutboxMessage).where(OutboxMessage.topic == TOPIC))
        with pytest.raises(OrderDenied): runner.dispatch(event.id)
        db.rollback()
        module = db.scalar(select(UserModule).where(UserModule.user_id == user))
        module.enabled = False; db.commit()
        # Revocation prevents remaining legs, not read-only historical evidence.
        if outcome == 'after_acceptance':
            with pytest.raises(PermissionError): runner.resume(user, intent)
            db.rollback()
        assert runner.broker.calls == []
        assert db.scalar(select(func.count()).select_from(ExecutionAttempt)) == 1
    with Session(venue) as db:
        assert db.scalar(select(func.count()).select_from(FakeVenueOrder)) == 1
    venue.dispose()


def test_blocked_approved_owner_does_not_starve_later_owner(env, tmp_path, monkeypatch):
    """A denied oldest approval remains immutable while independent work runs."""
    from test_stage14_order_intents import approve, NOW
    for table in preview_execution.TABLES:
        table.create(env.engine, checkfirst=True)
    venue = create_engine('sqlite:///' + str(tmp_path / 'starvation-venue.sqlite'))
    VenueBase.metadata.create_all(venue)
    monkeypatch.setattr(preview, 'policy', env.policy)
    monkeypatch.setattr(preview, 'risk', env.risk)
    first, first_event = approve(env, owner=env.owners[0], key='blocked-first')
    second, second_event = approve(env, owner=env.owners[1], key='eligible-second')
    first.created_at = NOW - timedelta(seconds=1)
    first_approval = first.approval_digest
    env.db.scalar(select(UserModule).where(UserModule.user_id == first.owner_id)).enabled = False
    env.db.commit()
    assert preview.advance(env.db, engine=venue, now=NOW, outcomes=['filled']) == second.id
    env.db.commit()
    assert env.db.get(OrderIntent, first.id).state == 'approved'
    assert env.db.get(OrderIntent, first.id).approval_digest == first_approval
    assert first_event.execution_attempts == 0
    assert env.db.get(OrderIntent, second.id).state == 'filled'
    assert second_event.execution_attempts == 1
    with Session(venue) as db:
        assert db.scalar(select(func.count()).select_from(FakeVenueOrder)) == 1
    venue.dispose()

@pytest.mark.parametrize('change', ['disable', 'cancel'])
def test_approved_but_not_started_is_fenced(env, tmp_path, change):
    from test_stage14_order_intents import approve, NOW
    for table in preview_execution.TABLES: table.create(env.engine, checkfirst=True)
    venue = create_engine('sqlite:///' + str(tmp_path / 'venue.sqlite'))
    VenueBase.metadata.create_all(venue)
    row, event = approve(env)
    if change == 'disable':
        env.db.scalar(select(UserModule).where(UserModule.user_id == row.owner_id)).enabled = False
    else:
        env.service.revoke(row.owner_id, row.id)
    env.db.commit()
    runner = preview_execution.worker(env.db, row, policy=env.policy, risk=env.risk, engine=venue, now=NOW)
    with pytest.raises((OrderDenied, PermissionError)): runner.dispatch(event.id)
    env.db.rollback()
    assert runner.broker.calls == []
    with Session(venue) as db: assert db.scalar(select(func.count()).select_from(FakeVenueOrder)) == 0
    venue.dispose()

from test_stage18_linked_analysis_preview import linked_env, complete_analysis


@pytest.mark.asyncio
@pytest.mark.parametrize('owner', [1, 2])
@pytest.mark.parametrize('outcome', ['partial', 'after_acceptance'])
async def test_completed_governed_analysis_to_exact_review_and_durable_execution(linked_env, tmp_path, monkeypatch, owner, outcome):
    import httpx
    from fastapi import FastAPI
    from app.domains.order_intents.router import router, get_runtime, get_read_runtime
    from app.domains.auth.dependencies import get_current_user
    from app.infrastructure.database.session import get_async_db
    from app.domains.modules.policy import DefaultFactsResolver, ModuleFacts
    from app.domains.modules.transports import install_route_policy
    from app.domains.recommendation_audit.models import SpendAttempt
    e = linked_env
    evidence = complete_analysis(e, owner=owner)
    for table in preview.TABLES: table.create(e.engine, checkfirst=True)
    row = preview.prepare_analysis(e.db, owner, evidence['workflow_id'], now=e.now)
    e.db.commit()
    intent = row.id
    assert row.state == 'awaiting_approval' and row.approved_at is None
    assert row.connection_version == evidence['source']['connection']['version'] == 7
    assert row.app_mode == ('user_owned' if owner == 1 else 'platform_managed')
    assert row.payload_json['legs'][0]['quantity'] == 2
    assert row.payload_json['legs'][0]['side'] == 'SELL'
    assert preview.prepare_analysis(e.db, owner, evidence['workflow_id'], now=e.now).id == intent
    assert e.db.scalar(select(func.count()).select_from(OrderIntent)) == 1
    assert e.db.scalar(select(func.count()).select_from(SpendAttempt).where(SpendAttempt.status == 'settled')) == 5
    assert e.db.scalar(select(func.count()).select_from(OutboxMessage).where(OutboxMessage.topic == TOPIC)) == 0
    class Bridge:
        async def run_sync(self, fn): return fn(e.db)
        async def commit(self): e.db.commit()
        async def rollback(self): e.db.rollback()
        async def scalar(self, q): return e.db.scalar(q)
        async def execute(self, q): return e.db.execute(q)
        def get_bind(self): return e.db.get_bind()
    selected = [owner]
    app = FastAPI(); app.include_router(router)
    app.dependency_overrides[get_async_db] = lambda: Bridge()
    app.dependency_overrides[get_current_user] = lambda: e.db.get(User, selected[0])
    app.dependency_overrides[get_runtime] = lambda: preview.runtime
    app.dependency_overrides[get_read_runtime] = lambda: preview.runtime
    monkeypatch.setattr(DefaultFactsResolver, 'resolve_sync', lambda *_: ModuleFacts(jurisdiction='allowed', plan='allowed', connection='ready', execution_capability=True))
    install_route_policy(app)
    venue = create_engine('sqlite:///' + str(tmp_path / 'linked-venue.sqlite'))
    VenueBase.metadata.create_all(venue)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://synthetic.invalid') as client:
        view = (await client.get('/order-intents/reviews/'+intent)).json()['intents'][0]
        assert view['actions']['confirm'] and view['legs'][0]['quantity'] == 2
        selected[0] = 3-owner
        assert (await client.get('/order-intents/reviews/'+intent)).status_code == 404
        selected[0] = owner
        response = await client.post('/order-intents/'+intent+'/approve', json={
            'displayed_digest': view['review_digest'], 'action': 'confirm_exact_order_or_basket'})
        assert response.status_code == 200, response.text
        preview.advance(e.db, engine=venue, now=e.now, outcomes=[outcome]); e.db.commit()
        assert e.db.get(OrderIntent, intent).state == ('partial' if outcome == 'partial' else 'unknown')
    e.db.close()
    e.db = Session(e.engine, expire_on_commit=False, autoflush=False)
    row = e.db.get(OrderIntent, intent)
    runner = preview_execution.worker(e.db, row, policy=preview.policy, risk=preview.risk, engine=venue, now=e.now+timedelta(seconds=1))
    runner.reconcile(owner, intent)
    assert row.state == ('partial' if outcome == 'partial' else 'filled')
    assert runner.broker.calls == []
    assert preview.prepare_analysis(e.db, owner, evidence['workflow_id'], now=e.now).id == intent
    assert e.db.scalar(select(func.count()).select_from(OrderIntent)) == 1
    with Session(venue) as db: assert db.scalar(select(func.count()).select_from(FakeVenueOrder)) == 1
    venue.dispose()


def test_invalid_completed_receipt_does_not_block_other_owner_preparation(linked_env):
    """Reject one corrupted governance receipt without killing the shared tick."""
    from app.domains.recommendation_audit.models import SpendAttempt
    e = linked_env
    first = complete_analysis(e, owner=1, key='invalid-completed-receipt')
    second = complete_analysis(e, owner=2, key='valid-completed-receipt')
    for table in preview.TABLES:
        table.create(e.engine, checkfirst=True)
    attempt = e.db.scalar(select(SpendAttempt).where(SpendAttempt.user_id == 1))
    attempt.user_id = 2
    e.db.commit()
    preview.prepare_completed(e.db)
    intents = list(e.db.scalars(select(OrderIntent)))
    assert len(intents) == 1
    assert intents[0].owner_id == 2 and intents[0].state == 'awaiting_approval'
    assert intents[0].approved_at is None
    assert e.db.scalar(select(func.count()).select_from(OutboxMessage).where(OutboxMessage.topic == TOPIC)) == 0


def test_disconnected_owner_does_not_abort_seed_or_relabel_snapshot(linked_env):
    """Boot cannot bless old acquisition bytes or block unrelated fixture owners."""
    import asyncio
    from copy import deepcopy
    from app.domains.zerodha.models import ZerodhaPortfolioSnapshot
    e = linked_env
    snapshot = e.preview.synthetic_acquire(e.db, 1, now=e.now)
    before = deepcopy(snapshot.acquisition_json)
    connection = e.db.scalar(select(IntegrationConnection).where(IntegrationConnection.owner_id == 1))
    connection.status = 'revoked'
    e.db.commit()
    class Bridge:
        async def run_sync(self, fn): return fn(e.db)
        async def commit(self): e.db.commit()
    users = list(e.db.scalars(select(User).order_by(User.id)))
    asyncio.run(preview.seed(Bridge(), users))
    rows = list(e.db.scalars(select(ZerodhaPortfolioSnapshot).order_by(ZerodhaPortfolioSnapshot.user_id)))
    assert [row.user_id for row in rows] == [1, 2]
    assert rows[0].acquisition_json == before
    assert rows[1].acquisition_json['owner_id'] == 2
    assert rows[1].acquisition_json['simulation'] is True
    assert e.db.get(IntegrationConnection, connection.id).status == 'revoked'


def test_preview_recovers_claimed_attempt_without_submission_replay(env, tmp_path, monkeypatch):
    from test_stage14_order_intents import approve, NOW
    for table in preview_execution.TABLES: table.create(env.engine, checkfirst=True)
    venue = create_engine('sqlite:///' + str(tmp_path / 'claimed-venue.sqlite'))
    VenueBase.metadata.create_all(venue)
    row, event = approve(env)
    runner = preview_execution.worker(env.db, row, policy=env.policy, risk=env.risk, engine=venue, now=NOW)
    original_commit = env.db.commit
    def crash_after_claim_commit():
        claimed = any(isinstance(item, ExecutionAttempt) for item in env.db.new)
        original_commit()
        if claimed:
            # The claim commit precedes the worker's BaseException handler.
            raise SystemExit('synthetic process loss immediately after durable commit')
    monkeypatch.setattr(env.db, 'commit', crash_after_claim_commit)
    with pytest.raises(SystemExit): runner.dispatch(event.id)
    assert runner.broker.calls == []
    intent = row.id
    env.db.close()
    env.db = Session(env.engine, expire_on_commit=False)
    assert env.db.get(OrderIntent, intent).state == 'submitting'
    result = preview.reconcile_one(env.db, engine=venue, now=NOW+timedelta(seconds=1))
    assert result.state == 'unknown'
    assert runner.broker.calls == []
    with Session(venue) as db: assert db.scalar(select(func.count()).select_from(FakeVenueOrder)) == 0
    venue.dispose()
