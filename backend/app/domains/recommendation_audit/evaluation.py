"""Offline replay/sensitivity and causal price-point simulations; never fetch data."""
from copy import deepcopy
from decimal import Decimal
from .deterministic import calculate, number, sizing_layer
from .schemas import Formula, WEIGHT_KEYS
from .verdict import aware


def record_calculation(record, formula, technical, samples=None, *, require_coverage=False):
    """Recomputation must not erase failed capture gates."""
    calc = calculate(record.get("samples", []) if samples is None else samples, formula, technical)
    errors = [deepcopy(f) for f in record.get("calculation", {}).get("findings", []) if f.get("severity") == "error"]
    coverage = record.get("coverage")
    if (require_coverage and (not coverage or coverage.get("captured_terminal") != coverage.get("attempted"))) or (coverage and (not coverage.get("attempted") or coverage.get("successful") != coverage.get("attempted") or coverage.get("captured_terminal", coverage.get("successful")) != coverage.get("attempted"))):
        errors.append({"code":"capture_coverage_incomplete", "severity":"error", "detail":"Original attempted coverage is missing or incomplete."})
    if errors:
        calc["findings"].extend(f for f in errors if f not in calc["findings"])
        calc["formula_action"] = calc["formula_units"] = None
    return calc


def replay(records):
    results = []
    for record in records:
        formula = Formula.model_validate(record["formula"]) if record.get("formula") else None
        calc = record_calculation(record, formula, record.get("technical"))
        score = number(calc["score"])
        results.append({"record_id": record.get("id"), "run_id": record.get("run_id"), "calculation": calc, "sizing": sizing_layer(calc, record.get("market")),
            "threshold_margin": str(min(abs(score - edge) for edge in map(Decimal, [-2, -1, 1]))) if score is not None else None,
            "recorded_score_matches": number(record.get("calculation", {}).get("score")) == score if record.get("calculation") else None,
            "original_policy_known": formula is not None and record.get("provenance") == "prospective", "provenance": record.get("provenance", "unspecified")})
    return results


def sensitivity(record):
    if not record.get("formula"): return {"status": "insufficient_evidence", "reason": "Original formula unavailable", "scenarios": []}
    formula = Formula.model_validate(record["formula"])
    scenarios = []
    for key in (*WEIGHT_KEYS, "mean-mode-action", "technical-scan-confidence"):
        for factor in (Decimal("0.8"), Decimal("1.2")):
            variant = formula.model_copy(deep=True)
            variant.detailedRationaleMultipliers[key] *= factor
            result = record_calculation(record, variant, record.get("technical"))
            scenarios.append({"parameter": key, "factor": str(factor), "score": result["score"], "action": result["formula_action"]})
    removed = record_calculation(record, formula, None)
    scenarios.append({"parameter": "technical_evidence_removed", "score": removed["score"], "action": removed["formula_action"]})
    families = {(str(s.get("provider")), str(s.get("model"))) for s in record.get("samples", [])}
    for family in sorted(families):
        remaining = [s for s in record.get("samples", []) if (str(s.get("provider")), str(s.get("model"))) != family]
        result = record_calculation(record, formula, record.get("technical"), remaining)
        scenarios.append({"parameter": "leave_one_provider_model_out", "family": list(family), "score": result["score"], "action": result["formula_action"]})
    base = record_calculation(record, formula, record.get("technical"))["formula_action"]
    return {"status": "computed", "baseline_action": base, "different_action_scenarios": sum(s["action"] != base for s in scenarios), "scenarios": scenarios,
        "interpretation": "One-at-a-time sensitivity, not market validation or calibrated probability"}


