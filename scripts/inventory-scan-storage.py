#!/usr/bin/env python3
"""Read-only, fail-closed inventory. All reference closures are unknown and pinned.
Explicit nonsymlink directory roots only. No sockets/devices/FIFOs are opened.
Whole-file duplicate observations never imply safe reclaimable bytes.
"""
import argparse
import hashlib
import json
import os
import stat
from pathlib import Path


def inventory(roots, *, max_files=100_000, max_total_bytes=128 * 1024**3):
    files, unknown, errors, seen = [], [], [], set()
    observed_bytes = 0
    budget_exhausted = False
    if max_files < 0 or max_total_bytes < 0:
        raise ValueError("Inventory limits must be non-negative")
    def pin(path, reason):
        entry = {'path': str(path), 'pinned': True, 'reason': reason}
        unknown.append(entry)
        errors.append({'path': str(path), 'error': reason})
    def walk_error(error):
        pin(error.filename or '<unknown directory>', f'unreadable directory: {error}')
    for root in roots:
        root = Path(root)
        if budget_exhausted:
            pin(root, "inventory resource limit reached; entire remaining root pinned")
            continue
        try:
            details = root.lstat()
        except OSError as exc:
            pin(root, f'root unavailable: {exc}')
            continue
        if stat.S_ISLNK(details.st_mode):
            pin(root, 'symlink root pinned; not followed')
            continue
        if not stat.S_ISDIR(details.st_mode):
            pin(root, 'root is not a directory; not opened')
            continue
        # Reject symlink ancestors too. A symlink directory supplied as part of
        # a longer root path must not bypass the no-follow root policy.
        try:
            if any(stat.S_ISLNK(parent.lstat().st_mode) for parent in root.absolute().parents):
                pin(root, 'symlink ancestor pinned; root not followed')
                continue
        except OSError as exc:
            pin(root, f'root ancestor unavailable: {exc}')
            continue
        for directory, dirs, names in os.walk(root, followlinks=False, onerror=walk_error):
            if budget_exhausted:
                pin(directory, 'inventory resource limit reached; remaining subtree pinned')
                break
            retained = []
            for name in sorted(dirs):
                path = Path(directory) / name
                try:
                    mode = path.lstat().st_mode
                    if stat.S_ISLNK(mode):
                        pin(path, 'symlink directory pinned; not followed')
                    elif stat.S_ISDIR(mode):
                        retained.append(name)
                    else:
                        pin(path, 'directory entry changed type; not followed')
                except OSError as exc:
                    pin(path, f'directory unavailable: {exc}')
            dirs[:] = retained
            for name in sorted(names):
                path = Path(directory) / name
                canonical = str(path.absolute())
                if canonical in seen:
                    continue
                seen.add(canonical)
                descriptor = None
                try:
                    before = path.lstat()
                    if len(seen) > max_files or observed_bytes + before.st_size > max_total_bytes:
                        pin(path, 'inventory resource limit reached; remaining traversal pinned')
                        budget_exhausted = True
                        break
                    if not stat.S_ISREG(before.st_mode):
                        pin(path, 'symlink or special file pinned; not opened')
                        continue
                    # O_NONBLOCK also prevents a raced replacement by a FIFO
                    # from hanging inventory. fstat verifies the opened type.
                    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                    opened = os.fstat(descriptor)
                    if not stat.S_ISREG(opened.st_mode) or (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
                        raise ValueError('file replaced or changed type before inventory')
                    digest = hashlib.sha256()
                    with os.fdopen(descriptor, 'rb') as handle:
                        descriptor = None
                        for block in iter(lambda: handle.read(1024 * 1024), b''):
                            digest.update(block)
                        after = os.fstat(handle.fileno())
                    current = path.lstat()
                    identity = lambda item: (item.st_dev, item.st_ino, item.st_size, item.st_mtime_ns, item.st_ctime_ns)
                    if identity(before) != identity(after) or identity(after) != identity(current):
                        raise ValueError('changed during inventory')
                    observed_bytes += after.st_size
                    files.append({'path': str(path), 'bytes': after.st_size,
                                  'allocatedBytes': after.st_blocks * 512,
                                  'device': after.st_dev, 'inode': after.st_ino,
                                  'sha256': digest.hexdigest(), 'pinned': True,
                                  'reason': 'authoritative run/database/retry reference closure unavailable'})
                except (OSError, ValueError) as exc:
                    pin(path, f'file unavailable or uncertain: {exc}')
                finally:
                    if descriptor is not None:
                        os.close(descriptor)
    groups = {}
    for item in files:
        groups.setdefault((item['bytes'], item['sha256']), []).append(item['path'])
    return {'dryRun': True, 'deletionEnabled': False, 'referenceClosureComplete': False,
            'safeReclaimableBytes': None, 'resourceLimitReached': budget_exhausted, 'files': files, 'unknownPinned': unknown, 'errors': errors,
            'exactWholeFileDuplicateGroups': [paths for paths in groups.values() if len(paths) > 1]}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('roots', nargs='+')
    parser.add_argument('--max-files', type=int, default=100_000)
    parser.add_argument('--max-total-bytes', type=int, default=128 * 1024**3)
    args = parser.parse_args()
    print(json.dumps(inventory(args.roots, max_files=args.max_files, max_total_bytes=args.max_total_bytes), indent=2))
