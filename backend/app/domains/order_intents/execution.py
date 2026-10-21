"""Bounded fake-only worker. Durable DB state, never Redis, decides replay.

No Celery task, outbox consumer, HTTP runtime dependency or real broker is
registered. Calling this class requires an explicit isolated synthetic harness.
"""
from copy import deepcopy
from datetime import timedelta
from uuid import UUID
import re
from sqlalchemy import select, func
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from app.domains.connections.models import IntegrationConnection
from app.infrastructure.database.outbox.models import OutboxMessage
from .contracts import OrderDenied, digest, payload, utc, stored_utc, receipt
from .models import OrderIntent, OrderLeg
from .service import TOPIC
from .execution_models import ExecutionFence, ExecutionRun, ExecutionAttempt
from .execution_fake import ExecutionBrokerFake
from .execution_risk import ExecutionLimits, fresh_risk


def venue_binding(row):
    return digest({'owner': row.owner_id, 'account': row.account_id,
                   'connection': row.connection_id, 'version': row.connection_version,
                   'mode': row.app_mode})


class ExecutionWorker:
    MAX_POLLS = 5
    RECONCILE_WINDOW = timedelta(minutes=10)

    def __init__(self, orders, broker, market, *, limits=None):
        if type(broker) is not ExecutionBrokerFake:
            raise OrderDenied('EXACT_SYNTHETIC_EXECUTION_BROKER_REQUIRED')
        if orders.db.get_bind() is broker.engine:
            raise OrderDenied('SEPARATE_SYNTHETIC_VENUE_REQUIRED')
        self.orders, self.db, self.broker, self.market = orders, orders.db, broker, market
        self.limits = limits or ExecutionLimits()
        self.limits.values()

    def now(self):
        return utc(self.orders.clock())

    def lock_keys(self, keys, *, shared=False):
        dialect = self.db.get_bind().dialect.name
        insert = {'postgresql': pg_insert, 'sqlite': sqlite_insert}.get(dialect)
        if insert is None:
            raise OrderDenied('SUPPORTED_TRANSACTIONAL_DATABASE_REQUIRED')
        result = []
        for key in sorted(keys):
            self.db.execute(insert(ExecutionFence).values(key=key, stopped=False).on_conflict_do_nothing(index_elements=['key']))
            result.append(self.db.scalar(select(ExecutionFence).where(ExecutionFence.key == key).with_for_update(read=shared).execution_options(populate_existing=True)))
        return result

    def fences(self, row, *, reconciliation=False):
        account = 'account:' + digest({'owner': row.owner_id, 'account': row.account_id})
        rows = self.lock_keys([account])
        rows += self.lock_keys(['platform', f'owner:{row.owner_id}', f'connection:{row.connection_id}'], shared=True)
        if not reconciliation and any(r.stopped for r in rows):
            raise OrderDenied('EMERGENCY_STOP')

    def set_stop(self, scope, stopped, *, owner_id=None, connection_id=None):
        """Synthetic control only; no public/operator entitlement is granted."""
        if type(stopped) is not bool:
            raise OrderDenied('BOOLEAN_STOP_REQUIRED')
        if scope == 'platform' and owner_id is None and connection_id is None:
            key = 'platform'
        elif scope == 'owner' and type(owner_id) is int and connection_id is None:
            from app.domains.auth.models import User
            if self.db.get(User, owner_id) is None:
                raise OrderDenied('OWNED_STOP_REQUIRED')
            key = f'owner:{owner_id}'
        elif scope == 'connection' and type(owner_id) is int:
            connection = self.db.get(IntegrationConnection, connection_id)
            if connection is None or connection.owner_id != owner_id:
                raise OrderDenied('OWNED_STOP_REQUIRED')
            key = f'connection:{connection_id}'
        else:
            raise OrderDenied('EXACT_STOP_SCOPE_REQUIRED')
        self.lock_keys([key])[0].stopped = stopped
        self.db.commit()

    def snapshot(self, owner, intent):
        """Narrow reconciliation may read frozen evidence after disable/expiry.

        It cannot submit, refresh credentials, change an order or reactivate a
        module. The original fake account binding is mandatory at every call.
        """
        row = self.orders.owned(owner, intent, lock=False)
        original = (row.owner_id, row.account_id, row.connection_id, row.request_digest)
        self.fences(row, reconciliation=True)
        # Same owner -> selection -> connection -> intent order as Orders.
        # Reconciliation acquires the locks without granting submission policy.
        from app.domains.auth.models import User
        from app.domains.modules.models import UserModulePreferences
        self.db.scalar(select(User).where(User.id==owner).with_for_update())
        self.db.scalar(select(UserModulePreferences).where(UserModulePreferences.user_id==owner).with_for_update())
        connection=self.db.scalar(select(IntegrationConnection).where(IntegrationConnection.id==original[2],IntegrationConnection.owner_id==owner).with_for_update())
        if connection is None:
            raise OrderDenied('ORIGINAL_OWNED_CONNECTION_REQUIRED')
        row = self.orders.owned(owner, intent)
        if original != (row.owner_id, row.account_id, row.connection_id, row.request_digest):
            raise OrderDenied('FENCE_BINDING_CHANGED')
        if payload(deepcopy(row.payload_json)) != row.payload_json or digest(self.orders.bound(row)) != row.request_digest:
            raise OrderDenied('IMMUTABLE_INTENT_CHANGED')
        if not isinstance(row.risk_json, dict) or row.risk_json.get('allowed') is not True or digest({'request': row.request_digest, 'risk': row.risk_json}) != row.review_digest:
            raise OrderDenied('IMMUTABLE_REVIEW_CHANGED')
        run = self.db.get(ExecutionRun, intent, populate_existing=True)
        if run is None or run.binding_digest != row.request_digest or run.approval_digest != row.approval_digest or row.approval_digest != self.orders.approval_hash(row):
            raise OrderDenied('EXECUTION_APPROVAL_BINDING_CHANGED')
        event = self.db.get(OutboxMessage, UUID(run.outbox_id), populate_existing=True)
        if event is None or event.topic != TOPIC or event.execution_attempts != 1 or event.payload != {'owner_id': owner, 'intent_id': intent, 'approval_digest': run.approval_digest, 'request_digest': run.binding_digest}:
            raise OrderDenied('EXECUTION_OUTBOX_BINDING_CHANGED')
        if venue_binding(row) != self.broker.binding:
            raise OrderDenied('ORIGINAL_ACCOUNT_RECONCILIATION_REQUIRED')
        legs = self.orders.legs(row)
        if len(legs) != len(row.payload_json['legs']):
            raise OrderDenied('BASKET_LEGS_CHANGED')
        for i, leg in enumerate(legs):
            if leg.position != i or leg.payload_digest != digest(row.payload_json['legs'][i]) or leg.client_reference != digest({'intent': row.id, 'leg': i}):
                raise OrderDenied('BASKET_LEGS_CHANGED')
            attempt = self.db.get(ExecutionAttempt, leg.id, populate_existing=True)
            if attempt is not None and (attempt.intent_id != intent or attempt.binding_digest != digest({'request': row.request_digest, 'approval': run.approval_digest, 'reference': leg.client_reference})):
                raise OrderDenied('ATTEMPT_BINDING_CHANGED')
        return row, legs, run

    def dispatch(self, outbox_id, *, before_effect=lambda: None):
        """One claimed run. Re-delivery can reconcile, never re-submit a leg."""
        try:
            oid = UUID(str(outbox_id))
        except (ValueError, TypeError):
            raise OrderDenied('PERSISTED_DISPATCH_REQUIRED') from None
        event = self.db.get(OutboxMessage, oid, populate_existing=True)
        if event is None or event.topic != TOPIC or set(event.payload) != {'owner_id', 'intent_id', 'approval_digest', 'request_digest'}:
            raise OrderDenied('PERSISTED_DISPATCH_REQUIRED')
        bound = deepcopy(event.payload)
        row = self.orders.owned(bound['owner_id'], bound['intent_id'], lock=False)
        self.fences(row)
        row, legs = self.orders.checked(bound['owner_id'], bound['intent_id'], self.now())
        event = self.db.scalar(select(OutboxMessage).where(OutboxMessage.id == oid).with_for_update().execution_options(populate_existing=True))
        if event.payload != bound or bound['approval_digest'] != row.approval_digest or bound['request_digest'] != row.request_digest or venue_binding(row) != self.broker.binding:
            raise OrderDenied('DISPATCH_BINDING_CHANGED')
        if self.db.get(ExecutionRun, row.id) is not None or event.execution_attempts or row.state != 'approved' or row.approval_digest != self.orders.approval_hash(row) or stored_utc(row.expires_at) <= self.now():
            raise OrderDenied('CURRENT_UNUSED_APPROVAL_REQUIRED')
        run = ExecutionRun(intent_id=row.id, outbox_id=str(oid), binding_digest=row.request_digest,
                           approval_digest=row.approval_digest, started_at=self.now(), limits_json=self.limits.values())
        self.db.add(run)
        event.execution_attempts = 1
        row.state = 'submitting'
        self.db.commit()
        return self._advance(row.owner_id, row.id, before_effect=before_effect)

    def _approval_current(self, row, run):
        if run.limits_json != self.limits.values() or stored_utc(row.expires_at) <= self.now():
            raise OrderDenied('EXPIRED_APPROVAL_OR_CHANGED_LIMITS')
        if row.state not in {'submitting', 'acknowledged', 'partial', 'unknown'}:
            raise OrderDenied('ORDER_STATE_CHANGED')

    def _advance(self, owner, intent, *, before_effect=lambda: None):
        row, legs, run = self.snapshot(owner, intent)
        for i in range(len(legs)):
            row, legs, run = self.snapshot(owner, intent)
            leg = legs[i]
            if leg.state == 'filled':
                self._stored_receipt(row, leg, i)
                continue
            # Persisted unknown/claimed work cannot ever return to submission.
            if self.db.get(ExecutionAttempt, leg.id) is not None or leg.state != 'draft':
                self.db.commit()
                return row
            self.fences(row)
            row, legs = self.orders.checked(owner, intent, self.now())
            leg = legs[i]
            self._approval_current(row, run)
            if any(prior.state != 'filled' or prior.filled_quantity != row.payload_json['legs'][j]['quantity'] for j, prior in enumerate(legs[:i])):
                raise OrderDenied('PRIOR_LEGS_REQUIRE_RECONCILIATION')
            # Fresh funds and holdings must come from a new observation after a
            # reconciled sell; no proceeds are inferred from an order status.
            proof = fresh_risk(self.market, row, i, self.now(), self.limits)
            # A previous effect consumes its observation. Reusing the same
            # balance/holdings snapshot across orders can over-spend despite
            # per-account serialization. Require a newer trusted observation.
            prior_claim = self.db.scalar(select(func.max(func.coalesce(ExecutionAttempt.observed_at, ExecutionAttempt.claimed_at))).join(OrderIntent, ExecutionAttempt.intent_id == OrderIntent.id).where(OrderIntent.owner_id == owner, OrderIntent.account_id == row.account_id))
            if prior_claim is not None and utc(self.market.read()['as_of']) <= stored_utc(prior_claim):
                raise OrderDenied('NEW_ACCOUNT_OBSERVATION_REQUIRED')
            unresolved = self.db.scalar(select(ExecutionAttempt.leg_id).join(OrderIntent, ExecutionAttempt.intent_id == OrderIntent.id).where(OrderIntent.owner_id == owner, OrderIntent.account_id == row.account_id, ExecutionAttempt.state.notin_(['filled', 'rejected'])).limit(1))
            if unresolved is not None:
                raise OrderDenied('ACCOUNT_RECONCILIATION_REQUIRED')
            minute_ago = self.now() - timedelta(minutes=1)
            count = self.db.scalar(select(func.count()).select_from(ExecutionAttempt).join(OrderIntent, ExecutionAttempt.intent_id == OrderIntent.id).where(OrderIntent.owner_id == owner, OrderIntent.account_id == row.account_id, ExecutionAttempt.claimed_at > minute_ago))
            if count >= self.limits.max_submissions_per_minute:
                raise OrderDenied('ACCOUNT_RATE_LIMIT')
            attempt = ExecutionAttempt(leg_id=leg.id, intent_id=intent, binding_digest=digest({'request': row.request_digest, 'approval': row.approval_digest, 'reference': leg.client_reference}),
                                       state='claimed', claimed_at=self.now(), polls=0, next_poll_at=self.now(), evidence_json={'risk_hash': proof})
            self.db.add(attempt)
            leg.state = row.state = 'submitting'
            self.db.commit()  # crash here is unknown even if the venue saw nothing
            try:
                before_effect()
                row, legs, run = self.snapshot(owner, intent)
                self.fences(row)
                row, legs = self.orders.checked(owner, intent, self.now())
                self._approval_current(row, run)
                leg = legs[i]
                if leg.state != 'submitting' or self.db.get(ExecutionAttempt, leg.id, populate_existing=True).state != 'claimed':
                    raise OrderDenied('CLAIM_STATE_CHANGED')
                effect_risk = fresh_risk(self.market, row, i, self.now(), self.limits)
                if prior_claim is not None and utc(self.market.read()['as_of']) <= stored_utc(prior_claim):
                    raise OrderDenied('NEW_ACCOUNT_OBSERVATION_REQUIRED')
                attempt=self.db.get(ExecutionAttempt,leg.id,populate_existing=True)
                attempt.evidence_json={**attempt.evidence_json,'effect_risk_hash':effect_risk}
                value = self.broker.submit(deepcopy(row.payload_json['legs'][i]), leg.client_reference, venue_binding(row))
                observation = self.broker.reconcile(leg.client_reference, venue_binding(row))
                verified, trades = self._observation(row, leg, i, observation)
                if verified != value:
                    raise OrderDenied('SUBMISSION_RECONCILIATION_MISMATCH')
                self._record(row, leg, i, verified, trades)
                self.db.commit()
                if leg.state != 'filled':
                    return row
            except BaseException as error:
                self.db.rollback()
                row = self.orders.owned(owner, intent)
                leg = self.orders.legs(row)[i]
                attempt = self.db.get(ExecutionAttempt, leg.id, populate_existing=True)
                row.state = leg.state = attempt.state = 'unknown'
                attempt.last_error = type(error).__name__[:80]
                self.db.commit()
                raise
        row, legs, run = self.snapshot(owner, intent)
        for i, leg in enumerate(legs):
            self._stored_receipt(row, leg, i)
        row.state = 'filled'
        self.db.commit()
        return row

    def _stored_receipt(self, row, leg, i):
        evidence = leg.reconciliation_json
        if not isinstance(evidence, dict) or set(evidence) != {'simulation', 'receipt'} or evidence['simulation'] is not True:
            raise OrderDenied('STORED_FILL_EVIDENCE_REQUIRED')
        value = receipt(evidence['receipt'], row.payload_json['legs'][i], leg.client_reference)
        if (value['filled_quantity'], value['broker_order_id'], value['state']) != (leg.filled_quantity, leg.broker_order_id, leg.state):
            raise OrderDenied('STORED_FILL_RECEIPT_CHANGED')
        attempt = self.db.get(ExecutionAttempt, leg.id, populate_existing=True)
        if attempt is None or attempt.state != leg.state or attempt.observed_at is None or not isinstance(attempt.evidence_json,dict) or attempt.evidence_json.get('simulation') is not True or attempt.evidence_json.get('receipt') != value:
            raise OrderDenied('DURABLE_FILL_ATTEMPT_REQUIRED')
        if not isinstance(attempt.evidence_json.get('risk_hash'),str) or not re.fullmatch(r'[0-9a-f]{64}',attempt.evidence_json['risk_hash']):
            raise OrderDenied('CLAIM_RISK_EVIDENCE_REQUIRED')
        self._trades(value, attempt.evidence_json.get('trades'))
        return value

    def _trades(self, value, trades):
        if not isinstance(trades,list) or len(trades)>1000:
            raise OrderDenied('BOUNDED_TRADE_EVIDENCE_REQUIRED')
        ids=set();quantity=0
        for trade in trades:
            if not isinstance(trade,dict) or set(trade)!={'trade_id','broker_order_id','client_reference','payload_digest','quantity'} or not isinstance(trade['trade_id'],str) or not 1<=len(trade['trade_id'])<=100 or trade['trade_id'] in ids or type(trade['quantity']) is not int or trade['quantity']<=0:
                raise OrderDenied('INVALID_TRADE_EVIDENCE')
            if any(trade[key]!=value[key] for key in ('broker_order_id','client_reference','payload_digest')):
                raise OrderDenied('TRADE_BINDING_CHANGED')
            ids.add(trade['trade_id']);quantity+=trade['quantity']
        if quantity!=value['filled_quantity']:
            raise OrderDenied('TRADE_FILL_QUANTITY_MISMATCH')

    def _observation(self,row,leg,i,result):
        if not isinstance(result,dict) or set(result)!={'matches','trades','ambiguous'} or result['ambiguous'] is not False or not isinstance(result['matches'],list) or len(result['matches'])!=1:
            raise OrderDenied('UNRESOLVED_BROKER_MATCH')
        value=receipt(result['matches'][0],row.payload_json['legs'][i],leg.client_reference)
        self._trades(value,result['trades'])
        return value,result['trades']

    def _record(self, row, leg, i, value, trades):
        value = receipt(value, row.payload_json['legs'][i], leg.client_reference)
        if value['filled_quantity'] < leg.filled_quantity or (leg.broker_order_id is not None and leg.broker_order_id != value['broker_order_id']):
            raise OrderDenied('NON_MONOTONIC_BROKER_EVIDENCE')
        duplicate = self.db.scalar(select(OrderLeg.id).join(OrderIntent).where(OrderIntent.owner_id == row.owner_id, OrderIntent.account_id == row.account_id, OrderLeg.broker_order_id == value['broker_order_id'], OrderLeg.id != leg.id).limit(1))
        if duplicate is not None:
            raise OrderDenied('DUPLICATE_BROKER_ORDER_RECEIPT')
        leg.state = value['state']
        leg.filled_quantity = value['filled_quantity']
        leg.broker_order_id = value['broker_order_id']
        leg.reconciliation_json = {'simulation': True, 'receipt': deepcopy(value)}
        attempt = self.db.get(ExecutionAttempt, leg.id, populate_existing=True)
        attempt.state = value['state']
        attempt.observed_at = self.now()
        prior=attempt.evidence_json or {}
        attempt.evidence_json = {key:prior[key] for key in ('risk_hash','effect_risk_hash') if key in prior}|{'simulation': True, 'receipt': deepcopy(value), 'trades':deepcopy(trades)}
        row.state = 'submitting' if value['state'] == 'filled' else value['state']

    def reconcile(self, owner, intent):
        row, legs, run = self.snapshot(owner, intent)
        now = self.now()
        for i, leg in enumerate(legs):
            attempt = self.db.get(ExecutionAttempt, leg.id, populate_existing=True)
            if attempt is None or leg.state in {'filled', 'rejected'}:
                if leg.state in {'filled', 'rejected'}:
                    self._stored_receipt(row, leg, i)
                continue
            expected = digest({'request': row.request_digest, 'approval': run.approval_digest, 'reference': leg.client_reference})
            if attempt.binding_digest != expected or attempt.intent_id != row.id:
                raise OrderDenied('ATTEMPT_BINDING_CHANGED')
            if attempt.polls >= self.MAX_POLLS or now - stored_utc(attempt.claimed_at) > self.RECONCILE_WINDOW or now < stored_utc(attempt.claimed_at):
                raise OrderDenied('BOUNDED_RECONCILIATION_EXHAUSTED')
            if now < stored_utc(attempt.next_poll_at):
                raise OrderDenied('RECONCILIATION_BACKOFF')
            attempt.polls += 1
            reserved_poll = attempt.polls
            attempt.next_poll_at = now + timedelta(seconds=min(2 ** attempt.polls, 30))
            attempt.state = 'reconciling'
            self.db.commit()  # reserve the bounded read even if the process dies
            try:
                row, legs, run = self.snapshot(owner, intent)
                leg = legs[i]
                attempt = self.db.get(ExecutionAttempt, leg.id, populate_existing=True)
                if attempt.polls != reserved_poll or attempt.state != 'reconciling':
                    raise OrderDenied('RECONCILIATION_RESERVATION_CHANGED')
                result = self.broker.reconcile(leg.client_reference, venue_binding(row))
                value,trades=self._observation(row,leg,i,result)
                self._record(row, leg, i, value,trades)
                self.db.commit()
            except (OrderDenied, TimeoutError) as error:
                self.db.rollback()
                if str(error) == 'RECONCILIATION_RESERVATION_CHANGED':
                    raise
                row = self.orders.owned(owner, intent)
                leg = self.orders.legs(row)[i]
                attempt = self.db.get(ExecutionAttempt, leg.id, populate_existing=True)
                row.state = attempt.state = 'unknown'
                # Preserve prior quantitative partial/ack evidence on a read fault.
                if leg.state not in {'partial', 'acknowledged'}:
                    leg.state = 'unknown'
                attempt.last_error = 'UNRESOLVED_BROKER_MATCH'
                self.db.commit()
                return row
        row, legs, run = self.snapshot(owner, intent)
        if all(leg.state == 'filled' for leg in legs):
            for i, leg in enumerate(legs):
                self._stored_receipt(row, leg, i)
            row.state = 'filled'
            self.db.commit()
        # No implicit resume/submission follows a reconciliation read.
        return row

    def resume(self, owner, intent):
        """Only remaining never-submitted legs of the unchanged unexpired basket."""
        return self._advance(owner, intent)
