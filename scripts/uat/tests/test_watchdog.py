import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import watchdog
import test_candidates


class WatchdogTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.manifest = Path(self.tmp.name) / 'limits.json'
        self.limits = test_candidates.CapacityGateTests().fixture()
        self.manifest.write_text(json.dumps(self.limits))
        self.metrics = {'memory': {'MemAvailable_bytes': 100},
                        'disk_free_bytes': 100, 'inodes_free': 100,
                        'pressure': {r: 'some avg10=0.00 avg60=0.00 avg300=0.00 total=0'
                                     for r in ('cpu', 'memory', 'io')}}
        self.run = Mock(return_value=Mock(returncode=0))

    def check(self, enforce=True):
        return watchdog.check(self.manifest, '/unused', enforce=enforce,
                              sample_fn=lambda _: self.metrics, run=self.run)

    def test_healthy_never_calls_systemctl(self):
        self.assertEqual(self.check()['status'], 'healthy')
        self.run.assert_not_called()

    def test_boundary_stops_only_fixed_uat_units(self):
        self.metrics['disk_free_bytes'] = 10
        self.assertEqual(self.check()['status'], 'stopped')
        command = self.run.call_args.args[0]
        self.assertEqual(command[:2], ['/usr/bin/systemctl', 'stop'])
        self.assertTrue(all(name.startswith('credx-uat-') for name in command[2:]))

    def test_dry_run_never_stops(self):
        self.metrics['inodes_free'] = 0
        self.assertEqual(self.check(False)['status'], 'would_stop')
        self.run.assert_not_called()

    def test_missing_config_fails_safe(self):
        self.manifest.unlink()
        self.assertEqual(self.check()['status'], 'stopped')

    def test_invalid_or_high_pressure_stops(self):
        for value in ('UNAVAILABLE', 'some avg10=nan', 'some avg10=10.0'):
            self.metrics['pressure']['cpu'] = value
            self.assertEqual(self.check()['status'], 'stopped')

    def test_failed_stop_is_not_reported_as_success(self):
        self.metrics['disk_free_bytes'] = 0
        self.run.return_value.returncode = 1
        self.assertEqual(self.check()['status'], 'stop_failed')


if __name__ == '__main__':
    unittest.main()
