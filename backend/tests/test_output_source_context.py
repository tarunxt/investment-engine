"""Owned source freezing uses mocked database records, never a live database."""
import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from pydantic import ValidationError

from app.domains.jobs.output_contracts import source_hash
from app.domains.jobs.output_sources import (
    MAX_OUTPUT_SOURCE_BYTES, OutputSourceJobReference, freeze_output_source_context,
    frozen_sources_from_context,
)
from app.domains.jobs.output_runtime import configure_output_context, output_validation_metadata, reset_output_context
from app.shared.exceptions import ValidationException
from app.shared.types import JobStatus
from test_output_contracts import rebalance_row, swing_row
from test_output_runtime import execute_mocked, make_job


def source(job_id=11, run_id=5, market="india", **overrides):
    metadata = dict(user_id=7, prompt=f"{market} swing-trade study", status=JobStatus.COMPLETED,
                    auto_rebalance_portfolio="india" if market == "india" else "indmoney_us",
                    auto_rebalance_label=f'{"India" if market == "india" else "IndMoney US"} Run #1 (Swing Scan)')
    run = SimpleNamespace(id=run_id, **metadata)
    job = SimpleNamespace(**({"id": job_id, "response": json.dumps([swing_row("OTHER")])} | metadata | overrides))
    link = SimpleNamespace(run_id=run_id, job_id=job_id, stage=1)
    return link, run, job


def reference(record):
    link, _, job = record
    return OutputSourceJobReference(run_id=link.run_id, job_id=job.id, response_sha256=source_hash(job.response))


def freeze(records, refs=None, target=None):
    projected = []
    for link, run, job in records:
        record = {"link_run_id": link.run_id, "link_job_id": link.job_id,
                  "run_member_count": getattr(run, "member_count", len({item[2].id for item in records if item[1].id == run.id})),
                  "response_bytes": len(job.response.encode("utf-8")) if isinstance(job.response, str) else None}
        for prefix, value in (("run", run), ("job", job)):
            record.update({f"{prefix}_{key}": getattr(value, key) for key in
                           ("id", "user_id", "status", "auto_rebalance_portfolio", "auto_rebalance_label", "prompt")})
        projected.append(record)
    metadata_result = SimpleNamespace(mappings=lambda: SimpleNamespace(all=lambda: projected))
    response_result = SimpleNamespace(all=lambda: [(row[2].id, row[2].response) for row in records])
    session = SimpleNamespace(execute=AsyncMock(side_effect=[metadata_result, response_result]))
    context = asyncio.run(freeze_output_source_context(session, user_id=7, target=target or make_job("rebalance"),
                                                      references=refs if refs is not None else [reference(row) for row in records]))
    return context, session


def test_freezes_full_evidence_without_raw_response_or_cross_sequence_restriction():
    record = source()
    context, session = freeze([record])
    assert session.execute.await_count == 2
    frozen, = frozen_sources_from_context(context, market="india")
    assert frozen.identities == (("NSE", "OTHER"),) and frozen.complete
    assert frozen.response_hash == source_hash(record[2].response)
    assert "response" not in context["sources"][0]
    assert context["sources"][0]["parsing_status"] == "valid"
    json.dumps(context)
    preflight, hydration = [str(call.args[0]) for call in session.execute.call_args_list]
    assert "octet_length(jobs.response)" in preflight and "left(jobs.prompt" in preflight
    assert "jobs.runtime_metadata_json" not in preflight and "jobs.request_context_json" not in preflight
    assert preflight.split("FROM")[0].count("jobs.response") == 1  # byte length only
    assert "octet_length(jobs.response) =" in hydration
    assert "jobs.prompt" not in hydration and "runs.prompt" not in hydration


