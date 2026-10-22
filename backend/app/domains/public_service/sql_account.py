"""Bounded SQL account export implementation, unbound from public runtime.

Uses the caller's transaction; it never opens a URL, reads credentials, writes
files or deletes data. An exact complete reviewed schema/field inventory is
required. This does not fabricate that review or replace a retention decision.
"""
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
import json
import hashlib
import math
import re
from uuid import UUID
from sqlalchemy import MetaData, JSON, LargeBinary, Text, and_, case, cast, exists, func, inspect, select
from sqlalchemy.dialects import postgresql, sqlite
from sqlalchemy.sql import visitors
from sqlalchemy.sql.elements import BindParameter
from sqlalchemy.exc import CompileError
from app.domains.ai_limits.contracts import BoundaryDenied, digest
from .account_data import filtered


@dataclass(frozen=True)
class OwnerHop:
    parent_table: str
    local_columns: tuple[str, ...]
    parent_columns: tuple[str, ...]


@dataclass(frozen=True)
class AccountTableRule:
    table: str
    export_columns: tuple[str, ...]
    withheld_columns: tuple[str, ...] = ()
    path: tuple[OwnerHop, ...] = ()
    owner_column: str = 'user_id'
    excluded_reason: str = ''
    owner_semantics: str = ''


@dataclass(frozen=True)
class AccountInventory:
    reference: str
    schema_digest: str
    rules: tuple[AccountTableRule, ...]


def schema_digest(metadata):
    return digest({name: {'columns': [(c.name, str(c.type), c.nullable) for c in table.columns],
                         'primary_key': tuple(c.name for c in table.primary_key),
                         'unique': sorted(tuple(c.name for c in constraint.columns) for constraint in table.constraints if constraint.__class__.__name__ == 'UniqueConstraint'),
                         'unique_indexes': sorted((tuple(c.name for c in index.columns),
                             _where(index.dialect_options['sqlite'].get('where'), sqlite.dialect()),
                             _where(index.dialect_options['postgresql'].get('where'), postgresql.dialect())) for index in table.indexes if index.unique),
                         'foreign_keys': sorted((sorted((e.parent.name, e.column.table.name, e.column.name)
                           for e in constraint.elements), _fk_options({'ondelete': constraint.ondelete,
                           'onupdate': constraint.onupdate, 'match': constraint.match,
                           'deferrable': constraint.deferrable, 'initially': constraint.initially}))
                           for constraint in table.foreign_key_constraints)}
                   for name, table in sorted(metadata.tables.items())})


APPLICATION_OWNER_SEMANTICS = 'recommendation_audit.user_id.v1'


def _application_owner_table(table):
    # These deliberately non-cascading records use an application tenant key,
    # not a physical user FK. Never generalize that exception by column name.
    from app.domains.recommendation_audit.models import EvidenceRecord, DecisionRecord, VerificationRecord, SpendAccount, SpendAttempt
    allowed = {model.__table__.name: model.__table__ for model in
               (EvidenceRecord, DecisionRecord, VerificationRecord, SpendAccount, SpendAttempt)}
    expected = allowed.get(table.name)
    if expected is None: return False
    actual_meta, expected_meta = MetaData(), MetaData()
    table.to_metadata(actual_meta); expected.to_metadata(expected_meta)
    return schema_digest(actual_meta) == schema_digest(expected_meta)


def _credential_column(name):
    normalized = re.sub('[^a-z0-9]', '', name.lower())
    return normalized in {'key', 'apikey', 'accesskey', 'authorization', 'bearer'} or bool(re.search(
        r'password|passhash|token|secret|credential|cipher|privatekey|signingkey|keyhash|cookie|session', normalized))


def _private_value(value):
    # Complete bounded decoding happens first. Apply conservative key-based
    # exclusion at every JSON depth; arbitrary unlabeled secret text is NOT detected.
    if isinstance(value, dict):
        return {key: '[withheld credential]' if _credential_column(key) else _private_value(item)
                for key, item in value.items()}
    if isinstance(value, list): return [_private_value(item) for item in value]
    return value


