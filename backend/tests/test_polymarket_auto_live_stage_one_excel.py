from types import SimpleNamespace
from zipfile import ZipFile

import pytest

from app.domains.polymarket_auto_live.stage_one_excel import (
    StageOneExcelExportError,
    EXCEL_HEADERS,
    encode_scan_export_data,
    _column_name,
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
        assert f'<autoFilter ref="A1:{_column_name(len(EXCEL_HEADERS) + 3)}1502"/>' in sheet
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


@pytest.mark.parametrize("scope,expected", [("all-scanned", 2), ("filtered", 1)])
def test_exhaustive_schema_and_raw_values_for_both_exports(scope, expected):
    import json
    from pathlib import Path
    from xml.etree import ElementTree as ET
    raw = {"id": "001234", "volume24hr": 123.45, "active": False,
           "outcomes": ["Yes", "No"], "newApiField": "kept",
           "_export_event": {"id": "event-1", "countryName": "India", "tags": [{"label": "Macro"}]}}
    rows = [{"market_id": "001234", "question": "Example", "scan_export_data": encode_scan_export_data(raw)}]
    run = _run_with_candidates(accepted=rows, rejected=[{**rows[0], "market_id": "rejected"}], scanned=2)
    path, _, count = build_stage_one_excel(run, scope)
    try:
        assert count == expected
        with ZipFile(path) as workbook:
            root = ET.fromstring(workbook.read("xl/worksheets/sheet1.xml"))
        ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
        xmlrows = root.findall("m:sheetData/m:row", ns)
        headers = ["".join(cell.itertext()) for cell in xmlrows[0]]
        assert headers[:len(EXCEL_HEADERS)] == list(EXCEL_HEADERS)
        assert len(EXCEL_HEADERS) == 220
        assert "market.newApiField" in headers
        cells = {cell.attrib["r"]: "".join(cell.itertext()) for cell in xmlrows[1]}
        for header, value in [("market.id", "001234"), ("market.volume24hr", "123.45"), ("event.countryName", "India"), ("market.newApiField", "kept")]:
            assert cells[f"{_column_name(headers.index(header)+1)}2"] == value
        frontend_schema = Path(__file__).resolve().parents[2] / "frontend/lib/bullpenStageOneExcelColumns.json"
        assert json.loads(frontend_schema.read_text()) == list(EXCEL_HEADERS)
    finally:
        remove_export(path)


def test_export_enrichment_preserves_frozen_odds_and_fills_source_fields(monkeypatch):
    from app.domains.polymarket_auto_live.stage_one_export_enrichment import enrich_export_rows
    from app.domains.polymarket_auto_live.stage_one_excel import decode_scan_export_data, _row_values
    class Response:
        def raise_for_status(self): pass
        def json(self):
            return [{"id": "123", "volume": "456", "bestBid": 0.42,
                     "events": [{"id": "e1", "description": "Event rules"}]}]
    class Client:
        def __init__(self, **kwargs): pass
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def get(self, url, params):
            assert ("id", "123") in params
            return Response()
    monkeypatch.setattr("app.domains.polymarket_auto_live.stage_one_export_enrichment.httpx.Client", Client)
    row = {"market_id": "123", "current_yes_odds": 90}
    enrich_export_rows([row])
    assert decode_scan_export_data(row)["market"]["volume"] == "456"
    assert row["current_yes_odds"] == 90
    values = dict(zip(EXCEL_HEADERS, _row_values(row, 1, "passed")))
    assert values["Volume (USD)"] == "456"
    assert values["Best Bid (cents)"] == 42
    assert "export time" in row["export_metadata"]["source"]
