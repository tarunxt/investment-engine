"""Synthetic transport and durable SQLite admission; never invoke a provider."""
from types import SimpleNamespace

import pytest

from app.domains.api_usage import metering
from app.domains.jobs.resource_policy import MAX_PROMPT_CHARS, ResourceBlocked, validate_provider_input
from app.domains.rebalance_budget import ledger, policy, runtime
from test_spend_cap import bind, bound, job, reserve, state


def test_missing_workflow_context_rejects_before_bound_or_transport(monkeypatch):
    token = runtime._context.set(None)
    monkeypatch.setattr(metering, "get_provider_usage_context", lambda: SimpleNamespace(
        user_id=1, job_id=1, workflow_id="synthetic-workflow", execution_id=None,
        job_attempt=0, last_attempt={}, requested_provider=None, requested_model=None,
        phase=None))
    calls = []
    try:
        with pytest.raises(ledger.SpendCapBlocked, match="context is missing"):
            metering.metered_call(lambda: calls.append(1), provider="synthetic", meter_model="fixture")
        assert calls == []
    finally:
        runtime.reset_job(token)


@pytest.mark.parametrize("field,value", [("user_id", 2), ("job_id", 2), ("job_attempt", 1)])
def test_mismatched_attempt_cannot_use_another_grant(cap_db, field, value):
    token = runtime.configure_job(job(), 0)
    values = dict(user_id=1, job_id=1, job_attempt=0)
    values[field] = value
    try:
        with pytest.raises(ledger.SpendCapBlocked, match="conflicts"):
            runtime.before_call(provider="synthetic", model="fixture", request={},
                usage_context=SimpleNamespace(**values))
    finally:
        runtime.reset_job(token)


@pytest.mark.parametrize("retry", [0, 1, 20])
def test_crashed_dispatch_suspends_retry_without_renewing_allowance(cap_db, retry):
    factory, _ = cap_db
    scope = bind(factory)
    reserve(factory, scope, amount="4")  # Process died after durable admission.
    with pytest.raises(ledger.SpendCapBlocked, match="Prior job dispatch"):
        runtime.configure_job(job(), retry)
    spent, held, status = state(factory, scope)
    assert spent == 0 and held == 4 and status == "uncertain"
    with pytest.raises(ledger.SpendCapBlocked):
        reserve(factory, scope, key="retry-must-not-renew", amount="1")


def test_admission_inspects_real_dispatch_not_hash_projection(cap_db, monkeypatch):
    requests = []
    monkeypatch.setattr(policy, "resolve_bound", lambda **kw: (requests.append(kw["request"]), bound())[1])
    token = runtime.configure_job(job(), 0)
    try:
        metering.metered_call(lambda **kw: {"usage": {"input_tokens": 1, "output_tokens": 1}},
            provider="synthetic", meter_model="fixture", request_hash_input={"redacted": True},
            model="fixture", messages=[{"role": "user", "content": "full context"}])
        assert requests == [{"args": (), "kwargs": {"model": "fixture",
            "messages": [{"role": "user", "content": "full context"}]}}]
    finally:
        runtime.reset_job(token)


def test_ordinary_untagged_context_does_not_acquire_workflow_cap():
    token = runtime._context.set(None)
    try:
        assert runtime.before_call(provider="synthetic", model="fixture", request={},
            usage_context=SimpleNamespace(user_id=1, job_id=2, workflow_id=None)) is None
    finally:
        runtime.reset_job(token)


def test_admission_uses_actual_model_not_requested_model_telemetry(monkeypatch):
    observed = []
    monkeypatch.setattr(metering, "get_provider_usage_context", lambda: SimpleNamespace(
        user_id=1, job_id=1, workflow_id=None, execution_id=None,
        job_attempt=0, last_attempt={}, requested_provider="synthetic",
        requested_model="original-selection", phase=None))
    monkeypatch.setattr(runtime, "before_call", lambda **kw: observed.append(kw))
    monkeypatch.setattr(metering, "_persist_attempt", lambda values: None)
    with metering.ApiAttempt(provider="synthetic", model="actual-dispatch-model", request={}):
        pass
    assert observed[0]["model"] == "actual-dispatch-model"


def test_tool_schema_keys_are_counted_as_transmitted_input():
    with pytest.raises(ResourceBlocked, match="Expanded provider input"):
        validate_provider_input((), {"tools": [{"x" * (MAX_PROMPT_CHARS + 1): None}]})
    with pytest.raises(ResourceBlocked, match="keys must be strings"):
        validate_provider_input((), {"tools": [{1: "not a JSON string key"}]})
    validate_provider_input((), {"messages": [{"role": "user", "content": "unchanged"}],
        "tools": [{"name": "existing", "properties": {"ticker": {"type": "string"}}}]})
