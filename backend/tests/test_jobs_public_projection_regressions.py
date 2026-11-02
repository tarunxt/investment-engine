"""Review-reproduced credential labels/auth schemes at actual public boundaries."""
import base64
from contextlib import asynccontextmanager
from copy import deepcopy
from datetime import datetime, timezone
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.domains.jobs.public_projection import public_text, public_value
from app.domains.jobs.schemas import JobResponse
from app.domains.jobs.output_contracts import SWING_COLUMNS
from test_google_sheets_output_contracts import export_job, job, markdown, stock

SENTINEL = "synthetic-private-review-sentinel"
BASIC = base64.b64encode(("synthetic-user:" + SENTINEL).encode()).decode()
CASES = [
    (f"SECRET_KEY={SENTINEL}", SENTINEL),
    (f"AWS_SECRET_ACCESS_KEY={SENTINEL}", SENTINEL),
    (f"Authorization: Basic {BASIC}", BASIC),
]


def source(message):
    now = datetime(2026, 11, 1, tzinfo=timezone.utc)
    return SimpleNamespace(id=41, user_id=7, prompt="retained financial prompt", response="retained financial output",
        provider="fixture", model="fixture", status="failed", created_at=now, updated_at=now,
        error_message=message + "; status=401 source_job_id=31", export_error=message,
        request_context_json={"diagnostic": message, "source_job_id": 31},
        runtime_metadata_json={"detail": message, "tokens_in": 0, "token_id": "financial-token-id", "currency": None},
        tokens_in=0, tokens_out=7, estimated_cost=0.0, web_search_used=False, web_search_queries=[], web_sources=[],
        export_status="failed", exported_at=None, exported_sheet_url=None)


@pytest.mark.parametrize("message,hidden", CASES)
def test_review_labels_at_dto_boundary_preserve_original_and_financial_fields(message, hidden):
    original = source(message)
    before = deepcopy(vars(original))
    projected = JobResponse.model_validate(original).model_dump(mode="json")
    assert hidden not in json.dumps(projected)
    assert "status=401" in projected["error_message"] and "source_job_id=31" in projected["error_message"]
    assert projected["runtime_metadata_json"]["token_id"] == "financial-token-id"
    assert projected["runtime_metadata_json"]["tokens_in"] == 0
    assert projected["runtime_metadata_json"]["currency"] is None
    assert projected["prompt"] == original.prompt and projected["response"] == original.response
    assert vars(original) == before


@pytest.mark.parametrize("message,hidden", CASES)
def test_review_labels_at_actual_ws_update_boundary(message, hidden, monkeypatch):
    from app.domains.jobs import tasks
    original = source(message)
    before = deepcopy(vars(original))
    redis = MagicMock()
    monkeypatch.setattr(tasks._sync_redis, "from_url", lambda *args, **kwargs: redis)
    tasks._publish_job_update(original)
    assert redis.publish.call_count == 2
    for call in redis.publish.call_args_list:
        projected = json.loads(call.args[1])
        assert hidden not in call.args[1]
        assert projected["response"] == original.response
        assert projected["tokens_in"] == 0 and projected["tokens_out"] == 7
        assert projected["runtime_metadata_json"]["token_id"] == "financial-token-id"
    assert vars(original) == before


@pytest.mark.asyncio
@pytest.mark.parametrize("message,hidden", CASES)
async def test_review_labels_at_actual_ws_initial_boundary(message, hidden, monkeypatch):
    from app.domains.jobs import ws_router
    original = source(message)
    before = deepcopy(vars(original))
    @asynccontextmanager
    async def session(): yield object()
    monkeypatch.setattr(ws_router, "AsyncSessionLocal", session)
    monkeypatch.setattr(ws_router, "PostgresJobRepository", lambda db: SimpleNamespace(get_for_user=AsyncMock(return_value=original)))
    monkeypatch.setattr(ws_router, "user_id_from_ws_token", AsyncMock(return_value=7))
    monkeypatch.setattr(ws_router, "relay_channel", AsyncMock())
    socket = SimpleNamespace(accept=AsyncMock(), send_json=AsyncMock(), close=AsyncMock())
    await ws_router.ws_job_detail(socket, 41, "synthetic-ws-ticket")
    socket.send_json.assert_awaited_once()
    projected = socket.send_json.await_args.args[0]
    assert hidden not in json.dumps(projected)
    assert projected["response"] == original.response
    assert vars(original) == before


@pytest.mark.parametrize("message,hidden", CASES)
def test_review_labels_at_actual_export_copy_boundary(message, hidden):
    content = markdown(SWING_COLUMNS, [stock("SYNTH")]) + (
        f"\n\nDiagnostic {message}; source_job_id=31\n\n"
        f"| Source | Detail |\n| --- | --- |\n| synthetic | {message} |\n")
    original = job(content, count=1)
    before = deepcopy(vars(original))
    result, append, _, _ = export_job(original)
    assert result["status"] == "completed"
    append.assert_called_once()
    assert hidden not in str(append.call_args)
    assert "SYNTH" in str(append.call_args) and "source_job_id=31" in str(append.call_args)
    assert vars(original) == before


@pytest.mark.parametrize("message,hidden", CASES)
def test_review_labels_plain_and_quoted_are_idempotent(message, hidden):
    safe = public_text(message)
    assert hidden not in safe
    assert public_text(safe) == safe
    quoted = public_text(json.dumps({message.split(":", 1)[0].split("=", 1)[0]: hidden}))
    assert hidden not in quoted
    assert public_text(quoted) == quoted


def test_text_and_mapping_share_label_policy_without_scrubbing_financial_assignments():
    original = {"SECRET_KEY": SENTINEL, "AWS_SECRET_ACCESS_KEY": SENTINEL,
                "source_job_id": 31, "token_id": "financial-id", "tokens_in": 0, "quantity": 7, "currency": None}
    projected = public_value(original)
    assert SENTINEL not in json.dumps(projected)
    for name in ("source_job_id", "token_id", "tokens_in", "quantity", "currency"):
        assert projected[name] == original[name]
    diagnostic = "token_id=financial-id tokens_in=0 quantity=7 strategy=Basic analysis source_job_id=31"
    assert public_text(diagnostic) == diagnostic


@pytest.mark.parametrize("label", ["SECRET_KEY", "AWS_SECRET_ACCESS_KEY"])
def test_safe_quoted_diagnostic_wrapper_cannot_hide_labeled_credentials(label):
    message = 'detail="' + label + '=' + SENTINEL + '"; source_job_id=31'
    projected = public_text(message)
    assert SENTINEL not in projected
    assert 'source_job_id=31' in projected
    assert projected.count('"') == 2
    assert public_text(projected) == projected


def test_flat_diagnostic_wrappers_are_scanned_without_recursive_depth_growth():
    message = "detail=" * 1500 + "SECRET_KEY=" + SENTINEL
    assert SENTINEL not in public_text(message)
