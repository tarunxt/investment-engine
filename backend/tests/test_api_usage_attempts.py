"""Offline provider metering tests: no credentials, network or database services."""
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
import json
from threading import Barrier
from types import SimpleNamespace as NS
from unittest.mock import Mock

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

import app.models  # noqa: F401 - canonical mapper registry, no DB connection
from app.domains.api_usage import metering
from app.domains.api_usage.metering import ApiAttempt, content_hash, metered_call
from app.domains.api_usage.models import ApiUsageAttemptEvent
from app.domains.api_usage.recorder import (
    provider_usage_phase, reset_provider_usage_context, set_provider_usage_context,
)

PERSIST = metering._persist_attempt
RATES = {"input": 1, "output": 2}


@pytest.fixture
def ledger(monkeypatch):
    from app.domains.api_usage import recorder
    from app.domains.api_usage.models import LlmProviderUsageCallRecord
    engine = create_engine("sqlite://")
    ApiUsageAttemptEvent.__table__.create(engine)
    LlmProviderUsageCallRecord.__table__.create(engine)
    sessions = sessionmaker(bind=engine)
    monkeypatch.setattr(metering, "SyncSessionLocal", sessions)
    monkeypatch.setattr(recorder, "SyncSessionLocal", sessions)
    monkeypatch.setattr(metering, "_persist_attempt", PERSIST)
    # All tests use mocks; any accidental external request fails immediately.
    monkeypatch.setattr("socket.socket.connect", Mock(side_effect=AssertionError("offline test")))
    monkeypatch.setattr("socket.socket.connect_ex", Mock(side_effect=AssertionError("offline test")))
    token = set_provider_usage_context(
        user_id=7, job_id=9, execution_id="task-1", job_attempt=0,
        run_id="run-1", workflow_id="workflow-1", market="india",
        stage="stage2", sample_id="sample-1", requested_provider="openai",
        requested_model="requested-model", evidence_hash=content_hash({"evidence": "private"}),
        schema_hash=content_hash({"type": "object"}),
    )
    def read(kind="finished"):
        with sessions() as db:
            query = select(ApiUsageAttemptEvent).order_by(ApiUsageAttemptEvent.started_at)
            if kind:
                query = query.where(ApiUsageAttemptEvent.event_kind == kind)
            return list(db.scalars(query))
    yield read
    reset_provider_usage_context(token)
    engine.dispose()


def response(response_id="r1", *, usage=True, tokens_in=100, tokens_out=20):
    return NS(id=response_id, _request_id="req-" + response_id if response_id else None,
              model="actual-model", output_text="answer",
              choices=[NS(finish_reason="stop", message=NS(content="answer", tool_calls=None))],
              usage=NS(prompt_tokens=tokens_in, completion_tokens=tokens_out,
                       completion_tokens_details=NS(reasoning_tokens=3)) if usage else None)


def call(result, **kwargs):
    return metered_call(lambda **unused: result, provider="openai", meter_model="requested-model",
                        tariff_rates=RATES, model="requested-model", input="PRIVATE PROMPT", **kwargs)


def test_success_keeps_reported_usage_identity_and_estimate_separate(ledger):
    call(response())
    row, = ledger()
    assert (row.user_id, row.job_id, row.run_id, row.workflow_id, row.market, row.stage, row.sample_id) == (
        7, 9, "run-1", "workflow-1", "india", "stage2", "sample-1")
    assert row.requested_model == "requested-model"
    assert row.actual_model == "actual-model"
    assert row.provider_request_id == "req-r1" and row.provider_response_id == "r1"
    assert row.reported_usage["input_tokens"] == 100
    assert row.reported_usage["completion_tokens_details"]["reasoning_tokens"] == 3
    assert row.reported_usage["cache_read_input_tokens"] is None
    assert row.tariff_estimated_cost_usd == pytest.approx(0.00014)
    assert row.provider_billed_cost_usd is None and row.allocated_cost_usd is None
    assert row.tariff_version and row.tariff_effective_date is None
    assert row.latency_ms >= 0 and row.finished_at >= row.started_at
    assert row.instrumentation_scope == "sdk_call_hidden_retries_unknown"
    assert row.evidence_hash and row.schema_hash and row.prompt_hash


def test_started_and_finished_are_immutable_and_replay_is_idempotent(ledger):
    with ApiAttempt(provider="openai", model="model", request="private", tariff_rates=RATES) as attempt:
        started = deepcopy(attempt.values)
        attempt.observe(response())
    finished = deepcopy(attempt.values)
    PERSIST(started)
    PERSIST(finished)
    rows = ledger(None)
    assert len(rows) == 2
    assert {r.event_kind for r in rows} == {"started", "finished"}
    initial = next(r for r in rows if r.event_kind == "started")
    assert initial.status == "started" and initial.finished_at is None
    assert initial.reported_usage is None and initial.tariff_estimated_cost_usd is None
    assert rows[0].attempt_id == rows[1].attempt_id
    assert rows[0].event_id != rows[1].event_id


def test_duplicate_response_delivery_has_one_charge_but_distinct_attempts(ledger):
    call(response())
    call(response())
    first, second = ledger()
    assert first.attempt_id != second.attempt_id
    assert second.duplicate_of_attempt_id == first.attempt_id
    assert second.tariff_estimated_cost_usd is None
    assert second.reported_usage == first.reported_usage
    assert sum(r.tariff_estimated_cost_usd or 0 for r in ledger()) == pytest.approx(0.00014)


