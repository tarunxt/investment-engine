"""Synthetic characterization; never contacts a provider or starts a worker."""
from datetime import datetime, timedelta, timezone
import pytest
from app.domains.recommendation_audit.schemas import Claim, Observation, POLICY_VERSION
from app.domains.recommendation_audit.verdict import evaluate, candle_observations, claims_for

NOW = datetime(2024, 2, 1, tzinfo=timezone.utc)
DECISION = {"original_completion_at": NOW.isoformat(), "coverage": {"successful": 1, "attempted": 1}}

def observation(claim_id, stance, **changes):
    data = dict(id=claim_id, claim_id=claim_id, source_id="synthetic", source_url="https://example.invalid/fixture", content_hash="0" * 64, observed_at=NOW, available_at=NOW, independent=True, stance=stance, detail="Synthetic", countersearch_complete=True)
    return Observation(**(data | changes))

def run(claims, obs, decision=None, comparison=None):
    return evaluate(DECISION if decision is None else decision, {"comparable": True} if comparison is None else comparison, claims, obs)

@pytest.mark.parametrize("trigger", ["supports", "contradicts", "unknown"])
@pytest.mark.parametrize("invalidation", ["contradicts", "neutral", "unknown"])
def test_exact_three_by_three_table(trigger, invalidation):
    claims = [Claim(id="trigger", kind="close_below", text="close below 80", threshold=80), Claim(id="invalidation", kind="close_above", text="close above 120", threshold=120)]
    result = run(claims, [observation("trigger", trigger), observation("invalidation", invalidation)])
    assert result["verdict"] == ("unsupported" if "contradicts" in (trigger, invalidation) else "insufficient_evidence")
    assert result["policy_version"] == POLICY_VERSION
    if invalidation == "neutral":
        assert result["claims"][1]["explanation"]["code"] == "unmet_invalidation_neutral"
        assert result["claims"][1]["state"] == "unknown"
        assert result["claims"][1]["explanation"]["reason"] == "The invalidation condition was not met. This is neutral counter-case evidence, not support for this critical claim; every critical claim must be supported."

@pytest.mark.parametrize("changes,code", [({}, "independent_support"), ({"available_at": None}, "eligible_evidence_missing"), ({"available_at": NOW + timedelta(seconds=1)}, "eligible_evidence_missing"), ({"independent": False}, "eligible_evidence_missing"), ({"countersearch_complete": False}, "countersearch_incomplete")])
def test_eligibility_reasons(changes, code):
    result = run([Claim(id="trigger", kind="close_below", text="fixture")], [observation("trigger", "supports", **changes)])
    assert result["claims"][0]["explanation"]["code"] == code
    assert result["verdict"] == ("supported" if not changes else "insufficient_evidence")

@pytest.mark.parametrize("gate", ["identity", "coverage", "calculation", "completion"])
def test_true_trigger_does_not_bypass_independent_gates(gate):
    decision = dict(DECISION)
    comparison = {"comparable": gate != "identity"}
    if gate == "coverage": decision["coverage"] = {"successful": 0, "attempted": 1}
    if gate == "calculation": decision["calculation"] = {"findings": [{"severity": "error"}]}
    if gate == "completion": decision.pop("original_completion_at")
    result = run([Claim(id="trigger", kind="close_below", text="fixture")], [observation("trigger", "supports")], decision, comparison)
    assert result["verdict"] == "insufficient_evidence"
    assert result["findings"]

def test_qualitative_and_conflicting_evidence():
    claim = Claim(id="rationale:0", kind="qualitative", text="Synthetic rationale")
    result = run([claim], [observation(claim.id, "supports")])
    assert result["verdict"] == "insufficient_evidence"
    assert result["claims"][0]["explanation"]["code"] == "qualitative_not_certifiable"
    assert result["claims"][0]["explanation"]["reason"] == "Qualitative rationale cannot be certified by repetition or a new explanation, even when an observation reports support."
    result = run([claim], [observation(claim.id, "supports"), observation(claim.id, "contradicts")])
    assert result["verdict"] == "unsupported"
    assert result["claims"][0]["explanation"]["code"] == "contradictory_evidence"

@pytest.mark.parametrize("changes", [{"complete": False}, {"completed_at": (NOW + timedelta(seconds=1)).isoformat()}, {"available_at": None}, {"available_at": (NOW + timedelta(seconds=1)).isoformat()}])
def test_candle_unknown_and_future_never_certify(changes):
    claim = Claim(id="trigger", kind="close_below", text="fixture", threshold=80)
    candles = [dict(close=75, complete=True, completed_at=NOW.isoformat(), available_at=NOW.isoformat()) | changes]
    obs = candle_observations([claim], candles, decision_at=NOW, source_id="synthetic", source_url="https://example.invalid", content_hash="0" * 64, observed_at=NOW)
    assert run([claim], obs)["verdict"] == "insufficient_evidence"

def test_capture_scope_and_paired_t37_t39_analogues():
    claims = claims_for({"technical": {"trigger": "close below 80", "invalidation": "close above 120"}, "samples": [{"row": {"rationale": "Synthetic rationale", "score_rationale": 1}}]})
    assert [c.id for c in claims] == ["trigger", "invalidation", "rationale:0"]
    obs = candle_observations(claims, [dict(close=75, complete=True, completed_at=NOW.isoformat(), available_at=NOW.isoformat())], decision_at=NOW, source_id="synthetic", source_url="https://example.invalid", content_hash="0" * 64, observed_at=NOW)
    result = run(claims, obs)
    assert [c["state"] for c in result["claims"]] == ["supported", "unknown", "unknown"]
    assert result["verdict"] == "insufficient_evidence"
    assert run([], [])["verdict"] == "insufficient_evidence"
