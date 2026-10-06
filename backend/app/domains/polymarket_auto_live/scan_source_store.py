"""Immutable scan source packs keep large Gamma payloads out of run JSON copies."""
from __future__ import annotations
import base64
import hashlib
import json
import os
import re
import zlib
import logging
from app.domains.polymarket_auto_live import source_reuse
from pathlib import Path
from uuid import uuid4
from collections import OrderedDict
from app.domains.polymarket_auto_live.source_storage import admit_source_write
from app.domains.trading_bots.storage_budget import StorageBudget, enabled as storage_budget_enabled

SOURCE_ROOT = Path(os.environ.get('BULLPEN_EXPORT_DIR', Path(__file__).resolve().parents[3] / '.stage-one-exports')) / 'scan-sources'
_REFERENCE = re.compile(r'^source-v1:([a-f0-9]{32}):(\d+):(\d+):([a-f0-9]{64})$')

class ScanSourceWriter:
    def __enter__(self):
        SOURCE_ROOT.mkdir(parents=True, exist_ok=True)
        self.identity = uuid4().hex
        self.path = SOURCE_ROOT / (self.identity + '.pack')
        self.budget = None
        if storage_budget_enabled():
            self.budget = StorageBudget(
                Path(os.environ.get('BULLPEN_STORAGE_RESERVATION_DIRECTORY') or SOURCE_ROOT.parent),
                identity=f'source-pack:{self.identity}',
            )
            self.budget.reserve(SOURCE_ROOT, 0)
        try:
            with admit_source_write(SOURCE_ROOT, 0):
                self.handle = self.path.open('x+b', buffering=0)
        except BaseException:
            if self.budget is not None:
                self.budget.release()
            raise
        self._write_failed = False
        self._sources = OrderedDict()
        self.bytes_written = 0
        self.bytes_reused = 0
        self.bytes_unreferenced = 0
        self.source_budget_bytes = 0
        self.pending_source_allocated = 0
        self.reuse_hints = source_reuse.SourceReuseHints(SOURCE_ROOT) if source_reuse.enabled() else None
        self.bytes_reused_cross_run = 0
        self.index_bytes_written = 0
        return self

    def store(self, row: dict) -> dict:
        if self._write_failed:
            raise OSError('Stage 1 source writer is failed; retry with a new immutable pack')
        value = row.get('scan_export_data')
        if not value or str(value).startswith('source-v1:'):
            return row
        data = base64.b64decode(value, validate=True)
        if len(data) > 32 * 1024 * 1024:
            raise ValueError('Stage 1 source row exceeds read limit')
        digest = hashlib.sha256(data).hexdigest()
        key = (digest, len(data))
        previous = self._sources.get(key)
        # Compare exact bytes as well as the digest. Keep the cache bounded;
        # eviction only reduces reuse and never invalidates a reference.
        if previous is not None:
            self.handle.seek(previous)
            identical = self.handle.read(len(data)) == data
            self.handle.seek(0, os.SEEK_END)
            if identical:
                self._sources.move_to_end(key)
                self.bytes_reused += len(data)
                row['scan_export_data'] = f'source-v1:{self.identity}:{previous}:{len(data)}:{digest}'
                if self.reuse_hints is not None:
                    self.reuse_hints.add(row['scan_export_data'])
                return row
        if self.reuse_hints is not None:
            for reference in self.reuse_hints.find(digest, len(data)):
                try:
                    identical = read_scan_source(reference) == data
                except (OSError, ValueError, OverflowError):
                    logging.getLogger(__name__).warning('Source reuse slice is missing/corrupt; writing a new immutable source instead')
                    continue
                if identical:
                    self.bytes_reused += len(data)
                    self.bytes_reused_cross_run += len(data)
                    row['scan_export_data'] = reference
                    self.reuse_hints.add(reference)
                    return row
        try:
            if self.budget is not None and self.source_budget_bytes < len(data):
                amount = max(len(data), 4 * 1024**2)
                self.budget.reserve(SOURCE_ROOT, amount)
                self.source_budget_bytes += amount
            with admit_source_write(SOURCE_ROOT, len(data)):
                self.handle.seek(0, os.SEEK_END)
                offset = self.handle.tell()
                # FileIO is unbuffered. Short/failed writes cannot retain bytes
                # that close(), seek() or context exit might flush later.
                written = self.handle.write(data)
                self.handle.flush()
                if written != len(data):
                    raise OSError('Stage 1 source write was incomplete')
            if self.budget is not None:
                self.source_budget_bytes -= len(data)
                self.pending_source_allocated += len(data)
                if self.pending_source_allocated >= 4 * 1024**2:
                    self.budget.consume(SOURCE_ROOT, self.pending_source_allocated)
                    self.pending_source_allocated = 0
        except BaseException:
            self._write_failed = True
            # Production handles are unbuffered. Also fail safely if a wrapper
            # retained bytes after a partial flush: close its raw descriptor
            # first, so wrapper finalization cannot flush the uncommitted tail.
            raw = getattr(self.handle, 'raw', None)
            if raw is not None:
                raw.close()
                try:
                    self.handle.close()
                except (OSError, ValueError):
                    pass  # raw descriptor is already closed; no writes possible
            else:
                self.handle.close()
            self.bytes_unreferenced = max(0, self.path.stat().st_size - self.bytes_written)
            raise
        self.bytes_written += len(data)
        self._sources[key] = offset
        if len(self._sources) > 4096:
            self._sources.popitem(last=False)
        row['scan_export_data'] = f'source-v1:{self.identity}:{offset}:{len(data)}:{digest}'
        if self.reuse_hints is not None:
            self.reuse_hints.add(row['scan_export_data'])
        return row

    def store_rejected(self, row: dict) -> dict:
        """Keep exhaustive text once on disk, not in every run JSON copy."""
        value = row.get('scan_export_data')
        if not value or str(value).startswith('source-v1:'):
            return self.store(row)
        fields = {key: row[key] for key in (
            'rules', 'event_description', 'market_context',
            'resolution_source', 'preflight_evidence_block',
        ) if isinstance(row.get(key), str) and row[key]}
        if not fields:
            return self.store(row)
        source = json.loads(zlib.decompress(base64.b64decode(value, validate=True)))
        source['candidate_text_fields_v1'] = fields
        compressed = zlib.compress(json.dumps(source, ensure_ascii=False,
                                             separators=(',', ':')).encode())
        compact = dict(row)
        compact['scan_export_data'] = base64.b64encode(compressed).decode('ascii')
        self.store(compact)
        for key in fields:
            compact[key] = None
        compact['scan_text_storage_version'] = 1
        return compact

    def __exit__(self, *args):
        # Finalize before any run snapshot is persisted with these references.
        try:
            try:
                # No final buffer flush: all data allocations occur under admission.
                if not self.handle.closed:
                    os.fsync(self.handle.fileno())
            finally:
                if not self.handle.closed:
                    self.handle.close()
            if self.reuse_hints is not None and not self._write_failed and (not args or args[0] is None):
                self.index_bytes_written = self.reuse_hints.publish(self.identity, admission=admit_source_write, budget=self.budget)
            logging.getLogger(__name__).info(
                'STAGE_ONE_SOURCE_STORAGE pack=%s written_bytes=%d reused_bytes=%d cross_run_reused_bytes=%d unreferenced_bytes=%d index_bytes=%d',
                self.identity, self.bytes_written, self.bytes_reused, self.bytes_reused_cross_run,
                self.bytes_unreferenced, self.index_bytes_written,
            )
            directory_fd = os.open(SOURCE_ROOT, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        finally:
            if self.budget is not None:
                self.budget.release()

    def store_market(self, market) -> None:
        """Retain cheap routing fields; preserve every original field on disk."""
        from app.domains.polymarket_auto_live.stage_one_excel import encode_scan_export_data
        raw = market.raw or {}
        stored = self.store({'scan_export_data': encode_scan_export_data(raw)})
        market.raw = {key: value for key, value in raw.items()
                      if value is None or isinstance(value, (str, int, float, bool))}
        market.raw['_scan_export_data'] = stored['scan_export_data']


def restore_market_raw(market) -> dict:
    raw = market.raw or {}
    if not raw.get('_scan_export_data'):
        return raw
    from app.domains.polymarket_auto_live.stage_one_excel import decode_scan_export_data
    source = decode_scan_export_data({'scan_export_data': raw['_scan_export_data']})
    return {**source['market'], '_export_event': source['event'], 'events': [source['event']]}


def read_scan_source(value: str) -> bytes:
    match = _REFERENCE.fullmatch(value)
    if not match:
        raise ValueError('Invalid Stage 1 source reference')
    identity, offset, size, digest = match.groups()
    length = int(size)
    if int(offset) > 2**63 - 1:
        raise ValueError("Stage 1 source offset exceeds filesystem read limit")
    if length > 32 * 1024 * 1024:
        raise ValueError('Stage 1 source row exceeds read limit')
    with (SOURCE_ROOT / (identity + '.pack')).open('rb') as source:
        source.seek(int(offset))
        data = source.read(length)
    if len(data) != length or hashlib.sha256(data).hexdigest() != digest:
        raise ValueError('Stage 1 source pack is incomplete or corrupted')
    return data
