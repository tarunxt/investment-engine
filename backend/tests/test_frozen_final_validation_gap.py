"""Audit 7 F05 probes: provenance must not certify arbitrary client assertions.

New captures reject the legacy schema; explicit legacy replay retains the old
structural gates. These tests exercise the real validator with DB lookup mocked.
"""
from copy import deepcopy
import hashlib
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import HTTPException

from app.domains.runs import frozen_final


@pytest.fixture(autouse=True)
def isolate_api_usage_telemetry():
    # This unit invokes no telemetry, router, provider, or task dispatch.
    yield


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def final_capture(monkeypatch):
    response = '{"symbol":"FIXTUREEQ","exchange":"NSE","action":"Hold"}'
    sources = [SimpleNamespace(id=10, prompt="rebalance"), SimpleNamespace(id=20, prompt="technical")]
    jobs = [SimpleNamespace(id=11, response=response, status="completed"),
            SimpleNamespace(id=21, response="{}", status="partial")]
    db = SimpleNamespace(execute=AsyncMock(side_effect=[
        SimpleNamespace(scalars=Mock(return_value=sources)),
        SimpleNamespace(scalars=Mock(return_value=jobs)),
    ]))
    monkeypatch.setattr(frozen_final, "validate_execution", AsyncMock())
    monkeypatch.setattr(frozen_final, "analysis_run_identity", lambda source: SimpleNamespace(
        market="india", stage="technical" if source.id == 20 else "rebalance"))
    payload = {
        "schema": "workflow-final-v1", "formula_version": "score-matrix-v1",
        "rebalance_run_ids": [10], "technical_run_id": 20,
        "response_hashes": {str(job.id): hashlib.sha256(job.response.encode()).hexdigest() for job in jobs},
        "input_listing_count": 1, "final_listing_count": 1,
        "rows": [{"exchange": "NSE", "symbol": "FIXTUREEQ", "score": None,
                  "action": "Hold", "estimate": None, "formula_inputs": {}}],
    }
    return db, payload


@pytest.mark.anyio
async def test_revision_mismatch_still_fails_closed(final_capture):
    db, payload = final_capture
    payload["response_hashes"] = {}
    with pytest.raises(HTTPException) as error:
        await frozen_final.validate_frozen_final(db, payload, user_id=7, portfolio="india", sequence=42, allow_legacy=True)
    assert error.value.status_code == 409
    assert error.value.detail == "Final source output revisions changed"


@pytest.mark.anyio
@pytest.mark.parametrize("mutation", [
    "score", "action", "estimate", "formula_inputs", "formula_version", "counts", "missing_rows", "listing",
])
async def test_new_captures_reject_legacy_policy_even_with_matching_revisions(final_capture, mutation):
    db, original = final_capture
    payload = deepcopy(original)
    if mutation == "score": payload["rows"][0]["score"] = 123456
    elif mutation == "action": payload["rows"][0]["action"] = "client-invented-action"
    elif mutation == "estimate": payload["rows"][0]["estimate"] = {"units": -999, "amount": 1e12}
    elif mutation == "formula_inputs": payload["rows"][0]["formula_inputs"] = {"calculatedScore": 999}
    elif mutation == "formula_version": payload["formula_version"] = "unimplemented-policy"
    elif mutation == "counts": payload.update(input_listing_count=-1, final_listing_count=999)
    elif mutation == "missing_rows": payload["rows"] = []
    elif mutation == "listing": payload["rows"][0]["symbol"] = "NOT_IN_SOURCE"
    # Incomplete/malformed source arithmetic cannot certify any of these claims.
    with pytest.raises(HTTPException) as error:
        await frozen_final.validate_frozen_final(db, payload, user_id=7, portfolio="india", sequence=42)
    assert (error.value.status_code, error.value.detail) == (422, "New final captures require workflow-final-v2 source recomputation")
    assert original == final_capture[1]


@pytest.mark.anyio
@pytest.mark.parametrize("score", [True, float("nan"), float("inf"), "1.5"])
async def test_nonfinite_or_non_numeric_score_fails_closed(final_capture, score):
    db, payload = final_capture
    payload["rows"][0]["score"] = score
    with pytest.raises(HTTPException) as error:
        await frozen_final.validate_frozen_final(db, payload, user_id=7, portfolio="india", sequence=42, allow_legacy=True)
    assert (error.value.status_code, error.value.detail) == (422, "Invalid final score")


@pytest.mark.anyio
@pytest.mark.parametrize("score", [None, 0, -3, 3])
async def test_existing_structural_validation_preserves_finite_and_unknown_scores(final_capture, score):
    db, payload = final_capture
    payload["rows"][0]["score"] = score
    before = deepcopy(payload)
    await frozen_final.validate_frozen_final(db, payload, user_id=7, portfolio="india", sequence=42, allow_legacy=True)
    assert payload == before
