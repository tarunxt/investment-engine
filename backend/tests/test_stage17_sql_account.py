"""Real SQL reads on disposable records, not real privacy actions or PG acceptance."""
from dataclasses import replace
from decimal import Decimal
import pytest
from sqlalchemy import MetaData, Table, Column, Integer, String, Boolean, ForeignKey, Numeric, JSON, Index, create_engine, event, inspect
from sqlalchemy.types import TypeDecorator
from sqlalchemy.orm import Session
from app.domains.ai_limits.contracts import BoundaryDenied
from app.domains.public_service.sql_account import SQLAccountReader, AccountInventory, AccountTableRule, OwnerHop, schema_digest

@pytest.fixture
def setup(tmp_path):
    metadata = MetaData()
    users = Table('users', metadata, Column('id', Integer, primary_key=True), Column('email', String),
        Column('password_hash', String), Column('is_active', Boolean, nullable=False), Column('is_verified', Boolean, nullable=False))
    portfolios = Table('portfolios', metadata, Column('id', Integer, primary_key=True),
        Column('user_id', ForeignKey('users.id'), nullable=False), Column('name', String), Column('api_secret', String))
    holdings = Table('holdings', metadata, Column('id', Integer, primary_key=True),
        Column('portfolio_id', ForeignKey('portfolios.id'), nullable=False), Column('value', Numeric(24, 8)), Column('metadata_json', JSON))
    global_table = Table('global_controls', metadata, Column('id', Integer, primary_key=True), Column('secret', String))
    engine = create_engine('sqlite:///' + str(tmp_path / 'account.sqlite')); metadata.create_all(engine)
    db = Session(engine)
    db.execute(users.insert(), [dict(id=i, email=f'fixture{i}@example.invalid', password_hash='NEVER_EXPORT_HASH', is_active=i != 3, is_verified=True) for i in (1, 2, 3)])
    db.execute(portfolios.insert(), [dict(id=i, user_id=i, name=f'private-{i}', api_secret='NEVER_EXPORT_SECRET') for i in (1, 2)])
    db.execute(holdings.insert(), [dict(id=i, portfolio_id=i, value=Decimal('10.12345678'), metadata_json={'note': f'owner{i}', 'access_token': 'NEVER_EXPORT_TOKEN'}) for i in (1, 2)])
    db.execute(global_table.insert(), [dict(id=1, secret='NEVER_EXPORT_GLOBAL')]); db.commit()
    rules = (AccountTableRule('users', ('id', 'email', 'is_active', 'is_verified'), ('password_hash',), owner_column='id'),
        AccountTableRule('portfolios', ('id', 'user_id', 'name'), ('api_secret',)),
        AccountTableRule('holdings', ('id', 'portfolio_id', 'value', 'metadata_json'), path=(OwnerHop('portfolios', ('portfolio_id',), ('id',)),)),
        AccountTableRule('global_controls', (), excluded_reason='reviewed platform control, not account data'))
    inventory = AccountInventory('fixture-inventory-not-real-approval', schema_digest(metadata), rules)
    try: yield db, metadata, inventory
    finally: db.close(); engine.dispose()

def test_direct_and_transitive_relationships_export_only_requested_owner(setup):
    db, metadata, inventory = setup
    output = SQLAccountReader(db, metadata, inventory).export(1)
    assert output['datasets']['users'][0]['id'] == 1
    assert output['datasets']['portfolios'][0]['name'] == 'private-1'
    assert output['datasets']['holdings'][0]['portfolio_id'] == 1
    assert output['datasets']['holdings'][0]['value'] == '10.12345678'
    assert output['datasets']['holdings'][0]['metadata_json']['access_token'] == '[withheld credential]'
    assert output['backend'] == 'sqlite' and output['legal_approval'] is False and output['runtime_binding'] is False
    assert len(output['content_hash']) == 64
    assert 'NEVER_EXPORT' not in str(output) and 'private-2' not in str(output)

def test_credential_columns_are_not_even_selected(setup):
    db, metadata, inventory = setup; statements = []
    def capture(connection, cursor, statement, parameters, context, executemany):
        if statement.lstrip().upper().startswith('SELECT'): statements.append(statement)
    event.listen(db.get_bind(), 'before_cursor_execute', capture)
    try: SQLAccountReader(db, metadata, inventory).export(1)
    finally: event.remove(db.get_bind(), 'before_cursor_execute', capture)
    assert not any('password_hash' in s or 'api_secret' in s for s in statements)

@pytest.mark.parametrize('owner', [True, 0, -1, 3, 99])
def test_inactive_missing_or_coerced_owner_never_exports(setup, owner):
    db, metadata, inventory = setup
    with pytest.raises(BoundaryDenied): SQLAccountReader(db, metadata, inventory).export(owner)

def test_unknown_table_or_field_and_changed_schema_are_not_silently_omitted(setup):
    db, metadata, inventory = setup
    with pytest.raises(BoundaryDenied): SQLAccountReader(db, metadata, replace(inventory, rules=inventory.rules[:-1])).export(1)
    rules = list(inventory.rules); rules[1] = replace(rules[1], export_columns=('id', 'user_id'))
    with pytest.raises(BoundaryDenied): SQLAccountReader(db, metadata, replace(inventory, rules=tuple(rules))).export(1)
    with pytest.raises(BoundaryDenied): SQLAccountReader(db, metadata, replace(inventory, schema_digest='0' * 64)).export(1)

