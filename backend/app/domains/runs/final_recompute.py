"""Validate new final captures against ownership/revision-checked source outputs."""
import math
import re
from datetime import timezone
from collections import defaultdict

from .final_score_math import ACTIONS, RATIONALE_HEADERS, calculate_listing
from .final_source_rows import UnverifiableFinal, rebalance_rows, technical_rows, technical_direction


def equivalent(actual, expected):
    """Float roundoff tolerance only; null/booleans/types remain distinct."""
    if expected is None:
        return actual is None
    if isinstance(expected, bool):
        return actual is expected
    if isinstance(expected, (int, float)):
        return (not isinstance(actual, bool) and isinstance(actual, (int, float))
                and math.isfinite(actual) and abs(actual - expected) <= 8 * max(math.ulp(float(actual)), math.ulp(float(expected))))
    if isinstance(expected, dict):
        return isinstance(actual, dict) and set(actual) == set(expected) and all(equivalent(actual[key], value) for key, value in expected.items())
    if isinstance(expected, list):
        return isinstance(actual, list) and len(actual) == len(expected) and all(equivalent(a, e) for a, e in zip(actual, expected))
    return type(actual) is type(expected) and actual == expected


def source_calculations(payload, *, sources, jobs_by_run, market):
    formula = payload.get("formula")
    required = {"detailedRationaleMultipliers", "detailedRationaleDenominator", "actionScores", "technicalScanMultipliers", "scoreSymbolThresholds"}
    if not isinstance(formula, dict) or set(formula) != required:
        raise UnverifiableFinal("Final calculation requires the complete captured formula")
    if (not isinstance(formula["detailedRationaleMultipliers"], dict)
            or not (set(RATIONALE_HEADERS) | {"technical-scan-confidence", "premarket-trend", "last-5-candles-trend", "mean-mode-action"}).issubset(formula["detailedRationaleMultipliers"])
            or not isinstance(formula["actionScores"], dict) or set(formula["actionScores"]) != set(ACTIONS)
            or not isinstance(formula["technicalScanMultipliers"], dict) or set(formula["technicalScanMultipliers"]) != {"bullish", "bearish"}):
        raise UnverifiableFinal("Final captured formula terms are incomplete")
    # JSON numerical types only: strings/booleans must not acquire numeric meaning.
    for key in required - {"detailedRationaleDenominator"}:
        if not isinstance(formula[key], dict) or any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) for value in formula[key].values()):
            raise UnverifiableFinal("Final formula terms must be finite numbers")
    denominator = formula["detailedRationaleDenominator"]
    if denominator is not None and (isinstance(denominator, bool) or not isinstance(denominator, (int, float)) or not math.isfinite(denominator)):
        raise UnverifiableFinal("Final denominator must be a finite number or null")
    grouped = defaultdict(list)
    grouped_jobs = defaultdict(list)
    output_jobs = set()
    rebalance_ids = payload["rebalance_run_ids"]
    for run_id in rebalance_ids:
        for job in jobs_by_run.get(run_id, []):
            rows = rebalance_rows(job)
            if rows:
                output_jobs.add((run_id, job.id))
            for row in rows:
                grouped[(row["Exchange Symbol"], row["Stock Symbol"])].append(row)
                grouped_jobs[(row["Exchange Symbol"], row["Stock Symbol"])].append((run_id, job))
    technical_id = payload["technical_run_id"]
    technical_source = next(source for source in sources if source.id == technical_id)
    selected = {}
    # The UI chooses the last completed Technical observation by updated/created
    # time. Equal-time conflicting observations have no stable source ordering.
    observations = []
    for job in jobs_by_run.get(technical_id, []):
        for row in technical_rows(job):
            when = getattr(job, "updated_at", None) or getattr(job, "created_at", None)
            observations.append((when.replace(tzinfo=timezone.utc).timestamp() if when and when.tzinfo is None else when.timestamp() if when else 0, job.id, row))
    for when, job_id, row in sorted(observations, key=lambda item: (item[0], item[1])):
        key = (row["Exchange Symbol"], row["Stock Symbol"])
        prior = selected.get(key)
        if prior is not None and prior[0] == when and prior[2] != row:
            raise UnverifiableFinal("Equal-time conflicting Technical rows require exact source selection")
        selected[key] = (when, job_id, row)
    result = {}
    for key, rows in grouped.items():
        match = selected.get(key)
        technical = match[2] if match else None
        # Symbol-only or decorated aliases in source can otherwise match the UI
        # while bypassing this exact listing map. Reject that ambiguity.
        if any(re.sub(r"[^A-Z0-9]", "", other[1]) == re.sub(r"[^A-Z0-9]", "", key[1]) and other != key for other in selected):
            raise UnverifiableFinal("Technical listing match is ambiguous across exchanges")
        direction = technical_direction(technical, technical_source.prompt) if technical else None
        calculation = calculate_listing(rows, formula, technical, direction=direction, market=market)
        calculation["valid_suggestions"] = len(output_jobs)
        calculation["technical_job_id"] = match[1] if match else None
        stock_key = f"{key[0]}:{key[1]}" if sum(other[1] == key[1] for other in grouped) > 1 else key[1]
        # The UI selects newest provider creation time for this lineage field.
        def timestamp(item):
            when = getattr(item[1], "created_at", None)
            return when.replace(tzinfo=timezone.utc).timestamp() if when and when.tzinfo is None else when.timestamp() if when else 0
        latest_run = max(grouped_jobs[key], key=timestamp)[0]
        calculation["inputs"].update(stockKey=stock_key, stockSymbol=key[1], stockExchange=key[0], stockName=key[1],
            rebalanceSourceRunId=latest_run, technicalScanSourceRunId=technical_id if selected else None,
            technicalScanSourceJobId=calculation["technical_job_id"])
        calculation["detail_rows"] = [{"id": f"{run_id}-{job.id}-matrix", **entry}
                                      for (run_id, job), entry in zip(grouped_jobs[key], calculation["entries"])]
        calculation["detail_rows"] += [
            {"id": f"{stock_key}-matrix-mean-mode", "action": calculation["inputs"]["modeAction"],
             "actionScore": calculation["inputs"]["meanScore"], "unitsChange": calculation["inputs"]["meanUnitsChange"], "isSummary": True},
            {"id": f"{stock_key}-matrix-calculated", "action": calculation["action"], "actionScore": calculation["raw_score"],
             "unitsChange": calculation["inputs"]["calculatedUnitsChange"], "isSummary": True, "isCalculated": True},
        ]
        result[key] = calculation
    return result


