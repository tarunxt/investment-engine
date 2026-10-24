"""SQL-backed reviewed residency ingestion; deliberately no default policy/binding.

Evidence types, reviewer identities and review reference must be configured by
the accountable owner after review. Only hashed document references are stored.
No email/IP/declaration, public request flag or synthetic producer grants access.
"""
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import re
from uuid import NAMESPACE_URL, uuid5
from sqlalchemy import select
from app.domains.auth.models import User, UserRole, ActivityLog
from app.domains.connections.crypto import ConnectionKeyring, ConnectionFault
from app.domains.ai_limits.contracts import BoundaryDenied, digest, utc
from app.infrastructure.database.outbox.models import OutboxMessage

CONSENT = 'public_service.residency.review_consent.v1'
EVIDENCE = 'public_service.residency.reviewed.v1'


@dataclass(frozen=True)
class ResidencyReviewPolicy:
    reference: str = ''
    reviewer_ids: frozenset[int] = frozenset()
    evidence_types: frozenset[str] = frozenset()
    max_valid_days: int = 30

    def fingerprint(self):
        if (not isinstance(self.reference, str) or not 3 <= len(self.reference) <= 120
            or type(self.reviewer_ids) is not frozenset or not self.reviewer_ids or len(self.reviewer_ids) > 32
            or any(type(i) is not int or i <= 0 for i in self.reviewer_ids)
            or type(self.evidence_types) is not frozenset or not self.evidence_types or any(type(t) is not str or not re.fullmatch('[a-z][a-z0-9_.-]{0,79}', t) for t in self.evidence_types)
            or type(self.max_valid_days) is not int or not 1 <= self.max_valid_days <= 365):
            raise BoundaryDenied('RESIDENCY_REVIEW_POLICY_UNCONFIGURED')
        return digest({'reference': self.reference, 'reviewers': sorted(self.reviewer_ids),
                       'types': sorted(self.evidence_types), 'max_days': self.max_valid_days})


