"""Bounded A11 migration qualification; execute only inside Docker CI."""
import os
from pathlib import Path
from uuid import uuid4
import pytest
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import make_url
from sqlalchemy.schema import CreateSchema, DropSchema

BACKEND = Path(__file__).parents[1]

def config():
    value = Config(str(BACKEND / 'alembic.ini'))
    value.set_main_option('script_location', str(BACKEND / 'alembic'))
    return value

def test_a11_migration_adds_one_revision_to_main_head():
    graph = ScriptDirectory.from_config(config())
    assert graph.get_heads() == ['jobs_admission_dispatch_001']
    assert graph.get_revision('jobs_admission_dispatch_001').down_revision == 'a12_cost_session_merge_001'
    delta = list(graph.iterate_revisions('jobs_admission_dispatch_001', 'a12_cost_session_merge_001'))
    assert [revision.revision for revision in delta] == ['jobs_admission_dispatch_001']

@pytest.mark.skipif(not os.getenv('CREDX_AUDIT_TEST_POSTGRES_URL')
                   or os.getenv('CREDX_AUDIT_DISPOSABLE_DB') != '1'
                   or not Path('/.dockerenv').exists(), reason='Explicit disposable Docker PostgreSQL not configured')
def test_bounded_a11_upgrade_preserves_historical_rows(monkeypatch):
    from alembic import command
    url = make_url(os.environ['CREDX_AUDIT_TEST_POSTGRES_URL'])
    if url.get_backend_name() != 'postgresql' or not (url.database or '').startswith('credx_audit_test'):
        pytest.fail('Refusing non-disposable PostgreSQL migration target')
    schema = 'a11_migration_' + uuid4().hex
    admin = create_engine(url)
    with admin.begin() as db:
        db.execute(CreateSchema(schema))
    isolated_url = url.set(query={'options': '-csearch_path=' + schema})
    isolated = create_engine(isolated_url)
    try:
        monkeypatch.setenv('DATABASE_URL', isolated_url.render_as_string(hide_password=False))
        # Real existing parent branch and exact A11 revision, not metadata reconstruction.
        # Never upgrade unrelated heads, including excluded Bullpen data repairs.
        command.upgrade(config(), 'a12_cost_session_merge_001')
        historical_id = uuid4()
        with isolated.begin() as db:
            db.execute(text('INSERT INTO outbox (id,topic,payload,created_at,attempts) VALUES (:id,:topic,CAST(:payload AS jsonb),CURRENT_TIMESTAMP,0)'),
                       {'id': historical_id, 'topic': 'historical.synthetic', 'payload': '{"fixture":true}'})
        command.upgrade(config(), 'jobs_admission_dispatch_001')
        with isolated.connect() as db:
            assert db.scalar(text('SELECT version_num FROM alembic_version')) == 'jobs_admission_dispatch_001'
            assert db.scalar(text('SELECT topic FROM outbox WHERE id=:id'), {'id': historical_id}) == 'historical.synthetic'
            assert db.execute(text('SELECT state,job_id,claim_token FROM outbox WHERE id=:id'), {'id': historical_id}).one() == (None,None,None)
            inspector = inspect(db)
            assert 'job_admissions' in inspector.get_table_names()
            uniques = inspector.get_unique_constraints('job_admissions')
            assert any(set(item['column_names']) == {'user_id','operation','request_key_hash'} for item in uniques)
            assert any(set(item['column_names']) == {'job_id'} for item in inspector.get_unique_constraints('outbox'))
        # Idempotent targeted upgrade must preserve the ledger.
        command.upgrade(config(), 'jobs_admission_dispatch_001')
    finally:
        isolated.dispose()
        with admin.begin() as db:
            db.execute(DropSchema(schema, cascade=True))
        admin.dispose()
