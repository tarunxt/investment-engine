import unittest

from app.domains.jobs.stage_status import aggregate_stage_status
from app.shared.types import JobStatus as S


class StageStatusTests(unittest.TestCase):
    def test_exact_aggregate_outcomes(self):
        for statuses, expected in [
            ([], S.FAILED),
            ([S.COMPLETED], S.COMPLETED),
            ([S.COMPLETED, S.COMPLETED], S.COMPLETED),
            ([S.COMPLETED, S.FAILED], S.PARTIAL),
            ([S.FAILED], S.FAILED),
            ([S.PARTIAL, S.FAILED], S.PARTIAL),
            ([S.COMPLETED, S.PARTIAL], S.PARTIAL),
            *[([S.COMPLETED, active], S.PROCESSING)
              for active in (S.PENDING, S.PROCESSING, S.SCHEDULED)],
        ]:
            with self.subTest(statuses=statuses):
                self.assertEqual(aggregate_stage_status(statuses), expected)
                self.assertEqual(aggregate_stage_status(reversed(statuses)), expected)
                self.assertEqual(aggregate_stage_status(statuses + statuses), expected)

    def test_interrupted_then_repeated_terminal_notifications(self):
        # An interrupted worker leaves persisted processing evidence unresolved.
        children = [S.COMPLETED, S.PROCESSING]
        self.assertEqual(aggregate_stage_status(children), S.PROCESSING)
        children[1] = S.FAILED
        for _ in range(3):
            self.assertEqual(aggregate_stage_status(children), S.PARTIAL)
            self.assertEqual(children, [S.COMPLETED, S.FAILED])

    def test_missing_unknown_and_output_quality_remain_distinct(self):
        self.assertEqual(aggregate_stage_status([None]), S.FAILED)
        self.assertEqual(aggregate_stage_status([S.COMPLETED, None]), S.PARTIAL)
        self.assertEqual(aggregate_stage_status([S.COMPLETED, 'unknown']), S.PARTIAL)
        # An explicitly partial child is never relabelled as a failed child.
        self.assertEqual(aggregate_stage_status([S.PARTIAL]), S.PARTIAL)