def walk_forward(records, prices, *, initial_cash="10000", initial_units="0", fee_bps="10", slippage_bps="10", lot_size="1", train_fraction=Decimal("0.2"), horizons=(5, 20, 60)):
    """Single-security simulation with declared costs and price availability.

    Fixed policy: chronological training/holdout split, no post-hoc parameter search.
    Fills use next eligible price point, never the decision's own close. Points are
    explicitly supplied, corporate-action-adjusted and tradable. Cash/hold baselines
    share starting cash/units. No portfolio-level performance claim is made.
    """
    cash, units = number(initial_cash), number(initial_units)
    fee, slip, lot = number(fee_bps), number(slippage_bps), number(lot_size)
    if any(v is None or v < 0 for v in (cash, units, fee, slip)) or lot is None or lot <= 0 or fee > 1000 or slip > 1000: raise ValueError("Invalid simulation assumptions")
    train_fraction = number(train_fraction)
    if train_fraction is None or not Decimal(0) <= train_fraction < Decimal(1): raise ValueError("Invalid chronological split")
    candidates = sorted(records, key=lambda r: aware(r["decision_at"]))
    security_keys = {(r.get("market"), r.get("security_id")) for r in candidates}
    if len(security_keys) != 1 or any(not key[1] for key in security_keys): return {"status": "insufficient_evidence", "eligible_decisions": 0, "reason": "Exactly one verified canonical security is required", "excluded": len(records)}
    market, security_id = next(iter(security_keys))
    eligible, excluded_prices = [], 0
    seen = set()
    for point in prices:
        key = point.get("at")
        if key in seen: raise ValueError("Duplicate price time")
        seen.add(key)
        value = number(point.get("price"))
        if point.get("security_id") != security_id or point.get("market") != market or not key or not point.get("available_at") or not point.get("adjusted") or not point.get("tradable") or value is None or value <= 0 or aware(point["available_at"]) > aware(key):
            excluded_prices += 1; continue
        eligible.append(point)
    eligible.sort(key=lambda p: aware(p["at"]))
    if not eligible: return {"status": "insufficient_evidence", "eligible_decisions": 0, "reason": "No eligible price points", "excluded_prices": excluded_prices}
    split = int(len(candidates) * train_fraction)
    holdout = candidates[split:]
    if not holdout: return {"status":"insufficient_evidence", "reason":"No holdout decisions", "eligible_decisions":0}
    eligible = [p for p in eligible if aware(p["at"]) >= aware(holdout[0]["decision_at"])]
    if not eligible: return {"status":"insufficient_evidence", "reason":"No holdout price points", "eligible_decisions":0}
    baseline_cash, baseline_units = cash, units
    trades, skipped, horizon_rows = [], [], []
    consumed = set()
    equity_curve = [cash + units * number(eligible[0]["price"])]
    peak, drawdown, turnover = equity_curve[0], Decimal(0), Decimal(0)
    for record in holdout:
        when = aware(record["decision_at"])
        if not record.get("original_completion_at") or aware(record["original_completion_at"]) > when or not record.get("inputs_available_at") or aware(record["inputs_available_at"]) > when:
            skipped.append({"id": record.get("id"), "reason": "Unknown or future original input/completion availability"}); continue
        future = [(i, p) for i, p in enumerate(eligible) if aware(p["at"]) > when]
        if not future: skipped.append({"id": record.get("id"), "reason": "No next price point"}); continue
        index, point = future[0]
        if index in consumed: skipped.append({"id": record.get("id"), "reason": "Overlapping decision at same fill point"}); continue
        calc = record_calculation(record, Formula.model_validate(record["formula"]) if record.get("formula") else None, record.get("technical"), require_coverage=True)
        if calc["formula_action"] is None: skipped.append({"id": record.get("id"), "reason": "Deterministic gates failed"}); continue
        if number(calc["current_units"]) != units: skipped.append({"id": record.get("id"), "reason": "Captured holdings differ from simulated holdings"}); continue
        sized = sizing_layer(calc, market)
        change = number(sized["units"])
        if change is None: skipped.append({"id": record.get("id"), "reason": "Quantity unknown"}); continue
        direction = Decimal(1) if change > 0 else Decimal(-1)
        amount = (abs(change) / lot).to_integral_value(rounding="ROUND_FLOOR") * lot
        change = direction * amount if change else Decimal(0)
        price = number(point["price"])
        fill = price * (1 + direction * slip / 10000)
        notional = abs(change) * fill
        cost = notional * fee / 10000
        if change > 0 and notional + cost > cash or change < 0 and abs(change) > units:
            skipped.append({"id": record.get("id"), "reason": "Cash/position constraints"}); continue
        cash -= change * fill + cost; units += change; turnover += notional; consumed.add(index)
        equity = cash + units * price; equity_curve.append(equity)
        peak = max(peak, equity); drawdown = min(drawdown, equity / peak - 1) if peak > 0 else drawdown
        trades.append({"id": record.get("id"), "fill_at": point["at"], "units": str(change), "fill_price": str(fill), "fee": str(cost), "equity": str(equity), "cash_after": str(cash), "units_after": str(units)})
        for horizon in horizons:
            target = index + horizon
            horizon_rows.append({"id": record.get("id"), "price_points": horizon, "return": str(number(eligible[target]["price"]) / price - 1) if target < len(eligible) else None})
    final_price = number(eligible[-1]["price"])
    curve_cash, curve_units = baseline_cash, baseline_units
    fills = {t["fill_at"]: t for t in trades}
    peak = baseline_cash + baseline_units * number(eligible[0]["price"])
    drawdown = Decimal(0)
    for point in eligible:
        if point["at"] in fills:
            curve_cash, curve_units = number(fills[point["at"]]["cash_after"]), number(fills[point["at"]]["units_after"])
        equity = curve_cash + curve_units * number(point["price"])
        peak = max(peak, equity)
        if peak: drawdown = min(drawdown, equity / peak - 1)
    final_equity = cash + units * final_price
    initial_equity = baseline_cash + baseline_units * number(eligible[0]["price"])
    return {"status": "computed" if trades else "insufficient_evidence", "training_decisions": split, "holdout_decisions": len(holdout), "eligible_decisions": len(trades), "executed_trades": sum(t["units"] != "0" for t in trades), "excluded_prices": excluded_prices,
        "initial_equity": str(initial_equity), "final_equity": str(final_equity), "net_return": str(final_equity / initial_equity - 1) if initial_equity else None,
        "hold_baseline_equity": str(baseline_cash + baseline_units * final_price), "cash_baseline_equity": str(initial_equity),
        "turnover": str(turnover), "max_drawdown_at_price_points": str(drawdown), "trades": trades, "skipped": skipped, "horizons": horizon_rows,
        "assumptions": {"fee_bps": str(fee), "slippage_bps": str(slip), "lot_size": str(lot), "fill": "next supplied eligible price point", "horizon_unit": "eligible price points, not calendar days"},
        "limitations": ["Single-security simulation; not a portfolio backtest", "Drawdown sampled at supplied eligible price points", "No parameter tuning on holdout", "Fixture results cannot establish recommendation robustness"]}
