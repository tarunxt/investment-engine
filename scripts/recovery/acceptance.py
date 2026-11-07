"""Offline primitives only. No database, archive, filesystem or network adapters."""
from dataclasses import dataclass
from hashlib import sha256
from typing import Iterable, Mapping

VERSION = 'a11-005-v1'
COVERAGE = frozenset({'tables', 'schema', 'sequences', 'extensions', 'large_objects'})


@dataclass(frozen=True)
class Field:
    # Adapter supplies an explicit PostgreSQL type identifier and canonical bytes.
    type_id: bytes
    length: int | None  # None is SQL NULL; empty bytes is distinct.
    parts: Iterable[bytes]


def _frame(value: bytes) -> bytes:
    return len(value).to_bytes(8, 'big') + value


def row_digest(fields: Iterable[Field], *, max_piece_bytes: int = 65536,
               max_columns: int = 4096) -> bytes:
    """Hash one row with O(max_piece_bytes + bounded type metadata) memory.

    A producer must itself stream values; this helper cannot undo allocations by
    a driver. Length/type/column boundaries and NULLs are domain separated.
    """
    if max_piece_bytes < 1 or max_columns < 1:
        raise ValueError('invalid limits')
    digest = sha256(b'row:' + VERSION.encode())
    count = 0
    for field in fields:
        count += 1
        if count > max_columns or not isinstance(field.type_id, bytes) or not 0 < len(field.type_id) <= 256:
            raise ValueError('invalid column metadata')
        digest.update(_frame(field.type_id))
        if field.length is not None and (type(field.length) is not int or not 0 <= field.length < 2**64):
            raise ValueError('invalid field length')
        digest.update(b'N' if field.length is None else b'V' + field.length.to_bytes(8, 'big'))
        consumed = 0
        for part in field.parts:
            if not isinstance(part, bytes) or not 0 < len(part) <= max_piece_bytes:
                raise ValueError('invalid or oversized piece')
            consumed += len(part)
            if field.length is None or consumed > field.length:
                raise ValueError('field length mismatch')
            digest.update(part)
        if consumed != (field.length or 0):
            raise ValueError('field length mismatch')
    digest.update(b'end' + count.to_bytes(8, 'big'))
    return digest.digest()


@dataclass(frozen=True)
class TableDigest:
    count: int
    digest: str


def table_digest(ordered_row_digests: Iterable[bytes]) -> TableDigest:
    """Consume externally sorted fixed-size row hashes, retaining duplicates.

    Sorting by hash avoids collation, key uniqueness and NULL ordering ambiguity.
    The approved adapter must use bounded external sort, never list(all_rows).
    """
    digest = sha256(b'table:' + VERSION.encode())
    previous = b''
    count = 0
    for row in ordered_row_digests:
        if not isinstance(row, bytes) or len(row) != 32 or row < previous:
            raise ValueError('row digests must be sorted SHA256 values')
        digest.update(row)
        previous = row
        count += 1
    digest.update(count.to_bytes(8, 'big'))
    return TableDigest(count, digest.hexdigest())


@dataclass(frozen=True)
class Manifest:
    # Opaque private provenance attestations, never connection strings or names.
    snapshot: str
    archive_sha256: str
    snapshot_pair_attested: bool
    snapshot_lost: bool
    canonical_version: str
    coverage: frozenset[str]
    # Locally assigned opaque table IDs, including empty tables.
    tables: Mapping[str, TableDigest]
    # Exact schema, sequence state, extension and large-object evidence digests.
    metadata: Mapping[str, str]


def compare(left: Manifest, right: Manifest) -> str:
    """Return data/schema status only; never implies privilege/app recovery.

    Attestations must be checked against private receipts by the operator;
    matching caller-supplied strings alone are not provenance proof.
    """
    if (not left.snapshot or left.snapshot != right.snapshot
            or not left.snapshot_pair_attested or not right.snapshot_pair_attested
            or left.snapshot_lost or right.snapshot_lost):
        return 'unknown'
    if (len(left.archive_sha256) != 64 or any(c not in '0123456789abcdef' for c in left.archive_sha256)
            or left.archive_sha256 != right.archive_sha256):
        return 'unknown'
    if left.canonical_version != VERSION or right.canonical_version != VERSION:
        return 'error'
    if not all(COVERAGE <= m.coverage and COVERAGE - {'tables'} <= m.metadata.keys()
               and all(len(m.metadata[k]) == 64 and all(c in '0123456789abcdef' for c in m.metadata[k])
                       for k in COVERAGE - {'tables'}) for m in (left, right)):
        return 'partial'
    return 'pass' if left.tables == right.tables and left.metadata == right.metadata else 'error'


def recovery_status(dimensions: Mapping[str, str]) -> str:
    """Full contract cannot silently omit replay, privileges or application."""
    required = {'replay', 'data_schema', 'privileges', 'application'}
    if any(v not in {'pass', 'partial', 'error', 'unknown'} for v in dimensions.values()):
        raise ValueError('invalid status')
    values = [dimensions.get(k, 'unknown') for k in required]
    if 'error' in values:
        return 'error'
    if all(v == 'pass' for v in values):
        return 'pass'
    return 'partial' if any(v in {'pass', 'partial'} for v in values) else 'unknown'
