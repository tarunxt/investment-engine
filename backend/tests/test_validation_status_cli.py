"""Current repository context and CLI status acceptance with synthetic records."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

import pytest
from app.domains.recommendation_audit.validation import ValidationContract, contract_gaps

ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.parametrize("market", ["india", "us"])
def test_current_context_contract_matches_pinned_source_without_policy_invention(market):
    path = ROOT / f"docs/audit10/validation-contract-{market}-draft.json"
    data = json.loads(path.read_text())
    contract = ValidationContract.model_validate(data)
    context = contract.current_strategy_context
    source = subprocess.check_output(["git", "-c", f"safe.directory={ROOT}", "show", f"{context.repository_commit}:{context.prompt_path}"], cwd=ROOT)
    assert hashlib.sha256(source).hexdigest() == context.prompt_sha256
    assert hashlib.sha256((ROOT / context.prompt_path).read_bytes()).hexdigest() == context.prompt_sha256
    assert "aggressive 1–3 month" in context.original_objective
    assert "2–12 weeks / 1–3 months" in context.original_horizon
    assert "NSE and BSE" in context.original_market_scope if market == "india" else "NASDAQ, NYSE, AMEX" in context.original_market_scope
    assert context.historical_prompt_version is None
    assert context.investment_validation == "not_established"
    assert contract.market == market and contract.strategy == "current aggressive swing-trade rebalance"
    assert all(value is None for value in contract.choices.values())
    assert "contract.objective.unset" in contract_gaps(contract)
    assert contract.approved_by is None and contract.approved_at is None and contract.frozen_at is None


def cli(tmp_path, data):
    source, output = tmp_path / "synthetic-input.json", tmp_path / "report.json"
    source.write_text(json.dumps(data))
    before = source.read_bytes()
    result = subprocess.run([sys.executable, str(ROOT / "backend/scripts/replay_recommendations.py"), str(source), str(output), "--evidence-only"], capture_output=True, text=True)
    assert source.read_bytes() == before
    return result, json.loads(output.read_text()) if output.exists() else None


def evidence_record():
    return {"id": "synthetic-only", "run_id": 1, "population_state": "eligible",
            "decision_at": "2024-01-01T00:00:00Z", "provenance": "calculation_observed"}


@pytest.mark.parametrize("capture,expected,reason", [
    ({"coverage": {"attempted": 2, "successful": 1, "captured_terminal": 2}}, "partial", "original_capture_coverage_incomplete"),
    ({"coverage": {"attempted": 2, "successful": 2, "captured_terminal": 1}}, "partial", "original_capture_coverage_incomplete"),
    ({"calculation": {"findings": [{"severity": "error", "detail": "synthetic failure"}]}}, "failed", "original_deterministic_capture_gate_failed"),
    ({"coverage": {"attempted": 1, "successful": 2, "captured_terminal": 1}}, "failed", "original_capture_counts_inconsistent"),
])
def test_cli_failed_partial_original_capture_preserves_population_and_verdict(tmp_path, capture, expected, reason):
    result, report = cli(tmp_path, {"records": [evidence_record() | capture]})
    assert result.returncode == 0
    validation = report["validation"]
    assert expected in validation["evidence_states"]
    assert f"population.record.0.{reason}" in validation["reasons"]
    assert validation["population"]["observed"] == 1
    assert validation["population"]["records"][0]["capture_coverage"]["state"] == expected
    assert validation["status"] == "not_established" and not report["robustness_established"]
    assert "walk_forward" not in report and "replay" not in report
    assert validation["dimensions"]["economic_effectiveness"] == "not_established"


def test_cli_declared_stale_requires_policy_and_reason_without_inventing_sla(tmp_path):
    record = evidence_record() | {"freshness_state": "stale", "freshness_policy_version": "synthetic-only-v1", "freshness_reason_code": "synthetic_source_withdrawn"}
    result, report = cli(tmp_path, {"records": [record]})
    validation = report["validation"]
    assert result.returncode == 0 and "stale" in validation["evidence_states"]
    assert "population.record.0.stale:synthetic_source_withdrawn" in validation["reasons"]
    freshness = validation["population"]["records"][0]["freshness"]
    assert freshness["policy_version"] == "synthetic-only-v1"
    assert freshness["basis"] == "supplied_declaration_not_independently_verified"
    assert validation["status"] == "not_established"


def test_cli_old_timestamp_does_not_invent_staleness_rule(tmp_path):
    result, report = cli(tmp_path, {"records": [evidence_record() | {"freshness_state": "stale"}]})
    assert result.returncode == 0
    validation = report["validation"]
    assert "stale" not in validation["evidence_states"]
    assert validation["population"]["records"][0]["freshness"]["state"] == "unknown"
    assert validation["population"]["records"][0]["evidence"]["decision_at"] == "2024-01-01T00:00:00Z"


def test_cli_overlapping_failed_partial_stale_maturity_states_never_drop_cases(tmp_path):
    records = [evidence_record() | {"id": "synthetic-failed", "population_state": "failed"},
               evidence_record() | {"id": "synthetic-partial", "population_state": "partial", "outcome_state": "pending_maturity", "freshness_state": "stale", "freshness_policy_version": "synthetic-v1", "freshness_reason_code": "synthetic_expired_source"}]
    result, report = cli(tmp_path, {"records": records})
    validation = report["validation"]
    assert result.returncode == 0
    assert {"failed", "partial", "stale", "pending_maturity", "contract_undefined", "missing_evidence", "not_established"} <= set(validation["evidence_states"])
    assert validation["population"]["observed"] == 2
    assert validation["population"]["state_counts"] == {"failed": 1, "partial": 1}
    assert validation["contract_version"] == "draft-unapproved" and validation["corpus_hash"]


def test_cli_invalid_contract_is_failure_not_validation_success(tmp_path):
    result, report = cli(tmp_path, {"records": [evidence_record()], "validation_contract": {"version": "synthetic", "approved_at": "2024-01-01T00:00:00"}})
    assert result.returncode != 0 and report is None


@pytest.mark.parametrize("source_kind", ["missing", "directory", "malformed", "invalid_contract"])
def test_cli_input_error_layer_preserves_previous_output_bytes(tmp_path, source_kind):
    source, output = tmp_path / "input.json", tmp_path / "report.json"
    if source_kind == "directory": source.mkdir()
    elif source_kind == "malformed": source.write_text('{"records": private-invalid-text')
    elif source_kind == "invalid_contract": source.write_text(json.dumps({"records": [], "validation_contract": {"version": "synthetic", "unapproved_extra": "private-value"}}))
    output.write_bytes(b'{"previous_local_report":true}\n')
    original = output.read_bytes()
    result = subprocess.run([sys.executable, str(ROOT / "backend/scripts/replay_recommendations.py"), str(source), str(output), "--evidence-only"], capture_output=True, text=True)
    assert result.returncode == 2 and output.read_bytes() == original
    assert "No new report was published" in result.stderr
    assert "private-value" not in result.stderr and "private-invalid-text" not in result.stderr
    assert not list(tmp_path.glob("*.tmp"))


def test_cli_source_and_output_cannot_be_the_same_file(tmp_path):
    source = tmp_path / "input.json"; source.write_text(json.dumps({"records": [evidence_record()]}))
    before = source.read_bytes()
    result = subprocess.run([sys.executable, str(ROOT / "backend/scripts/replay_recommendations.py"), str(source), str(source), "--evidence-only"], capture_output=True, text=True)
    assert result.returncode == 2 and source.read_bytes() == before


def test_atomic_output_failure_keeps_previous_report_and_cleans_temporary_file(tmp_path, monkeypatch):
    import importlib.util
    spec = importlib.util.spec_from_file_location("offline_replay_cli", ROOT / "backend/scripts/replay_recommendations.py")
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    output = tmp_path / "report.json"; output.write_bytes(b'{"previous_local_report":true}\n')
    before = output.read_bytes()
    def fail_replace(*args):
        raise OSError("synthetic publication failure")
    monkeypatch.setattr(module.os, "replace", fail_replace)
    with pytest.raises(OSError): module.atomic_report(output, {"synthetic": "only"})
    assert output.read_bytes() == before and len(list(tmp_path.iterdir())) == 1


def test_cli_permission_denied_input_preserves_old_report(tmp_path, monkeypatch, capsys):
    import importlib.util
    spec = importlib.util.spec_from_file_location("offline_replay_permission_cli", ROOT / "backend/scripts/replay_recommendations.py")
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    source, output = tmp_path / "input.json", tmp_path / "report.json"
    source.write_text(json.dumps({"records": [evidence_record()]}))
    output.write_text('{"previous_report":true}\n'); before = output.read_bytes()
    real_read = Path.read_text
    def unreadable(path, *args, **kwargs):
        if path == source: raise PermissionError("synthetic unreadable input")
        return real_read(path, *args, **kwargs)
    monkeypatch.setattr(Path, "read_text", unreadable)
    monkeypatch.setattr(sys, "argv", ["replay_recommendations.py", str(source), str(output), "--evidence-only"])
    with pytest.raises(SystemExit) as error: module.main()
    assert error.value.code == 2 and output.read_bytes() == before
    assert "PermissionError" in capsys.readouterr().err


def test_atomic_serialization_error_cannot_leave_partial_report(tmp_path):
    import importlib.util
    spec = importlib.util.spec_from_file_location("offline_replay_serialization_cli", ROOT / "backend/scripts/replay_recommendations.py")
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    output = tmp_path / "report.json"; output.write_bytes(b'{"previous_local_report":true}\n')
    before = output.read_bytes()
    with pytest.raises(ValueError): module.atomic_report(output, {"invalid": float("nan")})
    assert output.read_bytes() == before and len(list(tmp_path.iterdir())) == 1


@pytest.mark.parametrize("data", [["invalid"], {"records": None}, {"records": ["invalid"]}, {"records": [{"coverage": "invalid"}]}, {"records": [{"calculation": {"findings": ["invalid"]}}]}])
def test_cli_malformed_evidence_shape_is_sanitized_failure(tmp_path, data):
    result, report = cli(tmp_path, data)
    assert result.returncode == 2 and report is None
    assert "No new report was published" in result.stderr and "Traceback" not in result.stderr
