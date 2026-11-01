import tracemalloc
import unittest
from dataclasses import replace

from acceptance import (COVERAGE, VERSION, Field, Manifest, compare, recovery_status,
                        row_digest, table_digest)


def field(value, tag=b'pg_catalog.text'):
    return Field(tag, None if value is None else len(value), [] if not value else [value])


class AcceptanceTests(unittest.TestCase):
    def test_canonical_boundaries_types_null_duplicates_and_order(self):
        variants = [[field(None)], [field(b'')], [field(b'null')],
                    [field(b'ab'), field(b'c')], [field(b'a'), field(b'bc')],
                    [field(b'ab', b'pg_catalog.bytea')]]
        hashes = [row_digest(row) for row in variants]
        self.assertEqual(len(set(hashes)), len(hashes))
        self.assertNotEqual(table_digest(sorted(hashes)), table_digest(sorted(hashes + hashes)))
        with self.assertRaises(ValueError):
            table_digest(sorted(hashes, reverse=True))

    def test_chunk_invariance_large_value_and_bounded_memory(self):
        size = 32 * 1024 * 1024
        roots = []
        for chunk in (1024, 65536):
            tracemalloc.start()
            value = Field(b'pg_catalog.bytea', size,
                          (b'x' * min(chunk, size - i) for i in range(0, size, chunk)))
            roots.append(row_digest([value]))
            _, peak = tracemalloc.get_traced_memory()
            tracemalloc.stop()
            self.assertLess(peak, 512 * 1024)
        self.assertEqual(*roots)
        tracemalloc.start()
        result = table_digest(b'x' * 32 for _ in range(200000))
        _, peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()
        self.assertEqual(result.count, 200000)
        self.assertLess(peak, 512 * 1024)

    def test_bad_lengths_and_limits_fail_closed(self):
        for value in (Field(b't', 2, [b'x']), Field(b't', None, [b'x']),
                      Field(b't', 1, [b'xx']), Field(b't', -1, [])):
            with self.assertRaises(ValueError):
                row_digest([value])
        with self.assertRaises(ValueError):
            row_digest([field(b'xx')], max_piece_bytes=1)

    def test_provenance_coverage_versions_and_differences(self):
        original = Manifest('synthetic-pair', 'a' * 64, True, False, VERSION,
                            COVERAGE, {'opaque-1': table_digest([])},
                            {k: 'b' * 64 for k in COVERAGE - {'tables'}})
        self.assertEqual(compare(original, original), 'pass')
        for changes in ({'snapshot': 'later'}, {'snapshot_lost': True},
                        {'snapshot_pair_attested': False}, {'archive_sha256': 'c' * 64}):
            self.assertEqual(compare(original, replace(original, **changes)), 'unknown')
        self.assertEqual(compare(original, replace(original, coverage=frozenset())), 'partial')
        self.assertEqual(compare(original, replace(original, metadata={})), 'partial')
        self.assertEqual(compare(original, replace(original, canonical_version='other')), 'error')
        self.assertEqual(compare(original, replace(original, tables={})), 'error')

    def test_recovery_dimensions_remain_independent(self):
        self.assertEqual(recovery_status({}), 'unknown')
        self.assertEqual(recovery_status({'replay': 'pass', 'data_schema': 'unknown'}), 'partial')
        self.assertEqual(recovery_status(dict.fromkeys(
            ('replay', 'data_schema', 'privileges', 'application'), 'pass')), 'pass')
        self.assertEqual(recovery_status({'application': 'error'}), 'error')
        with self.assertRaises(ValueError):
            recovery_status({'replay': 'done'})


if __name__ == '__main__':
    unittest.main()
