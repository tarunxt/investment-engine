"""Bounded fan-in of pre-sorted hash streams and opaque object inventories."""
import heapq
from hashlib import sha256
from acceptance import row_digest, Field


def merge_runs(runs, *, max_runs=32):
    """Merge at most max_runs sorted iterables, without retaining row payloads.

    Does not create sorted runs. Production external sorting/storage is gated.
    Each run is independently checked; duplicates remain present.
    """
    if not 1 <= max_runs <= 32:
        raise ValueError('fan-in limit')
    exhausted = object()
    iterators = []
    heap = []
    for run in runs:
        if len(iterators) >= max_runs:
            raise ValueError('too many runs')
        iterator = iter(run)
        index = len(iterators)
        iterators.append(iterator)
        first = next(iterator, exhausted)
        if first is not exhausted:
            if not isinstance(first, bytes) or len(first) != 32:
                raise ValueError('invalid row digest')
            heapq.heappush(heap, (first, index))
    while heap:
        value, index = heapq.heappop(heap)
        yield value
        following = next(iterators[index], exhausted)
        if following is not exhausted:
            if not isinstance(following, bytes) or len(following) != 32 or following < value:
                raise ValueError('invalid sorted run')
            heapq.heappush(heap, (following, index))


def object_manifest(kind, objects, *, pg_major, migration_digest,
                    sequence_capture_attested=False):
    """Hash a sorted opaque-ID inventory plus already canonical object hashes.

    For schema: definition hashes; sequences: full state/config hashes;
    extensions: version/config hashes; large_objects: streamed content hashes.
    Empty inventory is positively captured. Names and privileges are not output.
    """
    if kind not in {'schema', 'sequences', 'extensions', 'large_objects'}:
        raise ValueError('unsupported inventory')
    if type(pg_major) is not int or pg_major < 1:
        raise ValueError('invalid PG version')
    if not isinstance(migration_digest, bytes) or len(migration_digest) != 32:
        raise ValueError('invalid migration digest')
    if kind == 'sequences' and not sequence_capture_attested:
        raise ValueError('sequence state is not frozen by MVCC')
    root = sha256(('objects-v1:' + kind + ':' + str(pg_major)).encode('ascii'))
    root.update(migration_digest)
    previous = b''
    count = 0
    for opaque_id, digest in objects:
        if (not isinstance(opaque_id, bytes) or not 0 < len(opaque_id) <= 256
                or opaque_id <= previous or not isinstance(digest, bytes) or len(digest) != 32):
            raise ValueError('invalid sorted object inventory')
        root.update(row_digest([Field(b'opaque-id', len(opaque_id), [opaque_id]),
                                Field(b'object-hash', 32, [digest])]))
        previous = opaque_id
        count += 1
    root.update(count.to_bytes(8, 'big'))
    return count, root.hexdigest()
