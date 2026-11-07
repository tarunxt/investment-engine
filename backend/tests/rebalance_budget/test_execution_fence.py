"""Offline fence tests. SQLite validates semantics, not PostgreSQL row locks."""
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app.domains.rebalance_budget import execution, ledger
from app.domains.rebalance_budget.execution_models import RebalanceExecution, RebalanceResourceReservation


@pytest.fixture
def execution_db(cap_db):
    factory, engine = cap_db
    # Safe only on this fixture's synthetic engine, never runtime configuration.
    RebalanceExecution.__table__.create(engine, checkfirst=True)
    RebalanceResourceReservation.__table__.create(engine, checkfirst=True)
    return factory


def claim(factory, now=None):
    with factory() as db:
        scope = ledger.bind_scope(db, user_id=1, portfolio="india", sequence=1)
        scope_id = scope.id
        token = execution.claim(db, scope_id=scope_id, user_id=1, job_id=1, now=now)
        db.commit()
    return dict(scope_id=scope_id, job_id=1, token=token)


def reserve(db, owned, key="one", output=12000, tools=4, now=None):
    return execution.reserve_call(db, **owned, attempt_key=key,
        output_tokens=output, tool_calls=tools, now=now)


def test_duplicate_claim_and_no_expired_lease_renewal(execution_db):
    start = datetime.now(timezone.utc)
    owned = claim(execution_db, start)
    for now in [start, start + timedelta(seconds=601)]:
        with execution_db() as db, pytest.raises(ledger.SpendCapBlocked):
            execution.claim(db, scope_id=owned['scope_id'], user_id=1, job_id=1, now=now)


def test_retry_keeps_original_deadline(execution_db):
    start = datetime.now(timezone.utc)
    owned = claim(execution_db, start)
    with execution_db() as db:
        assert execution.finish(db, **owned) == 'idle'
        db.commit()
    retried = claim(execution_db, start + timedelta(seconds=500))
    assert retried['token'] != owned['token']
    with execution_db() as db:
        assert execution.remaining(db, **retried, now=start + timedelta(seconds=500))['remaining_seconds'] == 100
        with pytest.raises(ledger.SpendCapBlocked):
            reserve(db, retried, now=start + timedelta(seconds=600))
        assert execution.finish(db, **retried) == 'idle'
        db.commit()
    with execution_db() as db, pytest.raises(ledger.SpendCapBlocked):
        execution.claim(db, scope_id=owned['scope_id'], user_id=1, job_id=1, now=start + timedelta(seconds=601))


def test_reserved_output_whole_job_and_per_request_caps(execution_db):
    owned = claim(execution_db)
    with execution_db() as db:
        for n in range(4):
            reserve(db, owned, str(n))
        db.commit()
        assert execution.remaining(db, **owned)['output_tokens'] == 0
        with pytest.raises(ledger.SpendCapBlocked):
            reserve(db, owned, 'fifth', output=1)
        with pytest.raises(ledger.SpendCapBlocked):
            reserve(db, owned, 'large', output=12001)
        assert execution.finish(db, **owned) == 'suspended'
        db.commit()
    with execution_db() as db:
        row = db.get(RebalanceExecution, 1)
        assert row.output_reserved == 48000 and row.fence_token == owned['token']


def test_tools_total_and_response_caps(execution_db):
    owned = claim(execution_db)
    with execution_db() as db:
        for n in range(32):
            resource = reserve(db, owned, str(n), output=0, tools=1)
            assert execution.settle_call(db, **owned, resource_id=resource, output_tokens=0, tool_calls=1) == 'settled'
        db.commit()
        with pytest.raises(ledger.SpendCapBlocked):
            reserve(db, owned, '33', output=0, tools=1)
        with pytest.raises(ledger.SpendCapBlocked):
            reserve(db, owned, 'too-many', output=1, tools=5)


