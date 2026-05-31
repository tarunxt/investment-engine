import os
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://test:test@localhost:5432/testdb",
)
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

from app.domains.google_sheets import tasks as google_sheets_tasks
from app.shared.types import JobStatus


PARTIAL_COMPLETE_RESPONSE = """
| GPT-4o | NSE | HAL | Hindustan Aeronautics Ltd | Flag breakout on daily chart, strong volume accumulation | 4800-4850 | 4600 | 5500 | Institutional Research Desk | 3 | 4825 | 14475 | 13.99 | 8 | 87 | Defence order momentum remains strong | Breakout above consolidation range with strong volume | Multi-quarter uptrend remains intact | Order book visibility supports near-term momentum | Defence capex cycle remains favorable | Tight setup with positive price-volume expansion | 1 | 2026-05-31 | 09:30 IST | GPT-4o |
| GPT-4o | NSE | IREDA | Indian Renewable Energy Dev Ag | Ascending triangle breakout, high relative strength | 175-180 | 165 | 210 | Momentum Screener | 80 | 177 | 14160 | 18.64 | 7 | 84 | Renewable financing theme remains strong | Fresh breakout above resistance with volume confirmation | Higher highs and higher lows structure intact | Funding pipeline remains supportive short term | Energy transition tailwinds remain strong | Momentum remains intact with room for follow-through | 2 | 2026-05-31 | 09:30 IST | GPT-4o |
| GPT-4o | NSE | LT | Larsen & Toubro Ltd | Inverse Head & Shoulders breakout, volume expansion | 3550-3600 | 3400 | 4000 | Brokerage Upgrade | 4 | 3575 | 14300 | 11.89 | 9 | 83 | Infra execution and order inflows remain supportive | Base breakout supported by rising volumes | Primary uptrend remains healthy | Execution momentum supports near-term upside | Capex cycle and order visibility remain strong | Clean reversal setup with strong institutional participation | 3 | 2026-05-31 | 09:30 IST | GPT-4o |
| GPT-4o | NSE | TATAMOTORS | Tata Motors Ltd | Channel breakout, positive divergence | 970-980 | 920 | 1100 | CNBC Interview | 7 | 975 | 6825 | 12.82 | 8 | 81 | JLR sentiment and domestic PV strength supportive | Breakout from rising channel with improving momentum | Weekly trend remains constructive | Near-term demand indicators remain healthy | EV optionality and JLR recovery remain long-term tailwinds | Momentum setup remains favorable into the next swing leg | 4 | 2026-05-31 | 09:30 IST | GPT-4o |
"""


class FakeScalarResult:
    def __init__(self, scalar=None, scalars=None):
        self._scalar = scalar
        self._scalars = list(scalars or [])

    def scalar_one_or_none(self):
        return self._scalar

    def scalars(self):
        return self

    def all(self):
        return list(self._scalars)


class FakeDB:
    def __init__(self, results):
        self._results = list(results)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def execute(self, _stmt):
        if not self._results:
            raise AssertionError("Unexpected execute() call")
        return self._results.pop(0)


class FakeJobRepo:
    def __init__(self, job):
        self.job = job

    def update_export_state(
        self,
        job,
        *,
        export_status,
        export_error=None,
        exported_at=None,
        exported_sheet_url=None,
    ):
        job.export_status = export_status
        job.export_error = export_error
        job.exported_at = exported_at
        job.exported_sheet_url = exported_sheet_url


class FakeRunRepo:
    def __init__(self, run):
        self.run = run

    def get(self, _run_id):
        return self.run

    def update_export_state(
        self,
        run,
        *,
        export_status,
        export_error=None,
        exported_at=None,
        exported_sheet_url=None,
    ):
        run.export_status = export_status
        run.export_error = export_error
        run.exported_at = exported_at
        run.exported_sheet_url = exported_sheet_url


