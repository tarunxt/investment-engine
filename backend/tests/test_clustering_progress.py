import asyncio
import json
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import uuid4

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from app.domains.jobs.models import Job  # noqa: F401 - auth model relationships
from app.domains.prompts.models import Prompt  # noqa: F401

from app.domains.polymarket_auto_live.clustering_progress import (
    ClusteringProgressRequest, owned_run, progress_view,
)


def test_no_report_does_not_claim_job_is_running():
    assert progress_view(None)["status"] == "not_reported"


def test_stale_heartbeat_does_not_fabricate_failure_or_completion():
    now = datetime.now(UTC)
    payload = {"status": "researching", "updated_at": (now - timedelta(minutes=11)).isoformat()}
    result = progress_view(payload, now)
    assert result["stale"] and result["status"] == "researching"
    assert "stale" not in payload
    assert not progress_view({**payload, "status": "completed"}, now)["stale"]


def test_run_lookup_requires_ownership_and_lock_for_writes():
    execute = AsyncMock(return_value=SimpleNamespace(scalar_one_or_none=lambda: None))
    with pytest.raises(HTTPException) as error:
        asyncio.run(owned_run(SimpleNamespace(execute=execute), 91, uuid4(), lock=True))
    assert error.value.status_code == 404
    statement = str(execute.call_args.args[0])
    assert "user_id" in statement and "FOR UPDATE" in statement


def test_report_rejects_invalid_phase_sequence_and_unbounded_detail():
    base = {"attempt_id": str(uuid4()), "sequence": 0, "status": "collecting", "detail": "Started"}
    assert ClusteringProgressRequest(**base).status == "collecting"
    for patch in [{"sequence": -1}, {"status": "running_maybe"}, {"detail": "x" * 1201}, {"attempt_id": "invalid"}]:
        with pytest.raises(ValidationError):
            ClusteringProgressRequest(**{**base, **patch})


def test_delayed_duplicate_and_concurrent_reports_cannot_replace_current_progress(monkeypatch):
    from app.domains.polymarket_auto_live import clustering_progress as module
    attempt = uuid4()
    previous = {"attempt_id": str(attempt), "sequence": 3, "status": "deploying", "updated_at": datetime.now(UTC).isoformat(), "detail": "Deployment started"}
    session = SimpleNamespace(add=Mock(), commit=AsyncMock())
    class Context:
        async def __aenter__(self):
            return session
        async def __aexit__(self, *args):
            pass
    monkeypatch.setattr(module, "AsyncSessionLocal", Context)
    monkeypatch.setattr(module, "owned_run", AsyncMock())
    monkeypatch.setattr(module, "latest_log", AsyncMock(return_value=SimpleNamespace(details=json.dumps(previous))))
    request = ClusteringProgressRequest(attempt_id=attempt, sequence=1, status="researching", detail="Delayed report")
    result = asyncio.run(module.record_clustering_progress(uuid4(), request, SimpleNamespace(id=1)))
    assert result["status"] == "deploying"
    session.add.assert_not_called()
    with pytest.raises(HTTPException) as error:
        asyncio.run(module.record_clustering_progress(uuid4(), request.model_copy(update={"attempt_id": uuid4(), "sequence": 0, "status": "collecting"}), SimpleNamespace(id=1)))
    assert error.value.status_code == 409
    session.add.assert_not_called()
