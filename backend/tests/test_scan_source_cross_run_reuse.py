import base64
from pathlib import Path

import pytest
from app.domains.polymarket_auto_live import scan_source_store as store
from app.domains.polymarket_auto_live.stage_one_excel import encode_scan_export_data, decode_scan_export_data


@pytest.fixture
def reuse(tmp_path, monkeypatch):
    monkeypatch.setattr(store, 'SOURCE_ROOT', tmp_path)
    monkeypatch.setenv('BULLPEN_SOURCE_REUSE_INDEX', '1')
    return tmp_path


def row(identity='42'):
    return {'scan_export_data': encode_scan_export_data({'id': identity, 'nested': [False, 0, 'preserved'], '_export_event': {'id': 'event'}})}


def test_exact_cross_run_reuse_preserves_v1_and_old_pack_bytes(reuse):
    first = row()
    with store.ScanSourceWriter() as a:
        a.store(first)
    original = a.path.read_bytes()
    second, different = row(), row('other')
    with store.ScanSourceWriter() as b:
        b.store(second)
        b.store(different)
    assert first['scan_export_data'] == second['scan_export_data']
    assert a.path.read_bytes() == original
    assert b.bytes_reused_cross_run == len(original)
    assert b.path.stat().st_size < len(original) + len(base64.b64decode(encode_scan_export_data({'id': 'other', 'nested': [False, 0, 'preserved'], '_export_event': {'id': 'event'}})))
    assert decode_scan_export_data(first) == decode_scan_export_data(second)
    assert decode_scan_export_data(different)['market']['id'] == 'other'
    assert b.index_bytes_written == 40 + 2 * 60


@pytest.mark.parametrize('damage', ['index', 'pack', 'missing-pack'])
def test_corrupt_or_missing_hints_fall_back_to_new_payload_without_false_reference(reuse, damage):
    first = row()
    with store.ScanSourceWriter() as a:
        a.store(first)
    if damage == 'index':
        next(reuse.glob('*.reuse-v1')).write_bytes(b'corrupt')
    elif damage == 'pack':
        a.path.write_bytes(b'broken')
    else:
        a.path.unlink()
    second = row()
    with store.ScanSourceWriter() as b:
        b.store(second)
    assert first['scan_export_data'] != second['scan_export_data']
    assert b.bytes_reused_cross_run == 0
    assert decode_scan_export_data(second)['market']['nested'] == [False, 0, 'preserved']


def test_failed_capture_never_publishes_source_reuse_hints(reuse):
    with pytest.raises(RuntimeError):
        with store.ScanSourceWriter() as a:
            a.store(row())
            raise RuntimeError('snapshot failed')
    assert a.path.exists()  # partial/unknown sources pinned, never swept
    assert not list(reuse.glob('*.reuse-v1'))


def test_hints_are_inactive_by_default(tmp_path, monkeypatch):
    monkeypatch.setattr(store, 'SOURCE_ROOT', tmp_path)
    monkeypatch.delenv('BULLPEN_SOURCE_REUSE_INDEX', raising=False)
    with store.ScanSourceWriter() as writer:
        writer.store(row())
    assert not list(tmp_path.glob('*.reuse-v1'))


@pytest.mark.parametrize('kind', ['fifo', 'directory', 'symlink', 'socket'])
def test_nonregular_indexes_are_ignored_without_opening(tmp_path, monkeypatch, kind):
    import os
    import stat
    from app.domains.polymarket_auto_live import source_reuse as hints
    path = tmp_path / 'special.reuse-v1'
    if kind == 'fifo':
        os.mkfifo(path)
    elif kind == 'directory':
        path.mkdir()
    elif kind == 'symlink':
        path.symlink_to('/dev/zero')
    else:
        # Mac sandbox denies socket.bind; inject only its lstat mode.
        path.write_bytes(b'not an index')
        original_lstat = Path.lstat
        def socket_stat(target, *args, **kwargs):
            value = original_lstat(target, *args, **kwargs)
            if target == path:
                values = list(value)
                values[0] = stat.S_IFSOCK | 0o600
                return os.stat_result(values)
            return value
        monkeypatch.setattr(Path, 'lstat', socket_stat)
    def forbidden(*args, **kwargs):
        pytest.fail('nonregular index must not be opened')
    monkeypatch.setattr(hints.os, 'open', forbidden)
    assert hints.SourceReuseHints(tmp_path).indexes == []


@pytest.mark.parametrize('replacement', ['fifo', 'symlink', 'regular'])
def test_index_replaced_before_open_is_rejected_without_blocking(tmp_path, monkeypatch, replacement):
    import os
    from app.domains.polymarket_auto_live import source_reuse as hints
    path = tmp_path / 'raced.reuse-v1'
    path.write_bytes(hints.MAGIC + __import__('hashlib').sha256(b'').digest())
    original_open = os.open
    def replace_then_open(target, flags, *args, **kwargs):
        path.unlink()
        if replacement == 'fifo':
            os.mkfifo(path)
        elif replacement == 'symlink':
            path.symlink_to('/dev/zero')
        else:
            path.write_bytes(b'replaced')
        assert flags & os.O_NONBLOCK and flags & os.O_NOFOLLOW
        return original_open(target, flags, *args, **kwargs)
    monkeypatch.setattr(hints.os, 'open', replace_then_open)
    assert hints.SourceReuseHints(tmp_path).indexes == []


@pytest.mark.parametrize('change', ['append', 'replace'])
def test_index_changed_during_read_is_rejected(tmp_path, monkeypatch, change):
    import os
    import hashlib
    from app.domains.polymarket_auto_live import source_reuse as hints
    path = tmp_path / 'changing.reuse-v1'
    data = hints.MAGIC + hashlib.sha256(b'').digest()
    path.write_bytes(data)
    original_fstat = os.fstat
    calls = 0
    def change_before_second_stat(fd):
        nonlocal calls
        calls += 1
        if calls == 2:
            if change == 'append':
                with path.open('ab') as writer:
                    writer.write(b'x')
            else:
                path.unlink()
                path.write_bytes(data)
        return original_fstat(fd)
    monkeypatch.setattr(hints.os, 'fstat', change_before_second_stat)
    assert hints.SourceReuseHints(tmp_path).indexes == []


def test_oversized_index_is_rejected_before_open(tmp_path, monkeypatch):
    from app.domains.polymarket_auto_live import source_reuse as hints
    path = tmp_path / 'huge.reuse-v1'
    with path.open('wb') as writer:
        writer.truncate(hints.MAX_INDEX_BYTES + 41)
    monkeypatch.setattr(hints.os, 'open', lambda *a, **k: pytest.fail('oversized index opened'))
    assert hints.SourceReuseHints(tmp_path).indexes == []
