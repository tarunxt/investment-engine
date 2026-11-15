"""Source-derived workflow arithmetic, matching the UI score matrix.

Separate from recommendation_audit's certification policy: this preserves the
configured frontend numerator, missing-weight denominator and mean fallback.
No client-supplied calculation inputs are used here.
"""
import math
import re
from decimal import Decimal, ROUND_HALF_UP
from collections import Counter

ACTIONS = ("Sell All", "Trim", "Add more", "Buy New", "Hold")
ACTION_VALUES = dict(zip(ACTIONS, (-2, -1, 1, 2, 0)))
RATIONALE_HEADERS = {
    "cruxx": "Score Rationale Cruxx",
    "technical-short": "Score Rationale Technical Setup Short Term 1–3 Months",
    "technical-medium": "Score Rationale - Technical Setup (Medium Term)",
    "technical-long": "Score Rationale - Technical Setup (Long Term)",
    "fundamentals-short": "Score Rationale - Fundamentals Short Term",
    "fundamentals-medium-long": "Score Rationale - Fundamentals Medium/Long Term",
}
ACTION_HEADER = "Action (Buy/Add/Sell All/Trim/Hold/Buy New)"


def numeric(value, *, strict=False):
    text = str(value or "").replace(",", "").strip()
    match = re.fullmatch(r"-?\d+(?:\.\d+)?", text) if strict else re.search(r"-?\d+(?:\.\d+)?", text)
    if not match:
        return None
    result = float(match[0])
    return result if math.isfinite(result) else None


def js_sum(values):
    # Python 3.12 sum compensates floats; the UI uses sequential JS reduce.
    total = 0.0
    for value in values:
        total += value
    return total


def mean(values):
    present = [value for value in values if value is not None]
    result = js_sum(present) / len(present) if present else None
    if result is not None and not math.isfinite(result):
        raise ArithmeticError("Source mean exceeds finite arithmetic")
    return result


def normalize_action(value):
    value = re.sub(r"[\s_-]+", " ", str(value or "").lower()).strip()
    for matches, action in (
        ("sell all" in value or value == "sell", "Sell All"),
        ("trim" in value or "reduce" in value, "Trim"),
        ("buy new" in value or "new buy" in value, "Buy New"),
        ("add" in value or "buy more" in value, "Add more"),
        ("hold" in value, "Hold"),
    ):
        if matches:
            return action
    return None


def signed_units(row, action):
    current, change, buy = (numeric(row.get(key)) for key in ("Current Units", "Units Change", "Units to Buy"))
    if action == "Hold":
        return 0
    choices = (current, change, buy) if action == "Sell All" else (change, buy) if action == "Trim" else (buy, change)
    value = next((value for value in choices if value is not None), None)
    return None if value is None or action is None else abs(value) * (-1 if action in {"Sell All", "Trim"} else 1)


def current_value(row):
    explicit = numeric(row.get("Current Value"))
    if explicit is not None:
        return abs(explicit)
    current, price, invested = (numeric(row.get(key)) for key in ("Current Units", "Price Per Unit", "Current Investment Amount"))
    pnl = next((value for key in ("PnL", "P&L", "Profit/Loss", "Profit and Loss") if (value := numeric(row.get(key))) is not None), None)
    if invested is not None and pnl is not None:
        return abs(invested + pnl)
    if current is None or price is None:
        return abs(invested) if invested is not None else None
    return abs(current * price)


