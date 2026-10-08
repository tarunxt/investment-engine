"""Pure versioned arithmetic and comparison; never repairs recorded rows."""
from __future__ import annotations

from collections import Counter
from decimal import Decimal, InvalidOperation
import hashlib
import json

from .schemas import Formula, SCORE_FIELDS, WEIGHT_KEYS, SCHEMA_VERSION

ORDER = ("Sell All", "Trim", "Add more", "Buy New", "Hold")


def digest(value):
    encoded = value if isinstance(value, str) else json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    return hashlib.sha256(encoded.encode()).hexdigest()


def number(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        result = Decimal(str(value))
        return result if result.is_finite() else None
    except (InvalidOperation, ValueError):
        return None


def normalize_action(value):
    text = str(value or "").strip().lower()
    return {"sell all": "Sell All", "sell": "Sell All", "trim": "Trim", "hold": "Hold", "add more": "Add more", "add": "Add more", "buy new": "Buy New", "buy": "Buy New"}.get(text)


def finding(code, detail, severity="warning"):
    return {"code": code, "detail": detail, "severity": severity}


def action_for_score(score, current):
    if score is None or current is None:
        return None
    score = min(Decimal(3), max(Decimal(-3), score))
    if score >= 1:
        return "Add more" if current > 0 else "Buy New"
    if score >= -1:
        return "Hold"
    if score >= -2:
        return "Trim"
    return "Sell All"


def calculate(samples, formula: Formula | None, technical=None):
    findings = []
    actions = [normalize_action(s.get("row", {}).get("action")) for s in samples]
    counts = Counter(a for a in actions if a)
    category_scores = {"Sell All": Decimal(-2), "Trim": Decimal(-1), "Hold": Decimal(0), "Add more": Decimal(1), "Buy New": Decimal(2)}
    mean_action = sum(category_scores[a] for a in actions if a) / sum(counts.values()) if counts else None
    mode = min(counts, key=lambda a: (-counts[a], abs(category_scores[a] - mean_action), ORDER.index(a))) if counts else None
    if len(counts) > 1 and sum(v == max(counts.values()) for v in counts.values()) > 1:
        findings.append(finding("action_tie", "Tie resolved by frontend category distance from mean action, then category order."))
    families = sorted({(str(s.get("provider") or "unknown"), str(s.get("model") or "unknown")) for s in samples})
    if len(families) < 2:
        findings.append(finding("same_model_consensus", "Agreement is between samples of one provider/model, not independent corroboration."))
    currents = {number(s.get("row", {}).get("current_units")) for s in samples}
    current = next(iter(currents)) if len(currents) == 1 and None not in currents else None
    if current is None:
        findings.append(finding("holdings_unknown_or_conflicting", "Captured holdings are missing or disagree.", "error"))
    for sample in samples:
        row = sample.get("row", {})
        a, c, u, final = normalize_action(row.get("action")), number(row.get("current_units")), number(row.get("units_change")), number(row.get("final_units"))
        if c is None or u is None or final is None or c + u != final or final < 0:
            findings.append(finding("units_arithmetic", f"Sample {sample.get('job_id')} has missing or inconsistent signed quantities.", "error"))
        if (a == "Sell All" and final != 0) or (a == "Hold" and u != 0) or (u is not None and ((a in {"Sell All", "Trim"} and u > 0) or (a in {"Buy New", "Add more"} and u < 0))):
            findings.append(finding("action_units_conflict", f"Sample {sample.get('job_id')} action and units disagree.", "error"))
        if sample.get("valid") is not True:
            findings.append(finding("output_contract_incomplete", f"Sample {sample.get('job_id')} did not fully validate.", "error"))
    averages = {}
    for field, key in zip(SCORE_FIELDS, WEIGHT_KEYS):
        vals = [number(s.get("row", {}).get(field)) for s in samples]
        if not vals or any(v is None or not -3 <= v <= 3 for v in vals):
            averages[key] = None
            findings.append(finding("missing_or_invalid_score", f"{field} is missing or invalid; no neutral zero is substituted.", "error"))
        else:
            averages[key] = sum(vals) / len(vals)
    numerator, denominator, score = None, None, None
    if formula is None:
        findings.append(finding("formula_not_recorded", "Original formula is unavailable; legacy rationale mean is not a final score.", "error"))
    elif all(v is not None for v in averages.values()) and mode:
        weights = formula.detailedRationaleMultipliers
        contributions = [(averages[k], weights[k], abs(weights[k])) for k in WEIGHT_KEYS]
        contributions.append((formula.actionScores[mode], weights["mean-mode-action"], abs(weights["mean-mode-action"])))
        if technical:
            if technical.get("policy_error"): findings.append(finding("technical_setup_policy_unknown", technical["policy_error"], "error"))
            conf = number(technical.get("confidence"))
            bias = technical.get("bias")
            if conf is not None and 0 <= conf <= 10 and bias in {"bullish", "bearish"}:
                mult = weights["technical-scan-confidence"] * formula.technicalScanMultipliers[bias]
                contributions.append((conf, mult, Decimal(2) if mult else Decimal(0)))
            else:
                findings.append(finding("technical_confidence_unknown", "Technical confidence/bias is missing or invalid.", "error"))
            for k, source in (("premarket-trend", "premarket"), ("last-5-candles-trend", "last5")):
                v = number(technical.get(source))
                if weights[k] and (v is None or v != v.to_integral_value() or not -3 <= v <= 3):
                    findings.append(finding("technical_trend_unknown", f"{source} is missing or invalid.", "error"))
                elif v is not None:
                    contributions.append((v, weights[k], abs(weights[k])))
        else:
            findings.append(finding("technical_not_available", "No frozen matching technical evidence; its contribution is excluded."))
        numerator = sum(v * w for v, w, _ in contributions)
        denominator = formula.detailedRationaleDenominator or sum(d for _, _, d in contributions)
        if denominator:
            score = numerator / denominator
        if score is not None and not -3 <= score <= 3:
            findings.append(finding("score_outside_guardrail", "Raw formula score exceeds -3..3; display clamp is separate.", "error"))
    # Error gates retain arithmetic for diagnosis but suppress certification/action.
    action = action_for_score(score, current) if not any(f["severity"] == "error" for f in findings) else None
    units = None
    if action and current is not None:
        if action == "Sell All": units = -current
        elif action == "Trim": units = -current / 2
        elif action == "Hold": units = Decimal(0)
        else:
            increases = [number(s["row"].get("units_change")) for s in samples if normalize_action(s["row"].get("action")) in {"Buy New", "Add more"}]
            units = sum(abs(v) for v in increases) / len(increases) if increases and all(v is not None for v in increases) else None
    return {"raw_action": mode, "raw_action_counts": dict(counts), "covered_samples": len(samples), "provider_families": [list(v) for v in families], "current_units": str(current) if current is not None else None,
            "rationale_mean": str(sum(averages.values()) / len(averages)) if averages and all(v is not None for v in averages.values()) else None,
            "averages": {k: str(v) if v is not None else None for k, v in averages.items()},
            "numerator": str(numerator) if numerator is not None else None, "denominator": str(denominator) if denominator is not None else None,
            "score": str(score) if score is not None else None, "formula_action": action, "formula_units": str(units) if units is not None else None, "findings": findings}


def sizing_layer(calculation, market):
    current, units = number(calculation.get("current_units")), number(calculation.get("formula_units"))
    action = calculation.get("formula_action")
    result = {"policy": "existing-basket-rounding-v1", "action": action, "units": str(units) if units is not None else None, "findings": []}
    if market == "india" and action in {"Trim", "Sell All"} and current is not None and current > 0 and units is not None:
        if action == "Trim" and 0 < abs(units) < 1:
            # New observations use the review policy. Existing append-only
            # snapshots retain their recorded minimum-one-share sizing.
            result.update(policy="whole-share-trim-review-v2", units=None, review_required=True)
            result["findings"].append(finding("whole_share_choice_required", "A fractional trim is below one whole share. No order is selected; keeping the position or reviewing a full exit requires an explicit choice."))
            return result
        sized = min(current.to_integral_value(rounding="ROUND_FLOOR"), Decimal(max(1, int(abs(units)))))
        result.update(units=str(-sized), action="Sell All" if sized >= current else "Trim")
        if sized != abs(units):
            result["findings"].append(finding("sizing_changes_exposure", f"Requested {units} shares becomes {-sized} under existing whole-share sizing; this is not stronger bearish evidence."))
    return result


def compare(previous, current):
    p, c = previous.get("calculation", {}), current.get("calculation", {})
    findings = list(c.get("findings", [])) + current.get("sizing", {}).get("findings", [])
    changes = []
    for field in ("raw_action", "formula_action", "current_units", "formula_units", "score"):
        if p.get(field) != c.get(field): changes.append({"field": field, "before": p.get(field), "after": c.get(field)})
    for field in ("objective", "horizon", "prompt_hash", "holdings_snapshot", "formula_hash", "source_hashes", "provider_families"):
        if previous.get(field) != current.get(field): changes.append({"field": field, "before": previous.get(field), "after": current.get(field)})
    before, after = number(p.get("formula_units")), number(c.get("formula_units"))
    reversal = before is not None and after is not None and before * after < 0
    comparable = previous.get("market") == current.get("market") and previous.get("symbol") == current.get("symbol")
    if previous.get("exchange") != current.get("exchange") and not (previous.get("isin") and previous.get("isin") == current.get("isin")):
        comparable = False
        findings.append(finding("security_mapping_unverified", "Exchange changed without a verified canonical security mapping; price continuity cannot be assumed.", "error"))
    if previous.get("formula_hash") != current.get("formula_hash"):
        findings.append(finding("different_score_policy", "Scores use different or unknown formula policies; direct score deltas are not comparable."))
    return {"schema_version": SCHEMA_VERSION, "comparable": comparable, "exposure_reversal": reversal, "changes": changes,
            "score_component_changes": {k: str(number(c["averages"][k]) - number(p["averages"][k])) for k in WEIGHT_KEYS if number(c.get("averages", {}).get(k)) is not None and number(p.get("averages", {}).get(k)) is not None}, "findings": findings}
