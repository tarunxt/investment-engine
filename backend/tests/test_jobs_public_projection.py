"""Public copies redact credential labels without mutating evidence or finance."""
from copy import deepcopy
from datetime import datetime, timezone
from types import SimpleNamespace
import json

import pytest

from app.domains.jobs.public_projection import public_value, public_text
from app.domains.jobs.schemas import JobResponse
from app.domains.jobs.output_contracts import normalize_output, export_tables, SWING_COLUMNS
from test_output_contracts import swing_row, table

SECRET = "synthetic-boundary-credential"


def test_nested_projection_preserves_financial_diagnostics_and_original():
    source = {
        "failure_diagnostics": {"password_hash": SECRET, "status": 429, "retryable": True},
        "execution_claim": {"owner_token": SECRET, "attempt_id": "synthetic-attempt", "state": "owned"},
        "calls": [{"Authorization": f"Bearer {SECRET}", "tokens_in": 0, "tokens_out": 7}],
        "account_secret": SECRET, "X-Api-Key": SECRET,
        "source": {"job_id": 41, "token_id": "12345", "stock_symbol": "SYNTH", "currency": None,
                   "quantity": 0, "value": 25.5, "source_hash": "synthetic-hash", "unknown": None},
    }
    before = deepcopy(source)
    projected = public_value(source)
    assert SECRET not in json.dumps(projected)
    assert source == before
    assert projected["source"] == source["source"]
    assert projected["calls"][0]["tokens_in"] == 0
    assert projected["calls"][0]["tokens_out"] == 7
    assert projected["execution_claim"]["attempt_id"] == "synthetic-attempt"
    assert projected["failure_diagnostics"]["status"] == 429
    assert projected["failure_diagnostics"]["retryable"] is True


@pytest.mark.parametrize("text", [
    f"provider unavailable status=429 OPENAI_API_KEY={SECRET} retry later",
    f"private detail token={SECRET}; symbol=SYNTH quantity=7",
    f'{{"password_hash": "{SECRET}"}}',
    f"Bearer {SECRET}",
    f"Authorization: Bearer {SECRET}",
    f"https://synthetic:{SECRET}@example.invalid/path?symbol=SYNTH",
])
def test_diagnostic_redaction_is_idempotent(text):
    projected = public_text(text)
    assert SECRET not in projected
    assert public_text(projected) == projected


def test_response_serialization_does_not_change_orm_like_evidence():
    now = datetime(2026, 11, 1, tzinfo=timezone.utc)
    source = SimpleNamespace(id=41, prompt="retained prompt", response="retained financial output",
        provider="fixture", model="fixture", status="completed", created_at=now, updated_at=now,
        error_message=f"status=429 token={SECRET}", export_error=f"OPENAI_API_KEY={SECRET}",
        request_context_json={"source_job_id": 31, "account_secret": SECRET},
        runtime_metadata_json={"failure_diagnostics": {"password": SECRET}, "tokens_in": 7})
    before = deepcopy(vars(source))
    dto = JobResponse.model_validate(source)
    projected = dto.model_dump(mode="json")
    assert SECRET not in json.dumps(projected)
    assert vars(source) == before
    assert dto.error_message == before["error_message"]
    assert projected["prompt"] == source.prompt and projected["response"] == source.response


def test_ancillary_sensitive_columns_minimized_without_changing_normalized_evidence():
    content = table(SWING_COLUMNS, [swing_row("SYNTH")]) + (
        f"\n\n| Source | access_token |\n| --- | --- |\n| synthetic | {SECRET} |\n")
    normalized = normalize_output(content, "swing")
    assert normalized.safe_to_replace
    before = deepcopy(normalized)
    projected = export_tables(normalized)
    assert SECRET not in str(projected)
    assert normalized == before and SECRET in normalized.original
    assert projected[0].headers == tuple(c.label for c in SWING_COLUMNS)
    assert projected[0].rows[0][2] == "SYNTH"
    assert projected[1].headers == ("Source", "access_token")
    assert projected[1].rows[0][0] == "synthetic"
    assert projected[1].provenance == export_tables(before)[1].provenance


def test_ws_publication_projects_only_diagnostic_copy(monkeypatch):
    from app.domains.jobs import tasks
    from unittest.mock import MagicMock
    source = SimpleNamespace(id=41, user_id=7, provider="fixture", model="fixture", status="failed",
        response="retained financial output", error_message=f"OPENAI_API_KEY={SECRET}",
        tokens_in=0, tokens_out=7, estimated_cost=0.0, web_search_used=False,
        web_search_queries=[], web_sources=[], runtime_metadata_json={"password": SECRET, "status": "partial"},
        export_status="failed", export_error=f"token={SECRET}", exported_at=None,
        exported_sheet_url=None, updated_at=None)
    before = deepcopy(vars(source))
    redis = MagicMock()
    monkeypatch.setattr(tasks._sync_redis, "from_url", lambda *args, **kwargs: redis)
    tasks._publish_job_update(source)
    assert redis.publish.call_count == 2
    for call in redis.publish.call_args_list:
        assert SECRET not in call.args[1]
        assert json.loads(call.args[1])["response"] == source.response
    assert vars(source) == before


def test_actual_valid_ancillary_export_uses_minimized_copy_only():
    from test_google_sheets_output_contracts import export_job, job, markdown, stock
    content = markdown(SWING_COLUMNS, [stock("SYNTH")]) + (
        f"\n\n| Source | token |\n| --- | --- |\n| synthetic | {SECRET} |\n")
    source = job(content, count=1)
    before = deepcopy(vars(source))
    result, append, _, _ = export_job(source)
    assert result["status"] == "completed"
    append.assert_called_once()
    assert SECRET not in str(append.call_args)
    assert "SYNTH" in str(append.call_args)
    assert vars(source) == before


def test_supplied_one_column_case_is_denied_before_append():
    from test_google_sheets_output_contracts import export_job, job, markdown, stock
    content = markdown(SWING_COLUMNS, [stock("SYNTH")]) + (
        f"\n\n| token |\n| --- |\n| {SECRET} |\n")
    normalized = normalize_output(content, "swing")
    assert not normalized.safe_to_replace
    assert any(finding.code == "unparsed_table_line" for finding in normalized.findings)
    result, append, _, _ = export_job(job(content, count=1))
    assert result["status"] == "failed"
    append.assert_not_called()
