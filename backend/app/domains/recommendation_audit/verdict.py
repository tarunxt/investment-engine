"""Predeclared falsifiable checks, including counterevidence and time availability."""
from datetime import datetime, timezone
import re
from .schemas import Claim, Observation, POLICY_VERSION


def aware(value):
    if isinstance(value, str): value = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value


def claims_for(decision):
    claims = []
    technical = decision.get("technical") or {}
    for key in ("trigger", "invalidation"):
        text = str(technical.get(key) or "")[:2000]
        # A bare breakdown/rejection level is not a completed-close assertion.
        matches = re.findall(r"\b(?:daily\s+)?close\s+(above|below)\s+(?:₹|Rs\.?\s*)?([0-9][0-9,]*(?:\.[0-9]+)?)", text, re.I)
        if len(matches) == 1:
            direction, threshold = matches[0]
            claims.append(Claim(id=key, kind=f"close_{direction.lower()}", text=text, threshold=threshold.replace(",", ""), critical=True))
        elif text:
            claims.append(Claim(id=key, kind="qualitative", text=text, critical=True))
    # Qualitative model statements cannot be certified by repetition or a new explanation.
    for index, sample in enumerate(decision.get("samples", [])[:20]):
        row = sample.get("row", {})
        rationale = " ".join(str(v) for k, v in row.items() if "rationale" in k and not k.startswith("score_"))[:2000]
        if rationale: claims.append(Claim(id=f"rationale:{index}", kind="qualitative", text=rationale))
    return claims


def evaluate(decision, comparison, claims, observations):
    findings = []
    deadline = decision.get("original_completion_at")
    if not deadline: findings.append("Original completion/evidence availability is unknown")
    if not comparison or not comparison.get("comparable"): findings.append("Previous security identity is absent or not verified")
    if any(f.get("severity") == "error" for f in decision.get("calculation", {}).get("findings", [])): findings.append("Deterministic calculation gates failed")
    if decision.get("coverage", {}).get("successful") != decision.get("coverage", {}).get("attempted"): findings.append("Some attempted model outputs are missing or failed")
    results = []
    for claim in claims:
        valid = [o for o in observations if o.claim_id == claim.id and o.independent and deadline and o.available_at and aware(o.available_at) <= aware(deadline)]
        # Invalidation evidence supports the counter-case. It cannot support the exit itself.
        contradictions = [o for o in valid if o.stance == "contradicts"]
        support = [o for o in valid if o.stance == "supports" and o.countersearch_complete]
        state = "contradicted" if contradictions else "supported" if support and claim.kind != "qualitative" else "unknown"
        explanation = explain_claim(claim, state, valid, support)
        results.append({"claim": claim.model_dump(mode="json"), "state": state, "observations": [o.model_dump(mode="json") for o in observations if o.claim_id == claim.id], "explanation": explanation})
    critical = [r for r in results if r["claim"]["critical"]]
    if any(r["state"] == "contradicted" for r in critical): verdict = "unsupported"
    elif critical and all(r["state"] == "supported" for r in critical) and not findings: verdict = "supported"
    else: verdict = "insufficient_evidence"
    return {"policy_version": POLICY_VERSION, "verdict": verdict, "findings": findings, "claims": results, "scope": "Captured claims and data checks; not proof of profitable trading", "model_explanation_is_proof": False}


def explain_claim(claim, state, valid, support):
    """Presentation metadata only; never participates in the verdict decision.

    Version describes explanations, not the historical evidence/verdict policy.
    """
    if state == "contradicted":
        code, reason = "contradictory_evidence", "Eligible independent evidence contradicts this claim; contradiction takes precedence over support."
    elif state == "supported":
        code, reason = "independent_support", "Eligible independent evidence supports this claim with countersearch complete; other critical claims and data gates must still pass."
    elif claim.kind == "qualitative" and valid:
        code, reason = "qualitative_not_certifiable", "Qualitative rationale cannot be certified by repetition or a new explanation, even when an observation reports support."
    elif claim.id == "invalidation" and any(o.stance == "neutral" for o in valid):
        code, reason = "unmet_invalidation_neutral", "The invalidation condition was not met. This is neutral counter-case evidence, not support for this critical claim; every critical claim must be supported."
    elif not valid:
        code, reason = "eligible_evidence_missing", "No independent observation with known availability by original completion is eligible for this claim. Missing or ineligible evidence cannot certify it."
    elif any(o.stance == "supports" for o in valid) and not support:
        code, reason = "countersearch_incomplete", "Reported support lacks completed countersearch and cannot certify this claim."
    else:
        code, reason = "evidence_unresolved", "Eligible observations are neutral or unknown and do not support this critical claim."
    return {"version": "claim-explanation-v1", "code": code, "reason": reason}


def candle_observations(claims, candles, *, decision_at, source_id, source_url, content_hash, observed_at):
    """Candles require completed_at and available_at; current quotes never prove a daily close."""
    observations = []
    deadline = aware(decision_at)
    eligible = [c for c in candles if c.get("complete") is True and c.get("completed_at") and aware(c["completed_at"]) <= deadline and (not c.get("available_at") or aware(c["available_at"]) <= deadline)]
    for claim in claims:
        if claim.kind not in {"close_below", "close_above"} or claim.threshold is None: continue
        selected = [c for c in eligible if (not claim.start_at or aware(c["completed_at"]) >= aware(claim.start_at)) and (not claim.end_at or aware(c["completed_at"]) <= aware(claim.end_at))]
        if not selected: continue
        # Latest completed candle, not a cherry-picked earlier crossing.
        candle = max(selected, key=lambda c: aware(c["completed_at"]))
        from .deterministic import number
        close = number(candle.get("close"))
        if close is None or close <= 0: continue
        met = close < claim.threshold if claim.kind == "close_below" else close > claim.threshold
        stance = "contradicts" if claim.id == "invalidation" and met else "neutral" if claim.id == "invalidation" else "supports" if met else "contradicts"
        observations.append(Observation(id=f"{source_id}:{claim.id}", claim_id=claim.id, source_id=source_id, source_url=source_url, content_hash=content_hash, observed_at=observed_at, published_at=aware(candle["completed_at"]), available_at=aware(candle["available_at"]) if candle.get("available_at") else None, independent=True, stance=stance, detail=f"Latest completed daily close {close}; threshold {claim.threshold}. Opposite boundary and invalidation also checked." + (" Original publication availability unknown: retrospective check only." if not candle.get("available_at") else ""), countersearch_complete=True))
    return observations
