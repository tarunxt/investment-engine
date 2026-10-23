"""Recoverable SQL erasure drill, confined to the existing disposable scope.

Encrypted preimages and deletion share one transaction. Restoration is explicit,
owner fenced and conflict rejecting. No route, worker or live-data binding is
installed. This preserves retention anchors and never claims complete erasure.
"""
import base64
from datetime import date, datetime
from decimal import Decimal
from enum import Enum
import json
import math
from uuid import UUID, NAMESPACE_URL, uuid5

from sqlalchemy import and_, select, func, cast, Text, LargeBinary
from sqlalchemy.exc import IntegrityError

from app.domains.ai_limits.contracts import BoundaryDenied, digest, utc
from app.domains.connections.crypto import ConnectionFault
from app.domains.auth.models import ActivityLog
from app.infrastructure.database.outbox.models import OutboxMessage
from .sql_privacy_plan import SQLPrivacyPlanner
from .sql_privacy_workflow import DisposableSQLPrivacyWorkflow

TOPIC = 'public_service.privacy.recovery_fixture.v1'
MAX_BYTES = 8 * 1024 * 1024
# Restoring executable records could replay old work. Such stores need a
# separate drain/quarantine adapter; a generic row restore cannot approve it.
DATA_ONLY_TABLES = frozenset({'user_profiles', 'indmoney_us_portfolio_snapshots',
    'zerodha_portfolio_snapshots', 'dashboard_portfolio_daily_snapshots'})


def restorable(name):
    return name in DATA_ONLY_TABLES or name.startswith('fixture_')


def encode(value, *, depth=0):
    if depth > 16: raise BoundaryDenied('PRIVACY_RECOVERY_VALUE_LIMIT')
    if type(value) in {str, bytes} and len(value) > 65536:
        raise BoundaryDenied('PRIVACY_RECOVERY_VALUE_LIMIT')
    if value is None or type(value) in {bool, int, str}:
        return ['primitive', value]
    if type(value) is float and math.isfinite(value): return ['primitive', value]
    if type(value) is datetime: return ['datetime', value.isoformat()]
    if type(value) is date: return ['date', value.isoformat()]
    if type(value) is Decimal and value.is_finite(): return ['decimal', str(value)]
    if type(value) is UUID: return ['uuid', str(value)]
    if type(value) is bytes: return ['bytes', base64.b64encode(value).decode('ascii')]
    if isinstance(value, Enum): return encode(value.value, depth=depth + 1)
    if type(value) is list and len(value) <= 1024:
        return ['list', [encode(v, depth=depth + 1) for v in value]]
    if type(value) is dict and len(value) <= 1024 and all(type(k) is str for k in value):
        return ['dict', [[k, encode(v, depth=depth + 1)] for k, v in sorted(value.items())]]
    raise BoundaryDenied('PRIVACY_RECOVERY_VALUE_UNSUPPORTED')


def decode(value, *, depth=0):
    if depth > 16 or type(value) is not list or len(value) != 2:
        raise BoundaryDenied('PRIVACY_RECOVERY_VALUE_INVALID')
    kind, item = value
    try:
        if kind == 'primitive' and (item is None or type(item) in {bool, int, str}
                or type(item) is float and math.isfinite(item)): return item
        if kind == 'datetime': return datetime.fromisoformat(item)
        if kind == 'date': return date.fromisoformat(item)
        if kind == 'decimal' and Decimal(item).is_finite(): return Decimal(item)
        if kind == 'uuid': return UUID(item)
        if kind == 'bytes': return base64.b64decode(item, validate=True)
        if kind == 'list' and type(item) is list and len(item) <= 1024:
            return [decode(v, depth=depth + 1) for v in item]
        if kind == 'dict' and type(item) is list and len(item) <= 1024:
            if any(type(v) is not list or len(v) != 2 or type(v[0]) is not str for v in item):
                raise ValueError()
            result = {k: decode(v, depth=depth + 1) for k, v in item}
            if len(result) != len(item): raise ValueError()
            return result
    except (ValueError, TypeError, ArithmeticError): pass
    raise BoundaryDenied('PRIVACY_RECOVERY_VALUE_INVALID')