@pytest.mark.parametrize("request_only_first", [True, False])
def test_deduplication_keeps_new_id_alias_for_later_partial_delivery(ledger, request_only_first):
    first = response(None)
    first._request_id = "same-request"
    delivered = response("now-known-response")
    delivered._request_id = "same-request"
    third = response("now-known-response")
    third._request_id = None
    if not request_only_first:
        first, third = third, first
    call(first)
    call(delivered)
    call(third)
    original, replay, partial = ledger()
    assert replay.provider_response_id == "now-known-response"
    assert replay.duplicate_of_attempt_id == partial.duplicate_of_attempt_id == original.attempt_id
    assert replay.tariff_estimated_cost_usd is partial.tariff_estimated_cost_usd is None
    assert sum(row.tariff_estimated_cost_usd or 0 for row in ledger()) == pytest.approx(0.00014)


def test_response_and_request_ids_use_distinct_namespaces(ledger):
    first = response("same-string")
    first._request_id = None
    second = response(None)
    second._request_id = "same-string"
    call(first)
    call(second)
    rows = ledger()
    assert all(row.duplicate_of_attempt_id is None for row in rows)
    assert sum(row.tariff_estimated_cost_usd for row in rows) == pytest.approx(0.00028)


def test_missing_provider_id_does_not_drop_or_deduplicate_distinct_calls(ledger):
    call(response(None))
    call(response(None))
    rows = ledger()
    assert len(rows) == 2 and rows[0].attempt_id != rows[1].attempt_id
    assert all(r.provider_request_id is None and r.provider_response_id is None for r in rows)
    assert all(r.tariff_estimated_cost_usd == pytest.approx(0.00014) for r in rows)


def test_missing_usage_and_unknown_tariff_are_unknown_not_zero(ledger):
    call(response(usage=False))
    metered_call(lambda: response("r2"), provider="new-provider", meter_model="unpriced")
    missing, unpriced = ledger()
    assert missing.reported_usage is None and missing.tariff_estimated_cost_usd is None
    assert unpriced.tariff_rates is None and unpriced.tariff_estimated_cost_usd is None
    assert missing.actual_model == "actual-model"


def test_observed_zero_is_distinct_from_missing_fields(ledger):
    call(response(tokens_in=0, tokens_out=0))
    row, = ledger()
    assert row.tariff_estimated_cost_usd == 0
    assert row.reported_usage["cache_read_input_tokens"] is None


def test_success_repair_recovery_and_retry_costs_accumulate(ledger):
    for index, phase in enumerate(("request", "format_repair", "recovery")):
        call(response(str(index)), phase=phase)
    with provider_usage_phase("row_repair"):
        call(response("row"))
    with ApiAttempt(provider="openai", model="requested-model", request="same",
                    phase="retry", retry=True, tariff_rates=RATES) as attempt:
        attempt.observe(response("retry"))
    rows = ledger()
    assert [r.phase for r in rows] == ["request", "format_repair", "recovery", "row_repair", "retry"]
    assert sum(r.tariff_estimated_cost_usd for r in rows) == pytest.approx(5 * 0.00014)
    assert rows[-1].retry_of_attempt_id == rows[-2].attempt_id
    assert all(r.parent_attempt_id == previous.attempt_id for previous, r in zip(rows, rows[1:]))


def test_job_retry_links_previous_execution_attempt_without_deduplicating(ledger):
    call(response("first"))
    token = set_provider_usage_context(user_id=7, job_id=9, execution_id="task-1",
                                       job_attempt=1, sample_id="sample-1")
    try:
        call(response("second"))
    finally:
        reset_provider_usage_context(token)
    first, retry = ledger()
    assert retry.retry_of_attempt_id == first.attempt_id
    assert retry.tariff_estimated_cost_usd == first.tariff_estimated_cost_usd


def test_same_model_independent_samples_remain_separate(ledger):
    call(response("first"))
    token = set_provider_usage_context(user_id=7, job_id=10, sample_id="sample-2")
    try:
        call(response("second"))
    finally:
        reset_provider_usage_context(token)
    first, second = ledger()
    assert first.sample_id != second.sample_id and first.job_id != second.job_id
    assert second.parent_attempt_id is None and second.duplicate_of_attempt_id is None
    assert first.tariff_estimated_cost_usd == second.tariff_estimated_cost_usd


@pytest.mark.parametrize("error,status", [(RuntimeError("private body sk-secret"), "error"),
                                           (KeyboardInterrupt("private"), "cancelled")])
def test_errors_and_cancellation_propagate_and_record_unknown_usage(ledger, error, status):
    def fail(**kwargs):
        raise error
    with pytest.raises(type(error)):
        metered_call(fail, provider="openai", meter_model="model", input="SECRET")
    row, = ledger()
    assert row.status == status and row.error_type == type(error).__name__
    assert row.reported_usage is None and row.tariff_estimated_cost_usd is None
    assert "private" not in json.dumps({c.name: str(getattr(row, c.name)) for c in row.__table__.columns})


def test_partial_stream_usage_survives_error(ledger):
    with pytest.raises(RuntimeError):
        with ApiAttempt(provider="gemini", model="model", request="secret", tariff_rates=RATES) as attempt:
            attempt.observe(NS(response_id="stream", usage_metadata=NS(prompt_token_count=10, candidates_token_count=3)))
            raise RuntimeError("broken stream with private body")
    row, = ledger()
    assert row.status == "error" and row.reported_usage["input_tokens"] == 10
    assert row.tariff_estimated_cost_usd == pytest.approx(0.000016)


