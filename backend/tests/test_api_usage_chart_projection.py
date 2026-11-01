"""Synthetic SQL instrumentation; never connects to a database/provider."""
from datetime import UTC, datetime
from types import SimpleNamespace
import json
import tracemalloc

import pytest
from sqlalchemy.dialects import postgresql
import app.models  # canonical mapper registry; no database connection
from app.domains.api_usage.corrected_router import _load_chart_rows, _accounting_window


@pytest.mark.asyncio
@pytest.mark.parametrize('size', [1, 10, 1000])
async def test_chart_projection_is_provider_owned_complete_and_bounded(size):
    statements = []
    timestamp = datetime(2026, 10, 31, 6, tzinfo=UTC)

    class FakeDB:
        async def execute(self, statement):
            compiled = statement.compile(dialect=postgresql.dialect())
            sql = str(compiled)
            statements.append(sql)
            assert 'user_id' in sql and 'provider =' in sql
            assert 17 in compiled.params.values() and 'deepseek' in compiled.params.values()
            selected = ' '.join(str(column) for column in statement.selected_columns)
            assert 'prompt' not in selected and 'output' not in selected
            assert 'LIMIT' not in sql  # run_limit never truncates accounting rows
            if 'FROM jobs' in sql:
                records = [(i, 'deepseek', 'model', 100, 10, .125, timestamp, {}, []) for i in range(size)]
            else:
                records = []
            return SimpleNamespace(all=lambda: records, scalars=lambda: SimpleNamespace(all=lambda: records))

    tracemalloc.start()
    rows = await _load_chart_rows(FakeDB(), user_id=17, provider='deepseek',
        start_utc=datetime(2026, 10, 31), end_utc=datetime(2026, 11, 1))
    _, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    assert len(statements) == 4
    assert len(rows) == size
    assert sum(row['estimated_cost'] for row in rows) == size * .125
    assert sum(row['tokens_in'] for row in rows) == size * 100
    assert all(row['measurement'] == 'estimated' for row in rows)
    assert all(row['settled_billed_cost_usd'] is None for row in rows)
    print(json.dumps({'rows': size, 'statements': len(statements),
        'response_bytes': len(json.dumps(rows, default=str)), 'peak_bytes': peak}))


def test_empty_window_never_proves_invoice_or_retry_coverage():
    window = _accounting_window(datetime(2026, 10, 31), datetime(2026, 11, 1))
    assert window['state'] == 'unknown'
    assert window['hidden_sdk_retries'] == 'unknown'
    assert window['failed_cancelled_attempts'] == 'not_integrated'
    assert window['window_end_exclusive'].startswith('2026-11-01')


@pytest.mark.asyncio
async def test_four_provider_baseline_hydrates_all_provider_entities():
    from app.domains.api_usage.corrected_router import _load_effective_usage_rows
    statements = []

    class FakeDB:
        async def execute(self, statement):
            statements.append(str(statement.compile(dialect=postgresql.dialect())))
            return SimpleNamespace(all=lambda: [], scalars=lambda: SimpleNamespace(all=lambda: []))

    for _ in ('openai', 'anthropic', 'deepseek', 'gemini'):
        await _load_effective_usage_rows(FakeDB(), user_id=17,
            start_utc=datetime(2026, 10, 31), end_utc=datetime(2026, 11, 1))
    assert len(statements) == 16
    job_reads = [sql for sql in statements if 'FROM jobs' in sql]
    assert len(job_reads) == 4
    assert all('jobs.prompt' in sql for sql in job_reads)
    assert all('jobs.provider =' not in sql for sql in job_reads)


@pytest.mark.asyncio
async def test_attempt_window_is_bounded_owned_and_kept_separate():
    from app.domains.api_usage.corrected_router import _window_attempt_coverage
    from app.domains.api_usage.coverage import MAX_EVENT_ROWS

    class FakeDB:
        async def execute(self, statement):
            compiled = statement.compile(dialect=postgresql.dialect())
            assert MAX_EVENT_ROWS + 1 in compiled.params.values()
            assert 17 in compiled.params.values()
            assert 'deepseek' in compiled.params.values()
            assert 'started_at >=' in str(compiled) and 'started_at <' in str(compiled)
            return SimpleNamespace(scalars=lambda: SimpleNamespace(all=lambda: []))

    coverage = await _window_attempt_coverage(FakeDB(), user_id=17, provider='deepseek',
        start_utc=datetime(2026, 10, 31), end_utc=datetime(2026, 11, 1))
    assert coverage['summary']['attempts'] == 0
