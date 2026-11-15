"""Source-to-result checks with synthetic canonical provider responses."""
from copy import deepcopy
from datetime import datetime
import json
from types import SimpleNamespace

import pytest

from app.domains.jobs.output_contracts.schemas import REBALANCE_COLUMNS
from app.domains.recommendation_audit.schemas import Formula
from app.domains.runs.final_recompute import source_calculations, verify_recomputed_rows, verify_formula_inputs
from app.domains.runs.final_source_rows import UnverifiableFinal
from app.domains.runs.final_score_math import ACTION_HEADER


@pytest.fixture(autouse=True)
def isolate_api_usage_telemetry():
    yield


def table(headers, rows):
    return "| " + " | ".join(headers) + " |\n| " + " | ".join("---" for _ in headers) + " |\n" + "\n".join("| " + " | ".join(row) + " |" for row in rows)


@pytest.fixture
def inputs():
    headers = [column.label for column in REBALANCE_COLUMNS]
    values = {header: "-" for header in headers}
    values.update({"Exchange Symbol": "NSE", "Stock Symbol": "FIXTUREEQ", "Current Units": "10",
                   ACTION_HEADER: "Add more", "Units Change": "5", "Final Units": "15", "Units to Buy": "5",
                   "Price Per Unit": "100", "Total Buy Amount": "500", "Technical Setup": "Support bounce"})
    values.update({header: "3" for header in headers if header.startswith("Score Rationale")})
    rebalance = SimpleNamespace(id=11, status="partial", response=table(headers, [[values[header] for header in headers]]))
    tech_headers = ["Exchange Symbol", "Stock Symbol", "Primary Setup", "Confidence Score", "Premarket trend", "Last 5 candles trend"]
    technical = SimpleNamespace(id=21, status="completed", created_at=datetime(2026,1,1), updated_at=None,
                                response=table(tech_headers, [["NSE", "FIXTUREEQ", "Support bounce", "10", "0", "3"]]))
    config = json.loads(json.dumps(Formula().model_dump(), default=float))
    config["detailedRationaleDenominator"] = 24
    payload = {"rebalance_run_ids": [10], "technical_run_id": 20, "formula": config}
    sources = [SimpleNamespace(id=10, prompt="rebalance"), SimpleNamespace(id=20, prompt="### Bullish Setups\n" + table(["Setup", "Bias", "Confidence"], [["Support bounce", "Bullish", "10"]]))]
    return payload, dict(sources=sources, jobs_by_run={10:[rebalance],20:[technical]}, market="india")


def capture(payload, calculation):
    result = deepcopy(payload)
    row = {"exchange":"NSE", "symbol":"FIXTUREEQ", "rawScore":calculation["raw_score"],
           "effectiveScore":calculation["effective_score"], "score":calculation["raw_score"], "scorePolicy":"score-matrix-raw-effective-v2",
           "action":calculation["action"], "estimate":deepcopy(calculation["estimate"]), "valid_suggestions":calculation["valid_suggestions"]}
    detail = deepcopy(calculation["inputs"])
    detail["rows"] = deepcopy(calculation["detail_rows"])
    detail["calculatedScore"] = calculation["raw_score"]
    detail["detailedRationaleRows"] = []
    for term in calculation["weighted_rows"]:
        weighted = {key: term[key] for key in ("id", "score", "multiplier")}
        rule = {"min": term.get("min", -3), "max": term.get("max", 3)}
        if term["id"] == "technical-scan-confidence": rule["actualValue"] = term["score"]
        if term.get("integer"): rule.update(integerOnly=True, actualValue=term["actual"])
        weighted["validationRule"] = rule
        for key in ("denominatorWeight", "outOfBoundsDenominatorWeight"):
            if key in term: weighted[key] = term[key]
        detail["detailedRationaleRows"].append(weighted)
    row["formula_inputs"] = detail
    result.update(rows=[row], input_listing_count=1, final_listing_count=1, excluded_non_buy_listings=[])
    return result


def test_partial_source_recomputation_is_repeatable_and_preserves_inputs(inputs):
    payload, context = inputs
    before = deepcopy(payload)
    original_response = context["jobs_by_run"][10][0].response
    calculations = source_calculations(payload, **context)
    actual = calculations[("NSE", "FIXTUREEQ")]
    assert actual["raw_score"] == 74/24
    assert actual["effective_score"] == 3
    assert actual["valid_suggestions"] == 1
    assert actual["technical_job_id"] == 21
    recorded = capture(payload, actual)
    verify_recomputed_rows(recorded, calculations, raw_field="rawScore", effective_field="effectiveScore")
    assert source_calculations(payload, **context) == calculations
    assert payload == before
    assert context["jobs_by_run"][10][0].response == original_response


