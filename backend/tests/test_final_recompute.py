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


@pytest.mark.parametrize("alias", ["Buy/Add", "Buy"])
@pytest.mark.parametrize("market,exchange", [("india", "NSE"), ("us", "NASDAQ")])
def test_rebalance_existing_position_buy_labels_verify_like_add(inputs, alias, market, exchange):
    payload, context = inputs
    context["market"] = market
    jobs = context["jobs_by_run"][10]
    add = jobs[0]
    add.status = "completed"
    add.response = add.response.replace("NSE", exchange).replace("FIXTUREEQ", "BEL").replace(
        "| 10 | Add more | 5 | 15 |", "| 36 | Add more | 10 | 46 |")
    add.response = add.response.replace("| 5 | 100 | 500 |", "| 10 | 100 | 1000 |")
    hold = deepcopy(add)
    hold.id, hold.status = 12, "partial"
    hold.response = add.response.replace("| Add more | 10 | 46 |", "| Hold | 0 | 36 |").replace(
        "| 10 | 100 | 1000 |", "| 0 | 100 | 0 |")
    jobs.append(hold)
    expected = source_calculations(payload, **context)
    listing = expected[(exchange, "BEL")]
    assert listing["valid_suggestions"] == 2
    assert listing["inputs"]["meanScore"] == 0.5
    assert listing["inputs"]["meanUnitsChange"] == 5
    add.response = add.response.replace("| Add more |", f"| {alias} |")
    original = add.response
    assert source_calculations(payload, **context) == expected
    assert add.response == original
    add.response = add.response.replace(f"| {alias} |", "| Buy/Sell |")
    with pytest.raises(UnverifiableFinal, match="Rebalance source action"):
        source_calculations(payload, **context)


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


@pytest.mark.parametrize("header", ["Rationale Cruxx", "Technical Setup"])
def test_report_title_and_encoded_description_preserve_calculation(inputs, header):
    payload, context = inputs
    job = context["jobs_by_run"][10][0]
    original = source_calculations(payload, **context)
    lines = job.response.splitlines()
    cells = lines[2].strip("|").split("|")
    col = [name.strip() for name in lines[0].strip("|").split("|")].index(header)
    cells[col] = " P&amp;L reflects unrealised gains "
    lines[2] = "|" + "|".join(cells) + "|"
    job.response = "## 18 November | Recommended Rebalance | Portfolio | Provider\n\n" + "\n".join(lines)
    assert source_calculations(payload, **context) == original
    job.response += "\n\nUnverified | extra row"
    with pytest.raises(UnverifiableFinal):
        source_calculations(payload, **context)


def test_technical_exact_venue_precedes_symbol_alias(inputs):
    payload, context = inputs
    job = context["jobs_by_run"][20][0]
    row = job.response.splitlines()[-1].replace("| NSE |", "| BSE |")
    job.response += "\n" + row
    assert ("NSE", "FIXTUREEQ") in source_calculations(payload, **context)
    job.response = "\n".join(job.response.splitlines()[:2] + [row])
    with pytest.raises(UnverifiableFinal, match="ambiguous across exchanges"):
        source_calculations(payload, **context)


@pytest.mark.parametrize(("primary", "bias"), [
    ("Unavailable – no live data", "Unresolved"),
    ("Unavailable – no dated chart data retrieved", "Unavailable"),
])
def test_saved_unavailable_technical_rows_keep_lineage_and_zero_confidence_weight(inputs, primary, bias):
    from app.domains.jobs.technical_prices import UnavailableTechnicalCoverage, validate_technical_prices

    payload, context = inputs
    job = context["jobs_by_run"][20][0]
    job.response = table(
        ["Exchange Symbol", "Stock Symbol", "Primary Setup", "Bias", "Confidence Score",
         "Premarket trend", "Last 5 candles trend"],
        [["NSE", "FIXTUREEQ", primary, bias, "Unavailable", "0", "Unavailable"]],
    )
    with pytest.raises(UnavailableTechnicalCoverage, match="no usable chart data for any of 1 listings"):
        validate_technical_prices("## Technical Scan Input Bundle", job.response)
    calculation = source_calculations(payload, **context)[("NSE", "FIXTUREEQ")]
    confidence = next(row for row in calculation["weighted_rows"] if row["id"] == "technical-scan-confidence")
    assert confidence["score"] is None and confidence["multiplier"] == 0
    assert calculation["technical_job_id"] == job.id
    job.response = job.response.replace(f"{bias} | Unavailable | 0", f"{bias} | 8 | 0")
    with pytest.raises(UnverifiableFinal, match="approved direction"):
        source_calculations(payload, **context)


def test_us_workflow_preserves_unresolved_listing_and_snapshot_position(inputs):
    payload, context = inputs
    context["market"] = "us"
    for jobs in context["jobs_by_run"].values():
        for job in jobs:
            job.response = job.response.replace("| NSE |", "| NASDAQ |")
    c = source_calculations(payload, **context)[("NASDAQ", "FIXTUREEQ")]
    assert c["inputs"]["stockKey"] == "unresolved:NASDAQ:FIXTUREEQ:?"
    assert c["inputs"]["currentUnits"] is None
    assert c["estimate"]["currentInvestmentAmount"] is None
    assert c["action"] == "Buy New"


