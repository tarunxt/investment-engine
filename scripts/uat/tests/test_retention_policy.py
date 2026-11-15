from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from retention_policy import Artifact, Registry, Priority, admission


class RetentionTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 10, 15, tzinfo=timezone.utc)
        self.registry = Registry()
        self.a = Artifact('cache', 'uat-synthetic', 'synthetic-owner', 'scan', 'run-1',
                          'page_cache', 'synthetic fixture', 'fixture-v1',
                          self.now - timedelta(days=5), allocated_bytes=4096)
        self.a.finalized_at = self.now - timedelta(days=4)
        self.a.terminal = self.a.writer_released = True
        self.a.external_references = 0
        self.a.queue_checked_at = self.a.references_checked_at = self.now
        self.a.sha256 = 'a' * 64
        self.a.recovery = 'APPROXIMATE_REFETCH'
        self.a.disposal_allowed = True
        self.registry.register(self.a)

    def result(self):
        return self.registry.evaluate('cache', self.now)

    def test_expiry_is_never_physical_authorization(self):
        self.assertTrue(self.result()['candidate'])
        self.assertFalse(self.result()['physical_purge_authorized'])

    def test_shared_reference_blocks_until_all_consumers_are_reconciled(self):
        for name in ['audit', 'download']:
            self.registry.register(Artifact(name, 'uat-synthetic', 'owner', 'wf', 'run',
                                           'user_result', 'fixture', 'v1', self.now))
            self.registry.reference(name, 'cache')
        self.assertEqual(self.result()['reference_count'], 2)
        self.assertFalse(self.result()['candidate'])

    def test_retry_and_missing_writer_evidence_block(self):
        self.a.terminal = False
        self.assertFalse(self.result()['candidate'])
        self.a.terminal = True
        self.a.leases.add('retry-lease')
        self.assertFalse(self.result()['candidate'])

    def test_holds_and_success_pin_override_expiry(self):
        self.a.holds.add('audit-hold')
        self.assertFalse(self.result()['candidate'])
        self.a.holds.clear()
        self.a.latest_success_pin = True
        self.assertFalse(self.result()['candidate'])

    def test_missing_stale_future_and_unknown_reference_evidence_block(self):
        for stamp in [None, self.now-timedelta(minutes=6), self.now+timedelta(seconds=1)]:
            self.a.queue_checked_at = stamp
            self.assertFalse(self.result()['candidate'])
        self.a.queue_checked_at = self.now
        self.a.external_references = None
        self.assertFalse(self.result()['candidate'])

    def test_access_extends_retention_and_boundary_is_explicit(self):
        self.a.last_access_at = self.now - timedelta(hours=72) + timedelta(seconds=1)
        self.assertFalse(self.result()['candidate'])
        self.a.last_access_at -= timedelta(seconds=1)
        self.assertTrue(self.result()['candidate'])

    def test_unknown_and_immutable_types_cannot_be_downgraded(self):
        for kind in ['unknown-new-type', 'immutable_capture', 'source_pack', 'operational_state']:
            self.a.kind = kind
            self.a.priority = Priority.LOW
            self.assertFalse(self.result()['candidate'])

    def test_refetch_is_not_exact_recovery(self):
        self.a.disposal_allowed = False
        self.assertFalse(self.result()['candidate'])
        self.a.recovery = 'EXACT_COPY_VERIFIED'
        self.a.exact_copy_digest = 'b' * 64
        self.a.recovery_verified_at = self.now
        self.assertFalse(self.result()['candidate'])
        self.a.exact_copy_digest = self.a.sha256
        self.assertTrue(self.result()['candidate'])

    def test_creation_rejects_production_and_missing_provenance(self):
        for env, provenance in [('production', 'fixture'), ('uat-synthetic', '')]:
            with self.assertRaises(ValueError):
                Artifact('id', env, 'owner', 'wf', 'run', 'page_cache', provenance, 'v1', self.now)

    def test_race_requires_fresh_evaluation(self):
        before = self.result()
        self.assertTrue(before['candidate'])
        self.a.leases.add('new-reader')
        self.assertFalse(self.result()['candidate'])
        self.assertFalse(before['physical_purge_authorized'])

    def test_reserves_include_peak_allocation(self):
        gib = 1024**3
        self.assertFalse(admission(11*gib, 2*gib)['admit'])
        self.assertTrue(admission(16*gib, gib)['admit'])
        self.assertFalse(admission(None, gib)['admit'])
        self.assertFalse(admission(5*gib, 1, optional=False)['admit'])


if __name__ == '__main__':
    unittest.main()
