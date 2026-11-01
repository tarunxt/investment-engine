"""Synthetic historical diagnostics; no provider, persistence or retry calls."""
from copy import deepcopy
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from app.domains.jobs.schemas import JobResponse
from app.domains.jobs.output_contracts import source_hash
from app.shared.types import JobStatus
from test_output_contracts import REBALANCE_COLUMNS, rebalance_row, table


@pytest.mark.parametrize("extra_cells", [4, 6])
def test_historical_schema_projection_preserves_original_evidence(extra_cells):
    original = table(REBALANCE_COLUMNS, [rebalance_row()]) + " extra |" * extra_cells
    error = f"invalid output contract (row_width: Expected 29 cells; received {29 + extra_cells})"
    timestamp = datetime(2026, 10, 20, 10, 30, tzinfo=timezone.utc)
    metadata = {
        "failure_diagnostics": {"provider": "fixture", "model": "dated-model",
                                "retry_safe": False, "attempt": 1},
        "deterministic_output": {"response_hash": source_hash(original),
                                 "contract_hash": "saved-contract-hash",
                                 "finding_counts": {"row_width": 1},
                                 "findings": [{"code": "row_width", "message": error,
                                               "source": {"table": 0, "row": 0, "line": 3}}]},
    }
    prompt = ("[REBALANCE_FLOW:india]\nReturn only one markdown table.\n"
              + table(REBALANCE_COLUMNS, [])
              + "\n# Inputs considered at current time\n## 1. Latest Portfolio Snapshot\n"
              "| Exchange | Stock Symbol | Current Units |\n| --- | --- | --- |\n| NSE | ABC | 10 |\n"
              "\n## 2. Completed Swing Trade Runs\n")
    job = SimpleNamespace(id=71, provider="fixture", model="dated-model", prompt=prompt,
                          status=JobStatus.FAILED, response=original, error_message=error,
                          auto_rebalance_label="Fixture Run #8 (Rebalance Scan)",
                          runtime_metadata_json=metadata, created_at=timestamp, updated_at=timestamp)
    before = deepcopy(vars(job))

    view = JobResponse.model_validate(job)

    assert view.status == JobStatus.PARTIAL
    assert vars(job) == before
    assert view.created_at == view.updated_at == timestamp
    assert (view.provider, view.model) == (job.provider, job.model)
    assert view.auto_rebalance_label == job.auto_rebalance_label
    assert view.runtime_metadata_json["failure_diagnostics"] == metadata["failure_diagnostics"]
    recovery = view.runtime_metadata_json["partial_recovery"]
    assert recovery["original_deterministic_output"] == metadata["deterministic_output"]
    assert recovery["original_error"] == error
    assert recovery["original_response_hash"] == source_hash(original)
    counts = view.runtime_metadata_json["deterministic_output"]["finding_counts"]
    assert counts["row_width"] == counts["unaligned_rationale"] == 1
    assert counts["missing_field_excluded"] > 0
    assert "Unaligned source cells (not scored)" in view.response
    assert "extra" in view.response
    assert JobResponse.model_validate(view.model_dump()).model_dump() == view.model_dump()