def test_named_overflow_is_isolated_and_unsafe_field_still_rejected():
    from app.domains.runs.final_source_rows import rebalance_rows, OVERFLOW
    headers = ["Exchange Symbol", "Stock Symbol", ACTION_HEADER, "Score Rationale Cruxx", OVERFLOW]
    job = SimpleNamespace(id=4, status="partial", response=table(headers, [
        ["NSE", "FIXTURE", "Hold", "-", "unaligned &#124; 2"],
        ["BSE", "OTHER", "Trim", "1", ""],
    ]))
    rows = rebalance_rows(job)
    assert [r[ACTION_HEADER] for r in rows] == ["Hold", "Trim"]
    assert rows[0]["Score Rationale Cruxx"] == "-" and all(OVERFLOW not in row for row in rows)
    job.response = job.response.replace("| Hold |", "| Hold&#124; |")
    with pytest.raises(UnverifiableFinal, match="encoded"):
        rebalance_rows(job)


def test_missing_chart_differs_from_an_observed_flat_chart():
    from app.domains.runs.final_source_rows import missing_chart
    missing = {"Bias": "Neutral", "Primary Setup": "Unavailable – no dated chart", "Confidence Score": "Unavailable"}
    assert missing_chart(missing)
    assert not missing_chart({**missing, "Primary Setup": "Range", "Confidence Score": "5"})


def test_category_labels_and_specific_evidence():
    from app.domains.runs.threat_evidence import audited_evidence
    common = dict(Exchange="NSE", Symbol="FIXTURE", Scenario="S1", Likelihood="3", Impact="2",
                  Rationale="Specific event exposure", Confidence="Low", **{"As of": "2026-11-12"})
    accepted, records = audited_evidence([
        {**common, "Category": "1 geopolitics/trade", "Source": "https://example.com/release/15"},
        {**common, "Category": "2 global economy", "Source": "https://example.com/"},
        {**common, "Category": "2 geopolitics/trade", "Source": "https://example.com/release/16"},
    ])
    assert [r["Category"] for r in accepted] == ["1"]
    assert [r["Disposition"].split(":")[0] for r in records] == ["Accepted", "Excluded", "Excluded"]


@pytest.mark.parametrize("status", ["completed", "partial"])
@pytest.mark.parametrize("market,exchange", [("india", "NSE"), ("us", "NASDAQ")])
def test_no_chart_evidence_replays_without_inventing_a_setup(inputs, status, market, exchange):
    from app.domains.jobs.technical_prices import UnavailableTechnicalCoverage, validate_technical_prices

    payload, context = inputs
    payload["formula_version"] = "score-matrix-v2"
    context["market"] = market
    context["sources"][1].prompt += "\n[SCORING_POLICY_V3]"
    rebalance = context["jobs_by_run"][10][0]
    rebalance.response = rebalance.response.replace("| NSE |", f"| {exchange} |")
    job = context["jobs_by_run"][20][0]
    job.status = status
    job.runtime_metadata_json = {"technical_chart_coverage": "unavailable"} if status == "partial" else {}
    headers = ["Exchange Symbol", "Stock Symbol", "Primary Setup", "Bias", "Confidence Score",
               "Premarket trend", "Last 5 candles trend", "Trigger Level", "Invalidation Level"]
    row = [exchange, "FIXTUREEQ", "Evidence unavailable – no dated chart data retrieved", "Neutral",
           "Unavailable", "0", "Unavailable", "Unavailable", "Unavailable"]
    job.response = table(headers, [row])
    with pytest.raises(UnavailableTechnicalCoverage):
        validate_technical_prices("## Technical Scan Input Bundle", job.response)
    calculation = source_calculations(payload, **context)[(exchange, "FIXTUREEQ")]
    terms = {r["id"]: r for r in calculation["weighted_rows"]}
    assert calculation["technical_job_id"] == job.id
    assert terms["technical-scan-confidence"]["score"] is None
    assert terms["last-5-candles-trend"]["score"] is None
    assert terms["premarket-trend"]["score"] == 0
    assert calculation["raw_score"] is not None
    row[2] = "No dated candles were supplied"
    job.response = table(headers, [row])
    assert source_calculations(payload, **context)[(exchange, "FIXTUREEQ")] == calculation
    row[4] = "9"
    job.response = table(headers, [row])
    with pytest.raises(UnverifiableFinal, match="approved direction"):
        source_calculations(payload, **context)


def test_encoded_ticker_matches_literal_ticker_across_final_sources(inputs):
    payload, context = inputs
    rebalance, technical = (context["jobs_by_run"][run][0] for run in (10, 20))
    for job in (rebalance, technical):
        job.response = job.response.replace("FIXTUREEQ", "A&B")
    expected = source_calculations(payload, **context)
    assert ("NSE", "A&B") in expected
    for job in (rebalance, technical):
        job.response = job.response.replace("A&B", "A&amp;B")
        assert source_calculations(payload, **context) == expected
        saved = job.response
        for malformed in ("A&amp;amp;B", "A&#124;B"):
            job.response = saved.replace("A&amp;B", malformed)
            with pytest.raises(UnverifiableFinal):
                source_calculations(payload, **context)
        job.response = saved
