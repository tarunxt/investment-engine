from types import SimpleNamespace
from zipfile import ZipFile

import pytest

from app.domains.polymarket_auto_live.stage_one_excel import (
    StageOneExcelExportError,
    build_stage_one_excel,
    remove_export,
)


def _run_with_candidates(*, accepted: list[dict], rejected: list[dict], scanned: int):
    return SimpleNamespace(
        started_at="2026-09-04T11:36:07+05:30",
        completed_at="2026-09-04T11:36:08+05:30",
        stage_results=[
            SimpleNamespace(
                stage_number=1,
                outputs={
                    "workflow_stage_key": "scan",
                    "accepted_candidates": accepted,
                    "rejected_candidates": rejected,
                    "scanned_candidates": scanned,
                },
            )
        ],
    )


def test_stage_one_excel_exports_more_than_the_old_1000_row_projection():
    accepted = [
        {
            "question_id": f"q-{index}",
            "market_id": f"m-{index}",
            "question": f"Accepted market {index}",
        }
        for index in range(501)
    ]
    rejected = [
        {
            "question_id": f"q-{index}",
            "market_id": f"m-{index}",
            "question": f"Rejected market {index}",
            "reasons": ["volume below threshold"],
        }
        for index in range(501, 1_501)
    ]
    run = _run_with_candidates(accepted=accepted, rejected=rejected, scanned=1_501)

    path, filename, row_count = build_stage_one_excel(run)  # type: ignore[arg-type]
    try:
        assert filename == "bullpen-stage-1-all-scanned-events-2026-09-04T06-06-08Z.xlsx"
        assert row_count == 1_501
        with ZipFile(path) as workbook:
            assert workbook.testzip() is None
            sheet = workbook.read("xl/worksheets/sheet1.xml").decode("utf-8")
        assert sheet.count('<row r="') == 1_502
        assert '<autoFilter ref="A1:AE1502"/>' in sheet
        assert "Accepted market 0" in sheet
        assert "Rejected market 1500" in sheet
        assert ">passed<" in sheet
        assert ">filtered<" in sheet
    finally:
        remove_export(path)


def test_stage_one_excel_refuses_a_truncated_run_snapshot():
    run = _run_with_candidates(
        accepted=[{"question_id": "q-1"}],
        rejected=[],
        scanned=95_586,
    )

    with pytest.raises(StageOneExcelExportError, match="1 detailed rows.*95,586 scanned events"):
        build_stage_one_excel(run)  # type: ignore[arg-type]