def weighted_score(rows, override=None):
    def out_of_bounds(row):
        value = row.get("actual", row["score"])
        if value is None:
            value = row["score"]
        return value is not None and (value < row.get("min", -3) or value > row.get("max", 3)
                                      or row.get("integer", False) and not value.is_integer())
    missing = js_sum(row.get("denominatorWeight", abs(row["multiplier"])) for row in rows
                  if row["multiplier"] != 0 and row["score"] is None)
    available = [row for row in rows if row["score"] is not None]
    base = js_sum(row.get("denominatorWeight", abs(row["multiplier"])) for row in available if row["multiplier"] != 0)
    reduction = js_sum(row.get("outOfBoundsDenominatorWeight", row.get("denominatorWeight", abs(row["multiplier"])))
                    for row in available if row["multiplier"] != 0 and out_of_bounds(row))
    denominator = max(0, override - missing if override is not None else base - reduction)
    numerator = js_sum(row["score"] * (0 if out_of_bounds(row) else row["multiplier"]) for row in available)
    if not math.isfinite(numerator) or not math.isfinite(denominator):
        raise ArithmeticError("Source formula exceeds finite arithmetic")
    score = numerator / denominator if denominator else None
    if score is not None and not math.isfinite(score):
        raise ArithmeticError("Source score exceeds finite arithmetic")
    return score, denominator