def test_usage_allowlist_and_hashes_never_store_prompts_bodies_or_keys(ledger):
    result = response()
    result.usage.secret = "API-KEY-PRIVATE"
    result.usage.prompt = "PRIVATE PROMPT"
    result.body = "PRIVATE RESPONSE"
    call(result)
    row, = ledger()
    serialized = json.dumps({c.name: str(getattr(row, c.name)) for c in row.__table__.columns})
    assert "PRIVATE" not in serialized
    assert len(row.prompt_hash) == 64


def test_deepseek_missing_cache_is_inferred_not_provider_reported(ledger):
    rates = {"cache_hit_input": 0.1, "cache_miss_input": 1, "output": 2}
    with ApiAttempt(provider="deepseek", model="model", request="secret", tariff_rates=rates) as attempt:
        attempt.observe(response())
    row, = ledger()
    assert row.reported_usage["cache_read_input_tokens"] is None
    assert row.reported_usage["cache_miss_input_tokens"] is None
    assert row.inferred_usage["cache_miss_input_tokens"] == 100
    assert row.tariff_estimated_cost_usd == pytest.approx(0.00014)


def test_stream_snapshots_are_not_double_counted(ledger):
    with ApiAttempt(provider="gemini", model="model", request="secret", tariff_rates=RATES) as attempt:
        for count in (10, 20, 30):
            attempt.observe(NS(response_id="stream", usage_metadata=NS(prompt_token_count=100, candidates_token_count=count)))
    row, = ledger()
    assert row.reported_usage["output_tokens"] == 30
    assert row.tariff_estimated_cost_usd == pytest.approx(0.00016)


def test_persistence_failure_does_not_change_request_behavior(monkeypatch):
    monkeypatch.setattr(metering, "_persist_attempt", PERSIST)
    monkeypatch.setattr(metering, "SyncSessionLocal", Mock(side_effect=RuntimeError("private db error")))
    upstream = Mock(return_value=response())
    result = metered_call(upstream, provider="openai", meter_model="model", model="model", input="prompt")
    assert result.id == "r1"
    upstream.assert_called_once_with(model="model", input="prompt")


def test_deepseek_recovery_and_format_repair_are_individually_metered(ledger, monkeypatch):
    from app.domains.ai_providers.deepseek import DeepSeekProvider
    client = Mock()
    outputs = [response("empty", tokens_in=10, tokens_out=2),
               response("recovery", tokens_in=20, tokens_out=3),
               response("repair", tokens_in=30, tokens_out=4)]
    outputs[0].choices = []
    outputs[1].choices[0].message.content = "not valid json"
    outputs[2].choices[0].message.content = '{"ok":true}'
    client.chat.completions.create.side_effect = outputs
    monkeypatch.setattr("app.domains.ai_providers.deepseek.OpenAI", lambda **kwargs: client)
    result = DeepSeekProvider().generate(prompt="Return ONLY valid JSON", model="deepseek-v4-flash")
    assert json.loads(result.content) == {"ok": True}
    rows = ledger()
    assert [r.phase for r in rows] == ["request", "empty_recovery", "format_repair"]
    assert sum(r.reported_usage["input_tokens"] for r in rows) == 60
    assert sum(r.reported_usage["output_tokens"] for r in rows) == 9
    assert all(r.tariff_estimated_cost_usd is not None for r in rows)


def test_openai_format_repair_preserves_upstream_arguments(ledger, monkeypatch):
    from app.domains.ai_providers.openai import OpenAIProvider
    first, repair = response("first"), response("repair")
    repair.output_text = "| A | B |\n|---|---|\n| 1 | 2 |"
    client = Mock()
    client.responses.create.side_effect = [first, repair]
    monkeypatch.setattr("app.domains.ai_providers.openai.OpenAI", lambda **kwargs: client)
    OpenAIProvider().generate(prompt="Return only one markdown table", model="gpt-4o-mini")
    assert [r.phase for r in ledger()] == ["request", "format_repair"]
    assert client.responses.create.call_args_list[0].kwargs == {
        "model": "gpt-4o-mini", "input": "Return only one markdown table"}


def test_gemini_key_rotation_records_error_then_retry_and_cumulative_stream(ledger, monkeypatch):
    from app.domains.ai_providers.gemini import GeminiProvider
    client = Mock()
    error = RuntimeError("503 unavailable")
    client.models.generate_content_stream.side_effect = [error, [NS(text="answer", response_id="stream",
        model_version="gemini-2.5-flash", usage_metadata=NS(prompt_token_count=10, candidates_token_count=2))]]
    monkeypatch.setattr("app.domains.ai_providers.gemini.get_gemini_api_keys", lambda: ["test-one", "test-two"])
    monkeypatch.setattr("app.domains.ai_providers.gemini.genai.Client", lambda **kwargs: client)
    result = GeminiProvider().generate(prompt="answer", model="gemini-2.5-flash")
    assert result.content == "answer"
    failed, recovered = ledger()
    assert failed.status == "error" and failed.tariff_estimated_cost_usd is None
    assert recovered.status == "success" and recovered.retry_of_attempt_id == failed.attempt_id
    assert recovered.reported_usage["output_tokens"] == 2