class RecoverableFixturePrivacy(DisposableSQLPrivacyWorkflow):
    """Explicit local/CI adapter; inherited scope denies every live database."""
    def _restorable(self,name):return restorable(name)

    def _after_restore(self,owner,counts,now):return {}

    def _restore_metadata(self,row):return {}

    def _archive_id(self, request_id):
        return uuid5(NAMESPACE_URL, 'credx:privacy-fixture-recovery:' + str(request_id))

    def _open_archive(self, row, owner, request, scope):
        try:
            if len(row.payload['ciphertext']) > 2 * MAX_BYTES:
                raise BoundaryDenied('PRIVACY_RECOVERY_ARCHIVE_LIMIT')
            value = self.keyring.open(row.payload['ciphertext'], row.payload['key_version'])
        except (ConnectionFault, KeyError, TypeError):
            raise BoundaryDenied('PRIVACY_RECOVERY_ARCHIVE_INVALID') from None
        if (set(value) != {'owner_id', 'request_id', 'request_hash', 'scope_hash', 'schema_digest', 'synthetic', 'order', 'datasets'}
                or value['synthetic'] is not True or type(value['order']) is not list
                or type(value['datasets']) is not dict
                or row.topic != TOPIC or row.payload.get('owner_id') != owner
                or value.get('owner_id') != owner or value.get('request_id') != str(request.id)
                or value.get('request_hash') != request.payload['receipt_hash']
                or value.get('scope_hash') != scope or value.get('schema_digest') != self.reader.inventory.schema_digest
                or digest(value) != row.payload.get('archive_hash')):
            raise BoundaryDenied('PRIVACY_RECOVERY_ARCHIVE_INVALID')
        return value

    def execute(self, owner, request_id, *, now=None):
        from datetime import timezone
        now = utc(now or datetime.now(timezone.utc))
        request, scope = self._fence(owner, request_id, now)
        if request.payload['kind'] != 'delete': return super().execute(owner, request_id, now=now)
        key = self._archive_id(request.id)
        existing = self.db.get(OutboxMessage, key, populate_existing=True)
        if existing is not None:
            self._open_archive(existing, owner, request, scope)
            return super().execute(owner, request_id, now=now)
        with self.db.begin_nested():
            planner = SQLPrivacyPlanner(self.db, self.reader, self.keyring, self.retention)
            planner.draft(owner, request.id, now=now)
            plan = planner.inspect(owner, request.id, now=now)
            rules = {rule.table: rule for rule in self.reader.inventory.rules}
            datasets = {}; used = 0
            for name in plan['child_first_order']:
                table = self.reader.metadata.tables[name]
                predicate = self.reader._predicate(table, rules[name], owner)
                # Reject oversized raw values in SQL before driver decoding,
                # including withheld fields needed only for encrypted recovery.
                lengths = [func.coalesce(func.octet_length(cast(c, Text))
                    if self.db.get_bind().dialect.name == 'postgresql'
                    else func.length(cast(c, LargeBinary)), 0) for c in table.c]
                bounds = self.db.execute(select(func.count(), func.coalesce(func.sum(sum(lengths)), 0),
                    *(func.coalesce(func.max(length), 0) for length in lengths))
                    .select_from(table).where(predicate)).one()
                if (bounds[0] > self.reader.MAX_ROWS_PER_TABLE or bounds[1] + used > MAX_BYTES
                        or any(length > 65536 for length in bounds[2:])):
                    raise BoundaryDenied('PRIVACY_RECOVERY_ARCHIVE_LIMIT')
                rows = self.db.execute(select(table).where(self.reader._predicate(table, rules[name], owner))
                    .limit(self.reader.MAX_ROWS_PER_TABLE + 1).with_for_update()).mappings().all()
                if len(rows) != plan['actions'][name]['owned_rows']:
                    raise BoundaryDenied('PRIVACY_SQL_SNAPSHOT_CHANGED')
                if rows and not self._restorable(name):
                    raise BoundaryDenied('PRIVACY_RECOVERY_STORE_ADAPTER_UNAVAILABLE')
                datasets[str(name)] = encode([{str(k): v for k, v in row.items()} for row in rows])
                used += len(json.dumps(datasets[str(name)], allow_nan=False).encode())
                if used > MAX_BYTES: raise BoundaryDenied('PRIVACY_RECOVERY_ARCHIVE_LIMIT')
            value = dict(owner_id=owner, request_id=str(request.id), request_hash=request.payload['receipt_hash'],
                scope_hash=scope, schema_digest=self.reader.inventory.schema_digest, synthetic=True,
                order=plan['child_first_order'], datasets=datasets)
            if len(json.dumps(value, allow_nan=False).encode()) > MAX_BYTES:
                raise BoundaryDenied('PRIVACY_RECOVERY_ARCHIVE_LIMIT')
            ciphertext, version = self.keyring.seal(value)
            self.db.add(OutboxMessage(id=key, topic=TOPIC, payload=dict(owner_id=owner,
                ciphertext=ciphertext, key_version=version, archive_hash=digest(value), state='recoverable')))
            self.db.flush()
            result = super().execute(owner, request_id, now=now)
        return result

    def restore(self, owner, request_id, *, now=None):
        from datetime import timezone
        now = utc(now or datetime.now(timezone.utc))
        request, scope = self._fence(owner, request_id, now)
        result = self.result(owner, request_id, now=now)
        if result['kind'] != 'delete': raise BoundaryDenied('PRIVACY_RECOVERY_DELETE_REQUIRED')
        self.reader.validate()
        row = self.db.scalar(select(OutboxMessage).where(OutboxMessage.id == self._archive_id(request.id)).with_for_update())
        if row is None: raise BoundaryDenied('PRIVACY_RECOVERY_ARCHIVE_UNAVAILABLE')
        value = self._open_archive(row, owner, request, scope)
        if (set(value['datasets']) != set(result['removed_counts'])
                or len(value['order']) != len(result['removed_counts'])
                or set(value['order']) != set(result['removed_counts'])):
            raise BoundaryDenied('PRIVACY_RECOVERY_DATASET_CHANGED')
        if row.payload.get('state') == 'restored':
            return dict(state='already_restored', restored_counts=result['removed_counts'], synthetic=True,
                        complete_account_erasure=False,**self._restore_metadata(row))
        if row.payload.get('state') != 'recoverable': raise BoundaryDenied('PRIVACY_RECOVERY_ARCHIVE_INVALID')
        rules = {rule.table: rule for rule in self.reader.inventory.rules}
        try:
            with self.db.begin_nested():
                for name in reversed(value['order']):
                    table = self.reader.metadata.tables[name]
                    rows = decode(value['datasets'][name])
                    if type(rows) is not list or len(rows) != result['removed_counts'][name]:
                        raise BoundaryDenied('PRIVACY_RECOVERY_DATASET_CHANGED')
                    if rows and not self._restorable(name):
                        raise BoundaryDenied('PRIVACY_RECOVERY_STORE_ADAPTER_UNAVAILABLE')
                    for item in rows:
                        if type(item) is not dict or set(item) != set(table.c.keys()):
                            raise BoundaryDenied('PRIVACY_RECOVERY_DATASET_CHANGED')
                        primary = and_(*(c == item[c.name] for c in table.primary_key))
                        if self.db.execute(select(1).select_from(table).where(primary)).first() is not None:
                            raise BoundaryDenied('PRIVACY_RECOVERY_CONFLICT')
                        self.db.execute(table.insert().values(item))
                        if self.db.execute(select(1).select_from(table).where(primary,
                                self.reader._predicate(table, rules[name], owner))).first() is None:
                            raise BoundaryDenied('PRIVACY_RECOVERY_OWNER_CHANGED')
                controls=self._after_restore(owner,result['removed_counts'],now)
                row.payload = {**row.payload, 'state': 'restored', 'restored_at': now.isoformat(),
                    **({'restore_controls':controls,'restore_controls_hash':digest(controls)} if controls else {})}
                self.db.add(ActivityLog(user_id=owner, action='privacy_fixture_restored',
                    resource_type='delete', details=str(request.id)))
                self.db.flush()
        except IntegrityError:
            raise BoundaryDenied('PRIVACY_RECOVERY_CONFLICT') from None
        return dict(state='restored', restored_counts=result['removed_counts'], synthetic=True,
                    complete_account_erasure=False,**self._restore_metadata(row))
