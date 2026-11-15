import ast
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
import io
import zipfile
import pytest
from app.domains.polymarket_auto_live.export_snapshot import build_export_snapshot
from app.domains.polymarket_auto_live.stage_one_excel import (
    _cell_xml, _write_sheet, encode_scan_export_data, build_stage_one_excel,
)


def test_minimal_snapshot_writes_complete_workbook_with_phase_progress():
    row = {'market_id': 'one', 'question': 'Question', 'reasons': ['Rejected'],
           'scan_export_data': encode_scan_export_data({'id': 'one', 'question': 'Question',
               'description': 'All original rules', 'outcomes': ['Yes', 'No'], 'volume': 1,
               '_export_event': {'id': 'event'}})}
    stages = [{'stage_number': 1, 'outputs': {'workflow_stage_key': 'scan',
        'scanned_candidates': 2, 'accepted_candidates': [dict(row, market_id='two')],
        'rejected_candidates': [row]}}]
    run = build_export_snapshot(stages, datetime(2026, 9, 7, tzinfo=timezone.utc), None)
    assert run.stage_results[0].outputs is stages[0]['outputs']
    assert run.started_at == '2026-09-07T00:00:00+00:00'
    for scope, expected in [('all-scanned', 2), ('filtered', 1)]:
        progress = []
        path, _, count = build_stage_one_excel(run, scope, progress_callback=lambda *p: progress.append(p))
        try:
            assert count == expected
            assert ('Reading source columns', 2, 2) in progress
            assert ('Writing Excel', expected, expected) in progress
            with zipfile.ZipFile(path) as book:
                assert 'All original rules' in book.read('xl/worksheets/sheet1.xml').decode()
        finally:
            path.unlink()
    assert stages[0]['outputs']['rejected_candidates'] == [row]


def test_fast_cell_cleanup_preserves_xml_semantics():
    assert 'ab\t\n\r&lt;&amp;é😀' in _cell_xml('A1', 'a\x00\x01b\t\n\r<&é😀')
    assert 't="s"' in _cell_xml('A1', None)
    assert '<v>3.5</v>' in _cell_xml('A1', 3.5)
    assert 's="1"' in _cell_xml('A1', 'Header', style=1)


def test_redelivered_export_retries_instead_of_dropping_locked_job():
    path = Path(__file__).parents[1] / 'app/domains/polymarket_auto_live/export_tasks.py'
    tree = ast.parse(path.read_text())
    node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'prepare_stage_one_excel')
    node.decorator_list = []
    class Retry(Exception): pass
    class Cache:
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def lock(self, *args, **kwargs): return SimpleNamespace(acquire=lambda **kwargs: False)
    calls = []
    def retry(**kwargs):
        calls.append(kwargs)
        return Retry()
    ns = {'job_key': lambda *a: 'job', 'client': Cache}
    exec(compile(ast.Module(body=[node], type_ignores=[]), str(path), 'exec'), ns)
    with pytest.raises(Retry):
        ns['prepare_stage_one_excel'](SimpleNamespace(retry=retry), 1, 'run', 'all-scanned')
    assert calls == [{'countdown': 30}]


def test_status_recovers_only_orphaned_preparations():
    path = Path(__file__).parents[1] / 'app/domains/polymarket_auto_live/export_jobs.py'
    node = next(n for n in ast.parse(path.read_text()).body
                if isinstance(n, ast.FunctionDef) and n.name == 'read_or_recover_job')
    state = {'status': 'working'}
    live = True
    calls = []
    class Cache:
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def exists(self, key): return live
    ns = {'job_key': lambda *a: 'job', 'read_job': lambda key: state,
          'client': Cache, 'ensure_job': lambda *args: calls.append(args) or {'status': 'queued'}}
    exec(compile(ast.Module(body=[node], type_ignores=[]), str(path), 'exec'), ns)
    recover = ns['read_or_recover_job']
    assert recover(1, 'run', 'filtered')['status'] == 'working'
    assert calls == []
    live = False
    assert recover(1, 'run', 'filtered')['status'] == 'queued'
    assert calls == [(1, 'run', 'filtered')]
    for status in ('ready', 'queued', 'failed'):
        state = {'status': status}
        assert recover(1, 'run', 'filtered')['status'] == status
    state = None
    assert recover(1, 'run', 'filtered') is None
    assert len(calls) == 1


def test_orphan_requeue_is_idempotent_and_preserves_live_lock(monkeypatch):
    import json, sys, time, logging
    path = Path(__file__).parents[1] / 'app/domains/polymarket_auto_live/export_jobs.py'
    nodes = [n for n in ast.parse(path.read_text()).body if isinstance(n, ast.FunctionDef)
             and n.name in {'ensure_job', 'read_job'}]
    values = {'job': json.dumps({'status': 'working'}), 'job:lock': 'owner'}
    class Cache:
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def get(self, key): return values.get(key)
        def exists(self, key): return key in values
        def delete(self, key): values.pop(key, None)
        def set(self, key, value, **kwargs):
            if kwargs.get('nx') and key in values: return False
            values[key] = value
            return True
    calls = []
    monkeypatch.setitem(sys.modules, 'app.domains.polymarket_auto_live.export_tasks',
        SimpleNamespace(prepare_stage_one_excel=SimpleNamespace(apply_async=lambda **kw: calls.append(kw))))
    ns = {'client': Cache, 'job_key': lambda *a: 'job', 'json': json,
          'Path': Path, 'time': time, 'logging': logging, 'TTL': 3600}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(path), 'exec'), ns)
    ensure = ns['ensure_job']
    assert ensure(1, 'run', 'all-scanned')['status'] == 'working'
    assert calls == []
    del values['job:lock']
    assert ensure(1, 'run', 'all-scanned')['status'] == 'queued'
    assert ensure(1, 'run', 'all-scanned')['status'] == 'queued'
    assert len(calls) == 1