def test_search_records_one_call_per_fallback_and_no_fake_free_price(ledger, monkeypatch):
    from app.domains.ai_providers.tools import web_search
    import sys
    tavily = Mock()
    tavily.search.side_effect = RuntimeError("quota exceeded")
    ddg = Mock()
    ddg.text.return_value = [{"title": "result", "href": "https://example.test", "body": "private evidence"}]
    monkeypatch.setitem(sys.modules, "tavily", NS(TavilyClient=lambda **kwargs: tavily))
    monkeypatch.setitem(sys.modules, "duckduckgo_search", NS(DDGS=lambda: ddg))
    monkeypatch.setattr(web_search.settings, "tavily_api_key", "test-key")
    result = json.loads(web_search._web_search("private search", 5))
    assert len(result["results"]) == 1
    first, second = ledger()
    assert [first.actual_provider, second.actual_provider] == ["tavily", "duckduckgo"]
    assert [first.status, second.status] == ["error", "success"]
    assert first.tariff_estimated_cost_usd is None and second.tariff_estimated_cost_usd is None
    assert first.search_result_count is None and second.search_result_count == 1
    assert first.reuse_status == second.reuse_status == "not_reused"
    ddg.text.assert_called_once_with("private search", max_results=5)


def test_anthropic_cache_and_server_tool_usage_are_provider_reported(ledger, monkeypatch):
    from app.domains.ai_providers.anthropic import AnthropicProvider
    client = Mock()
    client.messages.create.return_value = NS(
        id="anthropic-response", model="claude-sonnet-4-6", content=[], stop_reason="end_turn",
        usage=NS(input_tokens=5, output_tokens=3, cache_read_input_tokens=2,
                 cache_creation_input_tokens=1, server_tool_use=NS(web_search_requests=1)),
    )
    monkeypatch.setattr("app.domains.ai_providers.anthropic.anthropic.Anthropic", lambda **kwargs: client)
    AnthropicProvider().generate(prompt="PRIVATE", model="claude-sonnet-4-6")
    row, = ledger()
    assert row.actual_provider == "anthropic" and row.finish_reason == "end_turn"
    assert row.reported_usage["cache_read_input_tokens"] == 2
    assert row.reported_usage["cache_write_input_tokens"] == 1
    assert row.reported_usage["server_tool_use"]["web_search_requests"] == 1
    assert row.provider_billed_cost_usd is None


def test_bing_http_error_is_recorded_before_search_fallback_handles_it(ledger, monkeypatch):
    from app.domains.ai_providers.tools import web_search
    upstream = Mock(status_code=503, headers={"x-request-id": "bing-request"})
    upstream.raise_for_status.side_effect = RuntimeError("private HTTP response body")
    monkeypatch.setattr(web_search.requests, "get", Mock(return_value=upstream))
    with pytest.raises(RuntimeError):
        web_search._bing_rss_search("private query", 5)
    row, = ledger()
    assert row.status == "error" and row.http_status == 503
    assert row.provider_request_id == "bing-request"
    assert row.instrumentation_scope == "http_call_redirects_unmeasured"
    assert row.tariff_estimated_cost_usd is None


def test_unexpected_metadata_cannot_fail_successful_upstream_response(ledger):
    class ChangedSdkResponse:
        @property
        def id(self):
            raise ValueError("private malformed metadata")
    response_object = ChangedSdkResponse()
    assert call(response_object) is response_object
    row, = ledger()
    assert row.status == "success" and row.reported_usage is None


def test_duplicate_upstream_response_across_users_keeps_ownership_without_second_charge(ledger):
    call(response("shared-response"))
    token = set_provider_usage_context(user_id=8, job_id=10, sample_id="other-user-sample")
    try:
        call(response("shared-response"))
    finally:
        reset_provider_usage_context(token)
    first, replay = ledger()
    assert first.user_id == 7 and replay.user_id == 8
    assert first.job_id == 9 and replay.job_id == 10
    assert first.attempt_id != replay.attempt_id
    assert replay.duplicate_of_attempt_id == first.attempt_id
    assert replay.tariff_estimated_cost_usd is None
    assert replay.reported_usage == first.reported_usage
    assert sum(r.tariff_estimated_cost_usd or 0 for r in ledger()) == pytest.approx(0.00014)


def test_partial_snapshot_does_not_erase_previously_reported_usage(ledger):
    with ApiAttempt(provider="gemini", model="model", request="secret", tariff_rates=RATES) as attempt:
        attempt.observe(NS(response_id="stream", usage_metadata=NS(
            prompt_token_count=100, candidates_token_count=10, cached_content_token_count=20)))
        attempt.observe(NS(response_id="stream", usage_metadata=NS(candidates_token_count=30)))
    row, = ledger()
    assert row.reported_usage["input_tokens"] == 100
    assert row.reported_usage["output_tokens"] == 30
    assert row.reported_usage["cache_read_input_tokens"] == 20
    assert row.tariff_estimated_cost_usd == pytest.approx(0.00016)


def test_malformed_exception_metadata_preserves_original_failure(ledger):
    class ChangedSdkError(RuntimeError):
        @property
        def status_code(self):
            raise ValueError("private malformed error metadata")

        @property
        def request_id(self):
            raise ValueError("private malformed request metadata")

    error = ChangedSdkError("original upstream failure")
    with pytest.raises(ChangedSdkError) as caught:
        with ApiAttempt(provider="openai", model="model", request="secret"):
            raise error
    row, = ledger()
    assert caught.value is error
    assert row.status == "error" and row.error_type == "ChangedSdkError"
    assert row.http_status is None and row.provider_request_id is None