def test_settlement_releases_only_verified_counts_and_stale_fence_cannot_mutate(execution_db):
    owned = claim(execution_db)
    with execution_db() as db:
        resource = reserve(db, owned)
        db.commit()
        stale = {**owned, 'token': 'wrong'}
        with pytest.raises(ledger.SpendCapBlocked):
            execution.settle_call(db, **stale, resource_id=resource, output_tokens=5, tool_calls=1)
        with pytest.raises(ledger.SpendCapBlocked):
            execution.finish(db, **stale)
        assert execution.settle_call(db, **owned, resource_id=resource, output_tokens=5000, tool_calls=1) == 'settled'
        db.commit()
        row = db.get(RebalanceExecution, 1)
        assert (row.output_used, row.output_reserved, row.tools_used, row.tools_reserved) == (5000, 0, 1, 0)
        assert execution.finish(db, **owned, completed=True) == 'completed'
        db.commit()
    with execution_db() as db, pytest.raises(ledger.SpendCapBlocked):
        execution.claim(db, scope_id=owned['scope_id'], user_id=1, job_id=1)


def test_uncertainty_retains_reservations_and_suspends(execution_db):
    owned = claim(execution_db)
    with execution_db() as db:
        resource = reserve(db, owned)
        db.commit()
        assert execution.settle_call(db, **owned, resource_id=resource, output_tokens=None, tool_calls=0) == 'uncertain'
        assert execution.finish(db, **owned) == 'suspended'
        db.commit()
    with execution_db() as db:
        row = db.get(RebalanceExecution, 1)
        assert row.output_reserved == 12000 and row.tools_reserved == 4
        with pytest.raises(ledger.SpendCapBlocked):
            reserve(db, owned, 'later')


def test_resource_and_spend_reservations_share_transaction(execution_db):
    owned = claim(execution_db)
    with execution_db() as db:
        reserve(db, owned)
        with pytest.raises(ledger.SpendCapBlocked):
            ledger.reserve(db, scope_id=owned['scope_id'], user_id=1, job_id=1,
                attempt_key='overpriced', provider='synthetic', model='synthetic',
                upper_inr='21', tariff_version='synthetic', fx_version='synthetic')
        db.rollback()
        assert db.scalar(select(RebalanceResourceReservation.id)) is None
        assert db.get(RebalanceExecution, 1).output_reserved == 0


def test_overage_is_preserved_and_blocks_future_dispatch(execution_db):
    owned = claim(execution_db)
    with execution_db() as db:
        resource = reserve(db, owned)
        assert execution.settle_call(db, **owned, resource_id=resource, output_tokens=12001, tool_calls=5) == 'bound_breach'
        db.commit()
        row = db.get(RebalanceExecution, 1)
        assert row.output_used == 12001 and row.tools_used == 5
        with pytest.raises(ledger.SpendCapBlocked):
            reserve(db, owned, 'next')


@pytest.fixture
def postgres_execution_db(execution_db):
    factory = execution_db
    if factory.kw['bind'].dialect.name != 'postgresql':
        pytest.skip('Requires explicitly configured disposable PostgreSQL cap-test database')
    return factory


def _compete(count, operation):
    """Barrier ensures separate transactions compete, not sequential calls."""
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    barrier = Barrier(count, timeout=15)
    with ThreadPoolExecutor(max_workers=count) as pool:
        futures = [pool.submit(operation, index, barrier) for index in range(count)]
        return [future.result(timeout=30) for future in futures]


def test_postgres_simultaneous_claim_has_exactly_one_owner(postgres_execution_db):
    factory = postgres_execution_db
    with factory() as db:
        scope_id = ledger.bind_scope(db, user_id=1, portfolio='india', sequence=1).id
        db.commit()

    def compete(index, barrier):
        with factory() as db:
            # Open real independent transactions before releasing the barrier.
            db.execute(select(RebalanceExecution.job_id)).all()
            barrier.wait()
            try:
                token = execution.claim(db, scope_id=scope_id, user_id=1, job_id=1)
                db.commit()
                return token
            except ledger.SpendCapBlocked:
                db.rollback()
                return None

    results = _compete(6, compete)
    winners = [token for token in results if token is not None]
    assert len(winners) == 1
    with factory() as db:
        rows = db.scalars(select(RebalanceExecution)).all()
        assert len(rows) == 1
        assert rows[0].fence_token == winners[0]
        assert rows[0].status == 'active'


