"""Optional bounded reuse hints, never authoritative ownership or lifetime data.

Sealed v1 indexes point to existing immutable source-v1 slices. Every hit is
validated by the old reader and exact byte comparison before adoption. Corrupt
hints only reduce reuse; old packs/offsets are never rewritten or swept.
"""
from __future__ import annotations

import hashlib
import heapq
import logging
import os
import stat
import struct
from pathlib import Path
from uuid import uuid4

MAGIC = b'SSREUSE1'
RECORD = struct.Struct('>32s16sQI')
MAX_INDEX_BYTES = 16 * 1024**2
MAX_INDEX_FILES = 8


def enabled():
    return os.environ.get('BULLPEN_SOURCE_REUSE_INDEX') == '1'


def _identity(snapshot):
    return (snapshot.st_dev, snapshot.st_ino, snapshot.st_size,
            snapshot.st_mtime_ns, snapshot.st_ctime_ns)


def _read_index(path: Path, expected):
    """Reject special files and races without blocking on a replaced FIFO."""
    if not stat.S_ISREG(expected.st_mode) or expected.st_size > MAX_INDEX_BYTES + 40:
        raise ValueError('Reuse hint exceeds bounded regular-file read limit')
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'rb', buffering=0) as handle:
        before = os.fstat(handle.fileno())
        if not stat.S_ISREG(before.st_mode) or _identity(before) != _identity(expected):
            raise ValueError('Reuse hint changed before read')
        data = handle.read(MAX_INDEX_BYTES + 41)
        after = os.fstat(handle.fileno())
        current = path.lstat()
        if (len(data) != before.st_size or len(data) > MAX_INDEX_BYTES + 40
                or _identity(after) != _identity(before)
                or not stat.S_ISREG(current.st_mode)
                or _identity(current) != _identity(before)):
            raise ValueError('Reuse hint changed during read')
        return data


class SourceReuseHints:
    def __init__(self, root: Path):
        self.root = root
        self.pending = bytearray()
        self.indexes = []
        candidates = []
        for path in root.glob('*.reuse-v1'):
            try:
                snapshot = path.lstat()
                if stat.S_ISREG(snapshot.st_mode):
                    candidates.append((snapshot.st_mtime_ns, path, snapshot))
                else:
                    logging.getLogger(__name__).warning('Nonregular source reuse hint ignored; source packs remain pinned')
            except OSError:
                logging.getLogger(__name__).warning('Source reuse hint unavailable; source packs remain pinned')
        for _, path, snapshot in heapq.nlargest(MAX_INDEX_FILES, candidates):
            try:
                data = _read_index(path, snapshot)
                if data[:8] != MAGIC or len(data) < 40 or (len(data) - 40) % RECORD.size or hashlib.sha256(memoryview(data)[40:]).digest() != data[8:40]:
                    raise ValueError('Corrupt reuse hint')
                self.indexes.append(memoryview(data)[40:])
            except (OSError, ValueError):
                logging.getLogger(__name__).warning('Invalid source reuse hint ignored; referenced packs remain pinned')

    def find(self, digest: str, size: int):
        key = bytes.fromhex(digest)
        for index in self.indexes:
            low, high = 0, len(index) // RECORD.size
            while low < high:
                middle = (low + high) // 2
                if bytes(index[middle * RECORD.size:middle * RECORD.size + 32]) < key:
                    low = middle + 1
                else:
                    high = middle
            # An index is only a hint. Cap collision probing; exact byte checks
            # in the caller are mandatory even with a valid SHA256 entry.
            for number in range(low, min(low + 16, len(index) // RECORD.size)):
                stored, identity, offset, length = RECORD.unpack_from(index, number * RECORD.size)
                if stored != key:
                    break
                if length == size:
                    yield f'source-v1:{identity.hex()}:{offset}:{length}:{digest}'

    def add(self, value: str):
        if len(self.pending) + RECORD.size > MAX_INDEX_BYTES:
            return  # omitted hints reduce reuse only, never reference pinning
        version, identity, offset, length, digest = value.split(':')
        if version != 'source-v1':
            return
        self.pending.extend(RECORD.pack(bytes.fromhex(digest), bytes.fromhex(identity), int(offset), int(length)))

    def publish(self, identity: str, *, admission, budget=None):
        if not self.pending:
            return 0
        records = sorted(self.pending[offset:offset + RECORD.size] for offset in range(0, len(self.pending), RECORD.size))
        # Fixed-size sorted binary hints keep filesystem overhead bounded to
        # one file per writer, rather than one file per market/source payload.
        payload = b''.join(records)
        header = MAGIC + hashlib.sha256(payload).digest()
        size = len(header) + len(payload)
        if budget is not None:
            budget.reserve(self.root, size)
        target = self.root / f'{identity}.reuse-v1'
        temporary = self.root / f'.{identity}.{uuid4().hex}.reuse.tmp'
        try:
            with admission(self.root, size):
                with temporary.open('xb', buffering=0) as handle:
                    if handle.write(header) != len(header) or handle.write(payload) != len(payload):
                        raise OSError('Source reuse hint short write')
                    os.fsync(handle.fileno())
                os.replace(temporary, target)
                descriptor = os.open(self.root, os.O_RDONLY)
                try:
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
            if budget is not None:
                budget.consume(self.root, size)
            return size
        finally:
            temporary.unlink(missing_ok=True)