def test_unhashable_request_still_invokes_upstream(ledger):
    recursive = []
    recursive.append(recursive)
    result = metered_call(lambda **kwargs: response(), provider="openai", meter_model="model",
                          request_hash_input=recursive, input="private")
    row, = ledger()
    assert result.id == "r1" and row.status == "success"
    assert row.prompt_hash is None


def test_commit_failure_does_not_change_success_or_expose_parameters(monkeypatch, caplog):
    monkeypatch.setattr(metering, "_persist_attempt", PERSIST)
    sessions = Mock()
    sessions.return_value.__enter__ = Mock(return_value=NS(
        add=Mock(), commit=Mock(side_effect=RuntimeError("PRIVATE BOUND PARAMETERS"))))
    sessions.return_value.__exit__ = Mock(return_value=False)
    monkeypatch.setattr(metering, "SyncSessionLocal", sessions)
    upstream = Mock(return_value=response())
    assert metered_call(upstream, provider="openai", meter_model="model") is upstream.return_value
    assert "telemetry persistence failed" in caplog.text
    assert "PRIVATE" not in caplog.text


def test_unfinished_start_stays_unknown(ledger):
    attempt = ApiAttempt(provider="openai", model="model", request="secret", tariff_rates=RATES)
    attempt.__enter__()  # Models abrupt process loss: no __exit__ event was appended.
    row, = ledger(None)
    assert row.event_kind == row.status == "started"
    assert row.finished_at is None and row.reported_usage is None
    assert row.tariff_estimated_cost_usd is None


def test_concurrent_duplicate_responses_and_event_replays_charge_once(monkeypatch, tmp_path):
    # A file database gives every thread a real independent transaction. The
    # unique indexes, rather than an application pre-check, arbitrate races.
    engine = create_engine(f"sqlite:///{tmp_path / 'concurrent-ledger.sqlite'}",
                           connect_args={"timeout": 10})
    ApiUsageAttemptEvent.__table__.create(engine)
    sessions = sessionmaker(bind=engine)
    monkeypatch.setattr(metering, "SyncSessionLocal", sessions)
    monkeypatch.setattr("socket.socket.connect", Mock(side_effect=AssertionError("offline test")))
    values = []
    for _ in range(4):
        with ApiAttempt(provider="openai", model="model", request="secret", tariff_rates=RATES) as attempt:
            attempt.observe(response("one-upstream-response"))
        values.append(deepcopy(attempt.values))
    gate = Barrier(8)

    def persist(values):
        gate.wait(timeout=10)
        PERSIST(values)

    try:
        with ThreadPoolExecutor(max_workers=8) as workers:
            list(workers.map(persist, values + values))
        with sessions() as db:
            rows = list(db.scalars(select(ApiUsageAttemptEvent)))
        assert len(rows) == 4
        canonical = [row for row in rows if row.duplicate_of_attempt_id is None]
        assert len(canonical) == 1
        assert all(row.duplicate_of_attempt_id in {None, canonical[0].attempt_id} for row in rows)
        assert sum(row.tariff_estimated_cost_usd or 0 for row in rows) == pytest.approx(0.00014)
        assert all(row.reported_usage["input_tokens"] == 100 for row in rows)
    finally:
        engine.dispose()


def test_tavily_records_aggregate_results_and_reported_units(ledger, monkeypatch):
    from app.domains.ai_providers.tools import web_search
    import sys
    tavily = Mock()
    tavily.search.return_value = {"request_id": "search-request", "usage": {"credits": 2},
        "results": [{"title": "PRIVATE TITLE", "url": "https://private.test", "content": "PRIVATE BODY"}]}
    monkeypatch.setitem(sys.modules, "tavily", NS(TavilyClient=lambda **kwargs: tavily))
    payload = json.loads(web_search._tavily_search("PRIVATE QUERY", 5))
    tavily.search.assert_called_once_with(
        query="PRIVATE QUERY", max_results=5, search_depth="advanced",
        include_answer=True, include_usage=True,
    )
    row, = ledger()
    assert len(payload["results"]) == row.search_result_count == 1
    assert row.reuse_status == "not_reused" and row.provider_request_id == "search-request"
    assert row.reported_usage["search_units"] == 2
    assert row.tariff_estimated_cost_usd is None and row.provider_billed_cost_usd is None
    assert row.tool_tariff_estimated_cost_usd is None and row.tool_provider_billed_cost_usd is None
    serialized = json.dumps({column.name: str(getattr(row, column.name)) for column in row.__table__.columns})
    assert "PRIVATE" not in serialized and "private.test" not in serialized


def test_empty_search_is_zero_results_with_unknown_price(ledger, monkeypatch):
    from app.domains.ai_providers.tools import web_search
    import sys
    ddg = Mock()
    ddg.text.return_value = []
    monkeypatch.setitem(sys.modules, "duckduckgo_search", NS(DDGS=lambda: ddg))
    web_search._ddg_search("private query", 5)
    row, = ledger()
    assert row.status == "success" and row.search_result_count == 0
    assert row.tariff_estimated_cost_usd is None


