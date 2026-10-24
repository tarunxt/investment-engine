"""Durable fake venue journal in the existing transactional outbox.

Only synthetic order receipts are stored. There is no provider, credential,
network, task registration or production activation. A separate engine/SQL
transaction models acceptance surviving application rollback or process loss.
The outbox relay selects named topics and cannot publish this journal topic.
"""
from copy import deepcopy
import re
from uuid import NAMESPACE_URL, uuid5

from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError

from app.infrastructure.database.outbox.models import OutboxMessage
from .contracts import OrderDenied, digest, payload, receipt as validate_receipt

TOPIC = 'uat2.synthetic_venue.receipt.v1'
OUTCOMES = frozenset({'filled', 'partial', 'acknowledged', 'rejected',
                      'before_acceptance', 'after_acceptance', 'rate_limit'})


class JournalBrokerFake:
    """Same finite fake protocol on SQLite fixtures or PostgreSQL.

    PostgreSQL eligibility, owner admission and runtime isolation belong to the
    hosted composition. Constructing this adapter alone grants no runtime access.
    """
    def __init__(self, engine, binding, outcomes=()):
        if engine.dialect.name not in {'postgresql', 'sqlite'}:
            raise OrderDenied('TRANSACTIONAL_SYNTHETIC_JOURNAL_REQUIRED')
        if type(binding) is not str or not re.fullmatch('[0-9a-f]{64}', binding):
            raise OrderDenied('EXACT_SYNTHETIC_BINDING_REQUIRED')
        selected = tuple(outcomes)
        if len(selected) > 20 or any(type(v) is not str or v not in OUTCOMES for v in selected):
            raise OrderDenied('INVALID_SYNTHETIC_OUTCOME')
        self.engine, self.binding = engine, binding
        self.outcomes, self.calls = list(selected), []

    def _key(self, reference, binding):
        if binding != self.binding:
            raise OrderDenied('FAKE_ACCOUNT_BINDING_MISMATCH')
        if type(reference) is not str or not re.fullmatch('[0-9a-f]{64}', reference):
            raise OrderDenied('EXACT_SYNTHETIC_REFERENCE_REQUIRED')
        # One immutable reference across accounts: a changed account cannot
        # silently create a second venue order with the same client reference.
        return uuid5(NAMESPACE_URL, 'credx:synthetic-venue:' + reference)

    def _read(self, row, reference, binding):
        value = row.payload
        if (row.topic != TOPIC or type(value) is not dict
                or set(value) != {'schema', 'simulation', 'binding', 'leg', 'receipt', 'trades', 'digest'}
                or value['schema'] != 1 or value['simulation'] is not True
                or value['binding'] != binding
                or digest({k: v for k, v in value.items() if k != 'digest'}) != value['digest']):
            raise OrderDenied('SYNTHETIC_VENUE_RECEIPT_CHANGED')
        leg = payload({'legs': [value['leg']], 'sequencing': 'listed'})['legs'][0]
        receipt = validate_receipt(value['receipt'], leg, reference)
        quantity = receipt['filled_quantity']
        trades = [dict(trade_id='trade-' + reference, broker_order_id=receipt['broker_order_id'],
                       client_reference=reference, payload_digest=digest(leg), quantity=quantity)] if quantity else []
        if value['trades'] != trades:
            raise OrderDenied('SYNTHETIC_VENUE_TRADES_CHANGED')
        return {'matches': [deepcopy(receipt)], 'trades': deepcopy(trades), 'ambiguous': False}

    def submit(self, leg, reference, binding):
        key = self._key(reference, binding)
        normalized = payload({'legs': [leg], 'sequencing': 'listed'})['legs'][0]
        if normalized != leg:
            raise OrderDenied('EXACT_SYNTHETIC_LEG_REQUIRED')
        with Session(self.engine) as db:
            if db.get(OutboxMessage, key) is not None:
                raise OrderDenied('NO_SUBMISSION_REPLAY')
            outcome = self.outcomes.pop(0) if self.outcomes else 'filled'
            self.calls.append(reference)
            if outcome in {'before_acceptance', 'rate_limit'}:
                raise TimeoutError('Synthetic pre-acceptance uncertainty')
            state = 'filled' if outcome == 'after_acceptance' else outcome
            quantity = leg['quantity'] if state == 'filled' else (1 if state == 'partial' else 0)
            receipt = validate_receipt(dict(state=state, broker_order_id='fake-' + reference,
                filled_quantity=quantity, client_reference=reference, payload_digest=digest(leg)), leg, reference)
            trades = [dict(trade_id='trade-' + reference, broker_order_id=receipt['broker_order_id'],
                client_reference=reference, payload_digest=digest(leg), quantity=quantity)] if quantity else []
            value = dict(schema=1, simulation=True, binding=binding, leg=deepcopy(leg), receipt=receipt, trades=trades)
            db.add(OutboxMessage(id=key, topic=TOPIC, payload={**value, 'digest': digest(value)}))
            try:
                db.commit()
            except IntegrityError:
                db.rollback()
                raise OrderDenied('NO_SUBMISSION_REPLAY') from None
            if outcome == 'after_acceptance':
                raise TimeoutError('Synthetic acceptance followed by lost response')
            return deepcopy(receipt)

    def reconcile(self, reference, binding):
        key = self._key(reference, binding)
        with Session(self.engine) as db:
            row = db.get(OutboxMessage, key)
            return self._read(row, reference, binding) if row else {'matches': [], 'trades': [], 'ambiguous': False}
