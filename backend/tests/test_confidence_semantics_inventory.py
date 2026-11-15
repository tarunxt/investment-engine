"""A10-002-R02: characterize existing incompatible meanings, not calibration."""
import json
from pathlib import Path

import pytest

from app.domains.bullpen_trade_analysis.analytics import generate_bullpen_post_trade_analysis
from app.domains.bullpen_trade_analysis.helpers import confidence_score_from_value
from app.domains.jobs.output_contracts.schemas import Column, Provenance
from app.domains.jobs.output_contracts.validation import validate_row
from app.domains.polymarket_auto_live.normalization import normalize_auto_live_confidence
from app.domains.polymarket_auto_live.llm import _pick_consensus_label, CONFIDENCE_RANK
from app.domains.recommendation_audit.schemas import Formula
from app.domains.recommendation_audit.technical import technical_rows
from app.domains.runs.final_score_math import calculate_listing


@pytest.mark.parametrize("value,expected", [(None,None),("unestablished",None),(0,0),(.8,.8),(80,.8),
    ("High",.85),("Medium",.6),("Low",.25),(1,1),(1.01,.0101)])
def test_existing_trade_review_mapping_is_heuristic_and_never_alignment(value, expected):
    score = confidence_score_from_value(value)
    assert score == expected
    result = generate_bullpen_post_trade_analysis({"buy_confidence":score,"net_pnl":1})
    assert result["llm_confidence_aligned"] is None
    assert result["evidence_status"] == "descriptive_not_validated"
    assert not result["should_increase_confidence_for_similar_trade"]


@pytest.mark.parametrize("value,invalid", [(0,False),(80,False),(100,False),(101,True),(-1,True)])
def test_equity_contract_retains_0_to_100_score_without_probability_conversion(value, invalid):
    row, _, findings = validate_row({"confidence_score":value}, [Column("confidence_score","Confidence Score (0-100)")],
                                   Provenance(1,1,1), {}, {}, "swing", derive_arithmetic=False)
    assert row["confidence_score"] == value
    assert any(f.code == "invalid_confidence" for f in findings) is invalid


def test_technical_adapter_preserves_catalog_score_and_source_hash():
    table = "| Exchange Symbol | Stock Symbol | Bias | Confidence Score | Premarket trend | Last 5 candles trend | Trigger Level | Invalidation Level | Primary Setup |\n|---|---|---|---|---|---|---|---|---|\n| NSE | SYNTHETIC | Bullish | 8.2 | 0 | 0 | 100 | 90 | Support bounce |"
    row = technical_rows(table)[("SYNTHETIC","NSE")]
    assert row["confidence"] == "8.2" and row["source_hash"]


def test_equity_fallback_is_not_silently_converted_to_technical_scale():
    formula = json.loads(json.dumps(Formula().model_dump(),default=float))
    source = {"Confidence Score (0-100)":"80"}
    technical = {"Confidence Score":"—"}
    output = calculate_listing([source],formula,technical,direction="bullish",market="india")
    row = next(r for r in output["weighted_rows"] if r["id"] == "technical-scan-confidence")
    assert row["score"] == 80  # Existing compatibility arithmetic, not 8 or .8.
    assert row["max"] == 10    # Unsupported cross-scale equivalence remains visible.


def test_live_labels_and_trade_review_unknown_are_different_contracts():
    assert normalize_auto_live_confidence(None) == "Low"
    assert confidence_score_from_value(None) is None
    assert normalize_auto_live_confidence("Strong") == "High"
    assert confidence_score_from_value("Strong") is None
    assert _pick_consensus_label(["High","Medium"],tie_breaker="Low",rank_map=CONFIDENCE_RANK) == "Medium"
    assert _pick_consensus_label([],tie_breaker="Low",rank_map=CONFIDENCE_RANK) is None
    # Existing tie branch includes lower-count labels: characterize, do not change strategy.
    assert _pick_consensus_label(["High","High","Medium","Medium","Low"],tie_breaker="Low",rank_map=CONFIDENCE_RANK) == "Low"


def test_technical_prompt_declares_catalog_copy_instead_of_estimated_probability():
    root = Path(__file__).resolve().parents[2]
    source = (root / "frontend/app/console/_components/FinalActionablesConsole.tsx").read_text()
    assert "For Confidence Score, copy the numeric Confidence value from the approved Technical Setups list" in source
    assert "Return only the number, without /10, %, avg text, or LLM counts" in source


@pytest.mark.parametrize("original", [None, 0, .8, 8, 80, "High"])
def test_existing_capture_retains_original_confidence_model_and_time(original):
    from copy import deepcopy
    from app.domains.bullpen_trade_analysis.service import _llm_entries_for_phase

    payload = {"confidence": original, "provider": "synthetic", "model": "synthetic-model-v1",
               "timestamp": "2026-01-02T03:04:05Z", "raw_output": "synthetic original evidence"}
    before = deepcopy(payload)
    entry = _llm_entries_for_phase([payload], phase="BUY_ANALYSIS", computed_tags=[])[0]
    assert payload == before
    assert entry.model == before["model"]
    assert entry.parsed_output_json["confidence"] == original
    assert entry.parsed_output_json["timestamp"] == before["timestamp"]
    assert entry.raw_output == before["raw_output"]
    review_input = {"id":"synthetic-trade", "buy_confidence":entry.confidence,
                    "model":entry.model, "timestamp":before["timestamp"], "net_pnl":None}
    review_before = deepcopy(review_input)
    review = generate_bullpen_post_trade_analysis(review_input)
    assert review_input == review_before
    assert review["llm_confidence_aligned"] is None
    assert review["source_trade_id"] == "synthetic-trade"
