from copy import deepcopy
import pytest
from sqlalchemy import select
from app.domains.runs.stock_observations import stock_observation_page
from app.domains.recommendation_audit.capture import freeze_input, freeze_output
from app.domains.runs.models import RunJob
from app.shared.types import JobStatus
from test_recommendation_audit_integration import db, source  # noqa: F401


def pages(db, user=1, symbol='FIXTUREEQ', limit=1):
    cursor, all_rows, seen = None, {}, set()
    while True:
        page = stock_observation_page(db, user_id=user, market='india', symbol=symbol, cursor=cursor, limit=limit)
        for row in page['items']: all_rows.setdefault(row['id'], row)
        if not page['has_more']: return list(all_rows.values())
        cursor = page['next_cursor']
        assert cursor not in seen
        seen.add(cursor)


def test_all_pages_include_newer_failed_partial_and_separate_models_without_history_projection(db):
    run1, job1 = source(db)
    run2, job2 = source(db)
    run2.status = JobStatus.FAILED; job2.status = JobStatus.PARTIAL
    run3, job3 = source(db)
    job3.model = 'second-model'; db.commit()
    original = [job.response for job in [job1, job2, job3]]
    rows = pages(db)
    assert {row['run_id'] for row in rows} == {run1.id, run2.id, run3.id}
    assert rows[0]['run_id'] == run3.id
    assert next(row for row in rows if row['run_id'] == run2.id)['job_status'] == 'partial'
    assert next(row for row in rows if row['run_id'] == run2.id)['run_status'] == 'failed'
    assert [job.response for job in [job1, job2, job3]] == original
    assert len(pages(db, symbol='OTHER')) == 0


def test_owner_market_and_exact_symbol_are_required(db):
    source(db); source(db, user=2)
    assert len(pages(db)) == 1
    assert len(pages(db, user=2)) == 1
    assert len(pages(db, user=3)) == 0
    assert len(pages(db, symbol='FIXTURE')) == 0
    page = stock_observation_page(db, user_id=1, market='us', symbol='FIXTUREEQ')
    assert page['items'] == []


def test_immutable_retention_and_raw_job_have_stable_dedup_identity(db):
    run, job = source(db)
    inp = freeze_input(db, run, [job]); output = freeze_output(db, run, job, inp); db.commit()
    rows = pages(db)
    assert len(rows) == 1
    original_cells = deepcopy(rows[0]['cells'])
    for link in list(db.scalars(select(RunJob))): db.delete(link)
    db.delete(job); db.delete(run); db.commit()
    retained = pages(db)
    assert len(retained) == 1 and retained[0]['cells'] == original_cells
    assert retained[0]['id'] == rows[0]['id']
    assert retained[0]['run_status'] == 'original run status unavailable'
    assert retained[0]['source'] == 'retained_immutable_output'
    assert output.content


def test_cursor_validation_and_empty_pages_reach_audit_phase(db):
    with pytest.raises(ValueError): stock_observation_page(db, user_id=1, market='india', symbol='X', cursor='jobs:bad')
    with pytest.raises(ValueError): stock_observation_page(db, user_id=1, market='india', symbol='X', cursor='invalid:0')
    assert pages(db) == []


def test_technical_rows_need_no_action_column_and_malformed_rows_keep_every_cell(db):
    from app.domains.runs.stock_observations import matching_rows
    technical = "| Stock Symbol | Confidence | Rationale |\n|---|---|---|\n| HAL | 2 | Original technical rationale |"
    assert matching_rows(technical, 'HAL')[0][1]['confidence'] == '2'
    escaped = "| Stock Symbol | Rationale |\n|---|---|\n| HAL | Breakout \\| original |"
    assert matching_rows(escaped, 'HAL')[0][1]['rationale'] == 'Breakout | original'
    malformed = "| Stock Symbol | Score |\n|---|---|\n| HAL | 2 | additional financial cell |"
    row = matching_rows(malformed, 'HAL')[0][1]
    assert row['original cells'] == ['HAL', '2', 'additional financial cell']
    assert 'score' not in row and 'Malformed' in row['source contract status']
    assert matching_rows('HAL is mentioned in retained narrative.', 'HAL')[0][1]['original source text'].startswith('HAL')
    assert matching_rows(technical.replace('HAL', 'HALOTHER'), 'HAL') == []


