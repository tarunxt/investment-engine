"""Actual schemas/ASGI/local child primitive; synthetic data, no provider I/O."""
import asyncio
import json
import sys
import threading
import time
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.domains.jobs.resource_body import ResourceBodyMiddleware
from app.domains.jobs.resource_policy import MAX_BODY_BYTES, MAX_PROMPT_CHARS, ResourceBlocked, validate_provider_input
from app.domains.jobs.resource_process import invoke_local_json_process, LocalInvocationUncertain
from app.domains.jobs.schemas import JobCreate
from app.domains.runs.schemas import RunCreate


def target():
    return {"provider": "synthetic", "model": "selected-model"}


@pytest.mark.parametrize("count,accepted", [(1, True), (8, True), (9, False)])
def test_targets_count_repeated_samples_without_rewriting(count, accepted):
    payload = {"prompt": "all financial context retained", "targets": [target()] * count}
    if accepted:
        obj = RunCreate(**payload)
        assert len(obj.targets) == count and obj.prompt == payload["prompt"]
    else:
        with pytest.raises(ValidationError): RunCreate(**payload)


@pytest.mark.parametrize("text,accepted", [("x" * MAX_PROMPT_CHARS, True),
    ("x" * (MAX_PROMPT_CHARS + 1), False), ("😀" * 524288, True), ("😀" * 524289, False)])
def test_prompt_has_both_character_and_utf8_byte_limits(text, accepted):
    for constructor, fields in [(JobCreate, target()), (RunCreate, {"targets": [target()]})]:
        if accepted:
            assert constructor(prompt=text, **fields).prompt == text
        else:
            with pytest.raises(ValidationError): constructor(prompt=text, **fields)


