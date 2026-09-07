"""Immutable scan source packs keep large Gamma payloads out of run JSON copies."""
from __future__ import annotations
import base64
import hashlib
import os
import re
from pathlib import Path
from uuid import uuid4

SOURCE_ROOT = Path(os.environ.get('BULLPEN_EXPORT_DIR', Path(__file__).resolve().parents[3] / '.stage-one-exports')) / 'scan-sources'
_REFERENCE = re.compile(r'^source-v1:([a-f0-9]{32}):(\d+):(\d+):([a-f0-9]{64})$')

class ScanSourceWriter:
    def __enter__(self):
        SOURCE_ROOT.mkdir(parents=True, exist_ok=True)
        self.identity = uuid4().hex
        self.path = SOURCE_ROOT / (self.identity + '.pack')
        self.handle = self.path.open('xb')
        return self

    def store(self, row: dict) -> dict:
        value = row.get('scan_export_data')
        if not value or str(value).startswith('source-v1:'):
            return row
        data = base64.b64decode(value, validate=True)
        offset = self.handle.tell()
        self.handle.write(data)
        row['scan_export_data'] = f'source-v1:{self.identity}:{offset}:{len(data)}:{hashlib.sha256(data).hexdigest()}'
        return row

    def __exit__(self, *args):
        # Close and flush before any run snapshot is persisted with these references.
        self.handle.flush()
        os.fsync(self.handle.fileno())
        self.handle.close()


def read_scan_source(value: str) -> bytes:
    match = _REFERENCE.fullmatch(value)
    if not match:
        raise ValueError('Invalid Stage 1 source reference')
    identity, offset, size, digest = match.groups()
    length = int(size)
    if length > 32 * 1024 * 1024:
        raise ValueError('Stage 1 source row exceeds read limit')
    with (SOURCE_ROOT / (identity + '.pack')).open('rb') as source:
        source.seek(int(offset))
        data = source.read(length)
    if len(data) != length or hashlib.sha256(data).hexdigest() != digest:
        raise ValueError('Stage 1 source pack is incomplete or corrupted')
    return data
