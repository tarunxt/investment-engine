"""Disabled, owner-fenced local alert delivery/acknowledgement lifecycle.

No network adapter or normal runtime registration. Explicit LocalSink tests the
side-effect boundary; uncertain deliveries never retry. Real sink/roster/on-call
binding and delivery acknowledgement semantics remain separately reviewed work.
"""
from dataclasses import dataclass
from datetime import datetime, timezone, timedelta
from uuid import UUID, uuid5, NAMESPACE_URL
from sqlalchemy import select
from app.domains.auth.models import User, UserRole, ActivityLog
from app.infrastructure.database.outbox.models import OutboxMessage
from app.domains.ai_limits.contracts import BoundaryDenied, digest, utc
from app.domains.ai_limits.private_effects import LocalSink
from .store import control, owner

TOPIC = 'public_service.monitor_delivery.local.v1'
FIELDS = frozenset({'correlation_id', 'stale_data', 'unknown_orders', 'cost_spike', 'action',
                    'owner_id', 'source_unavailable', 'scope'})

@dataclass(frozen=True)
class MonitorDispatchPolicy:
    reference: str = ''
    operator_ids: frozenset[int] = frozenset()
    acknowledgement_seconds: int = 300

    def fingerprint(self):
        if (type(self.reference) is not str or not 3 <= len(self.reference) <= 120
            or type(self.operator_ids) is not frozenset or not self.operator_ids
            or any(type(i) is not int or i <= 0 for i in self.operator_ids)
            or type(self.acknowledgement_seconds) is not int or not 30 <= self.acknowledgement_seconds <= 3600):
            raise BoundaryDenied('MONITOR_BINDING_REQUIRED')
        return digest({'reference': self.reference, 'operators': sorted(self.operator_ids),
                       'acknowledgement_seconds': self.acknowledgement_seconds})

