"""Synthetic serialization evidence; no provider, credential or real export calls."""
from datetime import datetime, timezone
import json
from types import SimpleNamespace

import pytest

from app.domains.jobs.schemas import JobResponse
from app.domains.jobs.output_contracts import normalize_output, export_tables, SWING_COLUMNS
from test_auto_rebalance_audit_durability import audit_db, anyio_backend
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from unittest.mock import Mock
from app.domains.jobs.models import Job
from app.domains.google_sheets import tasks
from test_output_contracts import swing_row, table
from test_google_sheets_output_contracts import job, export_job, markdown, stock

SENTINEL = 'synthetic-private-credential-sentinel'


def projection(**overrides):
    now = datetime(2026, 11, 1, tzinfo=timezone.utc)
    values = dict(id=41, prompt='Synthetic financial request', provider='synthetic', model='fixture', status='completed',
                  response='Synthetic financial result', created_at=now, updated_at=now,
                  access_token=SENTINEL, refresh_token=SENTINEL, password_hash=SENTINEL, user_id=7)
    values.update(overrides)
    return JobResponse.model_validate(SimpleNamespace(**values)).model_dump(mode='json')


def test_job_projection_excludes_undeclared_credential_attributes():
    result = projection()
    assert SENTINEL not in json.dumps(result)
    assert {'access_token', 'refresh_token', 'password_hash', 'user_id'}.isdisjoint(result)
    assert result['prompt'] == 'Synthetic financial request'
    assert result['response'] == 'Synthetic financial result'


@pytest.mark.parametrize('field,value', [
    ('error_message', f'OPENAI_API_KEY={SENTINEL}'),
    ('export_error', f'private provider detail token={SENTINEL}'),
    ('runtime_metadata_json', {'failure_diagnostics': {'password': SENTINEL}}),
    ('request_context_json', {'account_secret': SENTINEL}),
])
@pytest.mark.xfail(strict=True, raises=AssertionError, reason='Evidence gap confirmed: declared error/context fields have no projection sanitization; owning lane must define safe projection')
def test_job_projection_must_not_expose_sensitive_declared_internals(field, value):
    assert SENTINEL not in json.dumps(projection(**{field: value}))


def test_canonical_export_keeps_financial_columns_and_rejects_extra_metadata():
    content = table(SWING_COLUMNS, [swing_row('SYNTH')])
    result = normalize_output(content, 'swing')
    exports = export_tables(result)
    assert exports[0].headers == tuple(c.label for c in SWING_COLUMNS)
    assert len(exports[0].rows[0]) == 31
    assert exports[0].rows[0][2] == 'SYNTH'
    rejected = normalize_output(content, 'swing', metadata={'OPENAI_API_KEY': SENTINEL})
    assert not rejected.safe_to_replace
    with pytest.raises(ValueError):
        export_tables(rejected)


def test_actual_export_task_ignores_nonexport_record_credentials_and_context():
    source = job(markdown(SWING_COLUMNS, [stock('SYNTH')]), count=1,
                 access_token=SENTINEL, password_hash=SENTINEL,
                 request_context_json={'private': SENTINEL}, runtime_metadata_json={'private': SENTINEL})
    result, append, _, _ = export_job(source)
    assert result['status'] == 'completed'
    append.assert_called_once()
    assert SENTINEL not in str(append.call_args)
    assert 'SYNTH' in str(append.call_args)


@pytest.mark.xfail(strict=True, raises=AssertionError, reason='Source-preserving export also retains sensitive values supplied inside ancillary tables; minimization policy/owning lane decision required')
def test_ancillary_export_must_not_contain_sensitive_synthetic_fields():
    content = markdown(SWING_COLUMNS, [stock('SYNTH')]) + f'\n\n| token |\n| --- |\n| {SENTINEL} |\n'
    result, append, _, _ = export_job(job(content, count=1))
    assert result['status'] == 'completed'
    assert SENTINEL not in str(append.call_args)


@pytest.mark.anyio
async def test_actual_export_worker_rejects_other_owner_before_credentials_or_dispatch(audit_db, monkeypatch):
    engine = create_engine(audit_db.sync_url)
    try:
        with Session(engine) as db:
            db.add(Job(id=9001, user_id=7, prompt='Synthetic', provider='synthetic', model='fixture'))
            db.commit()
        monkeypatch.setattr(tasks, 'SyncSessionLocal', lambda: Session(engine))
        decrypt = Mock(side_effect=AssertionError('no credential access'))
        append = Mock(side_effect=AssertionError('no external dispatch'))
        monkeypatch.setattr(tasks, 'decrypt_token', decrypt)
        monkeypatch.setattr(tasks._svc, 'append_sheet', append)
        assert tasks.export_job_to_sheets_task.run(8, 9001, None) == {'status': 'failed', 'error': 'Job not found'}
        decrypt.assert_not_called()
        append.assert_not_called()
        audit_db.dispatch.assert_not_called()
    finally:
        engine.dispose()