def test_bing_records_aggregate_parsed_results(ledger, monkeypatch):
    from app.domains.ai_providers.tools import web_search
    upstream = Mock(status_code=200, headers={}, text=(
        "<rss><channel><item><title>private result</title><link>https://private.test</link></item>"
        "<item></item></channel></rss>"))
    monkeypatch.setattr(web_search.requests, "get", Mock(return_value=upstream))
    payload = json.loads(web_search._bing_rss_search("private query", 5))
    row, = ledger()
    assert len(payload["results"]) == row.search_result_count == 1
    assert row.status == "success" and row.reuse_status == "not_reused"


def test_job_phase_does_not_hide_research_tool_rounds(ledger):
    with provider_usage_phase('initial_generation'):
        call(response('initial'),phase='request')
        call(response('research'),phase='tool_round')
    with provider_usage_phase('row_repair'):
        call(response('repair'),phase='request')
        call(response('repair-research'),phase='tool_round')
    assert [row.phase for row in ledger()]==['initial_generation','tool_round','row_repair','tool_round']


@pytest.mark.parametrize("usage,expected_status,reason", [
    (None, "omitted", "usage_omitted"),
    ({}, "omitted", "usage_omitted"),
    ({"unknown_private_field": "PRIVATE"}, "omitted", "usage_omitted"),
    ("PRIVATE", "malformed", "usage_malformed"),
    ({"input_tokens": "10", "output_tokens": True}, "malformed", "usage_malformed"),
    ({"input_tokens": -1, "output_tokens": float("nan")}, "malformed", "usage_malformed"),
    ({"input_tokens": 1.5, "output_tokens": float("inf")}, "malformed", "usage_malformed"),
    ({"input_tokens": 0}, "reported", "required_token_counts_missing"),
    ({"input_tokens": 0, "output_tokens": 0}, "reported", "listed_token_tariff"),
])
def test_coverage_preserves_omitted_malformed_partial_and_explicit_zero(ledger, usage, expected_status, reason):
    call(NS(usage=usage))
    row, = ledger()
    coverage = row.inferred_usage["coverage"]
    assert coverage["usage_status"] == expected_status
    assert coverage["cost_reason"] == reason
    assert (row.tariff_estimated_cost_usd == 0) if reason == "listed_token_tariff" else (row.tariff_estimated_cost_usd is None)
    assert row.provider_billed_cost_usd is None
    assert "PRIVATE" not in json.dumps(row.inferred_usage)
    assert "PRIVATE" not in json.dumps(row.reported_usage)


def test_unavailable_usage_before_response_is_separate_from_unpriced_usage(ledger):
    with pytest.raises(RuntimeError):
        metered_call(Mock(side_effect=RuntimeError("PRIVATE")), provider="openai", meter_model="m")
    metered_call(lambda: response("unpriced"), provider="openai", meter_model="unknown-tariff")
    unavailable, unpriced = ledger()
    assert unavailable.inferred_usage["coverage"]["usage_status"] == "unavailable"
    assert unavailable.inferred_usage["coverage"]["cost_reason"] == "usage_unavailable"
    assert unpriced.inferred_usage["coverage"]["usage_status"] == "reported"
    assert unpriced.inferred_usage["coverage"]["cost_status"] == "unpriced"
    assert unpriced.inferred_usage["coverage"]["cost_reason"] == "tariff_unavailable"
    assert unavailable.tariff_estimated_cost_usd is unpriced.tariff_estimated_cost_usd is None


def test_malformed_optional_metadata_does_not_hide_valid_usage(ledger):
    result = response()
    result.choices = 42  # Accessing choices[0] used to skip usage extraction.
    result.usage.prompt_tokens_details = "PRIVATE"
    call(result)
    row, = ledger()
    assert row.status == "success"
    assert row.reported_usage["input_tokens"] == 100
    assert row.tariff_estimated_cost_usd == pytest.approx(0.00014)
    assert row.inferred_usage["coverage"]["malformed_fields"] == ["prompt_tokens_details"]


def test_broken_usage_alias_does_not_hide_valid_fallback_or_zero(ledger):
    class Usage:
        @property
        def input_tokens(self):
            raise ValueError("PRIVATE")
        prompt_tokens = 0
        output_tokens = 0
        completion_tokens = 0

    call(NS(usage=Usage()))
    row, = ledger()
    assert row.reported_usage["input_tokens"] == row.reported_usage["output_tokens"] == 0
    assert row.tariff_estimated_cost_usd == 0
    assert row.inferred_usage["coverage"]["malformed_fields"] == ["input_tokens"]


@pytest.mark.parametrize("location", ["exception", "response", "body", "details"])
def test_failed_outcomes_keep_available_allowlisted_usage(ledger, location):
    error = RuntimeError("PRIVATE error body")
    error.status_code = 503
    error.request_id = "error-request"
    payload = {"usage": {"input_tokens": 8, "output_tokens": 0, "secret": "PRIVATE"}}
    if location == "exception":
        error.usage = payload["usage"]
    else:
        setattr(error, location, payload)
    with pytest.raises(RuntimeError) as caught:
        metered_call(Mock(side_effect=error), provider="openai", meter_model="m", tariff_rates=RATES)
    row, = ledger()
    assert caught.value is error
    assert row.status == "error" and row.http_status == 503
    assert row.reported_usage["input_tokens"] == 8 and row.reported_usage["output_tokens"] == 0
    assert row.tariff_estimated_cost_usd == pytest.approx(0.000008)
    assert row.provider_request_id == "error-request" and row.request_dedupe_key
    assert row.inferred_usage["coverage"]["usage_sources"] == ["exception" if location == "exception" else f"exception_{location}"]
    assert row.provider_billed_cost_usd is None
    assert "PRIVATE" not in json.dumps(row.reported_usage)


