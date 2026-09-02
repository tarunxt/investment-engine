from app.domains.jobs.failure_diagnostics import (
    build_failure_diagnostics,
    merge_failure_diagnostics,
)


class FakeResponse:
    status_code = 429
    headers = {"x-request-id": "req-123", "authorization": "Bearer hidden"}
    text = '{"error":"quota","api_key":"super-secret"}'


class FakeProviderError(RuntimeError):
    status_code = 429
    response = FakeResponse()


def test_build_failure_diagnostics_captures_safe_provider_context():
    diagnostics = build_failure_diagnostics(
        FakeProviderError("quota exceeded token=private"),
        provider="openai",
        model="gpt-test",
        job_id=41,
        run_id=17,
        task_id="celery-abc",
        attempt=2,
        retry_safe=True,
    )

    assert diagnostics["provider"] == "openai"
    assert diagnostics["model"] == "gpt-test"
    assert diagnostics["job_id"] == 41
    assert diagnostics["run_id"] == 17
    assert diagnostics["http_status"] == 429
    assert diagnostics["correlation_id"] == "req-123"
    assert diagnostics["exception_type"].endswith(".FakeProviderError")
    assert diagnostics["trace_reference"] == "ai-job:41/task:celery-abc/attempt:3"
    assert diagnostics["retry_safe"] is True
    assert "super-secret" not in str(diagnostics["provider_response_body"])


def test_merge_failure_diagnostics_preserves_existing_runtime_metadata():
    merged = merge_failure_diagnostics(
        {"latency_ms": 12},
        {"job_id": 9, "retry_safe": False},
    )

    assert merged["latency_ms"] == 12
    assert merged["failure_diagnostics"] == {"job_id": 9, "retry_safe": False}