def _value(value, *, max_bytes=65536, depth=0, nodes=None):
    if nodes is None: nodes = [1024]
    nodes[0] -= 1
    if depth > 16 or nodes[0] < 0: raise BoundaryDenied('ACCOUNT_EXPORT_VALUE_LIMIT')
    if isinstance(value, str):
        if len(value) > max_bytes or len(value.encode()) > max_bytes: raise BoundaryDenied('ACCOUNT_EXPORT_VALUE_LIMIT')
        return value
    if value is None or isinstance(value, (bool, int)):
        if isinstance(value, int) and value.bit_length() > max_bytes * 3: raise BoundaryDenied('ACCOUNT_EXPORT_VALUE_LIMIT')
        return value
    if isinstance(value, float):
        if not math.isfinite(value): raise BoundaryDenied('ACCOUNT_EXPORT_NONFINITE')
        return value
    if isinstance(value, Decimal):
        if not value.is_finite(): raise BoundaryDenied('ACCOUNT_EXPORT_NONFINITE')
        result = str(value)
        if len(result) > max_bytes: raise BoundaryDenied('ACCOUNT_EXPORT_VALUE_LIMIT')
        return result
    if isinstance(value, UUID): return str(value)
    if isinstance(value, (datetime, date)): return value.isoformat()
    if isinstance(value, dict):
        if len(value) > 1024: raise BoundaryDenied('ACCOUNT_EXPORT_VALUE_LIMIT')
        result = {}
        for key, item in value.items():
            if type(key) is not str: raise BoundaryDenied('ACCOUNT_EXPORT_VALUE_UNSUPPORTED')
            key = _value(key, max_bytes=max_bytes, depth=depth+1, nodes=nodes)
            result[key] = _value(item, max_bytes=max_bytes, depth=depth+1, nodes=nodes)
        return result
    if isinstance(value, (list, tuple)):
        if len(value) > 1024: raise BoundaryDenied('ACCOUNT_EXPORT_VALUE_LIMIT')
        return [_value(v, max_bytes=max_bytes, depth=depth+1, nodes=nodes) for v in value]
    # Never expose arbitrary repr/bytes/custom objects as an export primitive.
    raise BoundaryDenied('ACCOUNT_EXPORT_VALUE_UNSUPPORTED')


