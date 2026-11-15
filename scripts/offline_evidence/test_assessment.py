import unittest
from assessment import comparable, distribution, timeline, reuse_eligibility, CONDITIONS


class EvidenceTests(unittest.TestCase):
    def test_distribution_excludes_unknown_and_tiny_percentile(self):
        result = distribution([1, 3, None, -1, float('nan'), True])
        self.assertEqual((result['count'], result['excluded'], result['median'], result['p95']), (2, 4, 2, None))
        self.assertEqual(distribution(list(range(20)))['p95'], 18)
        self.assertEqual(distribution([])['status'], 'Not measured')

    def test_comparison_requires_all_conditions(self):
        a = dict.fromkeys(CONDITIONS, 'synthetic')
        b = dict(a, source_sha='candidate')
        self.assertTrue(comparable(a, b)['comparable'])
        b['cache_state'] = 'warm'
        self.assertFalse(comparable(a, b)['comparable'])
        del b['cpu']
        self.assertIn('cpu', comparable(a, b)['missing'])

    def test_explicit_timeline_leaves_residual_unknown(self):
        run = dict(run_id='synthetic-continuation', attempt_id='attempt-2', run_kind='continuation',
                   queued=0, started=10, attempt_started=20, attempt_finished=40,
                   finished=50, observed=60, rendered=65)
        result = timeline(run)
        self.assertEqual(result['known_union_ms'], 45)
        self.assertEqual(result['unattributed_ms'], 20)
        self.assertEqual(result['hidden_sdk_retries'], 'unknown')
        run['attempt_finished'] = 19
        self.assertIn('provider', timeline(run)['exclusions'])
        run['started'] = None
        self.assertNotIn('queue', timeline(run)['intervals'])

    def test_missing_identity_and_skipped_stages(self):
        self.assertEqual(len(timeline({})['exclusions']), 4)
        result = timeline(dict(run_id='interrupted', queued=0, started=3, reused_or_skipped=['queue']))
        self.assertEqual(result['exclusions']['queue'], 'reused or skipped')
        self.assertIsNone(result['unattributed_ms'])

    def test_cache_review_isolation_freshness_and_independence(self):
        saved = dict(owner='synthetic-owner', evidence_digest='digest', data_cutoff='window',
                     schema='v1', model='unchanged-model', expires_ms=100)
        requested = dict(saved, independent_sample=False)
        self.assertTrue(reuse_eligibility(saved, requested, 99)['eligible_for_review'])
        for key in ('owner', 'evidence_digest', 'data_cutoff', 'schema', 'model'):
            self.assertFalse(reuse_eligibility(saved, dict(requested, **{key: 'changed'}), 99)['eligible_for_review'])
        self.assertFalse(reuse_eligibility(saved, requested, 100)['eligible_for_review'])
        self.assertFalse(reuse_eligibility(saved, dict(requested, independent_sample=True), 99)['eligible_for_review'])
        self.assertFalse(reuse_eligibility(saved, requested, 99)['live_reuse_authorized'])


if __name__ == '__main__':
    unittest.main()
