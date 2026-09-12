import asyncio
import json

from starlette.requests import Request

from app.main import general_exception_handler


def _request(*, correlation_id: str | None = None) -> Request:
    headers = []
    if correlation_id:
        headers.append((b"x-correlation-id", correlation_id.encode("utf-8")))
    request = Request(
        {
            "type": "http",
            "http_version": "1.1",
            "method": "GET",
            "scheme": "https",
            "path": "/bullpen-ai/run-audits/test-run-id",
            "raw_path": b"/bullpen-ai/run-audits/test-run-id",
            "query_string": b"",
            "headers": headers,
            "client": ("127.0.0.1", 1234),
            "server": ("testserver", 443),
        }
    )
    if correlation_id:
        request.state.correlation_id = correlation_id
    return request


def test_unhandled_error_returns_safe_reference_id() -> None:
    response = asyncio.run(
        general_exception_handler(
            _request(correlation_id="test-correlation-id"),
            RuntimeError("sensitive internal failure"),
        )
    )

    body = json.loads(response.body)
    assert response.status_code == 500
    assert body == {
        "error": "INTERNAL_SERVER_ERROR",
        "message": "An unexpected error occurred",
        "details": {"correlation_id": "test-correlation-id"},
    }
    assert "sensitive internal failure" not in response.body.decode("utf-8")
