"""Protocol and retained-metadata tests use local synthetic inputs only."""
from copy import deepcopy
import json
from app.domains.recommendation_audit.deterministic import digest
from app.domains.recommendation_audit.retained_inventory import project_retained_metadata
from app.domains.recommendation_audit.tuning_ledger import ledger_gaps
from app.domains.recommendation_audit.validation import split_gaps


def entry(event, day, **kwargs):
    return {"event": event, "at": f"2024-04-{day:02}T00:00:00Z", "previous_entry_hash": None,
            "contract_hash": "a" * 64, "corpus_hash": "b" * 64, "code_hash": "c" * 64,
            "reason": "synthetic-only", "split_version": "synthetic-v1", "original_output_ids": ["synthetic-output"], **kwargs}


def chain(entries):
    result = deepcopy(entries)
    for index, value in enumerate(result):
        value["previous_entry_hash"] = digest(result[index - 1]) if index else None
    return result


def freeze(day=1, **kwargs):
    return entry("freeze", day, test_start_at="2024-01-01T00:00:00Z", test_end_at="2024-03-01T00:00:00Z", **kwargs)


def test_ledger_freeze_inspect_tune_requires_new_independent_test():
    rows = chain([freeze(), entry("inspect", 2), entry("tune", 3, selected_parameters={"synthetic": "only"})])
    before = deepcopy(rows)
    assert ledger_gaps(rows) == [] and rows == before
    rows = chain(rows + [entry("inspect", 4)])
    assert "ledger.3.test_not_frozen_or_consumed" in ledger_gaps(rows)
    rows = chain(rows[:3] + [freeze(4, split_version="synthetic-v2")])
    assert "ledger.3.new_test_period_not_independent" in ledger_gaps(rows)
    rows[-1].update(test_start_at="2024-03-02T00:00:00Z", test_end_at="2024-03-31T00:00:00Z")
    assert ledger_gaps(rows) == []


def test_ledger_tamper_missing_choices_and_out_of_order_are_rejected():
    rows = chain([freeze(), entry("inspect", 2)])
    rows[0]["reason"] = "changed"
    assert "ledger.1.chain_mismatch" in ledger_gaps(rows)
    assert "ledger.0.selection_not_recorded" in ledger_gaps([entry("retry", 1)])
    rows = chain([freeze(), entry("inspect", 1)])
    assert "ledger.1.time_unknown_or_not_increasing" in ledger_gaps(rows)
    rows = chain([entry("inspect", 1), freeze(2)])
    assert "ledger.0.test_not_frozen_or_consumed" in ledger_gaps(rows)


def test_ledger_inspection_before_maturity_and_invalid_hash_fail_closed():
    row = freeze(); row["test_end_at"] = "2024-05-01T00:00:00Z"
    assert "ledger.1.outcome_window_not_mature" in ledger_gaps(chain([row, entry("inspect", 2)]))
    row["code_hash"] = "unknown"
    assert "ledger.0.code_hash.invalid" in ledger_gaps([row])


def test_split_inspection_cannot_precede_label_maturity():
    row = {"partition": "test", "dependency_group": "synthetic", "decision_at": "2024-01-01T00:00:00Z",
           "outcome_end_at": "2024-02-01T00:00:00Z", "first_result_inspected_at": "2024-01-15T00:00:00Z"}
    assert "outcome_window_not_mature_at_inspection" in split_gaps([row], frozen_at="2023-01-01T00:00:00Z", embargo_seconds=0, embargo_reason="synthetic")


def test_retained_projection_keeps_source_counts_and_missing_population(tmp_path):
    ui, retained = tmp_path / "ui.json", tmp_path / "retained.json"
    ui.write_text(json.dumps({"records": [{"width": 100, "links": []}]}))
    retained.write_text(json.dumps({"records": [{"id": "synthetic", "run_id": 1, "decision_at": "2024-01-01T00:00:00Z", "user_id": 12345, "holdings_snapshot": {"amount": 54321}}]}))
    before = retained.read_bytes()
    result = project_retained_metadata([ui, retained, tmp_path / "missing.json"])
    assert result["source_inspections"][0]["exclusion"] == "no_original_recommendation_decision_metadata"
    assert result["source_inspections"][1]["candidate_records"] == 1
    assert result["source_inspections"][2]["exclusion"] == "not_a_retained_file"
    assert result["population"]["observed"] == 1 and not result["complete_decision_population"]
    assert "holdings_snapshot" not in result["population"]["records"][0]["evidence"]
    assert retained.read_bytes() == before


def test_retained_projection_bounds_and_invalid_json(tmp_path):
    source = tmp_path / "invalid.json"; source.write_text("{")
    assert project_retained_metadata([source])["source_inspections"][0]["exclusion"] == "not_readable_json_metadata"
    assert project_retained_metadata([source], max_bytes_per_file=0)["source_inspections"][0]["exclusion"] == "exceeds_declared_byte_bound"
    assert project_retained_metadata([source], max_files=0)["uninspected_path_count"] == 1


def test_inspection_cannot_switch_frozen_inputs():
    rows = chain([freeze(), entry("inspect", 2, corpus_hash="d" * 64)])
    assert "ledger.1.frozen_inputs_changed" in ledger_gaps(rows)
    assert ledger_gaps([]) == ["ledger.empty"]


def test_retained_projection_aggregate_bound_retains_exclusion_count(tmp_path):
    source = tmp_path / "retained.json"
    source.write_text(json.dumps({"records": [{"id": f"synthetic-{i}", "source_hashes": []} for i in range(2)]}))
    result = project_retained_metadata([source], max_records=1)
    assert result["source_inspections"][0]["candidate_records"] == 2
    assert result["source_inspections"][0]["projected_records"] == 1
    assert result["source_inspections"][0]["selection_limit"] == "aggregate_record_bound_reached"
    assert result["population"]["observed"] == 1 and not result["population"]["reconciled"]
