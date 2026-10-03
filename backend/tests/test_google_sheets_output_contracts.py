"""Offline task-to-Sheets boundary checks; every external dependency is mocked."""

import json
from contextlib import ExitStack
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from app.domains.google_sheets import tasks
from app.domains.jobs.output_contracts import REBALANCE_COLUMNS, SWING_COLUMNS, parse_markdown
from app.domains.jobs.output_contracts.document import encode_cell
from app.domains.jobs.output_runtime import current_output_context


NOW = datetime(2026, 10, 2, 9, 30, tzinfo=timezone.utc)


def stock(symbol, **overrides):
    row = {column.key: f"Supplied {symbol} {column.key}" for column in SWING_COLUMNS}
    row.update({column.key: 0 for column in SWING_COLUMNS if column.key.startswith("score_rationale_")})
    row.update(llm_name_model="Original model", exchange_symbol="NSE", stock_symbol=symbol,
               stock_name=f"Company {symbol}", entry_range="100-105", stop_loss=95, target=120,
               units_to_buy=2, price_per_unit=100, total_buy_amount=200, upside_horizon=20,
               weeks=8, confidence_score=80, run_number=0, run_date="2026-10-01",
               run_time="12:34:56", llm="Original source model")
    row.update(overrides)
    return row


def markdown(columns, rows):
    return "\n".join([
        "| " + " | ".join(column.label for column in columns) + " |",
        "| " + " | ".join("---" for _ in columns) + " |",
        *("| " + " | ".join(encode_cell(row[column.key]) for column in columns) + " |" for row in rows),
    ])


def job(response, *, job_id=77, count=5, prompt=None, **overrides):
    values = dict(id=job_id, user_id=5, status="completed", response=response, error_message=None,
                  provider="provider", model="model", created_at=NOW,
                  prompt=prompt or (
                      f"India swing trading. Choose exactly {count} unique stocks.\n\n"
                      + "| " + " | ".join(column.label for column in SWING_COLUMNS) + " |"
                  ))
    values.update(overrides)
    return SimpleNamespace(**values)


class Result:
    def __init__(self, value):
        self.value = value

    def scalar_one_or_none(self):
        return self.value

    def scalars(self):
        return self

    def all(self):
        return self.value


def export_job(source):
    """Execute the actual Celery task with fake storage and a captured append."""
    with ExitStack() as stack:
        session = stack.enter_context(patch.object(tasks, "SyncSessionLocal"))
        db = session.return_value.__enter__.return_value
        db.execute.side_effect = [Result(SimpleNamespace(access_token_enc="unused", refresh_token_enc=None)), Result(source)]
        repository = stack.enter_context(patch.object(tasks, "SyncJobRepository"))
        stack.enter_context(patch.object(tasks, "SyncRunRepository"))
        stack.enter_context(patch.object(tasks, "decrypt_token", return_value="mocked"))
        stack.enter_context(patch("app.domains.jobs.tasks._publish_job_update"))
        stack.enter_context(patch("app.domains.jobs.tasks._refresh_run_status"))
        stack.enter_context(patch.object(tasks._svc, "extract_spreadsheet_id", return_value="offline"))
        append = stack.enter_context(patch.object(tasks._svc, "append_sheet", return_value=(0, 1)))
        legacy = stack.enter_context(patch.object(tasks, "parse_complete_stock_recommendations", side_effect=AssertionError("Canonical export used legacy parser")))
        result = tasks.export_job_to_sheets_task.run(5, source.id, "https://docs.google.com/spreadsheets/d/offline/edit")
        return result, append, repository, legacy


def sheet_rows(headers, rows, first_label="LLM Name + Model"):
    """Read ordered table sections from the actual append payload."""
    active = headers
    found = []
    for row in rows:
        if row and row[0] == first_label and "Stock Symbol" in row:
            active = row
        elif len(row) == len(active) and "Stock Symbol" in active:
            found.append(dict(zip(active, row)))
    return found