def test_exporting_a_credential_field_is_rejected_even_when_policy_lists_it(setup):
    db, metadata, inventory = setup; rules = list(inventory.rules)
    rules[0] = replace(rules[0], export_columns=(*rules[0].export_columns, 'password_hash'), withheld_columns=())
    with pytest.raises(BoundaryDenied, match='CREDENTIAL_FIELD'): SQLAccountReader(db, metadata, replace(inventory, rules=tuple(rules))).export(1)

def test_invalid_relationship_path_cannot_select_another_owner(setup):
    db, metadata, inventory = setup; rules = list(inventory.rules)
    rules[2] = replace(rules[2], path=(OwnerHop('users', ('portfolio_id',), ('id',)),), owner_column='id')
    with pytest.raises(BoundaryDenied, match='OWNER_PATH'): SQLAccountReader(db, metadata, replace(inventory, rules=tuple(rules))).export(1)

def test_limits_fail_closed_instead_of_presenting_a_partial_account(setup):
    db, metadata, inventory = setup; reader = SQLAccountReader(db, metadata, inventory); reader.MAX_ROWS_PER_TABLE = 0
    with pytest.raises(BoundaryDenied, match='SIZE_LIMIT'): reader.export(1)

def test_reader_does_not_change_database_rows(setup):
    db, metadata, inventory = setup
    def snapshot(): return {name: [dict(r) for r in db.execute(table.select()).mappings()] for name, table in metadata.tables.items()}
    before = snapshot(); SQLAccountReader(db, metadata, inventory).export(1)
    assert snapshot() == before


@pytest.mark.parametrize('drift', ['foreign_key', 'primary_key', 'unique_index'])
def test_same_columns_do_not_hide_physical_ownership_constraint_drift(setup, tmp_path, drift):
    source, reviewed, inventory = setup; actual = MetaData()
    reviewed.tables['users'].to_metadata(actual)
    reviewed.tables['global_controls'].to_metadata(actual)
    if drift == 'primary_key':
        Table('portfolios', actual, Column('id', Integer, nullable=False),
            Column('user_id', ForeignKey('users.id'), nullable=False), Column('name', String), Column('api_secret', String))
    else: reviewed.tables['portfolios'].to_metadata(actual)
    Table('holdings', actual, Column('id', Integer, primary_key=True),
        Column('portfolio_id', ForeignKey('users.id' if drift == 'foreign_key' else 'portfolios.id'), nullable=False),
        Column('value', Numeric(24, 8)), Column('metadata_json', JSON))
    engine = create_engine('sqlite:///' + str(tmp_path / 'physical-schema-drift.sqlite')); actual.create_all(engine)
    if drift == 'unique_index': Index('unexpected_owner_index', actual.tables['portfolios'].c.name, unique=True).create(engine)
    try:
        with Session(engine) as db:
            for name in ('users', 'portfolios', 'global_controls'):
                rows = [dict(row) for row in source.execute(reviewed.tables[name].select()).mappings()]
                if name == 'portfolios':
                    for row in rows: row['user_id'] = 3 - row['user_id']
                db.execute(actual.tables[name].insert(), rows)
            db.execute(actual.tables['holdings'].insert(), dict(id=1, portfolio_id=1, value=1, metadata_json={'note': 'private-physical-owner-1'})); db.commit()
            # The independent exploit changes FK semantics without changing
            # any field/type/nullability that the original guard inspected.
            for name in actual.tables:
                assert [(c['name'], str(c['type']), c['nullable']) for c in inspect(engine).get_columns(name)] == [
                    (c.name, str(c.type), c.nullable) for c in reviewed.tables[name].columns]
            with pytest.raises(BoundaryDenied, match='SCHEMA_CHANGED'):
                SQLAccountReader(db, reviewed, inventory).export(2)
    finally: engine.dispose()


def test_cumulative_budget_aborts_before_later_table_read(setup):
    db, metadata, inventory = setup; reader = SQLAccountReader(db, metadata, inventory); reader.MAX_BYTES = 1
    statements = []
    def capture(connection, cursor, statement, *args):
        if statement.lstrip().upper().startswith('SELECT'): statements.append(statement)
    event.listen(db.get_bind(), 'before_cursor_execute', capture)
    try:
        with pytest.raises(BoundaryDenied, match='SIZE_LIMIT'): reader.export(1)
    finally: event.remove(db.get_bind(), 'before_cursor_execute', capture)
    assert not any('FROM holdings' in statement or 'FROM portfolios' in statement for statement in statements)


