"""Actual SQL transactions with disposable records; no real evidence or authority."""
from datetime import datetime, timezone, timedelta
from uuid import uuid5, NAMESPACE_URL
import pytest
from cryptography.fernet import Fernet
from sqlalchemy import create_engine, select, func, event
from sqlalchemy.orm import Session
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.dialects.postgresql import JSONB
import app.infrastructure.database.all_models
from app.domains.auth.models import User, UserRole, ActivityLog
from app.infrastructure.database.outbox.models import OutboxMessage
from app.domains.connections.crypto import ConnectionKeyring
from app.domains.ai_limits.contracts import BoundaryDenied
from app.domains.public_service.reviewed_residency import ReviewedResidencyProducer, ResidencyReviewPolicy, EVIDENCE

NOW = datetime(2026, 10, 22, 0, 0, tzinfo=timezone.utc)
@compiles(JSONB, 'sqlite')
def jsonb_sqlite(*args, **kwargs): return 'JSON'

@pytest.fixture
def setup(tmp_path):
    engine = create_engine('sqlite:///' + str(tmp_path / 'residency.sqlite'))
    for table in (User.__table__, ActivityLog.__table__, OutboxMessage.__table__): table.create(engine)
    db = Session(engine, expire_on_commit=False)
    for id, role in ((1, UserRole.USER), (2, UserRole.ADMIN), (3, UserRole.USER), (4, UserRole.ADMIN)):
        db.add(User(id=id, email=f'fixture{id}@example.invalid', username=f'fixture{id}', password_hash='unusable',
                    role=role, is_active=True, is_verified=True))
    db.commit()
    policy = ResidencyReviewPolicy('fixture-policy-not-real-approval', frozenset({2}), frozenset({'fixture_document_review'}))
    producer = ReviewedResidencyProducer(ConnectionKeyring({1: Fernet.generate_key().decode()}), policy)
    try: yield db, producer
    finally: db.close(); engine.dispose()

def consent(db, p, owner=1):
    row = p.consent(db, owner, 'fixture-consent', 'fixture_document_review', confirmed=True, now=NOW)
    db.commit(); return row.id

def issue(db, p, id, actor=2, owner=1, **overrides):
    values = dict(country='IN', evidence_type='fixture_document_review', reference_hash='a' * 64,
                  expires=NOW + timedelta(days=1), now=NOW)
    values.update(overrides)
    return p.ingest(db, actor, owner, id, **values)

def test_default_unconfigured_policy_cannot_admit_evidence(setup):
    db, p = setup
    with pytest.raises(BoundaryDenied, match='POLICY_UNCONFIGURED'):
        ReviewedResidencyProducer(p.keyring).consent(db, 1, 'key', 'fixture_document_review', confirmed=True, now=NOW)
    assert db.scalar(select(func.count()).select_from(OutboxMessage)) == 0

def test_owned_consent_authorized_review_and_single_use_persist(setup):
    db, p = setup; id = consent(db, p); row = issue(db, p, id); db.commit()
    assert p.resolve(db, 1, now=NOW)['evidence_id'] == str(row.id)
    with pytest.raises(BoundaryDenied): issue(db, p, id)
    assert db.scalar(select(func.count()).select_from(ActivityLog)) == 1

@pytest.mark.parametrize('actor', [1, 3, 4, True])
def test_owner_or_unappointed_admin_cannot_review(setup, actor):
    db, p = setup; id = consent(db, p)
    with pytest.raises(BoundaryDenied): issue(db, p, id, actor=actor)
    assert db.scalar(select(func.count()).select_from(OutboxMessage).where(OutboxMessage.topic == EVIDENCE)) == 0

@pytest.mark.parametrize('change', [dict(country='US'), dict(evidence_type='self_declaration'),
    dict(reference_hash='not-a-digest'), dict(expires=NOW), dict(expires=NOW + timedelta(days=31)),
    dict(now=NOW + timedelta(minutes=16))])
def test_unapproved_foreign_expired_or_stale_input_never_creates_eligibility(setup, change):
    db, p = setup; id = consent(db, p)
    with pytest.raises(BoundaryDenied): issue(db, p, id, **change)

def test_foreign_consent_and_transplanted_ciphertext_fail_closed(setup):
    db, p = setup; id = consent(db, p, owner=3)
    with pytest.raises(BoundaryDenied): issue(db, p, id, owner=1)
    own = consent(db, p); row = issue(db, p, own); db.commit()
    foreign_id = uuid5(NAMESPACE_URL, 'credx:reviewed-residency:3')
    db.add(OutboxMessage(id=foreign_id, topic=EVIDENCE, payload={**row.payload, 'owner_id': 3})); db.commit()
    with pytest.raises(BoundaryDenied): p.resolve(db, 3, now=NOW)

@pytest.mark.parametrize('when', [NOW - timedelta(seconds=1), NOW + timedelta(days=2)])
def test_future_or_expired_evidence_is_rejected(setup, when):
    db, p = setup; issue(db, p, consent(db, p)); db.commit()
    with pytest.raises(BoundaryDenied): p.resolve(db, 1, now=when)

def test_revocation_is_sealed_and_cannot_be_reset_by_unsigned_flag(setup):
    db, p = setup; row = issue(db, p, consent(db, p)); db.commit()
    p.revoke(db, 1, 1); db.commit()
    row.payload = {**row.payload, 'revoked': False}; db.commit()
    with pytest.raises(BoundaryDenied): p.resolve(db, 1, now=NOW)

def test_reviewer_demotion_policy_change_or_ciphertext_tamper_rejects(setup):
    db, p = setup; row = issue(db, p, consent(db, p)); db.commit()
    db.get(User, 2).role = UserRole.USER; db.commit()
    with pytest.raises(BoundaryDenied): p.resolve(db, 1, now=NOW)
    db.get(User, 2).role = UserRole.ADMIN; db.commit()
    p.policy = ResidencyReviewPolicy('different-reviewed-policy', frozenset({2}), frozenset({'fixture_document_review'}))
    with pytest.raises(BoundaryDenied): p.resolve(db, 1, now=NOW)
    row.payload = {**row.payload, 'ciphertext': 'forged'}; db.commit()
    with pytest.raises(BoundaryDenied): p.resolve(db, 1, now=NOW)

def test_audit_failure_rolls_back_consumption_and_evidence(setup):
    db, p = setup; id = consent(db, p)
    def fail(*args): raise RuntimeError('fixture audit failure')
    event.listen(ActivityLog, 'before_insert', fail)
    try:
        with pytest.raises(RuntimeError, match='audit failure'): issue(db, p, id)
        db.rollback()
    finally: event.remove(ActivityLog, 'before_insert', fail)
    assert db.get(OutboxMessage, id).payload['consumed'] is False
    assert db.scalar(select(func.count()).select_from(OutboxMessage).where(OutboxMessage.topic == EVIDENCE)) == 0
