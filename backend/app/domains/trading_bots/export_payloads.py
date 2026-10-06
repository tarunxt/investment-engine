"""Opt-in immutable byte sharing with independently allocated recovery bytes.

Logical UUID paths remain ordinary JSONL files for every historical reader. Only
newly completed files are adopted. Archive and primary never share an inode.
This is local recovery, not a cross-host disaster-recovery guarantee.
"""
from __future__ import annotations

import fcntl
import hashlib
import os
import stat
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4


def enabled() -> bool:
    return os.environ.get('BULLPEN_CANONICAL_EXPORT_STORAGE') == '1'


def sync_directory(directory: Path) -> None:
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


@contextmanager
def regular_reader(path: Path):
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode):
        raise ValueError('Nonregular immutable artifact remains pinned')
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    signature = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
    with os.fdopen(descriptor, 'rb', buffering=0) as handle:
        opened = os.fstat(handle.fileno())
        if not stat.S_ISREG(opened.st_mode) or signature(opened) != signature(before):
            raise ValueError('Immutable artifact changed before read')
        yield handle
        if signature(os.fstat(handle.fileno())) != signature(before) or signature(path.lstat()) != signature(before):
            raise ValueError('Immutable artifact changed during read')


def read_manifest(path: Path):
    import json
    limit = 64 * 1024**2
    with regular_reader(path) as handle:
        if os.fstat(handle.fileno()).st_size > limit:
            raise ValueError('Oversized manifest remains pinned')
        value = handle.read(limit + 1)
        if len(value) > limit:
            raise ValueError('Growing manifest remains pinned')
    return json.loads(value)


def integrity(path: Path) -> tuple[int, str]:
    digest = hashlib.sha256()
    size = 0
    with regular_reader(path) as handle:
        remaining = os.fstat(handle.fileno()).st_size
        while remaining:
            chunk = handle.read(min(1024 * 1024, remaining))
            if not chunk:
                raise ValueError('Immutable artifact shortened during read')
            digest.update(chunk)
            size += len(chunk)
            remaining -= len(chunk)
    return size, digest.hexdigest()


def identical(first: Path, second: Path) -> bool:
    with regular_reader(first) as a, regular_reader(second) as b:
        remaining = os.fstat(a.fileno()).st_size
        if remaining != os.fstat(b.fileno()).st_size:
            return False
        while remaining:
            amount = min(1024 * 1024, remaining)
            left, right = a.read(amount), b.read(amount)
            if len(left) != amount or left != right:
                return False
            remaining -= amount
        return True


def copy_regular(source: Path, destination: Path, *, expected_size: int):
    with regular_reader(source) as reader:
        remaining = os.fstat(reader.fileno()).st_size
        if type(expected_size) is not int or expected_size < 0 or remaining != expected_size:
            raise ValueError('Immutable source differs from reserved copy size')
        with destination.open('xb', buffering=0) as writer:
            while remaining:
                chunk = reader.read(min(1024 * 1024, remaining))
                if not chunk or writer.write(chunk) != len(chunk):
                    raise OSError('Immutable copy short read/write')
                remaining -= len(chunk)
            os.fsync(writer.fileno())


def independent(first: Path, second: Path) -> bool:
    a, b = first.lstat(), second.lstat()
    if not stat.S_ISREG(a.st_mode) or not stat.S_ISREG(b.st_mode):
        raise ValueError('Nonregular recovery artifact remains pinned')
    return (a.st_dev, a.st_ino) != (b.st_dev, b.st_ino)


def _checked(path: Path, size: int, digest: str, source: Path) -> None:
    if integrity(path) != (size, digest) or not identical(path, source):
        raise ValueError('UPS_SOURCE_CORRUPT: Existing immutable payload does not match; it was not overwritten.')


def _link_or_copy(source: Path, destination: Path, *, expected_size: int) -> None:
    # An unsupported/cross-device hardlink may use a separately allocated copy.
    # Never silently overwrite an already published immutable identity.
    try:
        os.link(source, destination)
    except OSError as exc:
        import errno
        if exc.errno not in {errno.EXDEV, errno.EPERM, errno.EOPNOTSUPP, errno.ENOTSUP}:
            raise
        copy_regular(source, destination, expected_size=expected_size)


