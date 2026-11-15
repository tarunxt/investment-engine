from pathlib import Path
from types import SimpleNamespace
import sys
import pytest
from app.domains.polymarket_auto_live import export_jobs as jobs

@pytest.fixture
def cache(monkeypatch):
    values = {}
    class Cache:
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def get(self, key): return values.get(key)
        def set(self, key, value, **kwargs):
            if kwargs.get('nx') and key in values: return False
            values[key] = value
            return True
        def delete(self, key): values.pop(key, None)
    monkeypatch.setattr(jobs, 'client', Cache)
    return values

def test_repeated_clicks_queue_one_job_and_hide_internal_path(cache, monkeypatch, tmp_path):
    calls = []
    monkeypatch.setitem(sys.modules, 'app.domains.polymarket_auto_live.export_tasks', SimpleNamespace(
        prepare_stage_one_excel=SimpleNamespace(apply_async=lambda **kwargs: calls.append(kwargs))))
    assert jobs.ensure_job(1, 'run', 'filtered')['status'] == 'queued'
    assert jobs.ensure_job(1, 'run', 'filtered')['status'] == 'queued'
    assert len(calls) == 1
    file = tmp_path / 'export.xlsx'; file.write_bytes(b'xlsx')
    jobs.save_job(jobs.job_key(1, 'run', 'filtered'), {'status': 'ready', 'path': str(file), 'filename': 'export.xlsx'})
    state = jobs.ensure_job(1, 'run', 'filtered')
    assert state['status'] == 'ready'
    assert 'path' not in jobs.public_state(state)
    assert len(calls) == 1
    assert jobs.read_job(jobs.job_key(2, 'run', 'filtered')) is None

def test_publish_failure_can_be_retried(cache, monkeypatch):
    def fail(**kwargs): raise RuntimeError('broker down')
    monkeypatch.setitem(sys.modules, 'app.domains.polymarket_auto_live.export_tasks', SimpleNamespace(
        prepare_stage_one_excel=SimpleNamespace(apply_async=fail)))
    with pytest.raises(RuntimeError): jobs.ensure_job(1, 'run', 'all-scanned')
    assert jobs.read_job(jobs.job_key(1, 'run', 'all-scanned')) is None