@pytest.mark.parametrize("root,path", [("", "/jobs"), ("", "/runs/"), ("/api", "/api/jobs")])
def test_chunked_body_rejects_before_handler_even_with_false_length(root, path):
    async def exercise():
        calls, messages = [], []
        async def downstream(*args): calls.append("handler")
        chunks = iter([{ "type": "http.request", "body": b"x" * (MAX_BODY_BYTES // 2), "more_body": True},
                       { "type": "http.request", "body": b"x" * (MAX_BODY_BYTES // 2 + 1)}])
        async def receive(): return next(chunks)
        async def send(message): messages.append(message)
        await ResourceBodyMiddleware(downstream)({"type": "http", "method": "POST", "path": path,
            "root_path": root, "headers": [(b"content-length", b"1")]}, receive, send)
        assert not calls and messages[0]["status"] == 413
        assert len(messages[1]["body"]) < 200
    asyncio.run(exercise())


def test_ordinary_untagged_request_remains_available_without_adapter_certification():
    app = FastAPI()
    app.add_middleware(ResourceBodyMiddleware)
    called = []
    @app.post('/jobs')
    async def submit(body: JobCreate):
        called.append(body)
        return {"accepted": True}
    with TestClient(app) as client:
        response = client.post('/jobs', json={"prompt": "unchanged strategy", **target()})
    assert response.status_code == 200 and response.json() == {"accepted": True}
    assert called[0].model == "selected-model"
    # This proves ingress availability only: no queue/provider call is made.


def test_expanded_system_and_tool_schema_are_included_without_query_projection():
    with pytest.raises(ResourceBlocked):
        validate_provider_input((), {"messages": [{"content": "financial context"}],
            "tools": [{"description": "x" * (MAX_PROMPT_CHARS + 1)}]})
    validate_provider_input((), {"messages": [{"content": "preserve context"}], "tools": [{"name": "existing"}]})


def command(code):
    return (sys.executable, '-I', '-c', code)


def test_local_process_success_returns_exact_json_without_provider_work():
    data = {"holdings": [{"symbol": "SYNTHETIC", "cash": None}], "selected_model": "same"}
    result = invoke_local_json_process(command('import sys,json; print(json.dumps(json.load(sys.stdin)))'), data,
        remaining_job_seconds=3, request_seconds=2)
    assert result == data


@pytest.mark.parametrize("reason", ['deadline', 'cancel'])
def test_local_timeout_and_cancel_stop_process_without_replay(reason):
    cancelled = threading.Event()
    timer = threading.Timer(.15, cancelled.set) if reason == 'cancel' else None
    if timer: timer.start()
    started = time.monotonic()
    try:
        with pytest.raises(LocalInvocationUncertain):
            invoke_local_json_process(command('import sys,time; sys.stdin.read(); time.sleep(30)'), {},
                remaining_job_seconds=3, request_seconds=.2 if reason == 'deadline' else 2,
                cancel_event=cancelled)
    finally:
        if timer: timer.join()
    assert time.monotonic() - started < 2


def test_no_local_spawn_after_original_allowance_expired_or_cancelled():
    cancelled = threading.Event(); cancelled.set()
    for kwargs in [{"remaining_job_seconds": 0}, {"remaining_job_seconds": 2, "cancel_event": cancelled}]:
        with patch('subprocess.Popen') as spawn, pytest.raises(ResourceBlocked):
            invoke_local_json_process(command('raise AssertionError'), {}, **kwargs)
        spawn.assert_not_called()


@pytest.mark.parametrize("code", ['print("not-json")', 'raise RuntimeError("synthetic private stderr must not escape")',
    'print("[1,2]")', 'print("x"*2000)'])
def test_invalid_or_excess_results_never_return_partial_or_external_error_text(code):
    with pytest.raises(LocalInvocationUncertain) as failure:
        invoke_local_json_process(command(code), {}, remaining_job_seconds=3, request_seconds=2,
            maximum_wire_bytes=1000)
    assert 'synthetic private stderr' not in str(failure.value)


@pytest.mark.parametrize('endpoint,parameter', [('openai.responses','max_output_tokens'),
    ('openai.chat','max_completion_tokens'),('deepseek.chat','max_tokens'),('anthropic.messages','max_tokens')])
def test_output_preparation_preserves_model_full_context_and_stricter_existing_ceiling(endpoint, parameter):
    from app.domains.jobs.resource_request import bounded_token_request
    payload = {'model':'selected-model', 'messages':[{'content':'complete unchanged holdings/context'}], parameter:8096}
    result = bounded_token_request(endpoint,payload,remaining_tokens=48000,remaining_seconds=75,sdk_retries=0)
    assert result[parameter] == 8096 and result['timeout'] == 75
    assert result['model'] == payload['model'] and result['messages'] is payload['messages']
    assert 'timeout' not in payload
    assert bounded_token_request(endpoint,payload,remaining_tokens=3000,remaining_seconds=10,sdk_retries=0)[parameter] == 3000


def test_unknown_native_streaming_or_hidden_retry_contract_remains_unqualified():
    from app.domains.jobs.resource_request import bounded_token_request
    for endpoint, retries in [('gemini.streaming',0),('unknown',0),('deepseek.chat',2),('openai.responses',True)]:
        with pytest.raises(ResourceBlocked):
            bounded_token_request(endpoint,{'messages':[{'content':'same prompt'}]},remaining_tokens=12000,remaining_seconds=120,sdk_retries=retries)


def test_tool_batch_limit_is_checked_before_dispatch_without_rewriting_calls():
    from app.domains.jobs.resource_request import validate_tool_batch
    calls = [{'query': 'synthetic public company query'}] * 4
    assert validate_tool_batch(calls,tools_already_reserved=28) == 32
    for batch, used in [(calls*2,0),(calls,29),(None,0),(calls,True)]:
        with pytest.raises(ResourceBlocked): validate_tool_batch(batch,tools_already_reserved=used)
    assert calls[0]['query'] == 'synthetic public company query'


def test_partial_or_unknown_usage_never_frees_a_reserved_output_allowance():
    from app.domains.jobs.resource_request import remaining_reserved_output
    assert remaining_reserved_output(24000,12000,7000) == 19000
    for used in [None, True, -1, 12001]:
        with pytest.raises(ResourceBlocked): remaining_reserved_output(24000,12000,used)


def test_queued_time_is_distinct_but_retry_cannot_extend_first_execution_deadline():
    from app.domains.jobs.resource_policy import new_resources,start_resources,require_resources
    admitted = new_resources(100)
    started = start_resources(admitted,10000)
    assert started['deadline'] == 10600 and started['admitted_at'] == 100
    with pytest.raises(ResourceBlocked): start_resources(started,10100)
    assert require_resources(started,10599)['deadline'] == 10600
    with pytest.raises(ResourceBlocked): require_resources(started,10600)


def test_pipe_holding_descendant_is_not_mistaken_for_completed_invocation(tmp_path):
    marker = tmp_path / 'unexpected-descendant-work'
    code = ("import os,sys,time; sys.stdin.read(); child=os.fork(); "
        f"exec(\"if child == 0:\\n time.sleep(.5)\\n open({str(marker)!r},'w').write('unexpected')\\n os._exit(0)\\nelse:\\n print('{{}}',flush=True)\\n os._exit(0)\")")
    with pytest.raises(LocalInvocationUncertain):
        invoke_local_json_process(command(code),{},remaining_job_seconds=3,request_seconds=.15)
    time.sleep(.55)
    assert not marker.exists()


@pytest.mark.parametrize('provider,model', [
    ('openai', 'selected-model'), ('deepseek', 'deepseek-v4-flash'),
    ('anthropic', 'selected-model'), ('gemini', 'selected-model'), ('tavily', None),
])
def test_request_helpers_never_certify_an_inr_adapter(provider, model):
    from app.domains.rebalance_budget.policy import resolve_bound
    from app.domains.rebalance_budget.ledger import SpendCapBlocked
    with pytest.raises(SpendCapBlocked, match='No paid request was dispatched'):
        resolve_bound(provider=provider, model=model, request={'bounded_helper_is_not_certification': True})
