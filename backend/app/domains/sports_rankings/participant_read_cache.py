"""Bounded reuse of passive Sports reads; never changes export selection policy."""
from __future__ import annotations

from collections import OrderedDict
import json
from pathlib import Path
from threading import Lock


MAX_CACHED_USERS = 8
MAX_CACHED_BYTES = 1024 * 1024
MAX_FINGERPRINT_FILES = 4096
_cache = OrderedDict()
_cache_lock = Lock()


def _stamp(path):
    try:
        stat = path.stat()
    except FileNotFoundError:
        return None
    return (stat.st_dev, stat.st_ino, stat.st_mode, stat.st_size,
            stat.st_mtime_ns, stat.st_ctime_ns)


def _export_fingerprint():
    # Import lazily: Universal Scan imports the participant index writer.
    from app.domains.trading_bots.universal_scan import _readable_export_directories

    directories = []
    seen = set()
    file_count = 0
    try:
        for directory in _readable_export_directories():
            directory = Path(directory).resolve()
            if directory in seen:
                continue
            seen.add(directory)
            before = _stamp(directory)
            files = []
            if before is not None:
                for path in directory.iterdir():
                    if path.suffix not in {".json", ".jsonl"}:
                        continue
                    file_count += 1
                    if file_count > MAX_FINGERPRINT_FILES:
                        # This bounds reuse bookkeeping, never source coverage.
                        return None
                    files.append((path.name, _stamp(path)))
                if _stamp(directory) != before:
                    return None
            directories.append((str(directory), before, tuple(sorted(files))))
    except OSError:
        # An incomplete fingerprint must never validate a cached result.
        return None
    return tuple(directories)


def _encode_for_cache(value):
    chunks = []
    size = 0
    encoder = json.JSONEncoder(ensure_ascii=False, separators=(",", ":"))
    for chunk in encoder.iterencode(value):
        if len(chunk) > MAX_CACHED_BYTES - size:
            return None
        encoded = chunk.encode("utf-8")
        size += len(encoded)
        if size > MAX_CACHED_BYTES:
            return None
        chunks.append(encoded)
    return b"".join(chunks)


def load_with_export_reuse(user_id, loader):
    """Revalidate every relevant file on every call, without a freshness TTL.

    Metadata/index changes (including an in-flight export completing), new
    exports, and JSONL availability/size changes all invalidate reuse. The
    existing resolver still makes every ownership and latest-export decision.
    Large or unstable file sets use the complete uncached read.
    """
    fingerprint = _export_fingerprint()
    if fingerprint is None:
        return loader(user_id)
    with _cache_lock:
        cached = _cache.get(user_id)
        if cached is not None and cached[0] == fingerprint:
            _cache.move_to_end(user_id)
            payload = cached[1]
        else:
            payload = None
    if payload is not None:
        # Store bounded bytes, not an unbounded decoded object graph. Each
        # caller gets its own complete index and cannot mutate future reads.
        return json.loads(payload)

    value = loader(user_id)
    payload = _encode_for_cache(value)
    if payload is not None and _export_fingerprint() == fingerprint:
        with _cache_lock:
            _cache[user_id] = (fingerprint, payload)
            _cache.move_to_end(user_id)
            while len(_cache) > MAX_CACHED_USERS:
                _cache.popitem(last=False)
    return value
