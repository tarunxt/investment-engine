"""No provider I/O: real SDK configuration and durable preparation boundaries."""
from dataclasses import replace
from types import SimpleNamespace

import pytest
import httpx
from openai import OpenAI

from app.domains.rebalance_budget import runtime, policy, execution
from app.domains.rebalance_budget.ledger import SpendCapBlocked
from app.domains.rebalance_budget.execution_models import RebalanceExecution, RebalanceResourceReservation
from app.domains.jobs.resource_policy import ResourceBlocked, validate_provider_input
from app.domains.api_usage.metering import metered_call
from test_spend_cap import job, bound


def test_real_sdk_copy_has_zero_retries_and_preserves_ordinary_client(cap_db):
    client = OpenAI(api_key="synthetic-not-a-credential", http_client=httpx.Client(transport=httpx.MockTransport(lambda request: pytest.fail("No provider I/O permitted")), trust_env=False), max_retries=2)
    assert runtime.scoped_client(client) is client
    token = runtime.configure_job(job(), 0)
    try:
        scoped = runtime.scoped_client(client)
        assert scoped.max_retries == 0 and client.max_retries == 2
        prepared = runtime.prepare_request("openai.responses", scoped.responses.create, (),
            {"model": "unchanged-selection", "input": "complete unchanged financial context"})
        assert prepared["model"] == "unchanged-selection"
        assert prepared["input"] == "complete unchanged financial context"
        assert prepared["max_output_tokens"] == 12000 and 0 < prepared["timeout"] <= 120
        scoped.close()
    finally:
        runtime.reset_job(token)
        client.close()


@pytest.mark.parametrize("kwargs", [{"max_output_tokens": 12001}, {"max_output_tokens": True}])
def test_cannot_silently_reduce_explicit_output_request(cap_db, kwargs):
    client = OpenAI(api_key="synthetic-not-a-credential", http_client=httpx.Client(transport=httpx.MockTransport(lambda request: pytest.fail("No provider I/O permitted")), trust_env=False), max_retries=0)
    token = runtime.configure_job(job(), 0)
    try:
        with pytest.raises(SpendCapBlocked, match="quality-reducing"):
            runtime.prepare_request("openai.responses", client.responses.create, (),
                {"model": "unchanged", "input": "preserved", **kwargs})
    finally:
        runtime.reset_job(token)
        client.close()


def test_unknown_transport_retries_reject_before_dispatch(cap_db):
    client = OpenAI(api_key="synthetic-not-a-credential", http_client=httpx.Client(transport=httpx.MockTransport(lambda request: pytest.fail("No provider I/O permitted")), trust_env=False), max_retries=2)
    token = runtime.configure_job(job(), 0)
    try:
        with pytest.raises(ResourceBlocked, match="Hidden transport retries"):
            runtime.prepare_request("openai.responses", client.responses.create, (), {"input": "unchanged"})
    finally:
        runtime.reset_job(token)
        client.close()


def test_resource_and_money_reservation_commit_before_mock_transport(cap_db, monkeypatch):
    factory, _ = cap_db
    calls = []
    b = replace(bound(), confirmed_resources=lambda evidence: (2, 0))
    monkeypatch.setattr(policy, "resolve_bound", lambda **kw: b)
    token = runtime.configure_job(job(), 0)
    def mock_transport():
        with factory() as db:
            row = db.get(RebalanceExecution, 1)
            assert row.output_reserved == b.limits.generated_tokens
            assert row.fence_token is not None
        calls.append(1)
        return {"usage": {"input_tokens": 1, "output_tokens": 2}}
    try:
        metered_call(mock_transport, provider="synthetic", meter_model="fixture")
        with factory() as db:
            row = db.get(RebalanceExecution, 1)
            assert (row.output_used, row.output_reserved) == (2, 0)
        assert calls == [1]
    finally:
        runtime.reset_job(token)


def test_ordinary_arguments_are_not_changed():
    kwargs = {"input": "unchanged", "max_output_tokens": 50000}
    assert runtime.prepare_request("unknown", lambda: None, (), kwargs) is kwargs


@pytest.mark.parametrize("value", [[0] * 600000, [None] * 250000, [False] * 210000])
def test_expanded_nonstrings_and_container_separators_count(value):
    with pytest.raises(ResourceBlocked, match="Expanded provider input"):
        validate_provider_input((), {"messages": value})


def test_nonfinite_numbers_cannot_claim_finite_serialized_envelope():
    with pytest.raises(ResourceBlocked, match="finite UTF-8 JSON"):
        validate_provider_input((), {"tools": [{"value": float("nan")}]})


def test_complete_returned_tool_batch_rejected_before_any_dispatch(cap_db):
    token = runtime.configure_job(job(), 0)
    dispatched = []
    calls = [SimpleNamespace(name="synthetic") for _ in range(5)]
    try:
        with pytest.raises(ResourceBlocked, match="Original job tool allowance"):
            runtime.check_tool_batch(calls)
            for call in calls:
                dispatched.append(call)
        assert not dispatched and len(calls) == 5
    finally:
        runtime.reset_job(token)