def test_sixty_rows_five_tables_ancillary_prose_and_all_rationales_reach_sheet():
    fragments = []
    for chunk in range(5):
        records = [stock(f"STOCK{i}") for i in range(chunk * 12, (chunk + 1) * 12)]
        fragments.append(f"## Independent block {chunk}\nContext {chunk}.\n\n" + markdown(SWING_COLUMNS, records) + f"\n\nCaveat {chunk}.\n")
    content = "\n".join(fragments) + "\n| Source | Limitation |\n| --- | --- |\n| A | Stale date |\n| B | Dissent |\n"
    parsed, findings = parse_markdown(content)
    assert not findings
    assert sum(len(block.rows) for block in parsed) == 62
    source = job(content, count=60)
    result, append, _, legacy = export_job(source)
    assert result["status"] == "completed"
    assert result["stocks_count"] == 60
    assert append.call_count == 1
    legacy.assert_not_called()
    headers, rows = append.call_args.args[3:5]
    assert headers[:31] == [column.label for column in SWING_COLUMNS]
    exported = sheet_rows(headers, rows)
    assert len(exported) == 60
    assert {row["Stock Symbol"] for row in exported} == {f"STOCK{i}" for i in range(60)}
    for index, row in enumerate(exported):
        for column in SWING_COLUMNS:
            assert row[column.label] == str(stock(f"STOCK{index}")[column.key])
        assert row["Export Job ID"] == source.id
        assert row["Source Row"] == index % 12 + 1
        assert isinstance(row["Source Line"], int)
    assert len({row["Source Fragment"] for row in exported}) == 5
    for name in ["Run #", "Run Date", "Run Time", "LLM"]:
        assert headers.count(name) == 1
    for chunk in range(5):
        assert any(f"Context {chunk}." in str(cell) for row in rows for cell in row)
        assert any(f"Caveat {chunk}." in str(cell) for row in rows for cell in row)
    assert any(row[:2] == ["A", "Stale date"] for row in rows)
    assert any(row[:2] == ["B", "Dissent"] for row in rows)
    assert any(row[:3] == ["", "info", "ancillary_table_preserved"] for row in rows)
    assert source.response == content
    assert current_output_context() is None

    # Exercise the unchanged Google client adapter too: a 26-column read range
    # must never narrow the actual RAW append payload or its header write.
    service = MagicMock()
    values = service.spreadsheets.return_value.values.return_value
    values.get.return_value.execute.return_value = {"values": []}
    with patch.object(tasks._svc, "_build_service", return_value=service), patch.object(tasks._svc, "ensure_sheet", return_value=1):
        tasks._svc.append_sheet("mocked", None, "offline", headers, rows, "Ideas")
    assert values.update.call_args.kwargs["body"]["values"] == [headers]
    written = values.append.call_args.kwargs
    assert written["valueInputOption"] == "RAW"
    assert written["body"]["values"] == [[], *rows]
    assert len(sheet_rows(headers, written["body"]["values"])) == 60


def test_rebalance_all_29_columns_zero_and_explicit_null_are_preserved():
    records = []
    for symbol, units in [("ABC", 10), ("ZERO", 0)]:
        record = {column.key: stock(symbol).get(column.key) for column in REBALANCE_COLUMNS}
        record.update(current_units=units, action="Hold", units_change=0, final_units=units,
                      units_to_buy=0, total_buy_amount=0, extra_null=None, extra_blank="", extra_zero=0)
        records.append(record)
    prompt = "[REBALANCE_FLOW:india]\n\n| " + " | ".join(column.label for column in REBALANCE_COLUMNS) + " |\n\n"
    prompt += "## 1. Latest Portfolio Snapshot\n| Exchange | Stock Symbol | Current Units |\n| --- | --- | --- |\n| NSE | ABC | 10 |\n| NSE | ZERO | 0 |\n\n## 2. Research\n"
    source = job(json.dumps(records), prompt=prompt)
    result, append, _, _ = export_job(source)
    assert result["status"] == "completed"
    assert result["stocks_count"] == 2
    headers, rows = append.call_args.args[3:5]
    assert headers[:29] == [column.label for column in REBALANCE_COLUMNS]
    exported = sheet_rows(headers, rows, first_label="Exchange Symbol")
    assert len(exported) == 2
    for record, row in zip(records, exported):
        for column in REBALANCE_COLUMNS:
            assert row[column.label] == record[column.key]
        assert row["extra_null"] == "null"
        assert row["extra_blank"] == ""
        assert row["extra_zero"] == 0
        assert row["Units to Buy"] == row["Total Buy Amount"] == 0
        assert row["LLM"] == "provider/model"
        assert row["Run Date"] == "2026-10-02"
        assert row["Run Time"] == "15:00:00"
    assert current_output_context() is None