@pytest.mark.parametrize('output,tools,competitors,admitted', [
    (12000, 0, 6, 4),
    (0, 4, 10, 8),
])
def test_postgres_competing_preloaded_sessions_cannot_overreserve(
        postgres_execution_db, output, tools, competitors, admitted):
    factory = postgres_execution_db
    owned = claim(factory)

    def compete(index, barrier):
        with factory() as db:
            # Retain a strong reference: FOR UPDATE must refresh this stale ORM
            # object after preceding competitors commit, not reuse zero counts.
            cached = db.get(RebalanceExecution, owned['job_id'])
            assert cached.output_reserved == cached.tools_reserved == 0
            barrier.wait()
            try:
                resource_id = reserve(db, owned, str(index), output=output, tools=tools)
                db.commit()
                return resource_id
            except ledger.SpendCapBlocked:
                db.rollback()
                return None

    results = _compete(competitors, compete)
    winners = [resource_id for resource_id in results if resource_id is not None]
    assert len(winners) == admitted
    assert len(set(winners)) == admitted
    with factory() as db:
        row = db.get(RebalanceExecution, owned['job_id'])
        reservations = db.scalars(select(RebalanceResourceReservation)).all()
        assert len(reservations) == admitted
        assert row.output_reserved == sum(r.output_bound for r in reservations) == output * admitted
        assert row.tools_reserved == sum(r.tools_bound for r in reservations) == tools * admitted
        assert row.output_reserved <= execution.JOB_OUTPUT_LIMIT
        assert row.tools_reserved <= execution.JOB_TOOL_LIMIT
        assert row.fence_token == owned['token']


def test_old_owner_cannot_release_new_retry_fence(execution_db):
    owned = claim(execution_db)
    with execution_db() as db:
        assert execution.finish(db, **owned) == 'idle'
        db.commit()
    retried = claim(execution_db)
    with execution_db() as db:
        with pytest.raises(ledger.SpendCapBlocked):
            execution.finish(db, **owned, completed=True)
        with pytest.raises(ledger.SpendCapBlocked):
            reserve(db, owned)
        assert db.get(RebalanceExecution, 1).fence_token == retried['token']


def test_late_reconciliation_does_not_reactivate_suspended_execution(execution_db):
    start = datetime.now(timezone.utc)
    owned = claim(execution_db, start)
    with execution_db() as db:
        resource_id = reserve(db, owned, now=start)
        assert execution.settle_call(db, **owned, resource_id=resource_id) == 'uncertain'
        db.commit()
        assert execution.settle_call(db, **owned, resource_id=resource_id,
            output_tokens=10, tool_calls=0, now=start + timedelta(seconds=601)) == 'settled'
        db.commit()
        row = db.get(RebalanceExecution, 1)
        assert row.status == 'suspended'
        assert row.output_reserved == 0 and row.output_used == 10
        with pytest.raises(ledger.SpendCapBlocked):
            reserve(db, owned, 'after-reconcile', now=start + timedelta(seconds=601))
        assert execution.finish(db, **owned, completed=True) == 'suspended'


def test_postgres_cached_old_owner_cannot_release_reclaimed_fence(postgres_execution_db):
    factory = postgres_execution_db
    owned = claim(factory)
    with factory() as stale_db:
        cached = stale_db.get(RebalanceExecution, owned['job_id'])
        assert cached.fence_token == owned['token']
        with factory() as owner_db:
            execution.finish(owner_db, **owned)
            owner_db.commit()
        retried = claim(factory)
        with pytest.raises(ledger.SpendCapBlocked):
            execution.finish(stale_db, **owned, completed=True)
        stale_db.rollback()
    with factory() as db:
        current = db.get(RebalanceExecution, owned['job_id'])
        assert current.fence_token == retried['token'] and current.status == 'active'
