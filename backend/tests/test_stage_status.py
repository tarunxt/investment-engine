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
