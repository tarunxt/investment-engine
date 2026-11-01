"""Synthetic software fixtures; not investment validation."""
from copy import deepcopy
import json
from pathlib import Path
import subprocess
import sys
import pytest
from app.domains.recommendation_audit.deterministic import digest
from app.domains.recommendation_audit.evaluation import replay, sensitivity
from app.domains.recommendation_audit.schemas import Formula, SCORE_FIELDS
from app.domains.recommendation_audit.validation import (
    COST_COMPONENTS, POLICY_FIELDS, ValidationContract, contract_gaps,
    cost_coverage, inventory, lineage_gaps, split_gaps, validation_report,
)


def record():
    return {"id": "synthetic-1", "market": "us", "security_id": "synthetic-security",
            "identity_verified": True, "provenance": "prospective",
            "decision_at": "2024-01-02T12:00:00Z", "original_completion_at": "2024-01-02T11:00:00Z",
            "inputs_available_at": "2024-01-02T10:00:00Z", "publication_at": "2024-01-02T09:00:00Z",
            "adjustment_available_at": "2024-01-01T00:00:00Z", "fx_available_at": "2024-01-01T00:00:00Z",
            "prompt_hash": "a" * 64, "prompt_version": "synthetic-v1", "formula_hash": "b" * 64,
            "source_hashes": ["c" * 64], "input_id": "synthetic-input", "output_ids": ["synthetic-output"],
            "corporate_action_provenance": "synthetic-no-actions", "share_unit_provenance": "synthetic-shares",
            "fx_provenance": "synthetic-same-currency", "population_state": "abstained"}


def population():
    return {"attempted": 1, "source_manifest_hash": "d" * 64, "universe_manifest_hash": "e" * 64,
            "selection_limits": 20, "pagination": "synthetic-one-page", "includes_delisted_ceased_expired": True}


def test_unapproved_contract_is_not_validation():
    contract = ValidationContract(version="synthetic-v1")
    assert all(contract.choices[key] is None for key in POLICY_FIELDS)
    data = {"records": [record()], "population": population()}
    before = deepcopy(data)
    result = validation_report(data)
    assert result["status"] == "not_established"
    assert "contract.benchmark.unset" in result["reasons"]
    assert result["corpus_hash"] == digest(data["records"])
    assert data == before


def test_approval_order_and_timezone():
    with pytest.raises(ValueError, match="Timezone required"):
        ValidationContract(version="v1", approved_at="2024-01-01T00:00:00")
    contract = ValidationContract(version="v1", approved_at="2024-01-03T00:00:00Z",
                                  frozen_at="2024-01-02T00:00:00Z", first_result_inspected_at="2024-01-02T00:00:00Z")
    assert "contract.approved_at.not_before_inspection" in contract_gaps(contract)
    assert "contract.frozen_at.not_before_inspection" in contract_gaps(contract)


@pytest.mark.parametrize("key,value,reason", [
    ("original_completion_at", None, "original_completion_at_unknown_or_future"),
    ("inputs_available_at", "2024-01-03T00:00:00Z", "inputs_available_at_unknown_or_future"),
    ("publication_at", "2024-01-03T00:00:00Z", "publication_at_unknown_or_future"),
    ("publication_at", "2024-01-01T00:00:00", "publication_at_unknown_or_future"),
    ("adjustment_available_at", None, "adjustment_available_at_unknown_or_future"),
    ("fx_available_at", "2025-01-01T00:00:00Z", "fx_available_at_unknown_or_future"),
    ("identity_verified", False, "canonical_identity_unverified"),
    ("provenance", "legacy_observed", "not_original_decision_time_evidence"),
    ("provenance", "calculation_observed", "not_original_decision_time_evidence"),
    ("prompt_version", None, "prompt_version_missing_or_invalid"),
    ("corporate_action_provenance", None, "corporate_action_provenance_missing"),
    ("share_unit_provenance", None, "share_unit_provenance_missing"),
])
def test_lineage_failures_preserve_original(key, value, reason):
    original = record()
    assert lineage_gaps(original) == []
    original[key] = value
    before = deepcopy(original)
    row = inventory([original], population())["records"][0]
    assert reason in row["lineage_gaps"] and not row["lineage_checks_passed"]
    assert original == before


def test_denominator_and_privacy_projection():
    original = record() | {"user_id": 123, "holdings_snapshot": {"amount": 987654}, "samples": [{"row": {"current_units": 999}}]}
    result = inventory([original])
    assert not result["reconciled"] and result["state_counts"] == {"abstained": 1}
    projected = result["records"][0]["evidence"]
    assert not ({"holdings_snapshot", "user_id", "samples"} & set(projected))
    assert inventory([original], population())["reconciled"]
    assert not inventory([original, original], population() | {"attempted": 2})["reconciled"]