def _json_value(raw, max_bytes):
    # JSON is selected as bounded SQL TEXT, so a driver never recursively decodes
    # an oversized/deep document before our depth/node checks.
    if raw is None: return None
    if type(raw) is not str or len(raw) > max_bytes or len(raw.encode()) > max_bytes:
        raise BoundaryDenied('ACCOUNT_EXPORT_VALUE_LIMIT')
    quoted = escaped = False; depth = tokens = 0
    for char in raw:
        if quoted:
            if escaped: escaped = False
            elif char == '\\': escaped = True
            elif char == '"': quoted = False
        elif char == '"': quoted = True
        elif char in '{[':
            depth += 1; tokens += 1
            if depth > 16: raise BoundaryDenied('ACCOUNT_EXPORT_VALUE_LIMIT')
        elif char in '}]': depth -= 1
        elif char in ',:': tokens += 1
        if tokens > 1024 or depth < 0: raise BoundaryDenied('ACCOUNT_EXPORT_VALUE_LIMIT')
    try: return json.loads(raw, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except (ValueError, TypeError, RecursionError): raise BoundaryDenied('ACCOUNT_EXPORT_VALUE_UNSUPPORTED') from None


def _encode(value):
    try: return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
    except (ValueError, TypeError, RecursionError, OverflowError): raise BoundaryDenied('ACCOUNT_EXPORT_VALUE_UNSUPPORTED') from None


def _fk_options(options):
    return tuple('' if options.get(k) in (None, 'NO ACTION') else str(options[k]).upper()
                 for k in ('ondelete', 'onupdate', 'match')) + (bool(options.get('deferrable')), str(options.get('initially') or 'IMMEDIATE').upper())


def _where(expression, dialect=None):
    """Render reviewed expressions as reflected SQL, retaining literal text.

    Compile values with the target dialect and omit only the table qualifier
    that an index predicate's single-table context already supplies. Never
    replace bind markers by regex or collapse whitespace inside literals.
    """
    if expression is None: return ''
    if dialect is not None and hasattr(expression, 'compile'):
        if any(isinstance(node, BindParameter) and node.required for node in visitors.iterate(expression)):
            raise BoundaryDenied('ACCOUNT_INDEX_PREDICATE_UNBOUND')
        try: value = str(expression.compile(dialect=dialect,
            compile_kwargs={'literal_binds': True, 'include_table': False})).strip()
        except (CompileError, ValueError, TypeError): raise BoundaryDenied('ACCOUNT_INDEX_PREDICATE_UNSUPPORTED') from None
    else: value = str(expression).strip()
    while value.startswith('(') and value.endswith(')'):
        depth = 0; quote = None; index = 0; wrapped = True
        while index < len(value):
            char = value[index]
            if quote:
                if char == quote:
                    if index + 1 < len(value) and value[index + 1] == quote: index += 1
                    else: quote = None
            elif char in ('"', "'"): quote = char
            elif char == '(': depth += 1
            elif char == ')':
                depth -= 1
                if depth == 0 and index != len(value) - 1: wrapped = False; break
            index += 1
        if not wrapped or depth != 0 or quote: break
        value = value[1:-1].strip()
    return value


class SQLAccountReader:
    MAX_ROWS_PER_TABLE = 1000
    MAX_BYTES = 8 * 1024 * 1024
    MAX_VALUE_BYTES = 65536

    def __init__(self, db, metadata, inventory: AccountInventory):
        self.db, self.metadata, self.inventory = db, metadata, inventory

    def validate(self):
        policy = self.inventory
        if type(policy) is not AccountInventory or type(policy.reference) is not str or not 1 <= len(policy.reference.strip()) <= 120 or policy.schema_digest != schema_digest(self.metadata):
            raise BoundaryDenied('ACCOUNT_INVENTORY_REVIEW_REQUIRED')
        rules = policy.rules
        if len({r.table for r in rules}) != len(rules) or {r.table for r in rules} != set(self.metadata.tables):
            raise BoundaryDenied('COMPLETE_ACCOUNT_TABLE_INVENTORY_REQUIRED')
        connection = self.db.connection(); inspector = inspect(connection)
        actual = set(inspector.get_table_names()) - {'alembic_version'}
        if actual != set(self.metadata.tables): raise BoundaryDenied('ACCOUNT_DATABASE_SCHEMA_CHANGED')
        for name, table in self.metadata.tables.items():
            if table.schema is not None: raise BoundaryDenied('ACCOUNT_DATABASE_SCHEMA_CHANGED')
            expected = {(c.name, c.type.compile(dialect=connection.dialect), c.nullable) for c in table.columns}
            observed = {(c['name'], c['type'].compile(dialect=connection.dialect), c['nullable']) for c in inspector.get_columns(name)}
            if expected != observed: raise BoundaryDenied('ACCOUNT_DATABASE_SCHEMA_CHANGED')
            # Columns alone do not prove ownership semantics: compare the real
            # FK targets/options and owner-critical referenced key structures.
            expected_fk = sorted((tuple(e.parent.name for e in c.elements),
                c.elements[0].column.table.name, tuple(e.column.name for e in c.elements),
                _fk_options({'ondelete': c.ondelete, 'onupdate': c.onupdate, 'match': c.match,
                             'deferrable': c.deferrable, 'initially': c.initially}))
                for c in table.foreign_key_constraints)
            physical_fk = inspector.get_foreign_keys(name)
            if any(c.get('referred_schema') not in (None, inspector.default_schema_name) for c in physical_fk):
                raise BoundaryDenied('ACCOUNT_DATABASE_SCHEMA_CHANGED')
            observed_fk = sorted((tuple(c['constrained_columns']), c['referred_table'], tuple(c['referred_columns']),
                                  _fk_options(c.get('options', {}))) for c in physical_fk)
            if expected_fk != observed_fk: raise BoundaryDenied('ACCOUNT_DATABASE_SCHEMA_CHANGED')
            if tuple(c.name for c in table.primary_key) != tuple(inspector.get_pk_constraint(name)['constrained_columns']):
                raise BoundaryDenied('ACCOUNT_DATABASE_SCHEMA_CHANGED')
            expected_unique = sorted(tuple(c.name for c in constraint.columns) for constraint in table.constraints
                                     if constraint.__class__.__name__ == 'UniqueConstraint')
            if expected_unique != sorted(tuple(c['column_names']) for c in inspector.get_unique_constraints(name)):
                raise BoundaryDenied('ACCOUNT_DATABASE_SCHEMA_CHANGED')
            expected_indexes = sorted((tuple(c.name for c in index.columns),
                _where(index.dialect_options[connection.dialect.name].get('where'), connection.dialect))
                for index in table.indexes if index.unique)
            observed_indexes = sorted((tuple(c['column_names']),
                _where(c.get('dialect_options', {}).get(connection.dialect.name + '_where')))
                for c in inspector.get_indexes(name) if c.get('unique') and not c.get('duplicates_constraint'))
            if expected_indexes != observed_indexes: raise BoundaryDenied('ACCOUNT_DATABASE_SCHEMA_CHANGED')
        for rule in rules:
            if type(rule) is not AccountTableRule or type(rule.excluded_reason) is not str or len(rule.excluded_reason) > 256:
                raise BoundaryDenied('ACCOUNT_INVENTORY_REVIEW_REQUIRED')
            table = self.metadata.tables[rule.table]
            if type(rule.owner_semantics) is not str: raise BoundaryDenied('ACCOUNT_OWNER_PATH_INVALID')
            if rule.excluded_reason:
                if rule.table == 'users' or rule.export_columns or rule.withheld_columns or rule.path or rule.owner_semantics:
                    raise BoundaryDenied('ACCOUNT_EXCLUSION_INVALID')
                continue
            exported, withheld = set(rule.export_columns), set(rule.withheld_columns)
            if not exported or len(exported) > 128 or len(exported) != len(rule.export_columns) or len(withheld) != len(rule.withheld_columns) or exported & withheld or exported | withheld != set(table.columns.keys()):
                raise BoundaryDenied('COMPLETE_ACCOUNT_FIELD_INVENTORY_REQUIRED')
            if any(_credential_column(c) for c in exported): raise BoundaryDenied('ACCOUNT_CREDENTIAL_FIELD_FORBIDDEN')
            current, visited = table, {table.name}
            if len(rule.path) > 4: raise BoundaryDenied('ACCOUNT_OWNER_PATH_INVALID')
            for hop in rule.path:
                if hop.parent_table in visited or hop.parent_table not in self.metadata.tables:
                    raise BoundaryDenied('ACCOUNT_OWNER_PATH_INVALID')
                parent = self.metadata.tables[hop.parent_table]
                expected = set(zip(hop.local_columns, hop.parent_columns))
                if not expected or len(hop.local_columns) != len(hop.parent_columns) or not any(
                    len(constraint.elements) == len(expected) and
                    {(e.parent.name, e.column.name) for e in constraint.elements} == expected and
                    all(e.column.table is parent for e in constraint.elements)
                    for constraint in current.foreign_key_constraints):
                    raise BoundaryDenied('ACCOUNT_OWNER_PATH_INVALID')
                visited.add(parent.name); current = parent
            if rule.owner_column not in current.c: raise BoundaryDenied('ACCOUNT_OWNER_PATH_INVALID')
            if rule.owner_semantics:
                if (rule.owner_semantics != APPLICATION_OWNER_SEMANTICS or rule.path
                    or rule.owner_column != 'user_id' or not _application_owner_table(current)):
                    raise BoundaryDenied('ACCOUNT_APPLICATION_OWNER_BINDING_INVALID')
                continue
            if current.name == 'users' and rule.owner_column == 'id': continue
            if not any(f.column.table.name == 'users' and f.column.name == 'id'
                       for f in current.c[rule.owner_column].foreign_keys):
                raise BoundaryDenied('ACCOUNT_OWNER_PATH_INVALID')
        return self

    def _predicate(self, table, rule, owner_id, depth=0):
        if depth == len(rule.path): return table.c[rule.owner_column] == owner_id
        hop = rule.path[depth]; parent = self.metadata.tables[hop.parent_table]
        return exists(select(1).select_from(parent).where(
            and_(*(table.c[a] == parent.c[b] for a, b in zip(hop.local_columns, hop.parent_columns))),
            self._predicate(parent, rule, owner_id, depth + 1)))

    def _application_references(self, owner_id):
        # Deliberately non-FK audit references still carry tenant semantics.
        # Reject inconsistent owned rows rather than export another tenant's
        # identifiers or silently conceal an integrity violation.
        selected = {rule.table for rule in self.inventory.rules if not rule.excluded_reason
                    and rule.owner_semantics == APPLICATION_OWNER_SEMANTICS}
        from .privacy_relations import APPLICATION_LINKS as links
        for name in sorted(selected & links.keys()):
            table = self.metadata.tables[name]
            for column, target, optional in links[name]:
                parent = self.metadata.tables.get(target)
                if parent is None or not _application_owner_table(parent):
                    raise BoundaryDenied('ACCOUNT_APPLICATION_REFERENCE_SCHEMA_REQUIRED')
                owned_parent = exists(select(1).select_from(parent).where(
                    parent.c.id == table.c[column], parent.c.user_id == owner_id, parent.c.user_id > 0))
                invalid = ~owned_parent
                if optional: invalid = and_(table.c[column].is_not(None), invalid)
                if self.db.execute(select(1).select_from(table).where(
                    table.c.user_id == owner_id, invalid).limit(1)).first() is not None:
                    raise BoundaryDenied('ACCOUNT_APPLICATION_REFERENCE_OWNER_MISMATCH')

    def export(self, owner_id):
        if type(owner_id) is not int or owner_id <= 0: raise BoundaryDenied('ACTIVE_OWNER_REQUIRED')
        self.validate()
        connection = self.db.connection()
        if connection.dialect.name == 'postgresql' and connection.get_isolation_level() not in {'REPEATABLE READ', 'SERIALIZABLE'}:
            raise BoundaryDenied('ACCOUNT_SNAPSHOT_ISOLATION_REQUIRED')
        if connection.dialect.name not in {'postgresql', 'sqlite'}: raise BoundaryDenied('ACCOUNT_DATABASE_UNSUPPORTED')
        users = self.metadata.tables.get('users')
        if users is None or not {'id', 'is_active', 'is_verified'} <= set(users.c.keys()):
            raise BoundaryDenied('ACCOUNT_OWNER_SCHEMA_UNAVAILABLE')
        identity = self.db.execute(select(users.c.id).where(users.c.id == owner_id,
            users.c.is_active.is_(True), users.c.is_verified.is_(True)).with_for_update()).first()
        if identity is None: raise BoundaryDenied('ACTIVE_OWNER_REQUIRED')
        self._application_references(owner_id)
        datasets = {}
        omitted = {r.table: r.excluded_reason for r in self.inventory.rules if r.excluded_reason}
        payload = {'owner_id': owner_id, 'inventory_reference': self.inventory.reference,
                   'schema_digest': self.inventory.schema_digest, 'datasets': datasets,
                   'excluded_tables': omitted, 'backend': connection.dialect.name,
                   'legal_approval': False, 'runtime_binding': False}
        used = len(_encode(payload)) + len(',"content_hash":""') + 64
        if used > self.MAX_BYTES: raise BoundaryDenied('ACCOUNT_EXPORT_SIZE_LIMIT')
        for rule in self.inventory.rules:
            if rule.excluded_reason: continue
            table = self.metadata.tables[rule.table]
            used += len(_encode(rule.table)) + 3 + (1 if datasets else 0)
            if used >= self.MAX_BYTES: raise BoundaryDenied('ACCOUNT_EXPORT_SIZE_LIMIT')
            columns = [table.c[c] for c in rule.export_columns]
            cap = min(self.MAX_VALUE_BYTES, self.MAX_BYTES - used)
            lengths = [(func.octet_length(cast(c, Text)) if connection.dialect.name == 'postgresql'
                        else func.length(cast(c, LargeBinary))) for c in columns]
            flags = [func.coalesce(length > cap, False) for length in lengths]
            projections = [case((flag, None), else_=cast(column, Text) if isinstance(column.type, JSON) else column)
                           for column, flag in zip(columns, flags)]
            statement = select(*projections, *flags).where(self._predicate(table, rule, owner_id)).limit(self.MAX_ROWS_PER_TABLE + 1)
            rows = []
            with self.db.execute(statement.execution_options(stream_results=True, yield_per=1, max_row_buffer=1)).yield_per(1) as result:
                while True:
                    try: raw = result.fetchone()
                    except (ValueError, RecursionError, OverflowError): raise BoundaryDenied('ACCOUNT_EXPORT_VALUE_UNSUPPORTED') from None
                    if raw is None: break
                    if len(rows) >= self.MAX_ROWS_PER_TABLE: raise BoundaryDenied('ACCOUNT_EXPORT_SIZE_LIMIT')
                    if any(raw[len(columns):]): raise BoundaryDenied('ACCOUNT_EXPORT_VALUE_LIMIT')
                    converted = {}; row_bytes = 2
                    for index, column in enumerate(columns):
                        value = _json_value(raw[index], cap) if isinstance(column.type, JSON) else raw[index]
                        value = _private_value(filtered(_value(value, max_bytes=cap)))
                        row_bytes += len(_encode(column.name)) + 1 + len(_encode(value)) + (1 if converted else 0)
                        if used + row_bytes + (1 if rows else 0) > self.MAX_BYTES:
                            raise BoundaryDenied('ACCOUNT_EXPORT_SIZE_LIMIT')
                        converted[column.name] = value
                    encoded = _encode(converted)
                    used += len(encoded) + (1 if rows else 0)
                    rows.append((encoded, converted))
            datasets[rule.table] = [row for _, row in sorted(rows, key=lambda item: item[0])]
        encoded = _encode(payload)
        return {**payload, 'content_hash': hashlib.sha256(encoded).hexdigest()}
