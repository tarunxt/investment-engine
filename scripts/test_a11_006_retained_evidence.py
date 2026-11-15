"""Synthetic only: no private receipt embedded in these tests."""
import unittest
from a11_006_retained_evidence import reconcile


class RetainedEvidenceTests(unittest.TestCase):
    def test_overlap_and_status_do_not_create_obligations(self):
        row = {'market': 'synthetic', 'run_id': 1, 'workflow_status_displayed': 'COMPLETED',
               'workflow_started_at_utc_derived': '2026-01-01T00:00:00Z',
               'workflow_finished_at_utc_derived': None}
        result = reconcile({'validation_input': {'records': [row]},
                            'older_workflow_observations': [row]})
        self.assertEqual(result['primary_unique_market_run_keys'], 1)
        self.assertEqual(result['older_rows_overlapping_primary'], 1)
        self.assertEqual(result['observation_rows_total'], 2)
        self.assertEqual(result['schedule_obligation_linkage']['unknown_rows'], 1)
        self.assertIsNone(result['schedule_obligation_linkage']['missed_obligation_count'])
        self.assertIsNone(result['schedule_obligation_linkage']['execution_duration'])
        self.assertEqual(result['execution_terminal_verification'].split(';')[0], 'unknown')
        self.assertFalse(result['population_complete'])

    def test_bad_or_naive_timestamp_stays_unknown(self):
        for value in ['Not recorded', '2026-01-01T00:00:00', None]:
            row = {'market': 'synthetic', 'run_id': 1, 'workflow_started_at_utc_derived': value}
            result = reconcile({'validation_input': {'records': [row]}})
            self.assertEqual(result['timestamp_field_coverage']['workflow_started_at_utc_derived_unknown'], 1)

    def test_missing_key_or_excess_rows_rejected(self):
        with self.assertRaises(ValueError):
            reconcile({'validation_input': {'records': [{}]}})
        with self.assertRaises(ValueError):
            reconcile({'validation_input': {'records': [{}] * 1001}})


if __name__ == '__main__':
    unittest.main()