def test_split_overlap_and_dependency_fail_closed():
    kwargs = {"frozen_at": "2023-12-01T00:00:00Z", "embargo_seconds": 0, "embargo_reason": "synthetic nonoverlap"}
    rows = [{"partition": part, "dependency_group": part, "decision_at": f"2024-0{month}-02T00:00:00Z", "outcome_end_at": f"2024-0{month}-03T00:00:00Z", "first_result_inspected_at": "2024-04-01T00:00:00Z"}
            for month, part in enumerate(("develop", "tune", "test"), 1)]
    assert split_gaps(rows, **kwargs) == []
    changed = deepcopy(rows); changed[0]["outcome_end_at"] = rows[2]["decision_at"]
    assert "chronology_overlap_or_embargo_violation" in split_gaps(changed, **kwargs)
    changed = deepcopy(rows); changed[2]["dependency_group"] = "develop"
    assert "dependency_crosses_partition" in split_gaps(changed, **kwargs)
    assert "embargo_not_justified" in split_gaps(rows)


def test_cost_zero_missing_partial():
    costs = {key: {"value": "0", "coverage": "complete", "source_hash": "a" * 64} for key in COST_COMPONENTS}
    assert cost_coverage(costs)["complete"]
    del costs["tax"]; costs["fx"]["coverage"] = "partial"
    result = cost_coverage(costs)
    assert not result["complete"]
    assert result["components"]["commission"] == "known_zero"
    assert result["components"]["tax"] == "unknown" and result["components"]["fx"] == "partial"


def test_synthetic_35_baselines_665_scenarios():
    total = 0
    for score in (-3, -2, -1, 0, 1, 2, 3):
        for action in ("Sell All", "Trim", "Hold", "Add more", "Buy New"):
            change = {"Sell All": -1, "Trim": -0.5, "Hold": 0, "Add more": 1, "Buy New": 1}[action]
            samples = [{"provider": "synthetic", "model": model, "valid": True,
                        "row": dict.fromkeys(SCORE_FIELDS, score) | {"action": action, "current_units": 1, "units_change": change, "final_units": 1 + change}}
                       for model in ("synthetic-a", "synthetic-b")]
            item = {"formula": Formula().model_dump(mode="json"), "samples": samples}
            before = deepcopy(item); result = sensitivity(item)
            total += len(result["scenarios"])
            assert result["diagnostic_version"] == "score-sensitivity-v1"
            assert result["formula_hash"] == digest(item["formula"])
            assert replay([item])[0]["action_thresholds"] == ["-2", "-1", "1"]
            assert item == before
    assert total == 665


def test_evidence_only_cli(tmp_path):
    source, output = tmp_path / "input.json", tmp_path / "output.json"
    source.write_text(json.dumps({"records": [record()], "population": population()}))
    script = Path(__file__).resolve().parents[1] / "scripts" / "replay_recommendations.py"
    subprocess.run([sys.executable, str(script), str(source), str(output), "--evidence-only"], check=True)
    report = json.loads(output.read_text())
    assert report["validation"]["status"] == "not_established" and not report["robustness_established"]
    assert "walk_forward" not in report and "replay" not in report


def test_nested_metadata_is_not_shared():
    item = record() | {"id": {"account": "private"}, "prompt_version": "arbitrary personal text", "output_ids": [{"secret": "private"}]}
    projected = inventory([item])["records"][0]["evidence"]
    assert projected["id"] is None and projected["prompt_version"] is None and projected["output_ids"] is None


@pytest.mark.parametrize("event", ["split", "dividend"])
def test_adjusted_flag_does_not_prove_action_vintage(event):
    item = record() | {"adjusted": True, "corporate_action": event, "adjustment_available_at": "2025-01-01T00:00:00Z"}
    assert "adjustment_available_at_unknown_or_future" in lineage_gaps(item)


def test_sole_family_removal_and_failure_gate_abstain():
    item = {"formula": Formula().model_dump(mode="json"), "samples": [{"provider": "synthetic", "model": "single", "valid": True, "row": dict.fromkeys(SCORE_FIELDS, 1) | {"action": "Hold", "current_units": 1, "units_change": 0, "final_units": 1}}]}
    scenarios = sensitivity(item)["scenarios"]
    assert next(s for s in scenarios if s["parameter"] == "leave_one_provider_model_out")["action"] is None
    item["calculation"] = {"findings": [{"code": "synthetic_failure", "severity": "error"}]}
    assert all(s["action"] is None for s in sensitivity(item)["scenarios"])


def test_invalid_hash_is_not_original_lineage():
    item = record() | {"prompt_hash": "invalid"}
    assert "prompt_hash_missing_or_invalid" in lineage_gaps(item)
