"""Immutable, run-scoped Gamma pages let a redelivered scan replay fetched data."""
from __future__ import annotations

import gzip
import hashlib
import json
import logging
import os
import tempfile

from app.domains.polymarket_auto_live import scan_source_store


class ScanPageCache:
    def __init__(self, run_key: str):
        identity = hashlib.sha256(run_key.encode()).hexdigest()
        self.root = scan_source_store.SOURCE_ROOT.parent / 'scan-pages-v1' / identity

    def path(self, cursor, end_date_min):
        query = json.dumps([cursor, end_date_min], separators=(',', ':'))
        return self.root / (hashlib.sha256(query.encode()).hexdigest() + '.json.gz')

    def read(self, cursor, end_date_min):
        path = self.path(cursor, end_date_min)
        if not path.exists():
            return None
        try:
            with gzip.open(path, 'rt', encoding='utf-8') as source:
                payload = json.load(source)
            if payload.get('version') != 1 or not isinstance(payload.get('rows'), list):
                raise ValueError('Invalid saved Gamma page')
            next_cursor = payload['next_cursor']
            if next_cursor is not None and not isinstance(next_cursor, str):
                raise ValueError('Invalid saved Gamma cursor')
            return payload['rows'], next_cursor
        except (OSError, EOFError, ValueError, KeyError, AttributeError):
            logging.getLogger(__name__).warning('Saved Gamma page is unreadable; refetching it')
            return None

    def write(self, cursor, end_date_min, rows, next_cursor):
        self.root.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(dir=self.root, suffix='.tmp')
        os.close(fd)
        try:
            with gzip.open(temporary, 'wt', encoding='utf-8', compresslevel=1) as target:
                json.dump({'version': 1, 'rows': rows, 'next_cursor': next_cursor}, target,
                          ensure_ascii=False, separators=(',', ':'))
            with open(temporary, 'rb') as target:
                os.fsync(target.fileno())
            os.replace(temporary, self.path(cursor, end_date_min))
            directory = os.open(self.root, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