def calculate_listing(rows, formula, technical=None, *, direction=None, market):
    """Rows are source cells; technical is the selected source Technical row."""
    actions = [normalize_action(row.get(ACTION_HEADER)) for row in rows]
    mean_action = mean([ACTION_VALUES.get(action) for action in actions])
    counts = Counter(action for action in actions if action)
    mode = min(counts, key=lambda action: (-counts[action], abs(ACTION_VALUES[action] - mean_action), ACTIONS.index(action))) if counts else None
    weights = formula["detailedRationaleMultipliers"]
    weighted = []
    for key, header in RATIONALE_HEADERS.items():
        values = [numeric(row.get(header), strict=True) for row in rows]
        score = mean([value for value in values if value is not None and -3 <= value <= 3])
        weighted.append({"id": key, "score": score, "multiplier": weights[key]})
    confidence = numeric(technical.get("Confidence Score")) if technical else None
    if technical and str(technical.get("Confidence Score", "")).strip().lower() in {"", "—", "-", "n/a", "na", "none", "null"}:
        # summarizeNumeric uses Number after stripping non-numeric characters,
        # then rounds the displayed mean before its numeric fallback is read.
        fallback_values = []
        for row in rows:
            text = re.sub(r"[^\d.-]", "", row.get("Confidence Score (0-100)", ""))
            try:
                value = float(text) if text else 0.0
                if not math.isfinite(value):
                    value = None
            except ValueError:
                value = None
            if value is not None:
                fallback_values.append(value)
        fallback_mean = mean(fallback_values)
        confidence = float(Decimal.from_float(fallback_mean).to_integral_value(rounding=ROUND_HALF_UP)) if fallback_mean is not None else None
    # The UI's existing confidence term uses the direction multiplier directly;
    # the configurable detailed confidence multiplier is not applied by that UI.
    multiplier = formula["technicalScanMultipliers"][direction] if technical and confidence is not None and direction in {"bullish", "bearish"} else 0
    weighted.append({"id": "technical-scan-confidence", "score": confidence if technical else None,
                     "multiplier": multiplier, "denominatorWeight": 2 if multiplier else 0,
                     "outOfBoundsDenominatorWeight": 3 if multiplier else 0, "min": 0, "max": 10})
    for key, header in (("premarket-trend", "Premarket trend"), ("last-5-candles-trend", "Last 5 candles trend")):
        actual = numeric(technical.get(header)) if technical else None
        weighted.append({"id": key, "score": max(-3, min(3, actual)) if actual is not None else None,
                         "actual": actual, "integer": True, "multiplier": weights[key] if technical else 0})
    weighted.append({"id": "mean-mode-action", "score": formula["actionScores"][mode] if mode else None,
                     "multiplier": weights["mean-mode-action"]})
    rationale, denominator = weighted_score(weighted, formula.get("detailedRationaleDenominator"))
    raw = rationale if rationale is not None else mean_action
    effective = max(-3, min(3, raw)) if raw is not None else None
    current = mean([numeric(row.get("Current Units")) for row in rows])
    value = mean([current_value(row) for row in rows])
    changes = [signed_units(row, action) for row, action in zip(rows, actions)]
    mean_change = mean(changes)
    bullish = mean([change for change in changes if change is not None and change > 0])
    bearish = mean([abs(change) for change in changes if change is not None and change < 0])
    bounded = effective if effective is not None else 0
    action = ("Add more" if (current or 0) > 0 else "Buy New") if bounded >= 1 else "Hold" if bounded >= -1 else "Trim" if bounded >= -2 else "Sell All"
    if action in {"Sell All", "Trim"} and current == 0:
        units_change = 0
    elif action == "Sell All":
        units_change = -abs(current) if (current or 0) > 0 else -abs(bearish) if bearish is not None else -abs(mean_change) if mean_change is not None else None
    elif action == "Trim":
        units_change = -abs(current * 0.5) if (current or 0) > 0 else -abs(bearish) if bearish is not None else -abs(mean_change) if mean_change is not None else 0
    elif action == "Hold":
        units_change = 0
    else:
        units_change = abs(bullish) if bullish is not None else abs(mean_change) if mean_change is not None else None
    # buildConsensusRows replaces the representative's Total Buy Amount with
    # the consensus action mean before buildFormulaActionEstimate reads it.
    consensus_action = "Hold"
    for category in ACTIONS:
        if counts[category] > counts[consensus_action]:
            consensus_action = category
    consensus_amounts, consensus_units = [], []
    for row, source_action in zip(rows, actions):
        if source_action != consensus_action or source_action == "Hold":
            continue
        c, u, buy = (numeric(row.get(key)) for key in ("Current Units", "Units Change", "Units to Buy"))
        choices = (c, u, 0) if source_action == "Sell All" else (u, buy, 0) if source_action == "Trim" else (buy, u, 0)
        source_units = abs(next(value for value in choices if value is not None)) or None
        if source_units is not None:
            consensus_units.append(source_units)
        explicit, source_price = numeric(row.get("Total Buy Amount")), numeric(row.get("Price Per Unit"))
        source_amount = abs(explicit) if explicit is not None and (explicit != 0 or source_action in {"Add more", "Buy New"}) else abs(source_units * source_price) if source_units is not None and source_price is not None else None
        if source_amount is not None:
            consensus_amounts.append(source_amount)
    consensus_change = 0 if consensus_action == "Hold" else mean(consensus_units)
    representative_amount = mean(consensus_amounts) if consensus_change is not None and consensus_change > 0 and consensus_action in {"Add more", "Buy New"} else 0 if consensus_change is not None else None
    units = None if action == "Hold" or units_change is None else math.floor(abs(units_change)) if market == "india" else abs(units_change)
    amount = None
    price = numeric(rows[0].get("Price Per Unit"))
    if units is not None:
        if action == "Sell All" and value is not None:
            amount = value
        elif action == "Trim" and current is not None and current > 0 and value is not None:
            amount = abs(units / current) * value
        elif price is not None:
            amount = abs(units * price)
        elif action == "Add more" and current is not None and current > 0 and value is not None:
            amount = abs(units / current) * value
        else:
            explicit = representative_amount
            if explicit is not None and (explicit != 0 or action in {"Add more", "Buy New"}):
                amount = abs(explicit)
    return {"raw_score": raw, "effective_score": effective, "action": action,
            "estimate": {"currentUnits": current, "currentInvestmentAmount": value, "units": units, "amount": amount},
            "entries": [{"action": action, "actionScore": ACTION_VALUES.get(action), "unitsChange": change} for action, change in zip(actions, changes)],
            "inputs": {"calculationPolicy": "missing-score-exclusion-v2", "currentUnits": current, "modeAction": mode, "meanScore": mean_action,
                       "meanUnitsChange": mean_change, "meanModeAction": mode, "meanModeUnitsChange": mean_change,
                       "calculatedAction": action, "calculatedUnitsChange": units_change,
                       "detailedRationaleFinalScore": rationale, "detailedRationaleDenominator": denominator},
            "weighted_rows": weighted}
