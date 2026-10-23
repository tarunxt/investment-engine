"""Actual disposable PostgreSQL rehearsal; collection is not acceptance.

Uses the existing explicitly acknowledged CI service, never a default URL.
All modifications are confined to a fresh stage18_<uuid> schema. No provider
adapters, credentials, external notifications or application worker are started.
"""
import asyncio
import json
import os
from pathlib import Path
import subprocess
from uuid import uuid4

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import CheckConstraint, Column, MetaData, String, Table, create_engine, func, inspect, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool
from sqlalchemy.schema import CreateSchema, DropSchema
from scripts.public_launch.stage18_postgres_tools import PG_DUMP, PG_RESTORE, require_compatible_clients

from scripts.public_launch.stage18_schema_contract import canonical_check_sql

URL = 'postgresql+psycopg2://stage09:stage09@postgres:5432/credx_stage09_test'
DSN = URL.replace('postgresql+psycopg2:', 'postgresql:', 1)
BACKEND = Path(__file__).resolve().parents[1]
pytestmark = pytest.mark.skipif(
    os.getenv('CREDX_STAGE18_ACK') != 'synthetic-disposable-only',
    reason='Stage18 requires acknowledged disposable CI PostgreSQL; CI rejects skips')


@pytest.fixture
def rehearsal(monkeypatch):
    assert Path('/.dockerenv').is_file()
    assert os.environ.get('DATABASE_URL') == URL
    assert os.environ.get('CREDX_STAGE09_DATABASE_ACK') == 'disposable-docker-only'
    assert os.environ.get('CI') == 'true' and os.environ.get('GITHUB_ACTIONS') == 'true'
    assert not any(path.exists() for path in (BACKEND/'.env', BACKEND.parent/'.env', BACKEND.parent/'frontend/.env'))
    for key in ('COST_DASHBOARD_ADMIN_EMAILS', 'STAGE05_APPROVED_COST_ROLE_MIGRATION_IDS', 'CREDX_UAT2'):
        monkeypatch.delenv(key, raising=False)
    schema = 'stage18_' + uuid4().hex
    root = create_engine(URL, poolclass=NullPool)
    with root.begin() as connection:
        assert connection.dialect.name == 'postgresql'
        assert connection.dialect.server_version_info[0] == 16
        connection.execute(CreateSchema(schema))
    engine = create_engine(URL, poolclass=NullPool, connect_args={
        'options': f'-csearch_path={schema} -cstatement_timeout=15000 -clock_timeout=5000'})
    try:
        yield engine, schema
    finally:
        engine.dispose()
        with root.begin() as connection:
            connection.execute(DropSchema(schema, cascade=True))
        root.dispose()


def migrate(engine, target, *, direction='upgrade', fail_after=False):
    """Use the real Alembic transaction injection contract, not create_all."""
    config = Config(str(BACKEND/'alembic.ini'))
    config.set_main_option('script_location', str(BACKEND/'alembic'))
    with engine.begin() as connection:
        config.attributes['connection'] = connection
        getattr(command, direction)(config, target)
        if fail_after:
            raise RuntimeError('synthetic migration transaction interruption')


def rows(engine, *, exclude=frozenset()):
    metadata = MetaData()
    metadata.reflect(engine)
    with engine.connect() as connection:
        return {name: sorted(json.dumps(dict(row), sort_keys=True, default=str)
                for row in connection.execute(select(table)).mappings())
                for name, table in sorted(metadata.tables.items()) if name not in exclude}


def schema_contract(engine):
    inspector = inspect(engine)
    contract = {}
    def canonical(items):
        return sorted(items, key=lambda item: json.dumps(item, sort_keys=True, default=str))
    for name in inspector.get_table_names():
        contract[name] = {
            'columns': [(c['name'], str(c['type']), c['nullable'], c.get('default'))
                        for c in inspector.get_columns(name)],
            'primary': inspector.get_pk_constraint(name),
            'unique': canonical(inspector.get_unique_constraints(name)),
            'foreign': canonical(inspector.get_foreign_keys(name)),
            'checks': canonical([{**check, 'sqltext': canonical_check_sql(check['sqltext'])}
                                 for check in inspector.get_check_constraints(name)]),
            'indexes': canonical(inspector.get_indexes(name)),
        }
    # Sort reflected unordered collections without discarding their semantics.
    return json.dumps(contract, sort_keys=True, default=str)


