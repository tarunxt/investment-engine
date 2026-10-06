#!/usr/bin/env python3
"""Local same-filesystem export transactions. No network or automatic retention.

An OS flock lives for this process/pipe session. A durable redo journal publishes
staged regular files, with metadata last. Restart rolls forward only a validated
journal; unknown/corrupt artifacts are pinned and fail closed.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.domains.trading_bots.storage_budget import StorageBudget

LIMIT = 1024 * 1024
SUFFIXES = {'rows': '.jsonl', 'filteredRows': '.filtered.jsonl', 'metadata': '.json',
            'reapply': '.filtered.jsonl.reapply.tmp'}


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def fingerprint(path, *, sync=False):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb', buffering=0) as handle:
        before = os.fstat(handle.fileno())
        if not stat.S_ISREG(before.st_mode):
            raise ValueError('Transaction payload is not regular')
        digest = hashlib.sha256()
        size = 0
        while chunk := handle.read(1024 * 1024):
            size += len(chunk)
            digest.update(chunk)
        after = os.fstat(handle.fileno())
        signature = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        if signature(before) != signature(after) or size != before.st_size:
            raise ValueError('Transaction payload changed during verification')
        if sync:
            os.fsync(handle.fileno())
        return {'bytes': size, 'sha256': digest.hexdigest()}


def load_regular(path, *, limit=LIMIT):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb', buffering=0) as handle:
        if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
            raise ValueError('Transaction journal is not regular')
        data = handle.read(limit + 1)
    if len(data) > limit:
        raise ValueError('Transaction journal exceeds limit')
    return json.loads(data)


def validate(record, identity):
    if record.get('version') != 1 or record.get('exportId') != identity:
        raise ValueError('Unknown transaction identity; artifacts remain pinned')
    token = record.get('token', '')
    if not re.fullmatch(r'[0-9a-f-]{36}', token):
        raise ValueError('Invalid transaction token')
    items = record.get('files')
    if not isinstance(items, list) or not 1 <= len(items) <= len(SUFFIXES):
        raise ValueError('Invalid transaction file set')
    seen = set()
    for item in items:
        kind = item.get('kind')
        if kind not in SUFFIXES or kind in seen:
            raise ValueError('Invalid transaction file kind')
        seen.add(kind)
        if item.get('stage') != f'.{identity}.{token}.{kind}.txn.tmp':
            raise ValueError('Invalid transaction stage identity')
        if type(item.get('bytes')) is not int or item['bytes'] < 0 or not re.fullmatch(r'[0-9a-f]{64}', item.get('sha256', '')):
            raise ValueError('Invalid transaction integrity')
    if 'metadata' not in seen:
        raise ValueError('Transaction must publish an ownership manifest')
    return sorted(items, key=lambda item: item['kind'] == 'metadata')


def recover(root, state, identity):
    journal = state / f'{identity}.journal'
    if not journal.exists() and not journal.is_symlink():
        return False
    record = load_regular(journal)
    items = validate(record, identity)
    if record.get('budgetRoot') != os.environ.get('BULLPEN_STORAGE_RESERVATION_DIRECTORY', str(root)):
        raise ValueError('Unknown transaction reservation root; claims remain pinned')
    # Verify EVERY remaining stage/published target before making any change.
    for item in items:
        stage = root / item['stage']
        target = root / (identity + SUFFIXES[item['kind']])
        source = stage if stage.exists() or stage.is_symlink() else target
        if fingerprint(source) != {'bytes': item['bytes'], 'sha256': item['sha256']}:
            raise ValueError('Corrupt transaction payload; artifacts remain pinned')
    manifest_item = next(item for item in items if item['kind'] == 'metadata')
    manifest_stage = root / manifest_item['stage']
    manifest = load_regular(manifest_stage if manifest_stage.exists() else root / (identity + '.json'), limit=64 * 1024**2)
    if manifest.get('exportId') != identity or not re.fullmatch(r'[0-9a-f]{64}', manifest.get('ownerHash', '')):
        raise ValueError('Unknown transaction ownership manifest')
    current_manifest = root / (identity + '.json')
    if current_manifest.exists() and load_regular(current_manifest, limit=64 * 1024**2).get('ownerHash') != manifest['ownerHash']:
        raise ValueError('Transaction cannot change logical ownership')
    for item in items:
        stage = root / item['stage']
        if stage.exists():
            os.replace(stage, root / (identity + SUFFIXES[item['kind']]))
            sync_dir(root)  # private rows durable BEFORE mutable metadata
    sync_dir(root)  # also persist an already-renamed final manifest on restart
    journal.unlink()
    sync_dir(state)
    # Release only this validated journal's own reservation after publication.
    StorageBudget(Path(record['budgetRoot']), identity='export-transaction', token=record['token']).release()
    return True


def commit(root, state, identity, request):
    token = request['token']
    record = {'version': 1, 'exportId': identity, 'token': token,
              'budgetRoot': request['budgetRoot'], 'files': []}
    for kind in request['kinds']:
        name = f'.{identity}.{token}.{kind}.txn.tmp'
        record['files'].append({'kind': kind, 'stage': name, **fingerprint(root / name, sync=True)})
    validate(record, identity)
    sync_dir(root)  # staged payload names survive before the redo journal
    encoded = json.dumps(record, separators=(',', ':')).encode()
    if len(encoded) > LIMIT:
        raise ValueError('Transaction journal exceeds limit')
    budget = StorageBudget(Path(request['budgetRoot']), identity='export-transaction', token=token)
    budget.reserve(state, len(encoded))
    temporary = state / f'.{identity}.{token}.journal.tmp'
    with temporary.open('xb', buffering=0) as handle:
        if handle.write(encoded) != len(encoded):
            raise OSError('Transaction journal short write')
        os.fsync(handle.fileno())
    os.replace(temporary, state / f'{identity}.journal')
    sync_dir(state)
    budget.consume(state, len(encoded))
    recover(root, state, identity)


def reply(value):
    print(json.dumps(value), flush=True)


def main():
    root = Path(sys.argv[1])
    identity = sys.argv[2]
    if not root.is_absolute() or not re.fullmatch(r'[0-9a-f-]{36}', identity):
        raise ValueError('Invalid export transaction location/identity')
    if root.is_symlink():
        raise ValueError('Symlink export root is pinned')
    root.mkdir(parents=True, exist_ok=True)
    state = root / '.export-transactions'
    state.mkdir(exist_ok=True)
    if state.is_symlink():
        raise ValueError('Symlink transaction directory is pinned')
    fd = os.open(state / f'{identity}.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    with os.fdopen(fd, 'r+b', buffering=0) as handle:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError('Nonregular transaction lock')
        fcntl.flock(fd, fcntl.LOCK_EX)
        recovered = recover(root, state, identity)
        reply({'ok': True, 'locked': True, 'recovered': recovered})
        for line in sys.stdin:
            request = json.loads(line)
            if request.get('action') == 'commit':
                commit(root, state, identity, request)
                reply({'ok': True, 'committed': True})
            else:
                raise ValueError('Unknown transaction action')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError) as error:
        reply({'ok': False, 'error': str(error)})
        sys.exit(1)
