import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('candidates', ROOT / 'scripts/uat/render_candidates.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CapacityGateTests(unittest.TestCase):
    def fixture(self):
        # Synthetic numbers to test validation, NOT host sizing recommendations.
        data = {key: 10 for key in module.NUMERIC_FIELDS}
        data.update(representative_periods_reviewed=True,
                    evidence_reference='synthetic unit test', io_device='8:1',
                    memory_high_bytes=100, memory_max_bytes=200,
                    redis_maxmemory_bytes=20)
        return data

    def test_missing_evidence_cannot_render(self):
        for patch in ({'representative_periods_reviewed': False}, {'evidence_reference': ''}):
            with self.assertRaises(ValueError):
                module.validate(self.fixture() | patch)

    def test_no_missing_zero_negative_bool_or_injected_budgets(self):
        for key in module.NUMERIC_FIELDS:
            for bad in (None, 0, -1, True, '100\nExecStart=/bin/true'):
                with self.subTest(key=key, bad=bad), self.assertRaises(ValueError):
                    module.validate(self.fixture() | {key: bad})

    def test_unsafe_memory_and_device_rejected(self):
        for patch in ({'memory_max_bytes': 100}, {'redis_maxmemory_bytes': 100},
                      {'io_device': '8:1\nCPUQuota=1000%'}):
            with self.assertRaises(ValueError):
                module.validate(self.fixture() | patch)

    def test_outputs_candidates_only_and_never_overwrites(self):
        with tempfile.TemporaryDirectory() as tmp:
            destination = Path(tmp) / 'candidates'
            module.render(self.fixture(), destination)
            files = list(destination.iterdir())
            self.assertEqual(len(files), 5)
            self.assertTrue(all(p.name.endswith('.candidate') for p in files))
            self.assertTrue(all('${' not in p.read_text() for p in files))
            with self.assertRaises(FileExistsError):
                module.render(self.fixture(), destination)


if __name__ == '__main__':
    unittest.main()
