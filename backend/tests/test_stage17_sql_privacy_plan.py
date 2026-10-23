"""Persistent SQL planning on fixtures only; this never performs deletions."""
from dataclasses import replace
from datetime import timedelta
import pytest
from sqlalchemy import MetaData, Table, Column, Integer, String, ForeignKey, select, event
from app.domains.ai_limits.contracts import BoundaryDenied
from app.domains.auth.models import ActivityLog
from app.infrastructure.database.outbox.models import OutboxMessage
from app.domains.public_service.privacy import PrivacyRequests
from app.domains.public_service.sql_account import SQLAccountReader, AccountInventory, AccountTableRule, OwnerHop, schema_digest, _credential_column
from app.domains.public_service.sql_privacy_plan import SQLPrivacyPlanner, RetentionSchedule, TOPIC
from test_stage17_reviewed_residency import setup as residency_setup, NOW

@pytest.fixture
def setup(residency_setup):
    db, producer = residency_setup; metadata = MetaData(); metadata.reflect(db.get_bind())
    portfolios = Table('fixture_portfolios', metadata, Column('id', Integer, primary_key=True),
        Column('user_id', ForeignKey('users.id'), nullable=False), Column('label', String))
    holdings = Table('fixture_holdings', metadata, Column('id', Integer, primary_key=True),
        Column('portfolio_id', ForeignKey('fixture_portfolios.id'), nullable=False), Column('label', String))
    portfolios.create(db.get_bind()); holdings.create(db.get_bind())
    db.execute(portfolios.insert(), [dict(id=i, user_id=i, label=f'private-portfolio-{i}') for i in (1, 2)])
    db.execute(holdings.insert(), [dict(id=i, portfolio_id=i, label=f'private-holding-{i}') for i in (1, 2)]); db.commit()
    rules = []
    for name, table in metadata.tables.items():
        if name in {'outbox', 'activity_logs'}:
            rules.append(AccountTableRule(name, (), excluded_reason='fixture request/audit retention anchor'))
        elif name == 'fixture_holdings':
            rules.append(AccountTableRule(name, tuple(table.c.keys()), path=(OwnerHop('fixture_portfolios', ('portfolio_id',), ('id',)),)))
        else:
            fields = tuple(c for c in table.c.keys() if not _credential_column(c))
            withheld = tuple(c for c in table.c.keys() if _credential_column(c))
            rules.append(AccountTableRule(name, fields, withheld, owner_column='id' if name == 'users' else 'user_id'))
    inventory = AccountInventory('fixture-scope-not-real-inventory-approval', schema_digest(metadata), tuple(rules))
    reader = SQLAccountReader(db, metadata, inventory)
    retention = RetentionSchedule('fixture-retention-not-legal-approval', NOW + timedelta(days=5),
        retain_until=tuple((name, None) for name in metadata.tables))
    request = PrivacyRequests(db).request(1, 'fixture-delete', 'delete', confirmed=True, now=NOW); db.commit()
    planner = SQLPrivacyPlanner(db, reader, producer.keyring, retention)
    return db, planner, request.id

def test_full_inventory_child_first_plan_is_owned_bounded_and_not_executable(setup):
    db, planner, id = setup; row = planner.draft(1, id, now=NOW); db.commit()
    result = planner.inspect(1, id, now=NOW)
    assert set(result['actions']) == set(planner.reader.metadata.tables)
    assert result['actions']['fixture_holdings']['owned_rows'] == 1
    assert result['child_first_order'].index('fixture_holdings') < result['child_first_order'].index('fixture_portfolios')
    assert result['actions']['users']['disposition'] == 'IDENTITY_REQUEST_AUDIT_ANCHOR'
    assert result['deletion_executable'] is False and 'reviewed_SQL_deletion_executor' in result['unfinished']
    assert 'private-holding' not in str(row.payload)
    assert planner.draft(1, id, now=NOW).id == row.id

