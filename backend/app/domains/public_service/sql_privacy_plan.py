"""Owner-fenced SQL retention/deletion planning; no deletion executor or activation.

Plans bind the existing authenticated request and complete reviewed inventory.
They enumerate all tables, protect request/audit anchors and propagate holds
through actual FK metadata. Cycles and unsupported erasure remain explicit.
"""
from dataclasses import dataclass, replace, asdict
from datetime import datetime, timezone
from uuid import NAMESPACE_URL, uuid5
from sqlalchemy import select
from app.domains.ai_limits.contracts import BoundaryDenied, digest, utc
from app.domains.auth.models import ActivityLog
from app.domains.connections.crypto import ConnectionKeyring, ConnectionFault
from app.infrastructure.database.outbox.models import OutboxMessage
from .privacy import PrivacyRequests
from .sql_account import SQLAccountReader, AccountTableRule

TOPIC = 'public_service.privacy.sql_plan.v1'
ANCHORS = frozenset({'users', 'activity_logs', 'outbox'})


@dataclass(frozen=True)
class RetentionSchedule:
    reference: str = ''
    expires_at: datetime | None = None
    legal_holds: frozenset[str] = frozenset()
    retain_until: tuple[tuple[str, datetime | None], ...] = ()

    def fingerprint(self, names, now):
        if (not isinstance(self.reference, str) or not 3 <= len(self.reference) <= 120
            or self.expires_at is None or utc(self.expires_at) <= now
            or type(self.legal_holds) is not frozenset or not self.legal_holds <= names
            or len(dict(self.retain_until)) != len(self.retain_until)
            or set(dict(self.retain_until)) != names):
            raise BoundaryDenied('COMPLETE_RETENTION_REVIEW_REQUIRED')
        dates = {name: utc(t).isoformat() if t is not None else None for name, t in self.retain_until}
        return digest({'reference': self.reference, 'expires_at': utc(self.expires_at).isoformat(),
                       'legal_holds': sorted(self.legal_holds), 'retain_until': dates})