@pytest.mark.parametrize("change,count", [({"score_rationale_cruxx": None}, 5), ({}, 4), ({}, 6)])
def test_invalid_current_output_never_falls_back_or_exports_partial_rows(change, count):
    records = [stock(f"STOCK{i}") for i in range(count)]
    records[-1].update(change)
    source = job(json.dumps(records))
    result, append, repository, legacy = export_job(source)
    assert result["status"] == "failed"
    assert "validation" in result["error"]
    append.assert_not_called()
    legacy.assert_not_called()
    assert repository.return_value.update_export_state.call_args.kwargs["export_status"] == "failed"
    assert source.response == json.dumps(records)
    assert current_output_context() is None


def test_failed_current_output_cannot_use_legacy_partial_export_permission():
    source = job(json.dumps([stock("ABC")]), status="failed", error_message="returned insufficient recommendations")
    with patch.object(tasks, "_extract_exportable_stocks", side_effect=AssertionError("Legacy parser called")):
        assert not tasks._job_can_export_partial_rows(source)


def test_custom_and_nested_schema_inputs_do_not_opt_in():
    content = markdown(SWING_COLUMNS, [stock("ABC")])
    custom = job(content, prompt="Custom research, using our historical column definitions.")
    assert tasks._validated_output_for_export(custom, None) is None
    nested = job(content, prompt="India swing trading.\n\n# Inputs considered\n" + content)
    assert tasks._validated_output_for_export(nested, None) is None


def test_missing_rebalance_snapshot_fails_before_export():
    source = job("unchanged output", prompt="[REBALANCE_FLOW:india]\n\n| " + " | ".join(column.label for column in REBALANCE_COLUMNS) + " |")
    result, append, _, legacy = export_job(source)
    assert result["status"] == "failed"
    assert "snapshot" in result["error"]
    append.assert_not_called()
    legacy.assert_not_called()
    assert source.response == "unchanged output"
    assert current_output_context() is None


def test_existing_metadata_aliases_are_never_duplicated_or_overwritten():
    headers = ["Run #", "run_date", "Run Time", "LLM", "Extra"]
    original = [[0, "2026-01-01", "01:02:03", "Original model", None]]
    actual_headers, actual_rows = tasks._with_run_metadata_columns(headers, original, 999, NOW, "Replacement")
    assert actual_headers == headers
    assert actual_rows == original


@pytest.mark.parametrize("invalid_second", [False, True])
def test_run_keeps_independent_samples_and_blocks_invalid_current_outputs(invalid_second):
    sources = [job(json.dumps([stock(f"STOCK{i}", rationale_remarks=f"Sample {sample} rationale") for i in range(5)]), job_id=sample)
               for sample in [77, 78]]
    if invalid_second:
        records = json.loads(sources[1].response)
        records[-1]["confidence_score"] = None
        sources[1].response = json.dumps(records)
    run = SimpleNamespace(id=12, user_id=5, created_at=NOW)
    with ExitStack() as stack:
        session = stack.enter_context(patch.object(tasks, "SyncSessionLocal"))
        db = session.return_value.__enter__.return_value
        db.execute.side_effect = [
            Result(SimpleNamespace(access_token_enc="unused", refresh_token_enc=None)), Result(run),
            Result([SimpleNamespace(job=source, stage=1) for source in sources]),
        ]
        stack.enter_context(patch.object(tasks, "SyncRunRepository"))
        stack.enter_context(patch.object(tasks, "decrypt_token", return_value="mocked"))
        stack.enter_context(patch.object(tasks._svc, "extract_spreadsheet_id", return_value="offline"))
        append = stack.enter_context(patch.object(tasks._svc, "append_sheet", return_value=(0, 1)))
        stack.enter_context(patch.object(tasks, "parse_complete_stock_recommendations", side_effect=AssertionError("Legacy parser used")))
        result = tasks.export_run_to_sheets_task.run(5, 12, "https://docs.google.com/spreadsheets/d/offline/edit")
    if invalid_second:
        assert result["status"] == "failed"
        assert "Job 78" in result["error"]
        append.assert_not_called()
        assert current_output_context() is None
        return
    assert result["stocks_count"] == 10
    assert result["models_count"] == 1
    headers, rows = append.call_args.args[3:5]
    exported = sheet_rows(headers, rows)
    assert len(exported) == 10
    assert {row["Export Job ID"] for row in exported} == {77, 78}
    assert {row["Rationale Cruxx"] for row in exported} == {"Sample 77 rationale", "Sample 78 rationale"}
    assert all(row["Run #"] == 0 and row["LLM"] == "Original source model" for row in exported)
    assert current_output_context() is None
