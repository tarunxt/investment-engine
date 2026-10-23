import tempfile
from pathlib import Path
import unittest
from scripts.public_launch.stage18_junit_gate import verify, REQUIRED_MODULES


class JunitGate(unittest.TestCase):
    def report(self):
        return '<testsuites><testsuite>'+''.join(
            f'<testcase classname="{module}" name="case_{n}" />'
            for module, count in REQUIRED_MODULES.items() for n in range(count))+'</testsuite></testsuites>'

    def run_report(self, data, sha='a'*40):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'tests.xml'; path.write_text(data)
            return verify(path, source_sha=sha)

    def test_complete_execution_receipt_is_not_full_acceptance(self):
        report = self.run_report(self.report())
        self.assertEqual(report['executed'], 17)
        self.assertFalse(report['full_release_verified'])
        self.assertFalse(report['browser_load_verified'])

    def test_actual_pytest_unittest_classnames_keep_module_identity(self):
        data = self.report().replace('test_stage18_migration_invariants"',
            'backend.tests.test_stage18_migration_invariants.MigrationInvariants"')
        self.assertEqual(self.run_report(data)['executed'], 17)

    def test_skips_xfail_failures_and_collection_errors_rejected(self):
        for child in ('skipped', 'failure', 'error'):
            with self.subTest(child=child), self.assertRaises(ValueError):
                self.run_report(self.report().replace('/>', f'><{child}/></testcase>', 1))

    def test_missing_or_duplicate_cases_and_wrong_source_rejected(self):
        for data in ('<testsuites/>', self.report().replace('case_1', 'case_0', 1)):
            with self.subTest(data=data), self.assertRaises(ValueError): self.run_report(data)
        with self.assertRaises(ValueError): self.run_report(self.report(), 'main')

    def test_required_module_cannot_be_replaced_by_other_checks(self):
        with self.assertRaises(ValueError):
            self.run_report(self.report().replace('test_stage18_queue_redis', 'unrelated_tests'))
