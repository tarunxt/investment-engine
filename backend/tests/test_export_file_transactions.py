import importlib.util
import json
import os
from pathlib import Path
from uuid import uuid4

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/export-file-transaction.py'
spec = importlib.util.spec_from_file_location('export_file_transaction', SCRIPT)
txn = importlib.util.module_from_spec(spec)
spec.loader.exec_module(txn)


def fixture(tmp_path, monkeypatch):
    root = tmp_path / 'exports'
    root.mkdir()
    state = root / '.export-transactions'
    state.mkdir()
    identity, token = str(uuid4()), str(uuid4())
    monkeypatch.setenv('BULLPEN_STORAGE_RESERVATIONS', '1')
    monkeypatch.setenv('BULLPEN_STORAGE_RESERVATION_DIRECTORY', str(root))
    old_meta = {'exportId': identity, 'ownerHash': 'a' * 64, 'rowCount': 1, 'immutableRowsStorage': {'version': 1}}
    new_meta = {'exportId': identity, 'ownerHash': 'a' * 64, 'rowCount': 2, 'storageTransactionVersion': 1}
    old, new = {'rows': b'base\n', 'filteredRows': b'old-filter\n', 'metadata': json.dumps(old_meta).encode()}, {'rows': b'base\nwallet\n', 'filteredRows': b'new-filter\n', 'metadata': json.dumps(new_meta).encode()}
    for kind in old:
        (root / (identity + txn.SUFFIXES[kind])).write_bytes(old[kind])
        (root / f'.{identity}.{token}.{kind}.txn.tmp').write_bytes(new[kind])
    request = {'token': token, 'budgetRoot': str(root), 'kinds': list(new)}
    return root, state, identity, request, old, new


@pytest.mark.parametrize('boundary', [1, 2, 3])
def test_restart_recovers_each_partial_publish_and_retries_idempotently(tmp_path, monkeypatch, boundary):
    root, state, identity, request, old, new = fixture(tmp_path, monkeypatch)
    replace, count = txn.os.replace, 0
    def fail(source, destination):
        nonlocal count
        if Path(destination).parent == root:
            count += 1
            if count == boundary:
                raise OSError('injected process interruption')
        return replace(source, destination)
    monkeypatch.setattr(txn.os, 'replace', fail)
    with pytest.raises(OSError, match='interruption'):
        txn.commit(root, state, identity, request)
    assert (root / (identity + '.json')).read_bytes() == old['metadata']
    assert (state / (identity + '.journal')).exists()
    monkeypatch.setattr(txn.os, 'replace', replace)
    assert txn.recover(root, state, identity)
    assert not txn.recover(root, state, identity)
    for kind in new:
        assert (root / (identity + txn.SUFFIXES[kind])).read_bytes() == new[kind]
    assert json.loads((root / '.storage-admission/claims.json').read_text())['claims'] == {}


@pytest.mark.parametrize('boundary', [2, 3, 4, 5])
def test_fsync_interruption_recovers_with_metadata_last(tmp_path, monkeypatch, boundary):
    root, state, identity, request, old, new = fixture(tmp_path, monkeypatch)
    sync, count = txn.sync_dir, 0
    def fail(directory):
        nonlocal count
        count += 1
        if count == boundary:
            raise OSError('injected fsync interruption')
        return sync(directory)
    monkeypatch.setattr(txn, 'sync_dir', fail)
    with pytest.raises(OSError, match='fsync interruption'):
        txn.commit(root, state, identity, request)
    monkeypatch.setattr(txn, 'sync_dir', sync)
    assert txn.recover(root, state, identity)
    for kind in new:
        assert (root / (identity + txn.SUFFIXES[kind])).read_bytes() == new[kind]


@pytest.mark.parametrize('damage', ['corrupt', 'missing', 'fifo', 'symlink', 'ownership'])
def test_invalid_recovery_is_pinned_without_publishing_remaining_files(tmp_path, monkeypatch, damage):
    root, state, identity, request, old, new = fixture(tmp_path, monkeypatch)
    replace = txn.os.replace
    def fail(source, destination):
        if str(destination).endswith('.filtered.jsonl'):
            raise OSError('interrupted')
        return replace(source, destination)
    monkeypatch.setattr(txn.os, 'replace', fail)
    with pytest.raises(OSError):
        txn.commit(root, state, identity, request)
    monkeypatch.setattr(txn.os, 'replace', replace)
    stage = root / f'.{identity}.{request["token"]}.filteredRows.txn.tmp'
    if damage == 'corrupt': stage.write_bytes(b'corrupt')
    elif damage == 'missing': stage.unlink()
    elif damage == 'fifo': stage.unlink(); os.mkfifo(stage)
    elif damage == 'symlink': stage.unlink(); stage.symlink_to('/dev/zero')
    else:
        path = root / (identity + '.json')
        manifest = json.loads(path.read_text()); manifest['ownerHash'] = 'b' * 64
        path.write_text(json.dumps(manifest))
    with pytest.raises((ValueError, OSError)):
        txn.recover(root, state, identity)
    assert (state / (identity + '.journal')).exists()
    assert (root / (identity + '.filtered.jsonl')).read_bytes() == old['filteredRows']
    assert json.loads((root / '.storage-admission/claims.json').read_text())['claims']


def test_enospc_before_intent_changes_no_published_payload(tmp_path, monkeypatch):
    root, state, identity, request, old, new = fixture(tmp_path, monkeypatch)
    monkeypatch.setattr(txn.StorageBudget, 'reserve', lambda *a, **kw: (_ for _ in ()).throw(OSError(28, 'disk full')))
    with pytest.raises(OSError, match='disk full'):
        txn.commit(root, state, identity, request)
    assert not txn.recover(root, state, identity)
    for kind in old:
        assert (root / (identity + txn.SUFFIXES[kind])).read_bytes() == old[kind]


def test_os_lock_serializes_processes_and_releases_after_killed_holder(tmp_path):
    import select
    import subprocess
    import sys
    root = tmp_path / 'exports'
    root.mkdir()
    identity = str(uuid4())
    command = [sys.executable, str(SCRIPT), str(root), identity]
    first = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    second = None
    try:
        assert json.loads(first.stdout.readline())['locked']
        second = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        assert not select.select([second.stdout], [], [], 0.15)[0]
        first.kill(); first.wait(timeout=5)
        assert select.select([second.stdout], [], [], 5)[0]
        assert json.loads(second.stdout.readline())['locked']
        second.stdin.close(); second.wait(timeout=5)
        assert second.returncode == 0
    finally:
        if first.poll() is None: first.kill(); first.wait(timeout=5)
        if second is not None and second.poll() is None: second.kill(); second.wait(timeout=5)
