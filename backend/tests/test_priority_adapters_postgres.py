"""Actual PostgreSQL gates; never counted as SQLite/local acceptance."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import os

import pytest
from sqlalchemy import create_engine, select, func
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool

from test_stage09_connections_postgres import database
from test_stage14_postgres import setup, approved, policy, risk
from test_stage15_execution import market
from test_stage17_sql_privacy_workflow_postgres import pg_workflow
from app.domains.order_intents.contracts import OrderDenied, digest
from app.domains.order_intents.execution import ExecutionWorker, venue_binding
from app.domains.order_intents.execution_fake import MarketDataFake
from app.domains.order_intents.journal_fake import JournalBrokerFake, TOPIC
from app.domains.order_intents.models import OrderIntent
from app.domains.order_intents.service import Orders
from app.domains.public_service.recoverable_privacy import RecoverableFixturePrivacy
from app.infrastructure.database.outbox.models import OutboxMessage

pytestmark = pytest.mark.skipif(os.getenv('CREDX_STAGE09_DATABASE_ACK') != 'disposable-docker-only',
    reason='Existing acknowledged disposable Docker PostgreSQL required; exact CI must reject skips')


def venue_engine(database):
    engine, _, _, schema, _ = database
    # Independent pool and transaction, existing isolated schema and database.
    return create_engine(engine.url, poolclass=NullPool,
        connect_args={'options': f'-csearch_path={schema} -cstatement_timeout=5000 -clock_timeout=3000'})


def test_pg_parallel_fake_acceptance_has_one_durable_journal_receipt(database):
    venue = venue_engine(database)
    try:
        binding, reference = digest('synthetic-owner'), digest('synthetic-reference')
        from test_stage14_order_intents import order
        def call(_):
            broker = JournalBrokerFake(venue, binding)
            try: broker.submit(order()['legs'][0], reference, binding); return True
            except OrderDenied: return False
        with ThreadPoolExecutor(2) as pool: assert sum(pool.map(call, range(2))) == 1
        with Session(venue) as db:
            assert db.scalar(select(func.count()).select_from(OutboxMessage).where(OutboxMessage.topic == TOPIC)) == 1
        assert JournalBrokerFake(venue, binding).reconcile(reference, binding)['matches'][0]['state'] == 'filled'
    finally: venue.dispose()


@pytest.mark.parametrize('outcome', ['partial', 'after_acceptance', 'before_acceptance'])
def test_pg_journal_and_execution_survive_new_sessions_without_replay(database, outcome):
    engine, owner = setup(database)
    event = approved(engine, owner)
    venue = venue_engine(database)
    try:
        with Session(engine) as db:
            row = db.scalar(select(OrderIntent))
            intent, binding = row.id, venue_binding(row)
            source = MarketDataFake(market(row, datetime.now(timezone.utc)))
        broker = JournalBrokerFake(venue, binding, [outcome])
        with Session(engine) as db:
            worker = ExecutionWorker(Orders(db, policy=policy, risk=risk), broker, source)
            if outcome in {'after_acceptance', 'before_acceptance'}:
                with pytest.raises(TimeoutError): worker.dispatch(event)
            else: assert worker.dispatch(event).state == 'partial'
        restarted = JournalBrokerFake(venue, binding)
        with Session(engine) as db:
            worker = ExecutionWorker(Orders(db, policy=policy, risk=risk), restarted, source)
            assert worker.reconcile(owner, intent).state == {
                'partial': 'partial', 'after_acceptance': 'filled', 'before_acceptance': 'unknown'}[outcome]
            with pytest.raises(OrderDenied): worker.dispatch(event)
        assert not restarted.calls and len(broker.calls) == 1
    finally: venue.dispose()


def test_pg_recoverable_erasure_roundtrip_is_atomic_and_owned(pg_workflow):
    engine, owner, other, request, now, original = pg_workflow
    from app.domains.auth.models import APIKey, UserProfile
    def service(db):
        base = original(db)
        return RecoverableFixturePrivacy(db, base.reader, base.keyring, retention=base.retention, scope=base.scope)
    with Session(engine) as db:
        erased = service(db).execute(owner, request, now=now); db.commit()
        assert erased['removed_counts'] == {'api_keys': 1, 'user_profiles': 1}
    with Session(engine) as db:
        assert service(db).restore(owner, request, now=now)['state'] == 'restored'; db.commit()
    with Session(engine) as db:
        assert service(db).restore(owner, request, now=now)['state'] == 'already_restored'
        for principal in (owner, other):
            assert db.scalar(select(func.count()).select_from(APIKey).where(APIKey.user_id == principal)) == 1
            assert db.get(UserProfile, principal) is not None