def test_oversized_cell_is_gated_in_sql_before_conversion_or_next_row(setup):
    db, metadata, inventory = setup; processed = []; statements = []
    class WatchedString(TypeDecorator):
        impl = String
        cache_ok = True
        def process_result_value(self, value, dialect):
            processed.append(value)
            assert value is None or len(value) <= 32
            return value
    table = metadata.tables['portfolios']
    db.execute(table.update().where(table.c.id == 1).values(name='x' * 200000))
    db.execute(table.insert(), dict(id=3, user_id=1, name='next-row-not-fetched', api_secret='withheld')); db.commit()
    table.c.name.type = WatchedString()
    reader = SQLAccountReader(db, metadata, inventory); reader.MAX_VALUE_BYTES = 32
    def capture(connection, cursor, statement, *args):
        if statement.lstrip().upper().startswith('SELECT'): statements.append(statement)
    event.listen(db.get_bind(), 'before_cursor_execute', capture)
    try:
        with pytest.raises(BoundaryDenied, match='VALUE_LIMIT'): reader.export(1)
    finally: event.remove(db.get_bind(), 'before_cursor_execute', capture)
    assert processed == [None]
    assert not any('FROM holdings' in statement for statement in statements)


def test_json_depth_is_checked_before_decoding_or_later_table_reads(setup, monkeypatch):
    import app.domains.public_service.sql_account as module
    db, metadata, inventory = setup; value = 'leaf'
    for _ in range(20): value = [value]
    table = metadata.tables['holdings']
    db.execute(table.update().where(table.c.id == 1).values(metadata_json=value)); db.commit()
    calls = []
    original = module.json.loads
    def parse(raw, **kwargs): calls.append(raw); return original(raw, **kwargs)
    monkeypatch.setattr(module.json, 'loads', parse)
    with pytest.raises(BoundaryDenied, match='VALUE_LIMIT'):
        SQLAccountReader(db, metadata, inventory).export(1)
    assert calls == []


def test_nested_value_node_limit_is_enforced_before_normalizing_unbounded_collections(setup):
    db, metadata, inventory = setup; table = metadata.tables['holdings']
    db.execute(table.update().where(table.c.id == 1).values(metadata_json=[0] * 2000)); db.commit()
    with pytest.raises(BoundaryDenied, match='VALUE_LIMIT'):
        SQLAccountReader(db, metadata, inventory).export(1)


def test_constraint_fingerprint_and_wrapper_normalization_keep_genuine_distinctions(setup):
    from app.domains.public_service.sql_account import _where
    _, metadata, _ = setup; before = schema_digest(metadata)
    Index('reviewed_unique', metadata.tables['portfolios'].c.name, unique=True)
    assert schema_digest(metadata) != before
    assert _where("((name = 'a  b'))") == "name = 'a  b'"
    assert _where("(name = 'a  b')") != _where("(name = 'a b')")


def test_matching_expression_partial_unique_index_succeeds_but_changed_literal_rejects(setup):
    db, metadata, inventory = setup
    table = metadata.tables['portfolios']
    index = Index('reviewed_owner_name', table.c.name, unique=True, sqlite_where=table.c.user_id == 1)
    index.create(db.get_bind())
    inventory = replace(inventory, schema_digest=schema_digest(metadata))
    assert SQLAccountReader(db, metadata, inventory).export(1)['datasets']['portfolios'][0]['user_id'] == 1
    db.rollback()
    physical = MetaData(); physical.reflect(db.get_bind()); actual = physical.tables['portfolios']
    next(i for i in actual.indexes if i.name == 'reviewed_owner_name').drop(db.get_bind())
    Index('reviewed_owner_name', actual.c.name, unique=True, sqlite_where=actual.c.user_id == 2).create(db.get_bind())
    with pytest.raises(BoundaryDenied, match='SCHEMA_CHANGED'):
        SQLAccountReader(db, metadata, inventory).export(1)


@pytest.mark.parametrize('dialect_name', ['sqlite', 'postgresql'])
def test_partial_predicate_compilation_binds_values_without_table_or_literal_loss(dialect_name):
    from sqlalchemy import bindparam, text
    from sqlalchemy.dialects import sqlite, postgresql
    from app.domains.public_service.sql_account import _where
    dialect = {'sqlite': sqlite, 'postgresql': postgresql}[dialect_name].dialect()
    table = Table('owned', MetaData(), Column('user_id', Integer), Column('label', String))
    assert _where(table.c.user_id == 1, dialect) == 'user_id = 1'
    assert _where(table.c.user_id == 1, dialect) != _where(table.c.user_id == 2, dialect)
    rendered = _where(table.c.label == "owner's  literal", dialect)
    assert "'owner''s  literal'" in rendered
    assert rendered != _where(table.c.label == "owner's literal", dialect)
    with pytest.raises(BoundaryDenied, match='UNBOUND'):
        _where(table.c.user_id == bindparam('unprovided'), dialect)


def test_partial_predicate_literal_changes_change_review_fingerprint():
    def fingerprint(value):
        metadata = MetaData(); table = Table('owned', metadata, Column('user_id', Integer), Column('label', String))
        Index('owner_name', table.c.label, unique=True, sqlite_where=table.c.user_id == value,
              postgresql_where=table.c.user_id == value)
        return schema_digest(metadata)
    assert fingerprint(1) != fingerprint(2)
