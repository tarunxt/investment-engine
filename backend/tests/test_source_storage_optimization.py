"""Dependency-free regression checks: python -m unittest discover -s tests -p test_source_storage_optimization.py."""
import base64
import errno
import io
from contextlib import contextmanager
import multiprocessing
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from app.domains.polymarket_auto_live import scan_source_store as store
from app.domains.polymarket_auto_live.stage_one_excel import encode_scan_export_data, decode_scan_export_data
from app.domains.polymarket_auto_live.source_storage import admit_source_write


def hold_lock(directory, entered):
    with admit_source_write(Path(directory), 1, reserve_bytes=0):
        entered.set()
        multiprocessing.Event().wait(30)


def lock_attempt(directory, ready, entered):
    ready.set()
    with admit_source_write(Path(directory), 1, reserve_bytes=0):
        entered.set()


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.patch = patch.object(store, 'SOURCE_ROOT', self.root)
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        self.temp.cleanup()

    def row(self, identity='42'):
        return {'scan_export_data': encode_scan_export_data({'id': identity, 'active': False, 'rules': 'x' * 10000, '_export_event': {'id': '7'}})}

    def test_shared_reference_and_historical_roundtrip_after_restart(self):
        original = self.row()
        expected = decode_scan_export_data(original)
        first, second, different = self.row(), self.row(), self.row('43')
        with store.ScanSourceWriter() as writer:
            writer.store(first)
            writer.store(second)
            writer.store(different)
            self.assertEqual(first, second)
            self.assertNotEqual(first, different)
            self.assertGreater(writer.bytes_reused, 0)
            self.assertEqual(writer.path.stat().st_size, writer.bytes_written)
        # A new writer does not alter or reuse old pack offsets.
        with store.ScanSourceWriter() as writer:
            writer.store(self.row())
        self.assertEqual(decode_scan_export_data(first), expected)
        self.assertEqual(decode_scan_export_data(original), expected)
        self.assertFalse(list(self.root.glob('*.json')))

    def test_digest_collision_does_not_reuse_different_bytes(self):
        class ConstantDigest:
            def hexdigest(self):
                return '0' * 64
        first = {'scan_export_data': base64.b64encode(b'aaaa').decode()}
        second = {'scan_export_data': base64.b64encode(b'bbbb').decode()}
        with patch.object(store.hashlib, 'sha256', return_value=ConstantDigest()):
            with store.ScanSourceWriter() as writer:
                writer.store(first)
                writer.store(second)
                self.assertNotEqual(first, second)
                self.assertEqual(writer.bytes_written, 8)
                self.assertEqual(writer.bytes_reused, 0)

    def test_full_disk_leaves_input_and_old_payload_intact(self):
        first, blocked = self.row(), self.row('43')
        with store.ScanSourceWriter() as writer:
            writer.store(first)
            before = writer.path.stat().st_size
            with patch('app.domains.polymarket_auto_live.source_storage.shutil.disk_usage') as usage:
                usage.return_value.free = 0
                writer.store(self.row())  # duplicate needs no additional allocation
                with self.assertRaisesRegex(OSError, 'STORAGE_CAPACITY'):
                    writer.store(blocked)
                with self.assertRaisesRegex(OSError, 'writer is failed'):
                    writer.store(self.row())
            self.assertEqual(writer.path.stat().st_size, before)
            self.assertFalse(blocked['scan_export_data'].startswith('source-v1:'))
        self.assertEqual(decode_scan_export_data(first)['market']['id'], '42')

    def test_corruption_and_missing_pack_fail_closed(self):
        row = self.row()
        with store.ScanSourceWriter() as writer:
            writer.store(row)
        writer.path.write_bytes(b'broken')
        with self.assertRaisesRegex(ValueError, 'corrupted'):
            decode_scan_export_data(row)
        writer.path.unlink()
        with self.assertRaises(FileNotFoundError):
            decode_scan_export_data(row)
        with self.assertRaises(ValueError):
            store.read_scan_source('source-v1:../../secret:0:1:bad')

    def test_failed_flush_closes_handle(self):
        writer = store.ScanSourceWriter().__enter__()
        with patch('app.domains.polymarket_auto_live.scan_source_store.os.fsync', side_effect=OSError('disk full')):
            with self.assertRaises(OSError):
                writer.__exit__(None, None, None)
        self.assertTrue(writer.handle.closed)

    def test_rejected_text_fields_roundtrip(self):
        row = {**self.row(), 'rules': 'exhaustive rules', 'market_context': 'context'}
        with store.ScanSourceWriter() as writer:
            saved = writer.store_rejected(row)
            again = writer.store_rejected(row)
            self.assertEqual(saved['scan_export_data'], again['scan_export_data'])
        self.assertIsNone(saved['rules'])
        self.assertEqual(decode_scan_export_data(saved)['candidate_text_fields_v1']['rules'], 'exhaustive rules')

    def test_buffered_partial_flush_failure_never_writes_tail_on_exit(self):
        state = {'locked': False, 'armed': False, 'calls': 0, 'writes': []}
        @contextmanager
        def guard(*args, **kwargs):
            state['locked'] = True
            try:
                yield
            finally:
                state['locked'] = False
        class FaultyRaw(io.FileIO):
            def write(self, value):
                if state['armed']:
                    state['calls'] += 1
                    if state['calls'] == 2:
                        raise OSError(errno.ENOSPC, 'disk full')
                    if state['calls'] == 1:
                        value = value[:len(value) // 2]
                state['writes'].append((len(value), state['locked']))
                return super().write(value)
        writer = store.ScanSourceWriter().__enter__()
        writer.handle.close()
        writer.handle = io.BufferedRandom(FaultyRaw(writer.path, 'r+'), buffer_size=8192)
        first = {'scan_export_data': base64.b64encode(b'original').decode()}
        failed = {'scan_export_data': base64.b64encode(b'a' * 1000).decode()}
        with patch.object(store, 'admit_source_write', guard):
            writer.store(first)
            state['armed'] = True
            with self.assertRaises(OSError):
                writer.store(failed)
            partial_size = writer.path.stat().st_size
            writer.__exit__(None, None, None)
        self.assertEqual(partial_size, 508)
        self.assertEqual(writer.path.stat().st_size, partial_size)
        self.assertTrue(all(locked for _, locked in state['writes']))
        self.assertEqual(writer.bytes_unreferenced, 500)
        self.assertFalse(failed['scan_export_data'].startswith('source-v1:'))
        self.assertEqual(store.read_scan_source(first['scan_export_data']), b'original')
        self.assertTrue(writer.handle.closed)

    def test_unbuffered_short_write_poisoning_keeps_input_and_prior_reference(self):
        writer = store.ScanSourceWriter().__enter__()
        self.assertIsInstance(writer.handle, io.FileIO)
        first = self.row()
        writer.store(first)
        original = writer.handle
        class ShortWrite:
            def __getattr__(self, name):
                return getattr(original, name)
            def write(self, value):
                return original.write(value[:len(value) // 2])
        writer.handle = ShortWrite()
        failed = self.row('short')
        with self.assertRaisesRegex(OSError, 'incomplete'):
            writer.store(failed)
        size = writer.path.stat().st_size
        writer.__exit__(None, None, None)
        self.assertEqual(writer.path.stat().st_size, size)
        self.assertEqual(decode_scan_export_data(first)['market']['id'], '42')
        self.assertFalse(failed['scan_export_data'].startswith('source-v1:'))
        with self.assertRaisesRegex(OSError, 'writer is failed'):
            writer.store(self.row())

    def test_admission_before_creating_pack(self):
        with patch('app.domains.polymarket_auto_live.source_storage.shutil.disk_usage') as usage:
            usage.return_value.free = 0
            with self.assertRaisesRegex(OSError, 'STORAGE_CAPACITY'):
                store.ScanSourceWriter().__enter__()
        self.assertEqual(list(self.root.glob('*.pack')), [])

    def test_lock_released_after_process_termination(self):
        context = multiprocessing.get_context('spawn')
        entered = context.Event()
        process = context.Process(target=hold_lock, args=(str(self.root), entered))
        process.start()
        try:
            self.assertTrue(entered.wait(10))
        finally:
            process.terminate()
            process.join(10)
        ready, acquired = context.Event(), context.Event()
        successor = context.Process(target=lock_attempt, args=(str(self.root), ready, acquired))
        successor.start()
        try:
            self.assertTrue(acquired.wait(10))
        finally:
            successor.join(10)
            if successor.is_alive():
                successor.terminate()
                successor.join(10)
        self.assertEqual(successor.exitcode, 0)

    def test_cache_eviction_never_invalidates_old_references(self):
        first = self.row()
        with store.ScanSourceWriter() as writer:
            writer.store(first)
            for number in range(4100):
                writer.store({'scan_export_data': base64.b64encode(str(number).encode()).decode()})
            self.assertEqual(len(writer._sources), 4096)
            again = self.row()
            writer.store(again)
            self.assertNotEqual(first, again)
        self.assertEqual(decode_scan_export_data(first), decode_scan_export_data(again))

    def test_process_writers_serialize_and_release_after_exit(self):
        context = multiprocessing.get_context('spawn')
        ready, entered = context.Event(), context.Event()
        with admit_source_write(self.root, 1, reserve_bytes=0):
            process = context.Process(target=lock_attempt, args=(str(self.root), ready, entered))
            process.start()
            self.assertTrue(ready.wait(10))
            self.assertFalse(entered.wait(.2))
        self.assertTrue(entered.wait(10))
        process.join(10)
        self.assertEqual(process.exitcode, 0)


if __name__ == '__main__':
    unittest.main()