def seed_legacy(engine):
    """Reflect the OLD schema so current ORM columns cannot mask migration gaps."""
    metadata = MetaData()
    metadata.reflect(engine)
    users, profiles = metadata.tables['users'], metadata.tables['user_profiles']
    legacy = metadata.tables['zerodha_credentials']
    from datetime import datetime, timedelta
    now = datetime.utcnow()
    identities = []
    def values(table, **provided):
        # Reflected Core inserts intentionally do not inherit ORM defaults.
        # Reject any other incomplete fixture before attempting partial seeds.
        missing = [column.name for column in table.c if not column.nullable
            and column is not table.autoincrement_column
            and ((column.name in provided and provided[column.name] is None)
                 or (column.name not in provided and column.default is None and column.server_default is None))]
        assert not missing, 'Incomplete synthetic fixture '+table.name+': '+','.join(missing)
        return provided
    with engine.begin() as connection:
        for name, role, active in [('owner', 'ADMIN', True), ('google_a', 'USER', True),
                                   ('google_b', 'USER', True), ('disabled', 'USER', False)]:
            identity = connection.execute(users.insert().values(**values(users,email=f'{name}@stage18.example.invalid',
                username='stage18_'+name, password_hash='synthetic-unusable', role=role,
                is_active=active, is_verified=True, created_at=now, updated_at=now)).returning(users.c.id)).scalar_one()
            # Reflection intentionally has no ORM Python defaults. Supply the
            # legacy NOT NULL profile fields explicitly rather than changing
            # the migrated schema or relying on create_all fixtures.
            connection.execute(profiles.insert().values(**values(profiles,user_id=identity,
                timezone='UTC',notification_preferences='all',theme_preference='light',
                created_at=now,updated_at=now)))
            identities.append(identity)
            connection.execute(legacy.insert().values(**values(legacy,user_id=identity,
                access_token='opaque-synthetic-cipher-'+name, login_time=now, expires_at=now+timedelta(hours=1),
                created_at=now,updated_at=now)))
    return identities


def test_actual_multiuser_migration_idempotence_and_connection_ownership(rehearsal):
    engine, _ = rehearsal
    migrate(engine, 'admin_roles_001')
    identities = seed_legacy(engine)
    before = rows(engine, exclude={'alembic_version'})
    migrate(engine, 'head')
    metadata = MetaData(); metadata.reflect(engine)
    with engine.connect() as connection:
        # Migration does not manufacture opt-in, execution authority or tokens.
        for name in ('user_modules', 'user_module_preferences', 'connection_credentials', 'confirmed_order_intents'):
            assert connection.scalar(select(func.count()).select_from(metadata.tables[name])) == 0
        migrated = connection.execute(select(metadata.tables['integration_connections'])).mappings().all()
        assert {row['owner_id'] for row in migrated} == set(identities)
        assert len(migrated) == 4
        assert all(row['status'] == 'legacy_review' and row['provider_account_id'] is None for row in migrated)
        assert all(row['app_ownership_mode'] == 'platform_managed' for row in migrated)
    after = rows(engine, exclude={'alembic_version'})
    for table, values in before.items():
        assert after[table] == values, table
    migrate(engine, 'head')
    assert rows(engine, exclude={'alembic_version'}) == after
    migrate(engine, 'admin_roles_001', direction='downgrade')
    assert rows(engine, exclude={'alembic_version'}) == before
    migrate(engine, 'head')
    repeated = rows(engine, exclude={'alembic_version'})
    for table, values in before.items():
        assert repeated[table] == values, table
    # Recreated metadata timestamps may change; private identities may not.
    with engine.connect() as connection:
        connections = metadata.tables['integration_connections']
        assert sorted((r['id'], r['owner_id'], r['credential_ref'], r['status']) for r in
            connection.execute(select(connections)).mappings()) == sorted(
            (r['id'], r['owner_id'], r['credential_ref'], r['status']) for r in migrated)


def test_actual_failed_migration_transaction_restores_schema_rows_and_revision(rehearsal):
    engine, _ = rehearsal
    migrate(engine, 'admin_roles_001'); seed_legacy(engine)
    before = rows(engine)
    tables = inspect(engine).get_table_names()
    with pytest.raises(RuntimeError, match='synthetic migration transaction interruption'):
        migrate(engine, 'head', fail_after=True)
    assert inspect(engine).get_table_names() == tables
    assert rows(engine) == before
    migrate(engine, 'head')  # Fresh transaction may recover; no partial version stamp.
    assert 'integration_connections' in inspect(engine).get_table_names()