class GoogleSheetsTaskTests(unittest.TestCase):
    @patch("app.domains.jobs.tasks._refresh_run_status")
    @patch("app.domains.jobs.tasks._publish_job_update")
    @patch.object(google_sheets_tasks._svc, "append_sheet", return_value=("Ideas", 321))
    @patch.object(google_sheets_tasks._svc, "extract_spreadsheet_id", return_value="sheet123")
    @patch("app.domains.google_sheets.tasks.decrypt_token", return_value="token")
    @patch("app.domains.google_sheets.tasks.SyncRunRepository")
    @patch("app.domains.google_sheets.tasks.SyncJobRepository")
    @patch("app.domains.google_sheets.tasks.SyncSessionLocal")
    def test_export_job_to_sheets_allows_failed_partial_stock_output(
        self,
        sync_session_local_mock,
        sync_job_repo_cls_mock,
        sync_run_repo_cls_mock,
        _decrypt_token_mock,
        _extract_spreadsheet_id_mock,
        append_sheet_mock,
        _publish_job_update_mock,
        _refresh_run_status_mock,
    ):
        cred = SimpleNamespace(access_token_enc="enc", refresh_token_enc=None)
        job = SimpleNamespace(
            id=77,
            user_id=5,
            status=JobStatus.FAILED,
            response=PARTIAL_COMPLETE_RESPONSE,
            error_message="gemini/gemini-2.5-flash returned insufficient recommendations (expected 5, got 4)",
            export_status=None,
            export_error=None,
            exported_at=None,
            exported_sheet_url=None,
            provider="gemini",
            model="gemini-2.5-flash",
        )
        fake_db = FakeDB([
            FakeScalarResult(scalar=cred),
            FakeScalarResult(scalar=job),
        ])

        sync_session_local_mock.return_value = fake_db
        sync_job_repo_cls_mock.return_value = FakeJobRepo(job)
        sync_run_repo_cls_mock.return_value = MagicMock()

        result = google_sheets_tasks.export_job_to_sheets_task.run(
            5,
            77,
            "https://docs.google.com/spreadsheets/d/sheet123/edit",
            "Ideas",
            "Export",
            "INR 50,000",
        )

        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["stocks_count"], 4)
        self.assertEqual(job.export_status, "completed")
        self.assertIsNone(job.export_error)
        self.assertIn("https://docs.google.com/spreadsheets/d/sheet123/edit#gid=321", job.exported_sheet_url)
        self.assertEqual(len(append_sheet_mock.call_args.args[4]), 4)

    @patch.object(google_sheets_tasks._svc, "append_sheet", return_value=("Ideas", 654))
    @patch.object(google_sheets_tasks._svc, "extract_spreadsheet_id", return_value="sheet999")
    @patch("app.domains.google_sheets.tasks.decrypt_token", return_value="token")
    @patch("app.domains.google_sheets.tasks.SyncRunRepository")
    @patch("app.domains.google_sheets.tasks.SyncSessionLocal")
    def test_export_run_to_sheets_includes_failed_partial_stock_jobs(
        self,
        sync_session_local_mock,
        sync_run_repo_cls_mock,
        _decrypt_token_mock,
        _extract_spreadsheet_id_mock,
        append_sheet_mock,
    ):
        cred = SimpleNamespace(access_token_enc="enc", refresh_token_enc=None)
        partial_job = SimpleNamespace(
            id=88,
            status=JobStatus.FAILED,
            response=PARTIAL_COMPLETE_RESPONSE,
            error_message="gemini/gemini-2.5-flash returned insufficient recommendations (expected 5, got 4)",
            provider="gemini",
            model="gemini-2.5-flash",
        )
        malformed_job = SimpleNamespace(
            id=89,
            status=JobStatus.FAILED,
            response="| header | only |",
            error_message="gemini/gemini-2.5-flash returned malformed table output (no data rows)",
            provider="gemini",
            model="gemini-2.5-flash",
        )
        run = SimpleNamespace(
            id=12,
            user_id=5,
            created_at=datetime(2026, 5, 31, 4, 0, 0, tzinfo=timezone.utc),
            export_status=None,
            export_error=None,
            exported_at=None,
            exported_sheet_url=None,
        )
        fake_db = FakeDB([
            FakeScalarResult(scalar=cred),
            FakeScalarResult(scalar=run),
            FakeScalarResult(scalars=[
                SimpleNamespace(stage=1, job=partial_job),
                SimpleNamespace(stage=1, job=malformed_job),
            ]),
        ])

        sync_session_local_mock.return_value = fake_db
        sync_run_repo_cls_mock.return_value = FakeRunRepo(run)

        result = google_sheets_tasks.export_run_to_sheets_task.run(
            5,
            12,
            "https://docs.google.com/spreadsheets/d/sheet999/edit",
            "Ideas",
            "Export",
            "INR 50,000",
        )

        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["stocks_count"], 4)
        self.assertEqual(run.export_status, "completed")
        self.assertIsNone(run.export_error)
        self.assertIn("https://docs.google.com/spreadsheets/d/sheet999/edit#gid=654", run.exported_sheet_url)
        self.assertEqual(len(append_sheet_mock.call_args.args[4]), 4)


if __name__ == "__main__":
    unittest.main()