def test_nonfinite_json_and_missing_fields_preserve_source_without_invalid_response_json():
    import json
    from app.domains.runs.stock_observations import matching_rows
    text = '[{"Stock Symbol":"HAL","Score":NaN}]'
    rows = matching_rows(text, 'HAL')
    assert rows[0][1]['original source fragment'] == text
    json.dumps(rows, allow_nan=False)


def test_first_page_and_bounded_cursor_compile_for_postgres_without_an_int4_overflow():
    from sqlalchemy.dialects.postgresql.asyncpg import PGDialect_asyncpg
    class Capture:
        def execute(self, query): self.query = query; return self
        def all(self): return []
    session = Capture()
    stock_observation_page(session, user_id=1, market='india', symbol='HAL')
    compiled = session.query.compile(dialect=PGDialect_asyncpg())
    assert 9223372036854775807 not in compiled.params.values()
    assert 'run_jobs.id <' not in str(compiled)
    stock_observation_page(session, user_id=1, market='india', symbol='HAL', cursor='jobs:10')
    compiled = session.query.compile(dialect=PGDialect_asyncpg())
    assert 'run_jobs.id <' in str(compiled) and 10 in compiled.params.values()
    with pytest.raises(ValueError): stock_observation_page(session, user_id=1, market='india', symbol='HAL', cursor='jobs:2147483648')


# This uses the existing disposable PostgreSQL fixture in the required CI audit
# job. It never falls back to production configuration.
import os
from pathlib import Path
from test_recommendation_audit_postgres import engine  # noqa: F401

@pytest.mark.skipif(not os.getenv('CREDX_AUDIT_TEST_POSTGRES_URL') or os.getenv('CREDX_AUDIT_DISPOSABLE_DB') != '1' or not Path('/.dockerenv').exists(), reason='Disposable PostgreSQL Docker test environment not provided')
def test_real_asyncpg_first_page_owner_and_next_cursor(engine):
    import asyncio
    import asyncpg
    from sqlalchemy.dialects.postgresql.asyncpg import PGDialect_asyncpg
    from app.domains.runs.models import RunJob
    schema = engine.get_execution_options()['schema_translate_map'][None]
    dsn = os.environ['CREDX_AUDIT_TEST_POSTGRES_URL'].replace('postgresql+psycopg2://', 'postgresql://')
    class Capture:
        def execute(self, query): self.query=query; return self
        def all(self): return []
    async def check():
        connection = await asyncpg.connect(dsn)
        try:
            await connection.execute(f'SET search_path TO "{schema}"')
            await connection.execute('CREATE TABLE runs (id INTEGER PRIMARY KEY, user_id INTEGER); CREATE TABLE jobs (id INTEGER PRIMARY KEY, user_id INTEGER); CREATE TABLE run_jobs (id INTEGER PRIMARY KEY, run_id INTEGER, job_id INTEGER); INSERT INTO runs VALUES (1, 1); INSERT INTO jobs VALUES (1, 1); INSERT INTO run_jobs VALUES (1, 1, 1)')
            with pytest.raises(asyncpg.DataError): await connection.fetchval('SELECT $1::INTEGER', 9223372036854775807)
            async def query(user, cursor=None):
                session=Capture(); stock_observation_page(session,user_id=user,market='india',symbol='HAL',cursor=cursor)
                compiled=session.query.with_only_columns(RunJob.id).compile(dialect=PGDialect_asyncpg())
                return await connection.fetch(str(compiled), *(compiled.params[key] for key in compiled.positiontup))
            assert len(await query(1)) == 1
            assert len(await query(2)) == 0
            assert len(await query(1, 'jobs:1')) == 0
        finally: await connection.close()
    asyncio.run(check())