@pytest.mark.parametrize("tamper", [
    lambda row: setattr(row[2], "user_id", 8),
    lambda row: setattr(row[1], "user_id", 8),
    lambda row: setattr(row[0], "run_id", 999),
    lambda row: setattr(row[0], "job_id", 999),
    lambda row: setattr(row[1], "id", 999),
    lambda row: setattr(row[2], "auto_rebalance_portfolio", "indmoney_us"),
    lambda row: setattr(row[1], "auto_rebalance_portfolio", "indmoney_us"),
    lambda row: setattr(row[2], "auto_rebalance_label", "India Run #1 (Rebalance Scan)"),
    lambda row: setattr(row[1], "auto_rebalance_label", "India Run #1 (Rebalance Scan)"),
    lambda row: setattr(row[2], "status", JobStatus.PROCESSING),
    lambda row: setattr(row[1], "status", JobStatus.PROCESSING),
    lambda row: setattr(row[2], "status", JobStatus.FAILED),
    lambda row: setattr(row[2], "response", ""),
    lambda row: setattr(row[2], "response", row[2].response + " "),
])
def test_rejects_wrong_owner_market_stage_link_status_or_changed_version(tamper):
    record = source()
    ref = reference(record)
    tamper(record)
    with pytest.raises(ValidationException):
        freeze([record], [ref])


def test_missing_and_duplicate_database_rows_are_rejected():
    record = source()
    with pytest.raises(ValidationException):
        freeze([], [reference(record)])
    with pytest.raises(ValidationException):
        freeze([record, record], [reference(record)])


def test_duplicate_delivery_only_deduplicates_identical_job_references():
    first, second = source(), source(job_id=12)
    assert first[2].response == second[2].response
    context, _ = freeze([first, second], [reference(first), reference(first), reference(second)])
    assert [item["job_id"] for item in context["sources"]] == [11, 12]
    conflict = reference(first).model_copy(update={"response_sha256": "0" * 64})
    with pytest.raises(ValidationException, match="Conflicting"):
        freeze([first], [reference(first), conflict])


@pytest.mark.parametrize("status,response", [(JobStatus.PARTIAL, None), (JobStatus.COMPLETED, "Unparsed source")])
def test_partial_or_unparsed_sources_cannot_prove_absence(status, response):
    record = source(status=status)
    if response is not None:
        record[2].response = response
    context, _ = freeze([record])
    frozen, = frozen_sources_from_context(context, market="india")
    assert not frozen.complete
    assert frozen.parsing_status in {"valid", "blocked"}


def test_old_clients_and_empty_selection_have_distinct_provenance():
    session = SimpleNamespace(execute=AsyncMock())
    assert asyncio.run(freeze_output_source_context(session, user_id=7, target=make_job("rebalance"), references=None)) is None
    session.execute.assert_not_awaited()
    context, session = freeze([], [])
    session.execute.assert_not_awaited()
    assert frozen_sources_from_context(context, market="india") == ()
    assert frozen_sources_from_context(context, market="us") is None
    assert frozen_sources_from_context(None, market="india") is None
    assert frozen_sources_from_context({"kind": context["kind"], "market": None, "sources": []}, market=None) is None


