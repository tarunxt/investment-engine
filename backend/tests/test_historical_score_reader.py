"""Synthetic retained captures; no production DB, provider calls, or backfill."""
from copy import deepcopy
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from sqlalchemy import select
from app.domains.recommendation_audit.capture import freeze_input, freeze_output, capture_terminal, materialize_run
from app.domains.recommendation_audit.models import DecisionRecord, EvidenceRecord
from app.domains.recommendation_audit.schemas import AuditRunContext
from app.domains.recommendation_audit.historical_score_reader import historical_score_view, stored_matrix, MATRIX_VERSION
from app.domains.runs.models import FinalActionableHistory, Run
from app.domains.jobs.models import Job
from test_recommendation_audit import formula
from test_recommendation_audit_integration import db, source  # noqa: F401


@pytest.fixture
def captured(db):
    FinalActionableHistory.__table__.create(db.bind)
    run, job = source(db)
    inp = freeze_input(db, run, [job], AuditRunContext(formula=formula()))
    capture_terminal(db, job)
    db.commit()
    history = FinalActionableHistory(user_id=1, rebalance_run_id=run.id, market="india", stock_symbol="FIXTUREEQ", covered_at=run.created_at, formula_version="legacy-backfill-v1", coverage_status="suggested", score=2.83, action="Hold", snapshot_json={"representative": {"Exchange Symbol": "NSE"}})
    db.add(history); db.commit()
    return run, job, inp, history


def read(db, captured, **overrides):
    run, _, _, history = captured
    return historical_score_view(db, **({"user_id": 1, "run_id": run.id, "market": "india", "symbol": "FIXTUREEQ", "exchange": "NSE", "covered_at": history.covered_at, "history_id": history.id} | overrides))


def test_future_capture_and_reader_copy_saved_values_without_recalculation(db, captured):
    decision = db.scalar(select(DecisionRecord))
    assert decision.payload["matrix_snapshot_version"] == MATRIX_VERSION
    before = deepcopy(decision.payload)
    with patch("app.domains.recommendation_audit.deterministic.calculate", side_effect=AssertionError("must never recalculate")):
        result = read(db, captured)
    assert result["status"] == "available"
    assert result["source"] == "immutable_audit"
    assert result["matrix"]["calculatedScore"] == float(before["calculation"]["score"])
    assert result["matrix"]["calculatedAction"] == before["calculation"]["formula_action"]
    assert result["parameters"]["technical-short"][0]["jobId"] == captured[1].id
    assert result["parameters"]["technical-short"][0]["rawRationale"] == before["samples"][0]["source_values"]["rationale_technical_short_term"]
    assert decision.payload == before
    assert result["history_context"]["score"] == 2.83
    assert captured[3].score == 2.83 and captured[3].action == "Hold"


def test_old_immutable_capture_without_optional_matrix_still_reads_stored_formula(db, captured):
    old = deepcopy(db.scalar(select(DecisionRecord)).payload)
    old.pop("matrix_snapshot"); old.pop("matrix_snapshot_version")
    assert stored_matrix(old)["calculatedAction"] == old["calculation"]["formula_action"]
    old["calculation"]["score"] = "2.83"
    old["calculation"]["formula_action"] = "Hold"
    assert stored_matrix(old)["calculatedScore"] == 2.83
    assert stored_matrix(old)["calculatedAction"] == "Hold", "old saved truth is not changed to current score ranges"


def test_reader_survives_raw_job_and_run_retention(db, captured):
    run, job, _, history = captured
    run_id, when = run.id, history.covered_at
    db.delete(history); db.delete(job); db.delete(run); db.commit()
    result = historical_score_view(db, user_id=1, run_id=run_id, market="india", symbol="FIXTUREEQ", exchange="NSE", covered_at=when)
    assert result["status"] == "available"
    assert result["parameters"]["cruxx"]


def test_tenants_and_exact_stock_venue_run_timestamp_do_not_fall_back(db, captured):
    with pytest.raises(LookupError): read(db, captured, user_id=2)
    assert read(db, captured, user_id=2, history_id=None)["status"] == "missing"
    for scope in [{"run_id": 999}, {"market": "us"}, {"symbol": "OTHER"}, {"exchange": "NYSE"}, {"covered_at": captured[3].covered_at + timedelta(seconds=1)}]:
        assert read(db, captured, history_id=None, **scope)["status"] == "missing"
    with pytest.raises(LookupError): read(db, captured, covered_at=captured[3].covered_at + timedelta(days=1))