class ReviewedResidencyProducer:
    def __init__(self, keyring, policy=None):
        if type(keyring) is not ConnectionKeyring: raise BoundaryDenied('REVIEW_KEYRING_REQUIRED')
        self.keyring = keyring
        self.policy = policy if type(policy) is ResidencyReviewPolicy else ResidencyReviewPolicy()

    def _owner(self, db, owner_id):
        if type(owner_id) is not int or owner_id <= 0: raise BoundaryDenied('ACTIVE_OWNER_REQUIRED')
        row = db.scalar(select(User).where(User.id == owner_id).with_for_update().execution_options(populate_existing=True))
        if row is None or not row.is_active or not row.is_verified: raise BoundaryDenied('ACTIVE_OWNER_REQUIRED')
        return row

    def _reviewer(self, db, actor):
        if type(actor) is not int or actor not in self.policy.reviewer_ids: raise BoundaryDenied('RESIDENCY_REVIEWER_REQUIRED')
        row = db.scalar(select(User).where(User.id == actor).execution_options(populate_existing=True))
        if row is None or not row.is_active or not row.is_verified or row.role != UserRole.ADMIN:
            raise BoundaryDenied('RESIDENCY_REVIEWER_REQUIRED')

    def _open(self, row):
        try: return self.keyring.open(row.payload['ciphertext'], row.payload['key_version'])
        except (ConnectionFault, KeyError, TypeError): raise BoundaryDenied('RESIDENCY_EVIDENCE_INVALID') from None

    def consent(self, db, owner_id, key, evidence_type, *, confirmed=False, now=None):
        policy = self.policy.fingerprint(); now = utc(now or datetime.now(timezone.utc)); self._owner(db, owner_id)
        if confirmed is not True or type(evidence_type) is not str or evidence_type not in self.policy.evidence_types or not isinstance(key, str) or not 1 <= len(key) <= 100:
            raise BoundaryDenied('EXACT_RESIDENCY_REVIEW_CONSENT_REQUIRED')
        id = uuid5(NAMESPACE_URL, f'credx:residency-consent:{owner_id}:{digest(key)}')
        payload = {'owner': owner_id, 'policy': policy, 'evidence_type': evidence_type,
                   'consumed': False, 'created_at': now.isoformat(), 'expires_at': (now + timedelta(minutes=15)).isoformat()}
        old = db.get(OutboxMessage, id)
        if old is not None:
            bound = self._open(old)
            if old.topic != CONSENT or bound['owner'] != owner_id or bound['policy'] != policy or bound['evidence_type'] != evidence_type:
                raise BoundaryDenied('RESIDENCY_CONSENT_REPLAY_CONFLICT')
            return old
        ciphertext, version = self.keyring.seal(payload)
        row = OutboxMessage(id=id, topic=CONSENT, payload={'owner_id': owner_id, 'ciphertext': ciphertext, 'key_version': version, 'consumed': False})
        db.add(row); db.flush(); return row

    def ingest(self, db, actor, owner_id, consent_id, *, country, evidence_type, reference_hash, expires, now=None):
        policy = self.policy.fingerprint(); now = utc(now or datetime.now(timezone.utc)); expires = utc(expires)
        self._owner(db, owner_id); self._reviewer(db, actor)
        if country != 'IN' or type(evidence_type) is not str or evidence_type not in self.policy.evidence_types or type(reference_hash) is not str or not re.fullmatch('[0-9a-f]{64}', reference_hash) or not now < expires <= now + timedelta(days=self.policy.max_valid_days):
            raise BoundaryDenied('REVIEWED_RESIDENCY_EVIDENCE_REQUIRED')
        consent = db.scalar(select(OutboxMessage).where(OutboxMessage.id == consent_id, OutboxMessage.topic == CONSENT).with_for_update())
        if consent is None or consent.payload.get('consumed') is not False: raise BoundaryDenied('RESIDENCY_CONSENT_UNAVAILABLE')
        bound = self._open(consent)
        try: valid = bound['consumed'] is False and bound['owner'] == owner_id and bound['policy'] == policy and bound['evidence_type'] == evidence_type and utc(datetime.fromisoformat(bound['created_at'])) <= now < utc(datetime.fromisoformat(bound['expires_at']))
        except (ValueError, TypeError, KeyError): valid = False
        if not valid: raise BoundaryDenied('RESIDENCY_CONSENT_BINDING')
        id = uuid5(NAMESPACE_URL, f'credx:reviewed-residency:{owner_id}')
        prior = db.get(OutboxMessage, id)
        if prior is not None:
            if prior.topic != EVIDENCE: raise BoundaryDenied('RESIDENCY_EVIDENCE_INVALID')
            if self._open(prior).get('consent_id') == str(consent_id): raise BoundaryDenied('RESIDENCY_CONSENT_UNAVAILABLE')
        claims = {'owner': owner_id, 'policy': policy, 'actor': actor, 'country': country,
                  'type': evidence_type, 'reference_hash': reference_hash, 'consent_id': str(consent_id),
                  'issued_at': now.isoformat(), 'expires_at': expires.isoformat(), 'revoked': False}
        ciphertext, version = self.keyring.seal(claims)
        values = {'owner_id': owner_id, 'ciphertext': ciphertext, 'key_version': version, 'revoked': False}
        if prior is None:
            prior = OutboxMessage(id=id, topic=EVIDENCE, payload=values); db.add(prior)
        else: prior.payload = values
        consumed_cipher, consumed_version = self.keyring.seal({**bound, 'consumed': True})
        consent.payload = {'owner_id': owner_id, 'ciphertext': consumed_cipher, 'key_version': consumed_version, 'consumed': True}
        db.add(ActivityLog(user_id=actor, action='residency_review_ingested', resource_type='user', resource_id=owner_id, details=str(prior.id)))
        db.flush(); return prior

    def resolve(self, db, owner_id, *, now=None):
        policy = self.policy.fingerprint(); now = utc(now or datetime.now(timezone.utc)); self._owner(db, owner_id)
        id = uuid5(NAMESPACE_URL, f'credx:reviewed-residency:{owner_id}')
        row = db.scalar(select(OutboxMessage).where(OutboxMessage.id == id, OutboxMessage.topic == EVIDENCE).with_for_update().execution_options(populate_existing=True))
        if row is None or row.payload.get('owner_id') != owner_id or row.payload.get('revoked') is not False:
            raise BoundaryDenied('REVIEWED_RESIDENCY_UNAVAILABLE')
        claims = self._open(row)
        try:
            valid = set(claims) == {'owner','policy','actor','country','type','reference_hash','consent_id','issued_at','expires_at','revoked'} and claims['revoked'] is False and claims['owner'] == owner_id and claims['policy'] == policy and claims['country'] == 'IN' and claims['type'] in self.policy.evidence_types and utc(datetime.fromisoformat(claims['issued_at'])) <= now < utc(datetime.fromisoformat(claims['expires_at']))
        except (KeyError, ValueError, TypeError): valid = False
        if not valid: raise BoundaryDenied('RESIDENCY_EVIDENCE_BINDING')
        self._reviewer(db, claims['actor'])
        return {'owner_id': owner_id, 'eligible': True, 'country': 'IN', 'evidence_id': str(id),
                'policy_hash': policy, 'expires_at': claims['expires_at']}

    def revoke(self, db, actor, owner_id, *, now=None):
        self.policy.fingerprint(); self._owner(db, owner_id)
        if actor != owner_id: self._reviewer(db, actor)
        row = db.get(OutboxMessage, uuid5(NAMESPACE_URL, f'credx:reviewed-residency:{owner_id}'))
        if row is None or row.topic != EVIDENCE: raise BoundaryDenied('REVIEWED_RESIDENCY_UNAVAILABLE')
        claims = self._open(row)
        if claims.get('owner') != owner_id: raise BoundaryDenied('RESIDENCY_EVIDENCE_BINDING')
        ciphertext, version = self.keyring.seal({**claims, 'revoked': True})
        row.payload = {**row.payload, 'ciphertext': ciphertext, 'key_version': version, 'revoked': True}
        db.add(ActivityLog(user_id=actor, action='residency_review_revoked', resource_type='user', resource_id=owner_id))
        db.flush()

    def apply_to_facts(self, db, owner_id, facts, *, now=None):
        from app.domains.modules.policy import ModuleFacts
        if type(facts) is not ModuleFacts: raise BoundaryDenied('SERVER_FACTS_REQUIRED')
        self.resolve(db, owner_id, now=now)
        # Residency cannot grant a plan, connection, execution right or order confirmation.
        return facts.model_copy(update={'jurisdiction': 'allowed'})
