from datetime import date, datetime, timezone, timedelta
from decimal import Decimal, localcontext
from hashlib import sha256
import tracemalloc
import unittest
from uuid import UUID
from acceptance import COVERAGE, VERSION, Manifest, compare, row_digest, table_digest
from dataclasses import replace
import scalar_codecs as codec
from streams import merge_runs, object_manifest


def digest(kind, value):
    return row_digest([codec.scalar(kind, value)])


class CodecStreamTests(unittest.TestCase):
    def test_representative_scalar_types(self):
        values = [('text', 'é'), ('bytea', b'\0\xff'), ('int2', -32768),
                  ('int4', 2147483647), ('int8', -(2**63)), ('bool', True),
                  ('date', date(2026, 11, 1)), ('timestamp', datetime(2026, 11, 1)),
                  ('uuid', UUID(int=123))]
        for kind, value in values:
            self.assertEqual(digest(kind, value), digest(kind, value))
            self.assertNotEqual(digest(kind, value), digest(kind, None))
        self.assertNotEqual(digest('text', 'é'), digest('text', 'e\u0301'))
        self.assertNotEqual(digest('float8', -0.0), digest('float8', 0.0))
        self.assertEqual(digest('float8', float('nan')), digest('float8', float('nan')))
        self.assertNotEqual(digest('float8', float('inf')), digest('float8', -float('inf')))
        utc = datetime(2026, 11, 1, tzinfo=timezone.utc)
        self.assertEqual(digest('timestamptz', utc), digest('timestamptz', utc.astimezone(timezone(timedelta(hours=5)))))

    def test_numeric_context_independence_and_fail_closed(self):
        with localcontext() as context:
            context.prec = 2
            self.assertEqual(digest('numeric', Decimal('123456.7800')), digest('numeric', Decimal('123456.78')))
        self.assertEqual(digest('numeric', Decimal('-0.000')), digest('numeric', Decimal('0')))
        for kind, value in [('jsonb', {}), ('int2', 32768), ('int4', True),
                            ('timestamp', datetime.now(timezone.utc)),
                            ('timestamptz', datetime(2026, 1, 1)), ('text', '\0'),
                            ('bytea', b'x' * 65537)]:
            with self.assertRaises(ValueError):
                codec.scalar(kind, value)

    def test_bounded_merge_comparison_chunk_invariance_and_changes(self):
        # Fixture sorting is tiny; actual comparison consumes streams only.
        hashes = sorted(digest('int4', i) for i in range(20))
        baseline = table_digest(iter(hashes))
        for chunk in (1, 3, 20):
            runs = [iter(hashes[i:i+chunk]) for i in range(0, len(hashes), chunk)]
            self.assertEqual(table_digest(merge_runs(runs)), baseline)
        self.assertNotEqual(table_digest(merge_runs([hashes, hashes])), baseline)
        with self.assertRaises(ValueError):
            list(merge_runs([list(reversed(hashes))]))
        with self.assertRaises(ValueError):
            list(merge_runs([[]] * 33))
        for run in ([None], [b'x' * 32, None]):
            with self.assertRaises(ValueError):
                list(merge_runs([run]))
        tracemalloc.start()
        result = table_digest(merge_runs([(b'x'*32 for _ in range(100000)) for _ in range(4)]))
        peak = tracemalloc.get_traced_memory()[1]
        tracemalloc.stop()
        self.assertEqual(result.count, 400000)
        self.assertLess(peak, 512 * 1024)

    def test_complete_synthetic_adapter_pair_and_historical_rejection(self):
        rows = [[codec.scalar('int4', i), codec.scalar('text', 'fixture')]
                for i in range(10)]
        hashes = sorted(row_digest(row) for row in rows)
        metadata = {kind: object_manifest(
            kind, [], pg_major=18, migration_digest=b'm'*32,
            sequence_capture_attested=True)[1] for kind in COVERAGE - {'tables'}}
        left = Manifest('synthetic-pair-only', 'a'*64, True, False, VERSION,
                        COVERAGE, {'opaque-table': table_digest(hashes)}, metadata)
        right = replace(left, tables={'opaque-table': table_digest(merge_runs(
            [hashes[:3], hashes[3:7], hashes[7:]]))})
        self.assertEqual(compare(left, right), 'pass')
        self.assertEqual(compare(left, replace(right, tables={
            'opaque-table': table_digest(hashes[:-1])})), 'error')
        self.assertEqual(compare(left, replace(right, metadata=metadata | {
            'schema': 'b'*64})), 'error')
        self.assertEqual(compare(left, replace(right, snapshot_lost=True)), 'unknown')

    def test_schema_sequence_extension_object_inventories(self):
        migration = sha256(b'synthetic-migration').digest()
        objects = [(b'object-1', sha256(b'synthetic-definition').digest())]
        for kind in ('schema', 'sequences', 'extensions', 'large_objects'):
            kwargs = dict(pg_major=18, migration_digest=migration, sequence_capture_attested=True)
            baseline = object_manifest(kind, objects, **kwargs)
            self.assertEqual(baseline, object_manifest(kind, iter(objects), **kwargs))
            self.assertNotEqual(baseline, object_manifest(kind, [], **kwargs))
            self.assertNotEqual(baseline, object_manifest(kind, [(b'object-1', b'x'*32)], **kwargs))
            self.assertNotEqual(baseline, object_manifest(kind, objects, **(kwargs | {'pg_major': 17})))
            with self.assertRaises(ValueError):
                object_manifest(kind, objects + objects, **kwargs)
        with self.assertRaises(ValueError):
            object_manifest('sequences', [], pg_major=18, migration_digest=migration)