def test_multiple_matching_revisions_are_ambiguous_not_latest(db, captured):
    original = db.scalar(select(DecisionRecord))
    copy = DecisionRecord(user_id=1, run_id=original.run_id, market=original.market, symbol=original.symbol, exchange=original.exchange, decision_at=original.decision_at, provenance=original.provenance, content_hash="a" * 64, payload=deepcopy(original.payload))
    db.add(copy); db.commit()
    result = read(db, captured)
    assert result["status"] == "ambiguous" and result["matrix"] is None
    assert len(result["candidates"]) == 2


def test_missing_original_formula_keeps_parameter_evidence_and_never_creates_matrix(db):
    FinalActionableHistory.__table__.create(db.bind)
    run, job = source(db)
    materialize_run(db, run)  # Explicit test fixture of already captured legacy data, never production.
    db.commit()
    result = historical_score_view(db, user_id=1, run_id=run.id, market="india", symbol="FIXTUREEQ", exchange="NSE", covered_at=run.created_at)
    assert result["status"] == "partial"
    assert result["matrix"] is None and result["parameters"]["technical-short"]
    assert any("not captured" in note for note in result["notes"])


def test_readonly_dry_run_reports_scope_and_ambiguity_without_mutating(db, captured):
    import importlib.util
    from pathlib import Path
    path = Path(__file__).resolve().parents[1] / "scripts/report_historical_score_coverage.py"
    spec = importlib.util.spec_from_file_location("coverage_report", path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    before = deepcopy(captured[3].snapshot_json)
    report = module.report_coverage(db, user_id=1, market="india", symbol="FIXTUREEQ", day=captured[3].covered_at.strftime("%Y-%m-%d"), timezone="UTC")
    assert report["dry_run"] and report["production_mutations"] == 0
    assert report["rows"][0]["proposed_action"] == "reuse_existing_capture"
    assert not db.new and not db.dirty and not db.deleted
    assert captured[3].snapshot_json == before


def test_legacy_saved_raw_cells_work_without_any_audit_or_raw_job(db):
    FinalActionableHistory.__table__.create(db.bind)
    history = FinalActionableHistory(user_id=1, rebalance_run_id=200, market="india", stock_symbol="HAL", covered_at=__import__('datetime').datetime(2026, 10, 5, 3, 58), formula_version="legacy-backfill-v1", coverage_status="suggested", score=2.83, action="Hold", snapshot_json={"rows": [
        {"job_id": 2000, "provider": "synthetic", "model": "same", "raw": {"exchange symbol": "NSE", "stock symbol": "HAL", "score rationale technical setup short term 1 3 months": "2", "rationale technical setup short term 1 3 months": "Original short rationale A"}},
        {"job_id": 2001, "provider": "synthetic", "model": "same", "raw": {"exchange symbol": "NSE", "stock symbol": "HAL", "score rationale technical setup short term 1 3 months": "3", "rationale technical setup short term 1 3 months": "Original short rationale B"}},
    ]})
    db.add(history); db.commit()
    before = deepcopy(history.snapshot_json)
    result = historical_score_view(db, user_id=1, run_id=200, market="india", symbol="HAL", exchange="NSE", covered_at=history.covered_at, history_id=history.id)
    assert result["status"] == "partial" and result["matrix"] is None
    assert result["source"] == "saved_legacy_projection_parameters"
    assert [o["score"] for o in result["parameters"]["technical-short"]] == [2, 3]
    assert [o["rationale"] for o in result["parameters"]["technical-short"]] == ["Original short rationale A", "Original short rationale B"]
    assert result["history_context"]["score"] == 2.83 and result["history_context"]["action"] == "Hold"
    assert history.snapshot_json == before and not db.dirty
    with pytest.raises(LookupError): historical_score_view(db, user_id=2, run_id=200, market="india", symbol="HAL", exchange="NSE", covered_at=history.covered_at, history_id=history.id)


def test_duplicate_legacy_job_rows_do_not_become_independent_votes(db):
    from app.domains.recommendation_audit.historical_score_reader import legacy_parameter_observations
    raw = {"exchange symbol": "NSE", "stock symbol": "HAL", "score rationale technical setup short term 1 3 months": "2"}
    row = {"job_id": 20, "raw": raw}
    history = SimpleNamespace(id=1, formula_version="legacy-backfill-v1", stock_symbol="HAL", rebalance_run_id=2, snapshot_json={"rows": [row, deepcopy(row), {"job_id": 21, "raw": raw}]})
    observations, notes = legacy_parameter_observations(history, "NSE")
    assert [o["jobId"] for o in observations["technical-short"]] == [21]
    assert notes and "ambiguous" in notes[0]