def verify_recomputed_rows(payload, calculations, *, raw_field, effective_field):
    """Field names are supplied by the version-specific contract adapter."""
    rows = payload["rows"]
    if type(payload.get("input_listing_count")) is not int or payload["input_listing_count"] != len(calculations):
        raise UnverifiableFinal("Final input listing count differs from source outputs")
    if type(payload.get("final_listing_count")) is not int or payload["final_listing_count"] != len(calculations):
        raise UnverifiableFinal("Final listing count differs from source outputs")
    if len(rows) != len(calculations) or payload.get("excluded_non_buy_listings") != []:
        # Current buildDashboardActionRows maps every listing, including zero Hold.
        raise UnverifiableFinal("Final rows/exclusions differ from source listing coverage")
    for row in rows:
        key = (row["exchange"], row["symbol"])
        expected = calculations.get(key)
        if expected is None:
            raise UnverifiableFinal("Final listing does not occur in selected sources")
        for key, value in ((raw_field, expected["raw_score"]), (effective_field, expected["effective_score"]),
                           ("score", expected["raw_score"]), ("action", expected["action"]),
                           ("estimate", expected["estimate"]), ("valid_suggestions", expected["valid_suggestions"]),
                           ("scorePolicy", "score-matrix-raw-effective-v2")):
            if key not in row or not equivalent(row[key], value) or key == "valid_suggestions" and type(row[key]) is not int:
                raise UnverifiableFinal(f"Final {key} differs from source recomputation")
        verify_formula_inputs(row.get("formula_inputs"), expected, score_fields={"calculatedScore": expected["raw_score"]})


def verify_formula_inputs(detail, calculation, *, score_fields):
    """Validate arithmetic and nested terms, independently of presentation text."""
    if not isinstance(detail, dict):
        raise UnverifiableFinal("Final formula inputs are missing")
    for key, value in {**calculation["inputs"], **score_fields}.items():
        if key not in detail or not equivalent(detail[key], value):
            raise UnverifiableFinal(f"Final formula input {key} differs from source recomputation")
    if "detail_rows" in calculation:
        rows = detail.get("rows")
        if not isinstance(rows, list) or len(rows) != len(calculation["detail_rows"]):
            raise UnverifiableFinal("Final detail rows differ from source recomputation")
        for row, expected in zip(rows, calculation["detail_rows"]):
            if not isinstance(row, dict) or any(key not in row or not equivalent(row[key], value) for key, value in expected.items()):
                raise UnverifiableFinal("Final detail row arithmetic differs from source recomputation")
            if any((key in row) != (key in expected) for key in ("isSummary", "isCalculated")):
                raise UnverifiableFinal("Final detail row roles differ from source recomputation")
    weighted = detail.get("detailedRationaleRows")
    if not isinstance(weighted, list) or len(weighted) != len(calculation["weighted_rows"]):
        raise UnverifiableFinal("Final weighted formula rows differ from source recomputation")
    for actual, expected in zip(weighted, calculation["weighted_rows"]):
        if not isinstance(actual, dict):
            raise UnverifiableFinal("Final weighted formula term is invalid")
        for key in ("id", "score", "multiplier"):
            if key not in actual or not equivalent(actual[key], expected[key]):
                raise UnverifiableFinal(f"Final weighted {key} differs from source recomputation")
        for key in ("denominatorWeight", "outOfBoundsDenominatorWeight"):
            if (key in actual) != (key in expected) or key in expected and not equivalent(actual[key], expected[key]):
                raise UnverifiableFinal(f"Final weighted {key} differs from source recomputation")
        rule = {"min": expected.get("min", -3), "max": expected.get("max", 3)}
        if expected["id"] == "technical-scan-confidence":
            rule["actualValue"] = expected["score"]
        if expected.get("integer"):
            rule.update(integerOnly=True, actualValue=expected["actual"])
        if not equivalent(actual.get("validationRule"), rule):
            raise UnverifiableFinal("Final weighted validation rule differs from source recomputation")