def test_partial_stream_usage_survives_malformed_error_metadata_and_cancellation(ledger):
    error = KeyboardInterrupt("PRIVATE")
    error.body = {"usage": {"input_tokens": "bad", "output_tokens": None}}
    with pytest.raises(KeyboardInterrupt):
        with ApiAttempt(provider="gemini", model="m", request="private", tariff_rates=RATES) as attempt:
            attempt.observe(NS(usage_metadata=NS(prompt_token_count=10, candidates_token_count=0)))
            raise error
    row, = ledger()
    assert row.status == "cancelled"
    assert row.reported_usage["input_tokens"] == 10 and row.reported_usage["output_tokens"] == 0
    assert row.tariff_estimated_cost_usd == pytest.approx(0.00001)
    assert row.inferred_usage["coverage"]["malformed_fields"] == ["input_tokens"]
    assert row.inferred_usage["coverage"]["usage_sources"] == ["exception_body", "response"]


def test_error_response_json_method_is_never_invoked(ledger):
    error = RuntimeError("PRIVATE")
    error.response = NS(status_code=503, headers={}, json=Mock(side_effect=AssertionError("do not parse bodies")))
    with pytest.raises(RuntimeError):
        metered_call(Mock(side_effect=error), provider="openai", meter_model="m")
    error.response.json.assert_not_called()
    row, = ledger()
    assert row.inferred_usage["coverage"]["usage_status"] == "omitted"
    assert row.reported_usage is row.tariff_estimated_cost_usd is None


def test_real_tavily_sdk_requests_only_usage_metadata_addition(ledger, monkeypatch):
    from tavily import TavilyClient
    from app.domains.ai_providers.tools import web_search
    import tavily

    client = TavilyClient(api_key="test-placeholder")
    upstream = Mock(status_code=200)
    upstream.json.return_value = {"usage": {"credits": 0}, "results": []}
    monkeypatch.setattr(client.session, "post", Mock(return_value=upstream))
    monkeypatch.setattr(tavily, "TavilyClient", lambda **kwargs: client)
    web_search._tavily_search("private query", 5)
    assert client.session.post.call_count == 1
    kwargs = client.session.post.call_args.kwargs
    assert json.loads(kwargs["data"]) == {
        "query": "private query", "max_results": 5, "search_depth": "advanced",
        "include_answer": True, "include_usage": True,
    }
    row, = ledger()
    assert row.reported_usage["search_units"] == 0
    assert row.inferred_usage["coverage"]["cost_status"] == "unpriced"
    assert row.tariff_estimated_cost_usd is row.tool_tariff_estimated_cost_usd is None


@pytest.mark.parametrize("second_value,expected", [(0, 0), (1, None)])
@pytest.mark.parametrize("other_container", [False, True])
def test_disagreeing_usage_aliases_and_containers_are_unknown_for_costing(ledger, second_value, expected, other_container):
    result = NS(usage={"input_tokens": 0, "output_tokens": 0})
    if other_container:
        result.usage_metadata = {"prompt_token_count": second_value}
    else:
        result.usage["prompt_tokens"] = second_value
    call(result)
    row, = ledger()
    assert row.reported_usage["input_tokens"] == expected
    assert row.tariff_estimated_cost_usd == expected
    assert row.inferred_usage["coverage"]["conflicting_fields"] == ([] if expected == 0 else ["input_tokens"])


def test_conflicting_cache_snapshot_never_turns_into_inferred_cache_price(ledger):
    rates = {"cache_hit_input": 0.1, "cache_miss_input": 1, "output": 2}
    with ApiAttempt(provider="deepseek", model="m", request="private", tariff_rates=rates) as attempt:
        attempt.observe(NS(usage={"input_tokens": 10, "output_tokens": 0, "prompt_cache_hit_tokens": 10}))
        attempt.observe(NS(usage={"cache_read_input_tokens": 0, "prompt_cache_hit_tokens": 10}))
    row, = ledger()
    assert row.reported_usage["input_tokens"] == 10
    assert row.reported_usage["cache_read_input_tokens"] is None
    assert row.tariff_estimated_cost_usd is None
    assert row.inferred_usage["coverage"]["conflicting_fields"] == ["cache_read_input_tokens"]
    assert row.inferred_usage["coverage"]["cost_reason"] == "invalid_tariff_or_usage"


def test_unpriced_error_does_not_suppress_later_available_estimate(ledger):
    error = RuntimeError("PRIVATE")
    error.request_id = "same-request"
    error.response = NS(status_code=503, headers={"x-request-id": "same-request"})
    with pytest.raises(RuntimeError):
        metered_call(Mock(side_effect=error), provider="openai", meter_model="m", tariff_rates=RATES)
    recovered = response("recovered")
    recovered._request_id = "same-request"
    call(recovered)
    failed, succeeded = ledger()
    assert failed.provider_request_id == succeeded.provider_request_id == "same-request"
    assert failed.tariff_estimated_cost_usd is None
    assert failed.request_dedupe_key is None
    assert succeeded.tariff_estimated_cost_usd == pytest.approx(0.00014)
    assert succeeded.duplicate_of_attempt_id is None


