"""Prepared actual PostgreSQL reflection checks; never substituted by SQLite.

Requires the existing explicitly acknowledged disposable CI PostgreSQL. Not
executed on the Mac; local collection alone is not acceptance evidence.
"""
import os
from pathlib import Path
from dataclasses import replace
from uuid import uuid4
import pytest
from sqlalchemy import MetaData, Table, Column, Integer, String, Boolean, ForeignKey, Index, create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool
from sqlalchemy.schema import CreateSchema, DropSchema
from app.domains.ai_limits.contracts import BoundaryDenied
from app.domains.public_service.sql_account import AccountInventory, AccountTableRule, SQLAccountReader, schema_digest
from test_stage09_connections_postgres import URL

pytestmark = pytest.mark.skipif(os.getenv('CREDX_STAGE09_DATABASE_ACK') != 'disposable-docker-only',
    reason='Actual acknowledged disposable PostgreSQL container required; not local acceptance')

@pytest.fixture
def pg_reader():
    assert Path('/.dockerenv').is_file() and os.environ['DATABASE_URL'] == URL
    assert not Path('.env').exists() and not Path('backend/.env').exists()
    root = create_engine(URL, poolclass=NullPool); schema = 'stage17_reader_' + uuid4().hex
    with root.begin() as db: db.execute(CreateSchema(schema))
    engine = create_engine(URL, poolclass=NullPool, isolation_level='REPEATABLE READ',
        connect_args={'options': f'-csearch_path={schema} -cstatement_timeout=5000 -clock_timeout=3000'})
    metadata = MetaData()
    Table('users', metadata, Column('id', Integer, primary_key=True), Column('email', String),
        Column('is_active', Boolean, nullable=False), Column('is_verified', Boolean, nullable=False))
    table = Table('portfolios', metadata, Column('id', Integer, primary_key=True),
        Column('user_id', ForeignKey('users.id'), nullable=False), Column('name', String))
    Index('reviewed_owner_name', table.c.name, unique=True, postgresql_where=table.c.user_id == 1)
    try:
        metadata.create_all(engine)
        with engine.begin() as db:
            db.execute(metadata.tables['users'].insert(), [dict(id=i, email=f'fixture{i}@example.invalid', is_active=True, is_verified=True) for i in (1, 2)])
            db.execute(table.insert(), [dict(id=i, user_id=i, name=f'private-{i}') for i in (1, 2)])
        inventory = AccountInventory('fixture-pg-review', schema_digest(metadata), (
            AccountTableRule('users', tuple(metadata.tables['users'].c.keys()), owner_column='id'),
            AccountTableRule('portfolios', tuple(table.c.keys()))))
        yield engine, metadata, inventory
    finally:
        engine.dispose()
        with root.begin() as db: db.execute(DropSchema(schema, cascade=True))
        root.dispose()

def test_actual_pg_matching_partial_expression_index_preserves_owned_export(pg_reader):
    engine, metadata, inventory = pg_reader
    with Session(engine) as db:
        result = SQLAccountReader(db, metadata, inventory).export(1)
        assert result['datasets']['portfolios'] == [{'id': 1, 'user_id': 1, 'name': 'private-1'}]

def test_actual_pg_changed_partial_predicate_rejects_before_export(pg_reader):
    engine, metadata, inventory = pg_reader; physical = MetaData(); physical.reflect(engine)
    table = physical.tables['portfolios']
    next(i for i in table.indexes if i.name == 'reviewed_owner_name').drop(engine)
    Index('reviewed_owner_name', table.c.name, unique=True, postgresql_where=table.c.user_id == 2).create(engine)
    with Session(engine) as db:
        with pytest.raises(BoundaryDenied, match='SCHEMA_CHANGED'):
            SQLAccountReader(db, metadata, inventory).export(1)
