from __future__ import annotations

import json
import re
from typing import Any, Mapping

_MAX_PROVIDER_BODY_CHARS = 4_000
_SENSITIVE_VALUE_PATTERN = re.compile(
    r'(?i)(authorization|api[-_ ]?key|token|secret|password|cookie)\s*[:=]\s*([^,;\s]+)'
)
_CORRELATION_HEADERS = (
    "x-request-id",
    "request-id",
    "x-correlation-id",
    "correlation-id",
    "traceparent",
    "x-amzn-requestid",
    "cf-ray",
)


def _redact_and_truncate(value: object, limit: int = _MAX_PROVIDER_BODY_CHARS) -> str | None:
    if value is None:
        return None
    if isinstance(value, (dict, list, tuple)):
        try:
            rendered = json.dumps(value, ensure_ascii=False, default=str)
        except (TypeError, ValueError):
            rendered = str(value)
    else:
        rendered = str(value)
    rendered = _SENSITIVE_VALUE_PATTERN.sub(lambda match: f"{match.group(1)}=[REDACTED]", rendered)
    rendered = rendered.strip()
    if not rendered:
        return None
    return rendered if len(rendered) <= limit else f"{rendered[:limit]}… [truncated]"


def _response_headers(response: object | None) -> Mapping[str, Any]:
    headers = getattr(response, "headers", None)
    return headers if isinstance(headers, Mapping) else {}


def _header_value(headers: Mapping[str, Any], name: str) -> str | None:
    for key, value in headers.items():
        if str(key).lower() == name:
            return _redact_and_truncate(value, 500)
    return None


def _provider_response_body(exc: Exception, response: object | None) -> str | None:
    body = getattr(exc, "body", None)
    if body is None and response is not None:
        body = getattr(response, "text", None)
    if body is None and response is not None:
        try:
            body = response.json()
        except Exception:
            body = None
    return _redact_and_truncate(body)


def build_failure_diagnostics(
    exc: Exception,
    *,
    provider: str | None,
    model: str | None,
    job_id: int,
    run_id: int | None,
    task_id: str | None,
    attempt: int,
    retry_safe: bool,
) -> dict[str, object]:
    response = getattr(exc, "response", None)
    status = getattr(exc, "status_code", None)
    if status is None and response is not None:
        status = getattr(response, "status_code", None)
    try:
        http_status = int(status) if status is not None else None
    except (TypeError, ValueError):
        http_status = None

    headers = _response_headers(response)
    correlation_id = next(
        (
            value
            for header in _CORRELATION_HEADERS
            if (value := _header_value(headers, header))
        ),
        None,
    )
    exception_type = f"{exc.__class__.__module__}.{exc.__class__.__name__}"
    safe_task_id = str(task_id).strip() if task_id else "unavailable"
    trace_reference = f"ai-job:{job_id}/task:{safe_task_id}/attempt:{attempt + 1}"

    return {
        "provider": provider,
        "model": model,
        "job_id": job_id,
        "run_id": run_id,
        "http_status": http_status,
        "provider_response_body": _provider_response_body(exc, response),
        "correlation_id": correlation_id,
        "exception_type": exception_type,
        "exception_message": _redact_and_truncate(exc),
        "trace_reference": trace_reference,
        "retry_safe": retry_safe,
        "attempt": attempt + 1,
    }


def merge_failure_diagnostics(
    runtime_metadata: dict[str, object] | None,
    diagnostics: dict[str, object],
) -> dict[str, object]:
    merged = dict(runtime_metadata or {})
    merged["failure_diagnostics"] = diagnostics
    return merged