@pytest.mark.parametrize("mutation", ["rawScore", "effectiveScore", "score", "action", "estimate", "listing", "counts", "missing_rows", "extra_rows", "exclusion", "suggestions", "bool_count"])
def test_forged_client_assertions_fail(inputs, mutation):
    payload, context = inputs
    calculations = source_calculations(payload, **context)
    recorded = capture(payload, calculations[("NSE", "FIXTUREEQ")])
    if mutation in {"rawScore", "effectiveScore", "score"}: recorded["rows"][0][mutation] = 2.9
    elif mutation == "action": recorded["rows"][0]["action"] = "Hold"
    elif mutation == "estimate": recorded["rows"][0]["estimate"]["units"] = 999
    elif mutation == "listing": recorded["rows"][0]["symbol"] = "INVENTED"
    elif mutation == "counts": recorded["input_listing_count"] = 999
    elif mutation == "missing_rows": recorded["rows"] = []
    elif mutation == "extra_rows": recorded["rows"].append(deepcopy(recorded["rows"][0]))
    elif mutation == "exclusion": recorded["excluded_non_buy_listings"] = [{"symbol":"FIXTUREEQ"}]
    elif mutation == "suggestions": recorded["rows"][0]["valid_suggestions"] = 999
    elif mutation == "bool_count": recorded["final_listing_count"] = True
    with pytest.raises(UnverifiableFinal):
        verify_recomputed_rows(recorded, calculations, raw_field="rawScore", effective_field="effectiveScore")


@pytest.mark.parametrize("mutation", ["formula_missing", "weight_missing", "formula_bool", "denominator_string", "blank_source", "row_width", "source_duplicate", "unknown_setup"])
def test_ambiguous_or_malformed_sources_are_not_certified(inputs, mutation):
    payload, context = inputs
    if mutation == "formula_missing": del payload["formula"]["actionScores"]
    elif mutation == "weight_missing": del payload["formula"]["detailedRationaleMultipliers"]["cruxx"]
    elif mutation == "formula_bool": payload["formula"]["actionScores"]["Hold"] = True
    elif mutation == "denominator_string": payload["formula"]["detailedRationaleDenominator"] = "24"
    elif mutation == "blank_source": context["jobs_by_run"][10][0].response = ""
    elif mutation == "row_width": context["jobs_by_run"][10][0].response += "\n| NSE | FIXTUREEQ |"
    elif mutation == "source_duplicate": context["jobs_by_run"][10][0].response += "\n" + context["jobs_by_run"][10][0].response.splitlines()[-1]
    elif mutation == "unknown_setup": context["jobs_by_run"][20][0].response = context["jobs_by_run"][20][0].response.replace("Support bounce", "Invented setup")
    if mutation == "blank_source":
        assert source_calculations(payload, **context) == {}
    else:
        with pytest.raises(UnverifiableFinal): source_calculations(payload, **context)


def test_valid_formula_inputs_and_tampered_weighted_terms(inputs):
    payload, context = inputs
    calculation = source_calculations(payload, **context)[("NSE", "FIXTUREEQ")]
    detail = deepcopy(calculation["inputs"])
    detail["rows"] = deepcopy(calculation["detail_rows"])
    detail["detailedRationaleRows"] = []
    for weighted in calculation["weighted_rows"]:
        row = {key: weighted[key] for key in ("id", "score", "multiplier")}
        row["validationRule"] = {"min": weighted.get("min", -3), "max": weighted.get("max", 3)}
        if weighted["id"] == "technical-scan-confidence": row["validationRule"]["actualValue"] = weighted["score"]
        if weighted.get("integer"): row["validationRule"].update(integerOnly=True, actualValue=weighted["actual"])
        for key in ("denominatorWeight", "outOfBoundsDenominatorWeight"):
            if key in weighted: row[key] = weighted[key]
        detail["detailedRationaleRows"].append(row)
    verify_formula_inputs(detail, calculation, score_fields={})
    detail["detailedRationaleRows"][0]["score"] = 0
    with pytest.raises(UnverifiableFinal, match="weighted score"):
        verify_formula_inputs(detail, calculation, score_fields={})


@pytest.mark.parametrize('status', ['partial', 'failed', 'cancelled'])
def test_uncompleted_technical_outputs_do_not_acquire_weight(inputs, status):
    payload, context = inputs
    context['jobs_by_run'][20][0].status = status
    result = source_calculations(payload, **context)[('NSE', 'FIXTUREEQ')]
    assert result['raw_score'] == 49 / 24  # 13*3 + 4*2.5, Technical excluded.
    assert result['technical_job_id'] is None
    assert result['inputs']['technicalScanSourceRunId'] is None
    assert result['effective_score'] == 49 / 24


def test_explicit_unknown_scores_and_zero_units_remain_distinct(inputs):
    payload, context = inputs
    job = context['jobs_by_run'][10][0]
    headers = [column.label for column in REBALANCE_COLUMNS]
    values = {header:'-' for header in headers}
    values.update({'Exchange Symbol':'NSE', 'Stock Symbol':'FIXTUREEQ', 'Current Units':'0', ACTION_HEADER:'Hold',
                   'Units Change':'0', 'Final Units':'0', 'Units to Buy':'0', 'Technical Setup':'Support bounce'})
    job.response = table(headers, [[values[header] for header in headers]])
    context['jobs_by_run'][20][0].status = 'failed'
    result = source_calculations(payload, **context)[('NSE','FIXTUREEQ')]
    assert result['raw_score'] == 0
    assert result['effective_score'] == 0
    assert result['inputs']['currentUnits'] == 0
    assert result['estimate']['units'] is None  # Hold carries no executable estimate.
    assert result['estimate']['amount'] is None
    assert all(term['score'] is None for term in result['weighted_rows'][:6])
