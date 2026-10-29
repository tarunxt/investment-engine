"""Exact, durable review of fake acquisition bytes; never a provider adapter.

Preview records are evidence, not dispatch messages. Acceptance uses the same
owner/module lock and immutable journal as the installed analysis composition.
No retention, real deletion, credential or financial-execution authority is added.
"""
from copy import deepcopy
from datetime import datetime, timezone
from uuid import UUID, uuid5

from sqlalchemy import func, select

from app.domains.runs.analysis_workflows import synthetic_journal as journal
from app.domains.runs.analysis_workflows.acquisition import MAX_AGE
from app.domains.runs.analysis_workflows.contracts import WorkflowDenied, digest, naive, utc
from app.domains.runs.analysis_workflows.synthetic_composition import SyntheticAnalysis
from app.infrastructure.database.outbox.models import OutboxMessage

TOPIC = 'uat2.synthetic_snapshot_review.v1'
NAMESPACE = uuid5(journal.NAMESPACE, TOPIC)
MAX_REVIEWS = 4096  # Same bounded-history ceiling as synthetic acquisition.


class SnapshotReviews:
    def __init__(self, analysis):
        if type(analysis) is not SyntheticAnalysis or analysis.source_storage != 'journal':
            raise WorkflowDenied('Installed journal simulation composition required')
        self.analysis = analysis

    def _authorize(self, db, owner, version=None):
        return self.analysis.authorize(db, owner, 'india', version=version, scheduled=False)

    def _baseline(self, db, owner):
        row = db.scalar(select(OutboxMessage).where(OutboxMessage.topic == journal.TOPIC,
            OutboxMessage.payload['owner_id'].as_integer() == owner)
            .order_by(OutboxMessage.payload['sequence'].as_integer().desc()).limit(1)
            .execution_options(populate_existing=True))
        if row is None:
            return None, None, None
        try:
            p, source = row.payload, row.payload['source']
            raw = {key: value for key, value in source.items() if key != 'content_hash'}
            if (type(p['owner_id']) is not int or p['owner_id'] != owner
                    or source['owner_id'] != owner or source['source_receipt_id'] != str(row.id)
                    or source['simulation_only'] is not True or p['simulation_only'] is not True
                    or source['content_hash'] != digest(raw) or p['source_hash'] != digest(source)):
                raise WorkflowDenied('Current source evidence is invalid')
            return str(row.id), p['source_hash'], deepcopy(source)
        except (KeyError, TypeError, ValueError, AttributeError):
            raise WorkflowDenied('Current source evidence is invalid') from None

    def _load(self, db, owner, identifier):
        try:
            row = db.get(OutboxMessage, UUID(str(identifier)), populate_existing=True)
            if row is None or row.topic != TOPIC:
                raise WorkflowDenied('Owned snapshot review unavailable')
            p = row.payload
            if (set(p) != {'owner_id', 'review', 'review_digest', 'accepted_receipt'}
                    or type(p['owner_id']) is not int or p['owner_id'] != owner):
                raise WorkflowDenied('Owned snapshot review unavailable')
            review = p['review']
            if (set(review) != {'schema_version', 'owner_id', 'simulation_only', 'module_version',
                    'base_receipt', 'base_hash', 'key', 'captured_at', 'expires_at', 'proposed'}
                    or review['schema_version'] != 1 or review['owner_id'] != owner
                    or review['simulation_only'] is not True or type(review['module_version']) is not int
                    or review['module_version'] < 1 or review['key'] != 'review-' + str(row.id)
                    or digest(review) != p['review_digest']):
                raise WorkflowDenied('Snapshot review integrity failed')
            from app.domains.runs.analysis_workflows.synthetic_price_history import validate_if_present
            validate_if_present(review['proposed'])
            capture = datetime.fromisoformat(review['captured_at'])
            expiry = datetime.fromisoformat(review['expires_at'])
            proposed = review['proposed']
            if (capture.tzinfo is None or expiry != capture + MAX_AGE
                    or proposed['captured_at'] != capture.isoformat()
                    or proposed['owner_id'] != owner or proposed['simulation_only'] is not True
                    or proposed['portfolio'] != 'india'
                    or proposed['source_receipt_id'] != str(uuid5(journal.NAMESPACE, str(owner) + ':' + review['key']))
                    or proposed['content_hash'] != digest({k: v for k, v in proposed.items() if k != 'content_hash'})):
                raise WorkflowDenied('Snapshot review source binding failed')
            if p['accepted_receipt'] is not None:
                receipt = db.get(OutboxMessage, UUID(p['accepted_receipt']), populate_existing=True)
                if (receipt is None or receipt.topic != journal.TOPIC
                        or receipt.payload.get('owner_id') != owner
                        or receipt.payload.get('source') != proposed
                        or receipt.payload.get('source_hash') != digest(proposed)):
                    raise WorkflowDenied('Accepted snapshot receipt unavailable')
            return row
        except (KeyError, TypeError, ValueError, AttributeError):
            raise WorkflowDenied('Snapshot review integrity failed') from None

    def describe(self, db, owner, identifier, *, now=None):
        self._authorize(db, owner)
        row = self._load(db, owner, identifier)
        now = utc(now or datetime.now(timezone.utc))
        baseline, _, _ = self._baseline(db, owner)
        p, review = row.payload, row.payload['review']
        previous = None
        if review['base_receipt'] is not None:
            base = db.get(OutboxMessage, UUID(review['base_receipt']), populate_existing=True)
            if (base is None or base.topic != journal.TOPIC
                    or base.payload.get('owner_id') != owner
                    or base.payload.get('source_hash') != review['base_hash']
                    or digest(base.payload.get('source')) != review['base_hash']):
                raise WorkflowDenied('Previous owned source evidence unavailable')
            previous = deepcopy(base.payload['source'])
        return {'id': str(row.id), 'owner_id': owner, 'simulation_only': True,
            'review_digest': p['review_digest'], 'review': deepcopy(review),
            'state': 'accepted' if p['accepted_receipt'] else
                'expired' if now > datetime.fromisoformat(review['expires_at']) else 'preview',
            'accepted_receipt': p['accepted_receipt'],
            'previous_source': previous,
            'is_current': p['accepted_receipt'] is not None and p['accepted_receipt'] == baseline,
            'orders_authorized': False}

    def preview(self, db, owner, key, *, now=None):
        if type(key) is not str or not 8 <= len(key) <= 96 or not key.isascii() or not key.isprintable():
            raise WorkflowDenied('Bounded snapshot review identity required')
        now = utc(now or datetime.now(timezone.utc))
        identity = self._authorize(db, owner)
        current = journal.connection(db, owner, self.analysis.scope, now)
        identifier = uuid5(NAMESPACE, str(owner) + ':' + key)
        if db.get(OutboxMessage, identifier) is not None:
            return self.describe(db, owner, identifier, now=now)
        count = db.scalar(select(func.count()).select_from(OutboxMessage).where(
            OutboxMessage.topic == TOPIC, OutboxMessage.payload['owner_id'].as_integer() == owner))
        if count >= MAX_REVIEWS:
            raise WorkflowDenied('Review history bound reached; reviewed retention required')
        baseline, source_hash, _ = self._baseline(db, owner)
        acquisition_key = 'review-' + str(identifier)
        source_id = uuid5(journal.NAMESPACE, str(owner) + ':' + acquisition_key)
        review = {'schema_version': 1, 'owner_id': owner, 'simulation_only': True,
            'module_version': identity.version, 'base_receipt': baseline, 'base_hash': source_hash,
            'key': acquisition_key, 'captured_at': now.isoformat(),
            'expires_at': (now + MAX_AGE).isoformat(),
            'proposed': journal.proposed_source(owner, current, source_id, now)}
        db.add(OutboxMessage(id=identifier, topic=TOPIC, created_at=naive(now), payload={
            'owner_id': owner, 'review': review, 'review_digest': digest(review), 'accepted_receipt': None}))
        db.flush()
        return self.describe(db, owner, identifier, now=now)

    def accept(self, db, owner, identifier, displayed_digest, *, now=None):
        now = utc(now or datetime.now(timezone.utc))
        self._authorize(db, owner)
        row = self._load(db, owner, identifier)
        p, review = row.payload, row.payload['review']
        if type(displayed_digest) is not str or displayed_digest != p['review_digest']:
            raise WorkflowDenied('Exact reviewed snapshot digest required')
        # A committed receipt can be read after a lost response without acquiring again.
        if p['accepted_receipt'] is not None:
            return self.describe(db, owner, row.id, now=now)
        self._authorize(db, owner, version=review['module_version'])
        if now > datetime.fromisoformat(review['expires_at']):
            raise WorkflowDenied('Snapshot review expired')
        current = journal.connection(db, owner, self.analysis.scope, now)
        if journal.binding(current) != review['proposed']['connection']:
            raise WorkflowDenied('Snapshot connection changed; review again')
        baseline, source_hash, _ = self._baseline(db, owner)
        if (baseline, source_hash) != (review['base_receipt'], review['base_hash']):
            raise WorkflowDenied('Current snapshot changed; review again')
        source = journal.acquire(db, owner, scope=self.analysis.scope, authorize=self.analysis.authorize,
            key=review['key'], now=now, reviewed_capture=datetime.fromisoformat(review['captured_at']),
            expected_source_hash=review['proposed']['content_hash'])
        row.payload = {**p, 'accepted_receipt': source['source_receipt_id']}
        db.flush()
        return self.describe(db, owner, row.id, now=now)