class SQLPrivacyPlanner:
    def __init__(self, db, reader, keyring, retention=None):
        if type(reader) is not SQLAccountReader or reader.db is not db:
            raise BoundaryDenied('SAME_PRIVACY_TRANSACTION_REQUIRED')
        if type(keyring) is not ConnectionKeyring: raise BoundaryDenied('PRIVACY_PLAN_KEYRING_REQUIRED')
        self.db, self.reader, self.keyring = db, reader, keyring
        self.retention = retention if type(retention) is RetentionSchedule else RetentionSchedule()

    def _request(self, owner, id, now):
        service = PrivacyRequests(self.db); service.fence(owner)
        row = service.owned(owner, id, True); payload = row.payload
        if payload.get('kind') != 'delete' or payload.get('state') != 'retention_review_required':
            raise BoundaryDenied('OWNED_PENDING_DELETE_REQUIRED')
        if digest({k: v for k, v in payload.items() if k not in {'state', 'result', 'receipt_hash'}}) != payload.get('receipt_hash'):
            raise BoundaryDenied('PRIVACY_BINDING_CHANGED')
        if digest({k: payload[k] for k in ('owner_id', 'kind', 'key')}) != payload.get('binding'):
            raise BoundaryDenied('PRIVACY_BINDING_CHANGED')
        try: valid = utc(datetime.fromisoformat(payload['created_at'])) <= now < utc(datetime.fromisoformat(payload['expires_at']))
        except (TypeError, ValueError, KeyError): valid = False
        if not valid: raise BoundaryDenied('PRIVACY_REQUEST_EXPIRED')
        return row

    def _build(self, owner, request, now):
        # Audit and outbox are permanently retained operational anchors, not
        # deletion candidates. Their changing planner/audit records cannot be
        # part of a self-referential plan fingerprint. This is a plan-only
        # projection: the original complete account export remains unchanged.
        # All other owned data, original reviewed rules, request, holds and
        # cancellation are still independently bound and revalidated.
        inventory = self.reader.inventory
        projection = replace(inventory, rules=tuple(
            AccountTableRule(rule.table, (), excluded_reason='retained operational plan boundary')
            if rule.table in {'activity_logs', 'outbox'} else rule for rule in inventory.rules))
        export = SQLAccountReader(self.db, self.reader.metadata, projection).export(owner)
        metadata = self.reader.metadata; names = set(metadata.tables)
        retention_hash = self.retention.fingerprint(names, now)
        until = dict(self.retention.retain_until)
        rules = {r.table: r for r in self.reader.inventory.rules}
        reasons = {}
        for name in names:
            if name in ANCHORS: reasons[name] = 'IDENTITY_REQUEST_AUDIT_ANCHOR'
            elif rules[name].excluded_reason: reasons[name] = 'EXCLUDED_REVIEWED_NON_ACCOUNT_DATA'
            elif name in self.retention.legal_holds: reasons[name] = 'LEGAL_HOLD'
            elif until[name] is not None and now < utc(until[name]): reasons[name] = 'RETENTION_DEADLINE'
        # Deleting an ancestor of any held/excluded table could cascade or
        # invalidate retained records. Protect that entire parent chain.
        changed = True
        while changed:
            changed = False
            for name in tuple(reasons):
                for fk in metadata.tables[name].foreign_key_constraints:
                    for edge in fk.elements:
                        parent = edge.column.table.name
                        if parent in names and parent not in reasons:
                            reasons[parent] = 'HELD_DEPENDENT_RELATIONSHIP'; changed = True
        candidates = names - set(reasons)
        children = {name: set() for name in candidates}
        for name in candidates:
            for fk in metadata.tables[name].foreign_key_constraints:
                for edge in fk.elements:
                    parent = edge.column.table.name
                    if parent in candidates: children[parent].add(name)
        order, remaining = [], set(candidates)
        while remaining:
            ready = sorted(name for name in remaining if not (children[name] & remaining))
            if not ready: break
            order.extend(ready); remaining -= set(ready)
        actions = {name: {'disposition': reasons.get(name, 'DELETE_CANDIDATE'),
                          'owned_rows': len(export['datasets'][name]) if name in export['datasets'] else None}
                   for name in sorted(names)}
        return {'owner_id': owner, 'request_id': str(request.id),
                'request_hash': request.payload['receipt_hash'], 'account_hash': export['content_hash'],
                'inventory_hash': self.reader.inventory.schema_digest, 'retention_hash': retention_hash,
                'inventory_policy_hash': digest(asdict(inventory)),
                'retained_operational_boundary': sorted(names & {'activity_logs', 'outbox'}),
                'actions': actions, 'child_first_order': order, 'blocked_relationships': sorted(remaining),
                'expires_at': request.payload['expires_at'], 'deletion_executable': False,
                'unfinished': ['real_account_identity_erasure', 'backup_retention_or_erasure',
                               'reviewed_SQL_deletion_executor', 'actual_retention_approval_and_runtime_binding']}

    def draft(self, owner, request_id, *, now=None):
        now = utc(now or datetime.now(timezone.utc)); request = self._request(owner, request_id, now)
        claims = self._build(owner, request, now)
        id = uuid5(NAMESPACE_URL, 'credx:sql-privacy-plan:' + str(request.id))
        old = self.db.scalar(select(OutboxMessage).where(OutboxMessage.id == id).with_for_update())
        if old is not None:
            if old.topic != TOPIC or old.payload.get('owner_id') != owner:
                raise BoundaryDenied('OWNED_PRIVACY_PLAN_REQUIRED')
            try: previous = self.keyring.open(old.payload['ciphertext'], old.payload['key_version'])
            except (ConnectionFault, KeyError, TypeError): raise BoundaryDenied('PRIVACY_PLAN_INVALID') from None
            if digest(previous) != digest(claims): raise BoundaryDenied('PRIVACY_PLAN_CHANGED_REVIEW_REQUIRED')
            return old
        ciphertext, version = self.keyring.seal(claims)
        row = OutboxMessage(id=id, topic=TOPIC,
            payload={'owner_id': owner, 'ciphertext': ciphertext, 'key_version': version})
        self.db.add(row)
        self.db.add(ActivityLog(user_id=owner, action='privacy_sql_plan_created',
                                 resource_type='privacy_request', details=str(request.id)))
        self.db.flush(); return row

    def inspect(self, owner, request_id, *, now=None):
        now = utc(now or datetime.now(timezone.utc)); request = self._request(owner, request_id, now)
        id = uuid5(NAMESPACE_URL, 'credx:sql-privacy-plan:' + str(request.id))
        row = self.db.scalar(select(OutboxMessage).where(OutboxMessage.id == id, OutboxMessage.topic == TOPIC).with_for_update())
        if row is None or row.payload.get('owner_id') != owner: raise BoundaryDenied('OWNED_PRIVACY_PLAN_REQUIRED')
        try: claims = self.keyring.open(row.payload['ciphertext'], row.payload['key_version'])
        except (ConnectionFault, KeyError, TypeError): raise BoundaryDenied('PRIVACY_PLAN_INVALID') from None
        if digest(claims) != digest(self._build(owner, request, now)):
            raise BoundaryDenied('PRIVACY_PLAN_CHANGED_REVIEW_REQUIRED')
        return claims
