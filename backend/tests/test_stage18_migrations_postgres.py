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
        # Nonempty private histories, plus unresolved nullable ownership. These
        # are not dangling FK rows and no migration may invent their owner.
        for owner in [*identities, None]:
            job = connection.execute(metadata.tables['jobs'].insert().values(**values(
                metadata.tables['jobs'], user_id=owner, prompt='synthetic historical job',
                response='synthetic result', provider='synthetic', model='offline',
                status='completed', created_at=now, updated_at=now)).returning(metadata.tables['jobs'].c.id)).scalar_one()
            run = connection.execute(metadata.tables['runs'].insert().values(**values(
                metadata.tables['runs'], user_id=owner, prompt='synthetic historical run',
                prompt_preview='synthetic historical run', status='completed', current_stage=1,
                auto_export_enabled=True,
                created_at=now, updated_at=now)).returning(metadata.tables['runs'].c.id)).scalar_one()
            connection.execute(metadata.tables['run_jobs'].insert().values(**values(
                metadata.tables['run_jobs'], run_id=run, job_id=job, stage=1,
                created_at=now, updated_at=now)))
    return identities


def assert_legacy_preserved(before, after):
    # New nullable lifecycle columns are allowed, but every original column and
    # complete row multiplicity must remain byte-for-byte equal.
    for table, encoded in before.items():
        original = [json.loads(row) for row in encoded]
        if not original:
            assert not after[table], table
            continue
        columns = set(original[0])
        projected = sorted(json.dumps({key: value for key, value in json.loads(row).items()
                                      if key in columns}, sort_keys=True) for row in after[table])
        assert projected == encoded, table
    for table in ('jobs', 'runs'):
        for encoded in after[table]:
            row = json.loads(encoded)
            assert row['module_id'] is None and row['module_version'] is None
            assert row['module_cancel_requested'] is False


def seed_populated_controls(engine, identities):
    """Explicit synthetic choices at order_intents_001, never migration defaults."""
    from datetime import datetime, timezone
    from hashlib import sha256
    now = datetime.now(timezone.utc)
    metadata = MetaData(); metadata.reflect(engine)
    with engine.begin() as connection:
        for index, owner in enumerate(identities):
            connection.execute(metadata.tables['user_module_preferences'].insert().values(
                user_id=owner, version=1, updated_at=now))
            connection.execute(metadata.tables['user_modules'].insert().values(user_id=owner,
                module_id='ai_studio', enabled=index != 3, config={'schema_version': 1},
                version=1, schedules_paused=True))
            integration = connection.execute(select(metadata.tables['integration_connections']).where(
                metadata.tables['integration_connections'].c.owner_id == owner)).mappings().one()
            assert integration['status'] == 'legacy_review'
            connection.execute(metadata.tables['connection_credentials'].insert().values(
                id=str(uuid4()), connection_id=integration['id'], owner_id=owner,
                ciphertext='synthetic-not-decryptable-'+str(owner), key_version=1))
            intent = str(uuid4())
            digest = sha256(('synthetic-'+str(owner)).encode()).hexdigest()
            connection.execute(metadata.tables['confirmed_order_intents'].insert().values(
                id=intent, owner_id=owner, operation_key_digest=digest, request_digest=digest,
                connection_id=integration['id'], connection_version=1,
                account_id='synthetic-unverified-'+str(owner), app_mode='platform_managed',
                module_id='ai_studio', module_version=1, payload_json={'synthetic': True},
                state='draft', created_at=now))
            connection.execute(metadata.tables['confirmed_order_legs'].insert().values(
                id=str(uuid4()), intent_id=intent, position=0, payload_digest=digest,
                client_reference='synthetic-'+str(owner), state='draft', filled_quantity=0))