@pytest.mark.parametrize("first_is_error", [True, False])
def test_conflicting_priced_deliveries_preserve_evidence_and_flag_identity_ambiguity(ledger, first_is_error):
    if first_is_error:
        error = RuntimeError("PRIVATE")
        error.request_id = "same-request"
        error.usage = {"input_tokens": 0, "output_tokens": 0}
        with pytest.raises(RuntimeError):
            metered_call(Mock(side_effect=error), provider="openai", meter_model="m", tariff_rates=RATES)
    else:
        first = response("first", tokens_in=0, tokens_out=0)
        first._request_id = "same-request"
        call(first)
    positive = response("positive")
    positive._request_id = "same-request"
    call(positive)
    first, conflicting = ledger()
    assert first.reported_usage["input_tokens"] == 0
    assert first.tariff_estimated_cost_usd == 0
    assert first.status == ("error" if first_is_error else "success")
    assert conflicting.reported_usage["input_tokens"] == 100
    assert conflicting.duplicate_of_attempt_id == first.attempt_id
    assert conflicting.tariff_estimated_cost_usd is None
    assert conflicting.inferred_usage["coverage"]["cost_status"] == "ambiguous"
    assert conflicting.inferred_usage["coverage"]["cost_reason"] == "conflicting_provider_identity"
    assert conflicting.inferred_usage["coverage"]["conflicting_fields"] == ["input_tokens", "output_tokens"]
    from app.domains.api_usage.coverage import summarize_attempt_coverage
    coverage = summarize_attempt_coverage(ledger(None))
    assert coverage["summary"]["ambiguous_attempts"] == 2
    assert coverage["summary"]["known_token_estimate_subtotal_usd"] is None
    assert coverage["invoice_total_usd"] is None


def test_identity_alias_replay_compares_to_original_priced_evidence(ledger):
    first = response(None, tokens_in=0, tokens_out=0)
    first._request_id = "same-request"
    alias = response("new-response", tokens_in=0, tokens_out=0)
    alias._request_id = "same-request"
    conflicting = response("new-response")
    conflicting._request_id = None
    for item in (first, alias, conflicting):
        call(item)
    first_row, alias_row, conflict_row = ledger()
    assert alias_row.duplicate_of_attempt_id == conflict_row.duplicate_of_attempt_id == first_row.attempt_id
    assert conflict_row.inferred_usage["coverage"]["cost_status"] == "ambiguous"
    assert first_row.tariff_estimated_cost_usd == 0


def test_omitted_success_usage_does_not_suppress_later_available_estimate(ledger):
    call(response("same-id", usage=False))
    call(response("same-id"))
    omitted, priced = ledger()
    assert omitted.status == priced.status == "success"
    assert omitted.provider_request_id == priced.provider_request_id
    assert omitted.provider_response_id == priced.provider_response_id
    assert omitted.request_dedupe_key is omitted.response_dedupe_key is None
    assert priced.tariff_estimated_cost_usd == pytest.approx(0.00014)
    assert priced.duplicate_of_attempt_id is None


def test_decreasing_cumulative_usage_is_conflicting_not_a_lower_settled_cost(ledger):
    with ApiAttempt(provider="gemini", model="m", request="private", tariff_rates=RATES) as attempt:
        attempt.observe(NS(usage_metadata=NS(prompt_token_count=10, candidates_token_count=5)))
        attempt.observe(NS(usage_metadata=NS(prompt_token_count=10, candidates_token_count=0)))
        attempt.observe(NS(usage_metadata=NS(prompt_token_count=10, candidates_token_count=7)))
    row, = ledger()
    assert row.reported_usage["input_tokens"] == 10
    assert row.reported_usage["output_tokens"] is None
    assert row.tariff_estimated_cost_usd is None
    assert row.inferred_usage["coverage"]["conflicting_fields"] == ["output_tokens"]


def test_malformed_cache_usage_is_not_replaced_by_an_inferred_cache_split(ledger):
    rates = {"cache_hit_input": 0.1, "cache_miss_input": 1, "output": 2}
    with ApiAttempt(provider="deepseek", model="m", request="private", tariff_rates=rates) as attempt:
        attempt.observe(NS(usage={"input_tokens": 10, "output_tokens": 0, "prompt_cache_hit_tokens": -5}))
    row, = ledger()
    assert row.reported_usage["cache_read_input_tokens"] is None
    assert row.tariff_estimated_cost_usd is None
    assert row.inferred_usage["coverage"]["malformed_fields"] == ["cache_read_input_tokens"]
    assert row.inferred_usage["coverage"]["cost_reason"] == "invalid_tariff_or_usage"


def test_request_response_identity_bridge_quarantines_both_prior_estimates(ledger):
    request_only = response(None)
    request_only._request_id = "request-Q"
    response_only = response("response-R")
    response_only._request_id = None
    bridge = response("response-R")
    bridge._request_id = "request-Q"
    for item in (request_only, response_only, bridge):
        call(item)
    first, second, linked = ledger()
    assert first.tariff_estimated_cost_usd == second.tariff_estimated_cost_usd == pytest.approx(0.00014)
    assert linked.tariff_estimated_cost_usd is None
    assert linked.inferred_usage["coverage"]["cost_reason"] == "conflicting_provider_identity"
    assert linked.provider_request_id == first.provider_request_id
    assert linked.provider_response_id == second.provider_response_id
    from app.domains.api_usage.coverage import summarize_attempt_coverage
    coverage = summarize_attempt_coverage(ledger(None))
    assert coverage["summary"]["ambiguous_attempts"] == 3
    assert coverage["summary"]["known_token_estimate_subtotal_usd"] is None
