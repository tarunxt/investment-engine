"""Integrated schema/HTTP checks; synthetic ASGI only, no runtime diagnostics."""
import json

import httpx
import pytest
from fastapi import FastAPI
from fastapi.encoders import jsonable_encoder
from sqlalchemy.dialects import postgresql

import app.models  # canonical mappings; never connects
from app.core import recovery
from app.domains.health import execution, execution_reader, router
from app.domains.jobs.models import Job
from app.infrastructure.database.outbox.models import OutboxMessage
from app.infrastructure.database.outbox.dispatch import TOPIC


@pytest.mark.asyncio
@pytest.mark.parametrize("contained", [False, True])
async def test_actual_http_default_remains_unknown_without_trusted_reader(contained, monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("Default HTTP diagnostics must not acquire a runtime session")
    monkeypatch.setattr(router, "AsyncSessionLocal", forbidden)
    monkeypatch.setattr(recovery, "recovery_mode", lambda: contained)
    app = FastAPI()
    app.include_router(router.router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://synthetic") as client:
        response = await client.get("/health/execution?actor_id=7")
    assert response.status_code == 200
    result = response.json()
    assert result["status"] == "unknown" and result["policy"] == "advisory"
    assert result["deployment_gate"] is False
    assert result["pending_count"] is None and result["exhausted_retry_count"] is None
    assert result["acceptance_threshold"] is None
    if contained:
        assert result["financial_services"] == "intentional_containment"
    # The unconnected HTTP default is not a claim to have sampled the SQL reader.
    assert "sample_size" not in result and "sample_counts" not in result


def test_projection_compiles_against_actual_integrated_job_outbox_schema():
    query = execution_reader.projection_query(Job.__table__, OutboxMessage.__table__, actor_id=7, recovery=True)
    compiled = query.compile(dialect=postgresql.dialect())
    assert execution_reader.TOPIC == TOPIC
    assert 7 in compiled.params.values() and TOPIC in compiled.params.values()
    assert execution_reader.ROW_LIMIT in compiled.params.values()
    assert len(query.selected_columns) == 5
    selected = " ".join(str(c) for c in query.selected_columns)
    for private in ("payload", "owner_token", "prompt", "response", "claim_token"):
        assert private not in selected
    assert "jobs.user_id" in str(compiled) and "outbox.topic" in str(compiled)
    assert "FOR UPDATE" not in str(compiled)


def test_json_consumer_distinguishes_unavailable_from_observed_empty():
    unknown = json.loads(json.dumps(jsonable_encoder(execution_reader._unknown()), allow_nan=False))
    empty = json.loads(json.dumps(jsonable_encoder(execution.summarize_durable([], now=100)), allow_nan=False))
    assert unknown["sample_size"] is None
    assert all(v is None for v in unknown["sample_counts"].values())
    assert empty["sample_size"] == 0 and all(v == 0 for v in empty["sample_counts"].values())
    assert unknown["sample_counts"].keys() == empty["sample_counts"].keys()
    for evidence in (unknown, empty):
        assert evidence["scope_complete"] is False
        assert evidence["consumer"] == evidence["receipt"] == evidence["service_state"] == "unknown"