def test_actual_pg_dump_restore_preserves_every_fixture_row_and_sequence(rehearsal, tmp_path):
    engine, schema = rehearsal
    assert Path(PG_DUMP).is_file() and Path(PG_RESTORE).is_file(), 'Required PostgreSQL16 client tools missing'
    with engine.connect() as connection:
        server_major = connection.dialect.server_version_info[0]
    dump_version = subprocess.run([PG_DUMP, '--version'], check=True, capture_output=True, text=True, timeout=5).stdout
    restore_version = subprocess.run([PG_RESTORE, '--version'], check=True, capture_output=True, text=True, timeout=5).stdout
    assert require_compatible_clients(server_major, dump_version, restore_version)['server_major'] == 16
    migrate(engine, 'admin_roles_001'); identities = seed_legacy(engine); migrate(engine, 'head')
    before = rows(engine)
    before_schema = schema_contract(engine)
    archive = tmp_path/'stage18-synthetic.dump'
    subprocess.run([PG_DUMP, '--dbname='+DSN, '--schema='+schema, '--format=custom',
                    '--no-owner', '--no-privileges', '--file='+str(archive)], check=True,
                   capture_output=True, text=True, timeout=90)
    assert archive.stat().st_size > 0
    # Only this fixture's random schema is removed, never another schema/database.
    with engine.begin() as connection:
        connection.execute(DropSchema(schema, cascade=True))
    subprocess.run([PG_RESTORE, '--dbname='+DSN, '--no-owner', '--no-privileges',
                    '--single-transaction', '--exit-on-error', str(archive)], check=True,
                   capture_output=True, text=True, timeout=90)
    assert rows(engine) == before
    assert schema_contract(engine) == before_schema
    metadata = MetaData(); metadata.reflect(engine); users = metadata.tables['users']
    with engine.begin() as connection:
        from datetime import datetime
        now = datetime.utcnow()
        new_id = connection.execute(users.insert().values(email='after-restore@stage18.example.invalid',
            username='stage18_after_restore', password_hash='synthetic-unusable', role='USER',
            is_active=True, is_verified=True, created_at=now, updated_at=now).returning(users.c.id)).scalar_one()
        assert new_id > max(identities)


@pytest.mark.asyncio
async def test_actual_concurrent_google_signup_preserves_independent_defaults(rehearsal, monkeypatch):
    engine, schema = rehearsal
    migrate(engine, 'head')
    from app.domains.auth import google_signin
    from app.domains.auth.models import User, UserProfile, UserRole
    from app.domains.modules.models import UserModule, UserModulePreferences
    monkeypatch.setattr(google_signin.PasswordUtils, 'hash_password', lambda _: 'synthetic-unusable-hash')
    async_engine = create_async_engine(URL.replace('+psycopg2', '+asyncpg'), poolclass=NullPool,
        connect_args={'server_settings': {'search_path': schema, 'statement_timeout': '15000'}})
    factory = async_sessionmaker(async_engine, expire_on_commit=False)
    async def login(email):
        async with factory() as session:
            user = await google_signin.resolve_google_user(session, email)
            await session.commit()
            return user.id
    try:
        first, repeat, second = await asyncio.gather(login('race-a@gmail.com'),
            login('race-a@gmail.com'), login('race-b@gmail.com'))
        assert first == repeat and first != second
        with Session(engine) as session:
            assert session.scalar(select(func.count()).select_from(User)) == 2
            assert session.scalar(select(func.count()).select_from(UserProfile)) == 2
            assert all(user.role == UserRole.USER for user in session.scalars(select(User)))
            assert session.scalar(select(func.count()).select_from(UserModule)) == 0
            assert session.scalar(select(func.count()).select_from(UserModulePreferences)) == 0
    finally:
        await async_engine.dispose()



@pytest.mark.parametrize('expression', [
    "value::text = ANY (ARRAY['user_owned'::character varying, 'platform_managed'::character varying]::text[])",
    "value::text = ANY (ARRAY['user_owned'::character varying::text, 'platform_managed'::character varying::text])",
])
def test_actual_check_cast_forms_preserve_constraint_semantics(rehearsal, expression):
    """Execute both cast forms in PostgreSQL, including SQL CHECK's NULL rule."""
    engine, _ = rehearsal
    table = Table('cast_contract_probe', MetaData(), Column('value', String(24)),
                  CheckConstraint(expression, name='ck_cast_contract_probe'))
    table.create(engine)
    with engine.begin() as connection:
        for value in ('user_owned', 'platform_managed', None):
            connection.execute(table.insert().values(value=value))
        for value in ('shared_fallback', '', 'USER_OWNED', 'user_owned '):
            with pytest.raises(IntegrityError) as error:
                with connection.begin_nested():
                    connection.execute(table.insert().values(value=value))
            assert error.value.orig.pgcode == '23514'
            assert error.value.orig.diag.constraint_name == 'ck_cast_contract_probe'
        assert connection.scalar(select(func.count()).select_from(table)) == 3