def publish_payload(rows: Path, archive: Path, *, size: int, digest: str) -> dict:
    """Publish the recovery copy before sharing a newly written primary payload.

    Caller closes/fsyncs rows first and holds allocation reservations. Shared
    artifacts are verified on every adoption. Crash leftovers are pinned; this
    function only removes its own unpublished temporary link/copy.
    """
    if len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest):
        raise ValueError('Invalid immutable payload digest')
    if integrity(rows) != (size, digest):
        raise ValueError('UPS_SOURCE_CORRUPT: Newly written payload failed verification.')
    primary = rows.parent / 'immutable-payloads'
    recovery = archive / 'immutable-payloads'
    primary.mkdir(parents=True, exist_ok=True)
    recovery.mkdir(parents=True, exist_ok=True)
    if primary.is_symlink() or recovery.is_symlink():
        raise ValueError('Symlink immutable directory remains pinned')
    lock_fd = os.open(primary / '.publish.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    with os.fdopen(lock_fd, 'r+b', buffering=0) as lock:
        if not stat.S_ISREG(os.fstat(lock_fd).st_mode):
            raise ValueError('Nonregular publication lock remains pinned')
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        canonical = primary / f'{digest}.jsonl'
        backup = recovery / f'{digest}.jsonl'
        if canonical.exists():
            _checked(canonical, size, digest, rows)
        if backup.exists():
            _checked(backup, size, digest, rows)
        else:
            temporary = recovery / f'.{digest}.{uuid4().hex}.tmp'
            try:
                copy_regular(rows, temporary, expected_size=size)
                _checked(temporary, size, digest, rows)
                if not independent(rows, temporary):
                    raise ValueError('UPS_RECOVERY_NOT_INDEPENDENT')
                # Shared recovery directory may have another primary writer.
                # Link publication never replaces an existing canonical file.
                try:
                    os.link(temporary, backup)
                except FileExistsError:
                    _checked(backup, size, digest, rows)
                sync_directory(recovery)
            finally:
                temporary.unlink(missing_ok=True)
        if not independent(rows, backup) or (canonical.exists() and not independent(canonical, backup)):
            raise ValueError('UPS_RECOVERY_NOT_INDEPENDENT: Primary and archive must contain independent bytes.')
        if not canonical.exists():
            _link_or_copy(rows, canonical, expected_size=size)
            _checked(canonical, size, digest, rows)
            sync_directory(primary)
        if not independent(canonical, backup):
            raise ValueError('UPS_RECOVERY_NOT_INDEPENDENT')
        logical_archive = archive / rows.name
        if logical_archive.exists():
            _checked(logical_archive, size, digest, rows)
            if not independent(canonical, logical_archive):
                raise ValueError('UPS_RECOVERY_NOT_INDEPENDENT')
        else:
            _link_or_copy(backup, logical_archive, expected_size=size)
            sync_directory(archive)
        # Replace only this capture's new file, after independently verifying
        # recovery. Historical paths/offsets and other captures are never edited.
        if independent(canonical, rows):
            temporary_link = rows.with_name(f'.{rows.name}.{uuid4().hex}.tmp')
            try:
                _link_or_copy(canonical, temporary_link, expected_size=size)
                os.replace(temporary_link, rows)
                sync_directory(rows.parent)
            finally:
                temporary_link.unlink(missing_ok=True)
        return {'version': 1, 'sha256': digest, 'bytes': size,
                'recoveryExportId': rows.stem, 'independentRecovery': True}


def materialize_legacy_alias(rows: Path, archive: Path, *, apply=False, writers_quiesced=False) -> dict:
    """Explicit rollback of one new logical alias; dry-run is the default.

    This is not retention: only caller-selected paths are copied, with identical
    validated bytes and the same logical identity. No records/manifests are deleted.
    Rollback needs copy headroom before older mutable readers/writers are restored.
    """
    import json
    from app.domains.trading_bots.storage_budget import StorageBudget
    metadata = read_manifest(rows.with_suffix('.json'))
    storage = metadata.get('immutableRowsStorage')
    if not storage or storage.get('version') != 1 or not storage.get('independentRecovery'):
        raise ValueError('Unknown rollback manifest; payload remains pinned')
    size, digest = storage['bytes'], storage['sha256']
    if metadata.get('exportId') != rows.stem or metadata.get('rowsBytes') != size or metadata.get('rowsSha256') != digest:
        raise ValueError('Rollback logical identity or checksum manifest does not match')
    source = rows
    try:
        primary_valid = integrity(source) == (size, digest)
    except OSError:
        primary_valid = False
    if not primary_valid:
        identity = storage['recoveryExportId']
        if len(identity) != 36 or any(char not in '0123456789abcdef-' for char in identity):
            raise ValueError('Invalid recovery identity')
        source = archive / f'{identity}.jsonl'
        if integrity(source) != (size, digest):
            raise ValueError('UPS_SOURCE_CORRUPT: Rollback has no validated payload')
    result = {'path': str(rows), 'dryRun': not apply, 'copyBytes': size,
              'logicalId': metadata['exportId'], 'deletionEnabled': False}
    if not apply:
        result['requiresQuiescedWriters'] = True
        result['flagOffAloneIsRollback'] = False
        return result
    if not writers_quiesced or enabled():
        raise ValueError('Rollback requires verified writer quiescence and disabled alias creation')
    restored = {key: value for key, value in metadata.items()
                if key not in {'immutableRowsStorage', 'rowsBytes', 'rowsSha256', 'storageTransactionVersion'}}
    restored['storageRollback'] = {'version': 1, 'materialized': True,
                                   'originalImmutableRowsStorage': storage}
    restored_bytes = json.dumps(restored).encode()
    budget = StorageBudget(Path(os.environ.get('BULLPEN_STORAGE_RESERVATION_DIRECTORY') or rows.parent),
                           identity=f'rollback:{metadata["exportId"]}')
    temporary = rows.with_name(f'.{rows.name}.{uuid4().hex}.rollback.tmp')
    metadata_temporary = rows.with_name(f'.{rows.stem}.{uuid4().hex}.rollback-manifest.tmp')
    try:
        budget.reserve(rows.parent, size + len(restored_bytes))
        copy_regular(source, temporary, expected_size=size)
        _checked(temporary, size, digest, source)
        os.replace(temporary, rows)
        sync_directory(rows.parent)
        # Directory persistence of the private inode must precede publishing a
        # mutable manifest. Flag-off alone leaves old immutable aliases unsafe.
        with metadata_temporary.open('xb', buffering=0) as writer:
            if writer.write(restored_bytes) != len(restored_bytes):
                raise OSError('Rollback manifest short write')
            os.fsync(writer.fileno())
        os.replace(metadata_temporary, rows.with_suffix('.json'))
        sync_directory(rows.parent)
        budget.consume(rows.parent, size + len(restored_bytes))
    finally:
        metadata_temporary.unlink(missing_ok=True)
        temporary.unlink(missing_ok=True)
        budget.release()
    return result