def assert_populated_ownership(engine, identities):
    from app.domains.runs.repository import PostgresRunRepository
    from app.domains.modules.lifecycle import (ModuleLifecycleDenied, WorkIdentity,
                                               current_sync, sync_owner_fence)
    metadata = MetaData(); metadata.reflect(engine)
    with Session(engine) as session:
        for owner in identities:
            for name, key in [('jobs', 'user_id'), ('runs', 'user_id'),
                              ('integration_connections', 'owner_id'), ('connection_credentials', 'owner_id'),
                              ('user_modules', 'user_id'), ('confirmed_order_intents', 'owner_id')]:
                table = metadata.tables[name]
                assert session.scalar(select(func.count()).select_from(table).where(table.c[key] == owner)) == 1
            visible = session.scalars(PostgresRunRepository(session)._owned_query(owner)).all()
            assert len(visible) == 1 and visible[0].user_id == owner
        # Real repository filtering must hide corrupt cross-owner AND null-owner
        # links, not just correctly owned histories. Roll back each probe.
        from datetime import datetime
        links, jobs, runs = (metadata.tables[name] for name in ('run_jobs', 'jobs', 'runs'))
        own_run = session.scalar(select(runs.c.id).where(runs.c.user_id == identities[0]))
        for other_owner in (identities[1], None):
            foreign_job = session.scalar(select(jobs.c.id).where(jobs.c.user_id == other_owner))
            probe = session.begin_nested()
            try:
                session.execute(links.insert().values(run_id=own_run, job_id=foreign_job,
                    stage=2, created_at=datetime.utcnow(), updated_at=datetime.utcnow()))
                assert not session.scalars(PostgresRunRepository(session)._owned_query(identities[0])).all()
            finally:
                probe.rollback()
        # Nullable ownership is distinct from dangling relational references.
        for source, column, target in [(links, 'job_id', jobs), (links, 'run_id', runs)]:
            assert session.scalar(select(func.count()).select_from(source.outerjoin(
                target, source.c[column] == target.c.id)).where(target.c.id.is_(None))) == 0
        for name in ('jobs', 'runs'):
            table = metadata.tables[name]
            assert session.scalar(select(func.count()).select_from(table).where(table.c.user_id.is_(None))) == 1
        with pytest.raises(ModuleLifecycleDenied, match='Current account required'):
            sync_owner_fence(session, None)
        with pytest.raises(ModuleLifecycleDenied, match='ACTIVE_IDENTITY_REQUIRED'):
            current_sync(session, WorkIdentity(identities[-1], 'ai_studio', 1))
        # Existing composite ownership FK rejects forged cross-owner credentials.
        credentials = metadata.tables['connection_credentials']
        with pytest.raises(IntegrityError) as rejected:
            with session.begin_nested():
                session.execute(credentials.update().where(credentials.c.owner_id == identities[0]).values(owner_id=identities[1]))
        assert rejected.value.orig.pgcode == '23503'  # FK, not a uniqueness failure


def exercise_explicit_queue_disposition(engine, identities):
    """Existing disable lifecycle, not automatic migration drain or quarantine."""
    from app.domains.modules.lifecycle import disable_owned_work
    metadata = MetaData(); metadata.reflect(engine)
    jobs = metadata.tables['jobs']
    with engine.begin() as connection:
        for owner in identities[:2]:
            for name in ('jobs', 'runs'):
                table = metadata.tables[name]
                connection.execute(table.update().where(table.c.user_id == owner).values(
                    status='pending', module_id='ai_studio', module_version=1))
        connection.execute(metadata.tables['user_modules'].update().where(
            metadata.tables['user_modules'].c.user_id == identities[0]).values(enabled=False))
    with Session(engine) as session:
        disable_owned_work(session, identities[0], ['ai_studio'])
        session.commit()
    with engine.connect() as connection:
        for name in ('jobs', 'runs'):
            for row in connection.execute(select(metadata.tables[name])).mappings():
                if row['user_id'] == identities[0]:
                    assert row['status'] == 'failed' and row['module_cancel_requested'] is True
                elif row['user_id'] == identities[1]:
                    assert row['status'] == 'pending' and row['module_cancel_requested'] is False
                else:
                    assert row['status'] == 'completed' and row['module_id'] is None


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
    assert_legacy_preserved(before, after)
    migrate(engine, 'head')
    assert rows(engine, exclude={'alembic_version'}) == after
    migrate(engine, 'admin_roles_001', direction='downgrade')
    assert rows(engine, exclude={'alembic_version'}) == before
    migrate(engine, 'head')
    repeated = rows(engine, exclude={'alembic_version'})
    assert_legacy_preserved(before, repeated)
    # Recreated metadata timestamps may change; private identities may not.
    with engine.connect() as connection:
        connections = metadata.tables['integration_connections']
        assert sorted((r['id'], r['owner_id'], r['credential_ref'], r['status']) for r in
            connection.execute(select(connections)).mappings()) == sorted(
            (r['id'], r['owner_id'], r['credential_ref'], r['status']) for r in migrated)

    # Newer records predate the execution migration, not the legacy tables.
    migrate(engine, 'order_intents_001', direction='downgrade')
    seed_populated_controls(engine, identities)
    populated = rows(engine, exclude={'alembic_version'})
    migrate(engine, 'head')
    for table, records in populated.items():
        assert rows(engine, exclude={'alembic_version'})[table] == records, table
    assert_populated_ownership(engine, identities)
    replay = rows(engine)
    migrate(engine, 'head')
    assert rows(engine) == replay
    contract = schema_contract(engine)
    with pytest.raises(RuntimeError, match='guarded backup/restore; downgrade refused'):
        migrate(engine, 'ai_limits_001', direction='downgrade')
    assert rows(engine) == replay
    assert schema_contract(engine) == contract
    exercise_explicit_queue_disposition(engine, identities)


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
    migrate(engine, 'admin_roles_001'); identities = seed_legacy(engine)
    migrate(engine, 'order_intents_001'); seed_populated_controls(engine, identities)
    migrate(engine, 'head'); assert_populated_ownership(engine, identities)
    exercise_explicit_queue_disposition(engine, identities)
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
    assert_populated_ownership(engine, identities)
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
], ids=str)
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