class MonitorDispatch:
    def __init__(self, db, *, policy=None, sink=None):
        self.db, self.policy, self.sink = db, policy, sink

    def _fence(self, subject):
        if type(self.policy) is not MonitorDispatchPolicy or type(self.sink) is not LocalSink:
            raise BoundaryDenied('MONITOR_BINDING_REQUIRED')
        fingerprint = self.policy.fingerprint()
        control(self.db, 'monitor'); owner(self.db, subject, verified=True)
        return fingerprint

    @staticmethod
    def _report(subject, report):
        if (type(report) is not dict or set(report) != FIELDS or type(report.get('owner_id')) is not int or report.get('owner_id') != subject
            or report.get('scope') != 'owned_database_observation'
            or any(type(report.get(k)) is not bool for k in ('stale_data','unknown_orders','cost_spike','source_unavailable'))
            or type(report.get('action')) is not str or report.get('action') not in {'pause_and_review','observe'}):
            raise BoundaryDenied('MONITOR_REPORT_INVALID')
        try:
            if str(UUID(report['correlation_id'])) != report['correlation_id']: raise ValueError
        except (ValueError, TypeError, AttributeError): raise BoundaryDenied('MONITOR_REPORT_INVALID') from None
        return dict(report)  # Closed projection excludes raw messages, tokens, paths and URLs.

    def _row(self, subject, key):
        try: key = UUID(str(key))
        except (ValueError, TypeError): raise BoundaryDenied('MONITOR_OWNED_ALERT_REQUIRED') from None
        row = self.db.scalar(select(OutboxMessage).where(OutboxMessage.id == key,
            OutboxMessage.topic == TOPIC).with_for_update().execution_options(populate_existing=True))
        if row is None or row.payload.get('owner_id') != subject:
            raise BoundaryDenied('MONITOR_OWNED_ALERT_REQUIRED')
        p = row.payload
        report = self._report(subject, p.get('report'))
        if (p.get('report_hash') != digest(report) or type(p.get('binding')) is not str
            or row.id != uuid5(NAMESPACE_URL, 'credx:monitor-delivery:' + digest({'report': report, 'binding': p['binding']}))):
            raise BoundaryDenied('MONITOR_ALERT_CHANGED')
        return row

    def _audit(self, subject, action, key):
        self.db.add(ActivityLog(user_id=subject, action=action, resource_type='monitor', details=str(key)))
        self.db.flush()  # No delivery result or protected payload before audit succeeds.

    def enqueue(self, subject, report, *, now=None):
        now = utc(now or datetime.now(timezone.utc)); binding = self._fence(subject)
        report = self._report(subject, report)
        key = uuid5(NAMESPACE_URL, 'credx:monitor-delivery:' + digest({'report': report, 'binding': binding}))
        row = self.db.get(OutboxMessage, key)
        if row is not None:
            row = self._row(subject, key)
            if row.payload.get('report') != report or row.payload.get('binding') != binding:
                raise BoundaryDenied('MONITOR_ALERT_CHANGED')
            return row
        row = OutboxMessage(id=key, topic=TOPIC, payload={'owner_id': subject, 'binding': binding,
            'report': report, 'report_hash': digest(report), 'state': 'queued', 'created_at': now.isoformat()})
        self.db.add(row); self._audit(subject, 'monitor_queued', key)
        return row  # caller transaction owns enqueue; no hidden commit

    def dispatch(self, subject, key, *, now=None):
        now = utc(now or datetime.now(timezone.utc)); binding = self._fence(subject)
        row = self._row(subject, key); p = dict(row.payload)
        if p['binding'] != binding: raise BoundaryDenied('MONITOR_BINDING_CHANGED')
        if utc(datetime.fromisoformat(p['created_at'])) > now: raise BoundaryDenied('MONITOR_CLOCK_ROLLBACK')
        if p['state'] != 'queued': return p['state']
        # Persist an uncertainty marker before leaving the transaction. A crash
        # after this point is not proof that a remote effect did not happen.
        self._audit(subject, 'monitor_dispatching', row.id)
        row.payload = {**p, 'state': 'dispatching', 'dispatched_at': now.isoformat()}
        self.db.commit()
        # Reacquire the same control -> owner -> alert fence after the durable
        # uncertainty commit, validate persisted data again, and hold it through
        # the local effect. A modified row never becomes a delivery payload.
        if self._fence(subject) != binding: raise BoundaryDenied('MONITOR_BINDING_CHANGED')
        row = self._row(subject, key)
        if row.payload['state'] != 'dispatching' or row.payload['report'] != p['report']:
            raise BoundaryDenied('MONITOR_ALERT_CHANGED')
        safe_report = self._report(subject, row.payload['report'])
        try: receipt = self.sink.deliver(str(row.id), safe_report)
        except Exception:
            self.db.rollback(); self._fence(subject); row = self._row(subject, key)
            row.payload = {**row.payload, 'state': 'uncertain'}
            self._audit(subject, 'monitor_uncertain', row.id); self.db.commit()
            raise BoundaryDenied('MONITOR_DELIVERY_UNCERTAIN') from None
        self._fence(subject); row = self._row(subject, key)
        if row.payload['state'] != 'dispatching' or row.payload['binding'] != binding:
            raise BoundaryDenied('MONITOR_DELIVERY_UNCERTAIN')
        if type(receipt) is not str or receipt != digest(p['report']):
            raise BoundaryDenied('MONITOR_DELIVERY_UNCERTAIN')
        row.payload = {**row.payload, 'state': 'recorded', 'receipt': receipt,
            'ack_due_at': (now + timedelta(seconds=self.policy.acknowledgement_seconds)).isoformat()}
        self._audit(subject, 'monitor_recorded', row.id); self.db.commit()
        return 'recorded'

    def acknowledge(self, subject, key, actor, *, now=None):
        now = utc(now or datetime.now(timezone.utc)); binding = self._fence(subject)
        person = self.db.scalar(select(User).where(User.id == actor).execution_options(populate_existing=True))
        if (type(actor) is not int or actor not in self.policy.operator_ids or person is None
            or not person.is_active or not person.is_verified or person.role != UserRole.ADMIN):
            raise BoundaryDenied('MONITOR_OPERATOR_REQUIRED')
        row = self._row(subject, key)
        if row.payload['binding'] != binding or row.payload['state'] not in {'recorded','escalated','acknowledged'}:
            raise BoundaryDenied('MONITOR_ACK_STATE')
        if utc(datetime.fromisoformat(row.payload['dispatched_at'])) > now:
            raise BoundaryDenied('MONITOR_CLOCK_ROLLBACK')
        if row.payload['state'] != 'acknowledged':
            row.payload = {**row.payload, 'state': 'acknowledged', 'actor_id': actor, 'ack_at': now.isoformat()}
            self._audit(subject, 'monitor_acknowledged', row.id)
        return row.payload['state']

    def escalate(self, subject, key, *, now=None):
        now = utc(now or datetime.now(timezone.utc)); binding = self._fence(subject)
        row = self._row(subject, key)
        if row.payload['binding'] != binding: raise BoundaryDenied('MONITOR_BINDING_CHANGED')
        if row.payload['state'] == 'recorded' and utc(datetime.fromisoformat(row.payload['ack_due_at'])) <= now:
            row.payload = {**row.payload, 'state': 'escalated', 'escalated_at': now.isoformat()}
            self._audit(subject, 'monitor_escalated', row.id)
        return row.payload['state']  # durable escalation only, no external send