@pytest.mark.parametrize('mode', ['legal', 'deadline'])
def test_child_holds_protect_parent_chain_against_cascade(setup, mode):
    db, planner, id = setup
    if mode == 'legal': planner.retention = replace(planner.retention, legal_holds=frozenset({'fixture_holdings'}))
    else: planner.retention = replace(planner.retention, retain_until=tuple((n, NOW + timedelta(days=1) if n == 'fixture_holdings' else t) for n, t in planner.retention.retain_until))
    planner.draft(1, id, now=NOW); result = planner.inspect(1, id, now=NOW)
    assert result['actions']['fixture_portfolios']['disposition'] == 'HELD_DEPENDENT_RELATIONSHIP'
    assert 'fixture_portfolios' not in result['child_first_order']

@pytest.mark.parametrize('mode', ['missing', 'expired', 'unclassified'])
def test_missing_expired_or_incomplete_retention_review_never_persists_plan(setup, mode):
    db, planner, id = setup
    if mode == 'missing': planner.retention = RetentionSchedule()
    elif mode == 'expired': planner.retention = replace(planner.retention, expires_at=NOW)
    else: planner.retention = replace(planner.retention, retain_until=planner.retention.retain_until[:-1])
    with pytest.raises(BoundaryDenied): planner.draft(1, id, now=NOW)
    assert db.scalar(select(OutboxMessage).where(OutboxMessage.topic == TOPIC)) is None

def test_cancelled_expired_or_foreign_request_cannot_use_a_plan(setup):
    db, planner, id = setup; planner.draft(1, id, now=NOW); db.commit()
    with pytest.raises(BoundaryDenied): planner.inspect(2, id, now=NOW)
    with pytest.raises(BoundaryDenied): planner.inspect(1, id, now=NOW + timedelta(days=8))
    PrivacyRequests(db).cancel(1, id); db.commit()
    with pytest.raises(BoundaryDenied): planner.inspect(1, id, now=NOW)

@pytest.mark.parametrize('mode', ['policy', 'data', 'ciphertext'])
def test_data_policy_or_envelope_changes_require_fresh_review(setup, mode):
    db, planner, id = setup; row = planner.draft(1, id, now=NOW); db.commit()
    if mode == 'policy': planner.retention = replace(planner.retention, reference='changed-policy')
    elif mode == 'data':
        table = planner.reader.metadata.tables['fixture_holdings']
        db.execute(table.update().where(table.c.id == 1).values(label='changed-owned-data')); db.commit()
    else: row.payload = {**row.payload, 'ciphertext': 'forged'}; db.commit()
    with pytest.raises(BoundaryDenied): planner.inspect(1, id, now=NOW)

def test_audit_failure_leaves_no_plan_or_account_changes(setup):
    db, planner, id = setup
    table = planner.reader.metadata.tables['fixture_holdings']
    before = list(db.execute(table.select()))
    def fail(*args): raise RuntimeError('fixture audit failure')
    event.listen(ActivityLog, 'before_insert', fail)
    try:
        with pytest.raises(RuntimeError, match='audit failure'): planner.draft(1, id, now=NOW)
        db.rollback()
    finally: event.remove(ActivityLog, 'before_insert', fail)
    assert db.scalar(select(OutboxMessage).where(OutboxMessage.topic == TOPIC)) is None
    assert list(db.execute(table.select())) == before

def test_audit_included_inventory_plan_is_stable_but_account_changes_are_not(setup):
    db, planner, id = setup
    inventory = planner.reader.inventory; table = planner.reader.metadata.tables['activity_logs']
    planner.reader.inventory = replace(inventory, rules=tuple(
        AccountTableRule('activity_logs', tuple(table.c.keys())) if r.table == 'activity_logs' else r for r in inventory.rules))
    row = planner.draft(1, id, now=NOW); db.commit()
    claims = planner.inspect(1, id, now=NOW)
    assert claims['retained_operational_boundary'] == ['activity_logs', 'outbox']
    assert claims['actions']['activity_logs']['owned_rows'] is None
    assert planner.draft(1, id, now=NOW).id == row.id
    db.add(ActivityLog(user_id=1, action='synthetic_other_audit')); db.commit()
    assert planner.inspect(1, id, now=NOW) == claims
    holdings = planner.reader.metadata.tables['fixture_holdings']
    db.execute(holdings.update().where(holdings.c.id == 1).values(label='changed owned data')); db.commit()
    with pytest.raises(BoundaryDenied, match='CHANGED'): planner.inspect(1, id, now=NOW)
