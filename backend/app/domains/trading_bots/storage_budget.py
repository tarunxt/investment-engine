"""Opt-in cross-process/cross-language filesystem allocation reservations.

Claims represent unallocated bytes. Actual bytes are flushed before consumption.
Every claim survives a crash and remains pinned until its owner explicitly releases
it. Unknown/stale claims are reported, never automatically expired/reaped.
"""
from __future__ import annotations

import fcntl
import json
import os
import shutil
from pathlib import Path
from uuid import uuid4

RESERVE_BYTES = 2 * 1024**3
MAX_LEDGER_BYTES = 8 * 1024**2


def enabled() -> bool:
    return os.environ.get('BULLPEN_STORAGE_RESERVATIONS') == '1'


def _available(path: Path) -> int:
    stats = os.statvfs(path)
    return min(shutil.disk_usage(path).free, stats.f_bavail * stats.f_frsize)


class StorageBudget:
    def __init__(self, root: Path, *, identity: str, token: str | None = None):
        self.root = Path(root) / '.storage-admission'
        self.identity = identity
        self.token = token or uuid4().hex
        self.path = self.root / 'claims.json'

    def _change(self, operation, *, persist=True):
        self.root.mkdir(parents=True, exist_ok=True)
        with (self.root / 'ledger.lock').open('a+b') as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            try:
                if self.path.exists():
                    if self.path.stat().st_size > MAX_LEDGER_BYTES:
                        raise OSError('UPS_STORAGE_CAPACITY: Reservation ledger exceeds safe read limit; all unknown claims remain pinned.')
                    ledger = json.loads(self.path.read_text())
                    if not isinstance(ledger, dict) or ledger.get('version') != 1 or not isinstance(ledger.get('claims'), dict):
                        raise ValueError('Invalid reservation ledger')
                    for key, claim in ledger['claims'].items():
                        if not isinstance(key, str) or not isinstance(claim, dict) or not isinstance(claim.get('pending'), dict):
                            raise ValueError('Invalid reservation claim')
                        if any(not isinstance(device, str) or type(size) is not int or size < 0 for device, size in claim['pending'].items()):
                            raise ValueError('Invalid reservation bytes')
                else:
                    ledger = {'version': 1, 'claims': {}}
                result = operation(ledger)
                if not persist:
                    return result
                serialized = json.dumps(ledger, separators=(',', ':'))
                if len(serialized.encode()) > MAX_LEDGER_BYTES:
                    raise OSError('UPS_STORAGE_CAPACITY: Too many unresolved reservation claims.')
                temporary = self.path.with_name(f'.claims.{uuid4().hex}.tmp')
                try:
                    with temporary.open('x') as handle:
                        handle.write(serialized)
                        handle.flush()
                        os.fsync(handle.fileno())
                    os.replace(temporary, self.path)
                    descriptor = os.open(self.root, os.O_RDONLY)
                    try:
                        os.fsync(descriptor)
                    finally:
                        os.close(descriptor)
                finally:
                    temporary.unlink(missing_ok=True)
                return result
            except (json.JSONDecodeError, ValueError) as exc:
                raise OSError('UPS_STORAGE_CAPACITY: Invalid reservation metadata; unknown claims are pinned and admission is blocked.') from exc
            finally:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)

    def reserve_many(self, requests: list[tuple[Path, int]]) -> None:
        devices = {}
        for target, size in requests:
            if type(size) is not int or size < 0:
                raise ValueError('Invalid reservation size')
            target = Path(target)
            device = str(target.stat().st_dev)
            value = devices.setdefault(device, [target, 0])
            value[1] += size
        def operation(ledger):
            existing = ledger['claims'].get(self.token)
            if existing and existing.get('identity') != self.identity:
                raise ValueError('Reservation ownership mismatch')
            for device, (target, requested) in devices.items():
                held = sum(claim['pending'].get(device, 0) for claim in ledger['claims'].values())
                if _available(target) < held + requested + RESERVE_BYTES:
                    raise OSError('UPS_STORAGE_CAPACITY: Concurrent capture reservations and recovery overhead exceed available storage. No existing export was deleted.')
            claim = ledger['claims'].setdefault(self.token, {'identity': self.identity, 'pid': os.getpid(), 'pending': {}})
            for device, (_, requested) in devices.items():
                claim['pending'][device] = claim['pending'].get(device, 0) + requested
        self._change(operation)

    def reserve(self, target: Path, size: int) -> None:
        self.reserve_many([(target, size)])

    def consume(self, target: Path, size: int) -> None:
        if type(size) is not int or size < 0:
            raise ValueError('Invalid consumed size')
        device = str(Path(target).stat().st_dev)
        def operation(ledger):
            claim = ledger['claims'].get(self.token)
            if not claim or claim.get('identity') != self.identity or claim['pending'].get(device, 0) < size:
                raise ValueError('Reservation consumption exceeds owned claim')
            claim['pending'][device] -= size
        self._change(operation)

    def release(self) -> None:
        def operation(ledger):
            claim = ledger['claims'].get(self.token)
            if claim and claim.get('identity') != self.identity:
                raise ValueError('Reservation ownership mismatch')
            ledger['claims'].pop(self.token, None)
        self._change(operation)

    def snapshot(self) -> dict:
        def operation(ledger):
            return {'version': 1, 'claims': ledger['claims'], 'unknownClaimsPinned': True,
                    'automaticReaping': False, 'deletionEnabled': False}
        if not self.path.exists():
            return {"version": 1, "claims": {}, "unknownClaimsPinned": True, "automaticReaping": False, "deletionEnabled": False}
        return self._change(operation, persist=False)


class ReservedFile:
    """Unbuffered streaming allocation for gzip/ZIP temporary outputs.

    Chunked reservations conservatively keep already allocated bytes claimed until
    the next checkpoint. No pending buffer can allocate data on finalization.
    """
    def __init__(self, handle, budget: StorageBudget, target: Path):
        self.handle, self.budget, self.target = handle, budget, Path(target)
        self.credit = self.allocated = 0
        self.failed = False

    def __getattr__(self, name):
        return getattr(self.handle, name)

    def write(self, value):
        if self.failed:
            raise OSError('Storage writer is failed')
        needed = max(0, self.handle.tell() + len(value) - os.fstat(self.handle.fileno()).st_size)
        try:
            if self.credit < needed:
                amount = max(needed, 4 * 1024**2)
                self.budget.reserve(self.target, amount)
                self.credit += amount
            written = self.handle.write(value)
            if written != len(value):
                raise OSError('Storage writer returned a short write')
            self.credit -= needed
            self.allocated += needed
            if self.allocated >= 4 * 1024**2:
                self.budget.consume(self.target, self.allocated)
                self.allocated = 0
            return written
        except BaseException:
            self.failed = True
            self.handle.close()
            raise