def test_bounds_fail_clearly_without_truncating_sources():
    record = source(response="é" * (MAX_OUTPUT_SOURCE_BYTES // 2 + 1))
    with pytest.raises(ValidationException, match="UTF-8 bytes"):
        freeze([record])
    with pytest.raises(ValidationException, match="At most"):
        freeze([], [reference(source(job_id=i + 1)) for i in range(201)])


@pytest.mark.parametrize("values", [
    {"run_id": True}, {"job_id": "11"}, {"job_id": 0}, {"job_id": 2**53},
    {"response_sha256": "bad"}, {"extra": "field"},
])
def test_request_reference_is_strict_and_bounded(values):
    with pytest.raises(ValidationError):
        OutputSourceJobReference(**({"run_id": 5, "job_id": 11, "response_sha256": "a" * 64} | values))


def test_create_run_request_keeps_legacy_payload_and_accepts_only_typed_new_references():
    from app.domains.runs.schemas import RunCreate
    payload = {"prompt": "[REBALANCE_FLOW:india]", "targets": [{"provider": "example", "model": "same-model"}]}
    assert RunCreate(**payload).output_source_jobs is None
    ref = reference(source())
    assert RunCreate(**payload, output_source_jobs=[ref.model_dump()]).output_source_jobs == [ref]
    with pytest.raises(ValidationError):
        RunCreate(**payload, output_source_jobs=[{**ref.model_dump(), "job_id": "11"}])


def test_runtime_reports_precise_frozen_mismatch_without_gating_valid_output():
    context, _ = freeze([source()])
    job = make_job("rebalance", request_context_json=context)
    token = configure_output_context(job, {})
    try:
        content = json.dumps([rebalance_row(analyst_source="Swing job #11", price_per_unit=124.2,
                                           rationale_remarks="Weak setup. Current price is below 120.")])
        report = output_validation_metadata(content)
        assert report["safe_to_render"] is True and report["status"] == "valid"
        assert report["consistency"]["status"] == "issues_found"
        assert report["consistency"]["check_counts"]["inconsistent"] == 2
        assert report["semantic_research_quality"] == "not_evaluated"
    finally:
        reset_output_context(token)


@pytest.mark.parametrize("tamper", [
    lambda context: context["sources"].append(dict(context["sources"][0])),
    lambda context: context["sources"][0].update(identities=[["NSE", "X" * 129]]),
    lambda context: context["sources"][0].update(identities=[["NSE", "ABC"]] * 20_001),
    lambda context: context["sources"][0].update(complete=True, parsing_status="blocked"),
    lambda context: context["sources"][0].update(complete=True, source_status="partial"),
    lambda context: context["sources"][0].update(complete=True, identities=[]),
    lambda context: context["sources"][0].update(finding_counts={"bad": True}),
    lambda context: context.update(unexpected_large_field="x" * 500_001),
])
def test_malformed_oversized_or_duplicate_frozen_context_stays_unknown(tamper):
    context, _ = freeze([source()])
    tamper(context)
    assert frozen_sources_from_context(context, market="india") is None


def test_preflight_size_limit_never_fetches_response_text():
    record = source()
    projected = {"link_run_id": 5, "link_job_id": 11, "response_bytes": MAX_OUTPUT_SOURCE_BYTES + 1,
                 "run_member_count": 1}
    for prefix, value in (("run", record[1]), ("job", record[2])):
        projected.update({f"{prefix}_{key}": getattr(value, key) for key in
                          ("id", "user_id", "status", "auto_rebalance_portfolio", "auto_rebalance_label", "prompt")})
    session = SimpleNamespace(execute=AsyncMock(return_value=SimpleNamespace(
        mappings=lambda: SimpleNamespace(all=lambda: [projected]))))
    with pytest.raises(ValidationException, match="UTF-8 bytes"):
        asyncio.run(freeze_output_source_context(session, user_id=7, target=make_job("rebalance"), references=[reference(record)]))
    assert session.execute.await_count == 1


def test_run_absence_requires_every_server_counted_member_and_complete_run():
    first, second = source(), source(job_id=12)
    context, _ = freeze([first, second])
    assert all(item["run_complete"] for item in context["sources"])
    first[1].member_count = 3  # Includes an omitted source job; never fetch its text.
    context, _ = freeze([first])
    assert context["sources"][0]["run_complete"] is False
    first[1].member_count = 1
    first[1].status = JobStatus.PARTIAL
    context, _ = freeze([first])
    assert context["sources"][0]["run_complete"] is False
    second[2].status = JobStatus.PARTIAL
    first[1].status = JobStatus.COMPLETED
    first[1].member_count = 2
    context, _ = freeze([first, second])
    assert all(not item["run_complete"] for item in context["sources"])


def test_advisory_conflicts_never_regenerate_or_change_completed_rows():
    from app.domains.ai_providers.base import AIProviderResponse
    context, _ = freeze([source()])
    job = make_job("rebalance", request_context_json=context)
    content = json.dumps([rebalance_row(analyst_source="Swing Trade Run #5", price_per_unit=124.2,
                                       rationale_remarks="Current price is below 120.")])
    response = AIProviderResponse(content=content, tokens_in=1, tokens_out=2, cost=0.001,
                                  provider=job.provider, model=job.model)
    _, provider, _, failed = execute_mocked(job, [response])
    provider.generate.assert_called_once()
    failed.assert_not_called()
    assert job.status == JobStatus.COMPLETED
    assert "Current price is below 120." in job.response and "124.2" in job.response
    assert job.runtime_metadata_json["deterministic_output"]["consistency"]["check_counts"]["inconsistent"] == 2
