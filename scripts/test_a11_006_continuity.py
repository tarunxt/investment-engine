"""Offline contract checks. No application imports, sockets or live receipts."""
import ast
from datetime import datetime, timezone
import json
from pathlib import Path
import unittest
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]


def classify_sample(*, enabled, expected, actual, terminal, skip_reason=None):
    """Synthetic evidence rule; not a production execution-health classifier."""
    if not enabled:
        return 'disabled', None
    if skip_reason:
        return 'skipped', None
    if expected is None or actual is None or terminal is None:
        return 'unknown', None
    return terminal, (actual - expected).total_seconds()


class ContinuityContractTests(unittest.TestCase):
    def test_all_source_schedules_reconciled_without_import(self):
        tree = ast.parse((ROOT / 'backend/app/infrastructure/messaging/celery_app.py').read_text())
        source = next(node.value for node in ast.walk(tree)
                      if isinstance(node, ast.Assign) and any(
                          ast.unparse(t) == 'celery.conf.beat_schedule' for t in node.targets))
        entries = {key.value: dict(zip((k.value for k in val.keys), val.values))
                   for key, val in zip(source.keys, source.values)}
        inventory = json.loads((ROOT / 'docs/operations/a11-006-inventory.json').read_text())
        self.assertEqual(len(entries), 16)
        self.assertEqual(set(entries), {r['workflow'] for r in inventory['workflows']})
        for row in inventory['workflows']:
            self.assertEqual(row['source_schedule'], ast.unparse(entries[row['workflow']]['schedule']))
            self.assertEqual(row['task'], ast.literal_eval(entries[row['workflow']]['task']))
            for field in ('owner', 'last_expected_start', 'last_actual_start', 'lag_seconds',
                          'execution_objective', 'objective_approval', 'evidence_window'):
                self.assertIsNone(row[field])
            self.assertEqual(row['terminal_outcome'], 'unknown')
        self.assertFalse(inventory['history_sample']['complete'])
        self.assertIsNone(inventory['history_sample']['total'])

    def test_ist_and_preserved_november_occurrence(self):
        local = datetime(2026, 11, 2, 6, tzinfo=ZoneInfo('Asia/Kolkata'))
        self.assertEqual(local.astimezone(timezone.utc).isoformat(), '2026-11-02T00:30:00+00:00')

    def test_us_dst_market_time_is_not_fixed_offset(self):
        for day, expected_hour in [('2026-03-06', 14), ('2026-03-09', 13),
                                   ('2026-10-30', 13), ('2026-11-02', 14)]:
            local = datetime.fromisoformat(day + 'T09:30:00').replace(tzinfo=ZoneInfo('America/New_York'))
            self.assertEqual(local.astimezone(timezone.utc).hour, expected_hour)
            self.assertEqual(local.astimezone(timezone.utc).minute, 30)

    def test_every_synthetic_obligation_has_explicit_outcome(self):
        expected = datetime(2026, 11, 2, tzinfo=timezone.utc)
        cases = [
            (dict(enabled=False, expected=expected, actual=None, terminal=None), ('disabled', None)),
            (dict(enabled=True, expected=expected, actual=None, terminal=None,
                  skip_reason='market_closed_weekend'), ('skipped', None)),
            (dict(enabled=True, expected=expected, actual=None, terminal=None), ('unknown', None)),
            (dict(enabled=True, expected=None, actual=expected, terminal='completed'), ('unknown', None)),
            (dict(enabled=True, expected=expected, actual=expected, terminal='completed'), ('completed', 0)),
        ]
        for sample, outcome in cases:
            with self.subTest(sample=sample):
                self.assertEqual(classify_sample(**sample), outcome)


if __name__ == '__main__':
    unittest.main()
