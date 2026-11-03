"""Synthetic workflow metadata, distinct from original investment evidence."""
from copy import deepcopy
from app.domains.recommendation_audit.retained_context import workflow_context, source_receipts
from app.domains.recommendation_audit.validation import validation_report


def record():
    return {"id": "synthetic-workflow", "record_kind": "retained_workflow_metadata", "market": "india",
            "retained_source_ref": "SYNTHETIC", "retained_source_line": 1, "population_state": "unknown",
            "workflow_status_displayed": "FAILED", "workflow_started_displayed": "1 Nov 2026, 2:46:28 pm IST",
            "workflow_started_at_utc_derived": "2026-11-01T09:16:28Z", "workflow_finished_displayed": "Not recorded",
            "workflow_finished_at_utc_derived": None, "stage_states_displayed": {"Sync Portfolio": "COMPLETED"}}


def test_original_display_and_derived_utc_are_separate_from_decision_availability():
    row = record(); before = deepcopy(row)
    result = validation_report({"records": [row]})
    context = result["population"]["records"][0]["retained_workflow_context"]
    assert context["workflow_started_displayed"] == row["workflow_started_displayed"]
    assert context["workflow_started_at_utc_derived"] == row["workflow_started_at_utc_derived"]
    assert context["started_conversion_check"] == "matches_displayed_IST"
    assert context["workflow_finished_displayed"] == "Not recorded" and context["workflow_finished_at_utc_derived"] is None
    assert result["population"]["records"][0]["evidence"]["decision_at"] is None
    assert result["population"]["records"][0]["evidence"]["inputs_available_at"] is None
    assert result["population"]["state_counts"] == {"unknown": 1}
    assert "failed" in result["evidence_states"] and result["status"] == "not_established"
    assert row == before


def test_queued_historical_workflow_never_proves_current_activity_or_freshness():
    result = workflow_context(record() | {"workflow_status_displayed": "QUEUED"})
    assert result["workflow_status_displayed"] == "QUEUED"
    assert result["freshness"] == "historical_observation_current_freshness_unknown"


def test_derived_mismatch_is_retained_not_repaired():
    row = record() | {"workflow_started_at_utc_derived": "2026-11-01T09:16:29Z"}
    result = workflow_context(row)
    assert result["started_conversion_check"] == "derived_time_missing_or_mismatch"
    assert result["workflow_started_at_utc_derived"] == row["workflow_started_at_utc_derived"]


def test_sept_normalization_for_parsing_does_not_rewrite_display():
    row = record() | {"workflow_started_displayed": "1 Sept 2026, 2:46:28 pm IST", "workflow_started_at_utc_derived": "2026-09-01T09:16:28Z"}
    result = workflow_context(row)
    assert result["started_conversion_check"] == "matches_displayed_IST"
    assert result["workflow_started_displayed"] == row["workflow_started_displayed"]


def test_receipt_verification_time_is_not_exact_source_capture_time():
    source = {"ref": "SYNTHETIC", "sha256": "a" * 64, "bytes": 10, "capture_context_build_sha": "b" * 40,
              "exact_capture_time_utc": None, "verification_receipt_at_utc": "2026-11-01T15:26:04Z", "raw_source_transferred": False}
    receipt = source_receipts([source])[0]
    assert receipt["exact_capture_time_utc"] is None
    assert receipt["verification_receipt_at_utc"] == source["verification_receipt_at_utc"]
    assert not receipt["raw_source_transferred"]
    assert receipt["capture_context_build_sha"] == "b" * 40


def test_saved_partial_stage_remains_visible_without_becoming_outcome_or_missing_stage_claim():
    row = record() | {"workflow_status_displayed": "COMPLETED", "stage_states_displayed": {"Synthetic Stage": "PARTIAL"}}
    result = validation_report({"records": [row]})
    context = result["population"]["records"][0]["retained_workflow_context"]
    assert context["stage_states_displayed"] == row["stage_states_displayed"]
    assert "partial" in result["evidence_states"] and result["status"] == "not_established"
    assert result["population"]["records"][0]["outcome_state"] == "unknown"
    assert result["population"]["state_counts"] == {"unknown": 1}
    assert context["stage_coverage"] == "retained_name_status_pairs_only_absence_not_proof_of_skipped_or_missing_stage"
