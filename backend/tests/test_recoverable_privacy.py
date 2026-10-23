"""Reversible erasure on disposable synthetic SQL fixtures only."""
from dataclasses import replace
from datetime import date, datetime, timezone, timedelta
from decimal import Decimal
from uuid import uuid4

import pytest
from sqlalchemy import select, event, Table, Column, Integer, ForeignKey

from test_stage17_sql_privacy_plan import setup as plan_setup, residency_setup, NOW
from app.domains.ai_limits.contracts import BoundaryDenied
from app.domains.public_service.recoverable_privacy import RecoverableFixturePrivacy, TOPIC, encode, decode
from app.domains.public_service.sql_privacy_workflow import DisposablePrivacyScope
from app.domains.public_service.sql_account import AccountTableRule, schema_digest
from app.domains.auth.models import ActivityLog
from app.infrastructure.database.outbox.models import OutboxMessage


@pytest.fixture
def recovery(plan_setup):
    db, planner, request = plan_setup
    workflow = RecoverableFixturePrivacy(db, planner.reader, planner.keyring, retention=planner.retention,
        scope=DisposablePrivacyScope('synthetic:recoverable-erasure-drill'))
    return db, workflow, request


def snapshot(db, workflow):
    return {name: [dict(row) for row in db.execute(select(workflow.reader.metadata.tables[name])
        .order_by(workflow.reader.metadata.tables[name].c.id)).mappings()]
        for name in ('fixture_portfolios', 'fixture_holdings')}


def test_encrypted_archive_and_restore_exact_rows_without_touching_other_owner(recovery):
    db, workflow, request = recovery
    before = snapshot(db, workflow)
    result = workflow.execute(1, request, now=NOW); db.commit()
    assert result['complete_account_erasure'] is False
    archive = db.scalar(select(OutboxMessage).where(OutboxMessage.topic == TOPIC))
    assert 'private-holding-1' not in str(archive.payload)
    assert len(snapshot(db, workflow)['fixture_holdings']) == 1
    restored = workflow.restore(1, request, now=NOW); db.commit()
    assert restored['state'] == 'restored' and restored['synthetic'] is True
    assert snapshot(db, workflow) == before
    assert workflow.restore(1, request, now=NOW)['state'] == 'already_restored'
    assert workflow.execute(1, request, now=NOW) == result


def test_conflicting_restore_rolls_back_parent_insert_and_never_overwrites(recovery):
    db, workflow, request = recovery
    workflow.execute(1, request, now=NOW); db.commit()
    table = workflow.reader.metadata.tables['fixture_holdings']
    db.execute(table.insert().values(id=1, portfolio_id=2, label='foreign-collision')); db.commit()
    before = snapshot(db, workflow)
    with pytest.raises(BoundaryDenied, match='RECOVERY_CONFLICT'): workflow.restore(1, request, now=NOW)
    db.commit()
    assert snapshot(db, workflow) == before
    assert db.scalar(select(OutboxMessage).where(OutboxMessage.topic == TOPIC)).payload['state'] == 'recoverable'


@pytest.mark.parametrize('change', ['owner', 'production', 'expired', 'ciphertext', 'scope'])
def test_restore_boundaries_fail_closed_without_mutation(recovery, monkeypatch, change):
    db, workflow, request = recovery
    workflow.execute(1, request, now=NOW); db.commit()
    if change == 'production': monkeypatch.setenv('ENVIRONMENT', 'production')
    if change == 'scope': workflow.scope = DisposablePrivacyScope('synthetic:different-recovery-drill')
    if change == 'ciphertext':
        row = db.scalar(select(OutboxMessage).where(OutboxMessage.topic == TOPIC))
        row.payload = {**row.payload, 'ciphertext': 'corrupted'}; db.commit()
    before = snapshot(db, workflow)
    with pytest.raises(BoundaryDenied):
        workflow.restore(2 if change == 'owner' else 1, request,
            now=NOW + timedelta(days=8) if change == 'expired' else NOW)
    db.commit()
    assert snapshot(db, workflow) == before


def test_archive_failure_prevents_deletion_even_if_outer_transaction_commits(recovery):
    db, workflow, request = recovery
    before = snapshot(db, workflow)
    def fail(session, context, objects):
        if any(isinstance(row, OutboxMessage) and row.topic == TOPIC for row in session.new):
            raise RuntimeError('synthetic archive failure')
    event.listen(db, 'before_flush', fail)
    try:
        with pytest.raises(RuntimeError): workflow.execute(1, request, now=NOW)
        db.commit()
    finally: event.remove(db, 'before_flush', fail)
    assert snapshot(db, workflow) == before
    assert db.scalar(select(OutboxMessage).where(OutboxMessage.topic == TOPIC)) is None


@pytest.mark.parametrize('phase', ['delete', 'restore'])
def test_effect_and_recovery_audit_failure_roll_back_together(recovery, phase):
    db, workflow, request = recovery
    if phase == 'restore': workflow.execute(1, request, now=NOW); db.commit()
    before = snapshot(db, workflow)
    action = 'privacy_fixture_restored' if phase == 'restore' else 'privacy_sql_fixture_complete'
    def fail(session, context, objects):
        if any(isinstance(row, ActivityLog) and row.action == action for row in session.new):
            raise RuntimeError('synthetic audit failure')
    event.listen(db, 'before_flush', fail)
    try:
        with pytest.raises(RuntimeError):
            getattr(workflow, 'restore' if phase == 'restore' else 'execute')(1, request, now=NOW)
        db.commit()
    finally: event.remove(db, 'before_flush', fail)
    assert snapshot(db, workflow) == before
    archive = db.scalar(select(OutboxMessage).where(OutboxMessage.topic == TOPIC))
    assert archive is None if phase == 'delete' else archive.payload['state'] == 'recoverable'


def test_operational_store_without_safe_restore_adapter_blocks_before_erasure(recovery):
    db, workflow, request = recovery
    metadata = workflow.reader.metadata
    table = Table('queued_work', metadata, Column('id', Integer, primary_key=True),
        Column('user_id', ForeignKey('users.id'), nullable=False))
    table.create(db.get_bind()); db.execute(table.insert().values(id=1, user_id=1)); db.commit()
    workflow.reader.inventory = replace(workflow.reader.inventory, schema_digest=schema_digest(metadata),
        rules=(*workflow.reader.inventory.rules, AccountTableRule('queued_work', ('id', 'user_id'))))
    workflow.retention = replace(workflow.retention,
        retain_until=(*workflow.retention.retain_until, ('queued_work', None)))
    before = snapshot(db, workflow)
    with pytest.raises(BoundaryDenied, match='STORE_ADAPTER_UNAVAILABLE'): workflow.execute(1, request, now=NOW)
    db.commit()
    assert snapshot(db, workflow) == before
    assert db.execute(select(table)).one().id == 1


def test_type_codec_roundtrips_data_without_interpreting_user_json_tags():
    value = {'date': date(2026, 10, 23), 'time': datetime(2026, 10, 23, tzinfo=timezone.utc),
        'amount': Decimal('123.450'), 'identifier': uuid4(), 'binary': b'fixture-only',
        'json': {'type': 'datetime', 'value': 'user-text', 'items': [True, None, 2, .5]}}
    assert decode(encode(value)) == value


@pytest.mark.parametrize('value', [float('nan'), object(), {'nested': object()}])
def test_unsupported_preimages_are_held_before_deletion(value):
    with pytest.raises(BoundaryDenied): encode(value)
