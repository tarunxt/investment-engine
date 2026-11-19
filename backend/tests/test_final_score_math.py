"""Synthetic exact-value and differential checks against component arithmetic."""
from copy import deepcopy
import json
from pathlib import Path
import shutil
import subprocess

import pytest

from app.domains.recommendation_audit.schemas import Formula
from app.domains.runs.final_recompute import equivalent
from app.domains.runs.final_source_rows import SETUP_DIRECTIONS
from app.domains.runs.final_score_math import ACTION_HEADER, RATIONALE_HEADERS, calculate_listing, weighted_score


@pytest.fixture(autouse=True)
def isolate_api_usage_telemetry():
    yield


def formula():
    return json.loads(json.dumps(Formula().model_dump(), default=float))


def source_row(**overrides):
    row = {header: "2" for header in RATIONALE_HEADERS.values()}
    row.update({"Exchange Symbol": "NSE", "Stock Symbol": "FIXTUREEQ", "Current Units": "10",
                ACTION_HEADER: "Add more", "Units Change": "5", "Units to Buy": "5", "Price Per Unit": "100",
                "Confidence Score (0-100)": "80", "Technical Setup": "Support bounce"})
    row.update(overrides)
    return row


def test_raw_arithmetic_is_preserved_and_effective_is_separate():
    config = formula()
    config["detailedRationaleDenominator"] = 30
    rows = [{**source_row(), **{header: "3" for header in RATIONALE_HEADERS.values()}}]
    technical = {"Confidence Score": "10", "Premarket trend": "0", "Last 5 candles trend": "3"}
    actual = calculate_listing(rows, config, technical, direction="bullish", market="india", legacy=True)
    # 13*3 rationale + 10 confidence + 5*3 trend + 4*2.5 action = 74.
    assert actual["raw_score"] == 74 / 30
    config["detailedRationaleDenominator"] = 24
    actual = calculate_listing(rows, config, technical, direction="bullish", market="india", legacy=True)
    assert actual["raw_score"] == 74 / 24
    assert actual["effective_score"] == 3
    assert actual["action"] == "Add more"
    assert actual["estimate"] == {"currentUnits": 10, "currentInvestmentAmount": 1000, "units": 5, "amount": 500}


def test_missing_zero_and_invalid_denominators_keep_existing_semantics():
    assert weighted_score([{"score": None, "multiplier": 3}, {"score": 0, "multiplier": 2}], 5) == (0, 2)
    assert weighted_score([{"score": None, "multiplier": 3}], 3) == (None, 0)
    assert weighted_score([{"score": 1300, "multiplier": 1, "min": 0, "max": 10,
                            "denominatorWeight": 2, "outOfBoundsDenominatorWeight": 3},
                           {"score": 2, "multiplier": 3}]) == (3, 2)
    # Explicit denominator excludes missing weights, not out-of-range reduction.
    assert weighted_score([{"score": 1300, "multiplier": 1, "min": 0, "max": 10}], 3) == (0, 3)


def test_comparison_keeps_null_zero_and_boolean_distinct():
    assert equivalent(3.000000000000001, 3)
    assert not equivalent(None, 0)
    assert not equivalent(True, 1)
    assert not equivalent(float("nan"), 1)


def test_component_arithmetic_parity():
    root = Path(__file__).resolve().parents[2]
    if not shutil.which("node") or not (root / "frontend/node_modules/typescript").exists():
        pytest.skip("Node and frontend TypeScript dependency required for component differential check")
    fixtures = []
    for score in (-3, -2, -1, 0, 1, 2, 3):
        row = {**source_row(), **{header: str(score) for header in RATIONALE_HEADERS.values()}}
        config = formula()
        config["detailedRationaleMultipliers"]["mean-mode-action"] = 0
        fixtures.append({"rows": [row], "technical": None, "formula": config, "market": "india"})
    for confidence, trend in (("10", "3"), ("1300", "2"), ("-", "-"), ("0", "0"), ("8", "4"), ("8", "1.5"), ("junk", "2"), ("N/A", "1")):
        technical = {"primarySetup": "Support bounce", "secondarySetups": "", "bias": "bullish",
                     "confidenceScore": confidence, "premarketTrend": "0", "last5CandlesTrend": trend,
                     "runId": 20, "jobId": 21}
        fixtures.append({"rows": [source_row(), source_row(**{"Current Units": "11", "Units Change": "2", "Units to Buy": "2"})],
                         "technical": technical, "formula": formula(), "market": "us"})
    missing = source_row(**{header: "-" for header in RATIONALE_HEADERS.values()})
    for override in (None, -1, 0, 1, 30, 1001):
        config = formula()
        config["detailedRationaleDenominator"] = override
        fixtures.append({"rows": [missing], "technical": None, "formula": config, "market": "india"})
    for action, current in (("Add more", "10"), ("Hold", "0"), ("Buy New", "0")):
        rows = [source_row(**{ACTION_HEADER: action, "Current Units": current, "Price Per Unit": "-", "Total Buy Amount": "500"}),
                source_row(**{ACTION_HEADER: action, "Current Units": current, "Price Per Unit": "-", "Total Buy Amount": "200"})]
        fixtures.append({"rows": rows, "technical": None, "formula": formula(), "market": "india"})
    custom = formula()
    custom["actionScores"]["Add more"] = 4
    custom["detailedRationaleMultipliers"]["cruxx"] = 101
    fixtures.append({"rows": [source_row()], "technical": None, "formula": custom, "market": "india"})
    icici = [source_row(**{ACTION_HEADER: "Trim", "Exchange Symbol": "BSE", "Stock Symbol": "ICICIBANK",
                           "Current Units": "34", "Units Change": change}) for change in ("-10", "-12")]
    config = formula()
    config["detailedRationaleMultipliers"]["mean-mode-action"] = 0
    fixtures.append({"rows": icici, "technical": None, "formula": config, "market": "india"})
    corrected = calculate_listing(icici, config, market="india")
    assert corrected["action"] == "Add more"
    assert corrected["inputs"]["meanUnitsChange"] == -11
    assert corrected["estimate"]["units"] is None and corrected["estimate"]["amount"] is None
    before = deepcopy(fixtures)
    run = subprocess.run(["node", str(root / "frontend/tests/helpers/frozenFinalArithmetic.mjs")],
                         input=json.dumps(fixtures), capture_output=True, text=True, check=False)
    assert run.returncode == 0, run.stderr[-5000:]
    outputs = json.loads(run.stdout)
    assert outputs[0]["setupDirections"] == SETUP_DIRECTIONS
    for fixture, output in zip(fixtures, outputs):
        scan = fixture["technical"]
        technical = {key: scan[field] for key, field in (("Confidence Score", "confidenceScore"),
                    ("Premarket trend", "premarketTrend"), ("Last 5 candles trend", "last5CandlesTrend"))} if scan else None
        prices = [float(row["Price Per Unit"]) for row in fixture["rows"] if str(row.get("Price Per Unit", "")).replace(".", "", 1).isdigit() and float(row["Price Per Unit"]) > 0]
        expected = calculate_listing(fixture["rows"], fixture["formula"], technical,
                                     direction="bullish" if scan else None, market=fixture["market"], buy_quote={"price":next(iter(prices), None)})
        detail = output["detail"]
        assert equivalent(detail["calculatedScore"], expected["raw_score"]), fixture
        assert equivalent(output["estimate"], expected["estimate"]), fixture
        for key, value in expected["inputs"].items():
            assert equivalent(detail[key], value), (key, fixture, detail[key], value)
    assert fixtures == before


def test_negative_raw_score_is_preserved_and_effective_is_bounded():
    config = formula()
    config['detailedRationaleDenominator'] = 24
    rows = [{**source_row(), ACTION_HEADER: 'Sell All', **{header:'-3' for header in RATIONALE_HEADERS.values()}}]
    scan = {'Confidence Score':'10', 'Premarket trend':'0', 'Last 5 candles trend':'-3'}
    result = calculate_listing(rows, config, scan, direction='bearish', market='india', legacy=True)
    assert result['raw_score'] == -74 / 24
    assert result['effective_score'] == -3
    assert result['action'] == 'Sell All'
    assert result['estimate'] == {'currentUnits':10, 'currentInvestmentAmount':1000, 'units':10, 'amount':1000}

@pytest.mark.parametrize("scan_value,rebalance_value,expected", [
    ("", "", None), (None, 0, 0), ("8", "80", 8), ("", "80", 8), ("80", "", None),
])
def test_informational_confidence(scan_value, rebalance_value, expected):
    config = formula()
    row = source_row(**{"Confidence Score (0-100)": rebalance_value})
    result = calculate_listing([row], config, {"Confidence Score": scan_value}, direction="bullish", market="india")
    term = next(row for row in result["weighted_rows"] if row["id"] == "technical-scan-confidence")
    assert (term["score"], term["multiplier"], term["denominatorWeight"]) == (expected, 0, 0)
    assert result["raw_score"] == calculate_listing([row], config, market="india")["raw_score"]


def test_deferred_action_and_numeric_zero():
    from app.domains.runs.final_score_math import numeric
    assert [numeric(value) for value in (0, 0.0, "0", "", None, True)] == [0, 0, 0, None, None, None]
    for rows in ([{}], [source_row(**{"Current Units": ""})]):
        result = calculate_listing(rows, formula(), market="india")
        assert result["action"] is None
        assert result["estimate"]["units"] is None
        assert result["estimate"]["amount"] is None
    assert calculate_listing([source_row(**{"Current Units": 0})], formula(), market="india")["action"] == "Buy New"


def test_whole_action_labels_and_ambiguous_prose():
    from app.domains.runs.final_score_math import normalize_action
    assert normalize_action("  BUY_NEW ") == "Buy New"
    assert normalize_action("reduce") == "Trim"
    for text in ("Do not sell all", "Hold, do not add", "additional information", "hold2"):
        assert normalize_action(text) is None


def test_snapshot_value_and_trim_exclude_zero_provider_price_and_unsettled_units():
    from app.domains.runs.final_positions import captured_positions
    from app.domains.runs.final_source_rows import UnverifiableFinal
    prompt = """[THREAT_CAPTURED_AT=2026-11-18T18:44:47+00:00]
- Holdings count: 1
Portfolio holdings table:
| Exchange | Stock Symbol | Units | Settled Units | Live Price |
| --- | --- | --- | --- | --- |
| NSE | OIL | 21 | 19 | 435.50 |
"""
    _, positions = captured_positions(prompt)
    rows = [{**source_row(), **{h: "-1.5" for h in RATIONALE_HEADERS.values()},
             ACTION_HEADER: "Trim", "Units Change": "-9", "Current Units": "19", "Price Per Unit": px}
            for px in ("435.50", "0")]
    before = calculate_listing(rows, formula(), market="india")
    after = calculate_listing(rows, formula(), market="india", position=positions[("NSE", "OIL")])
    assert after["effective_score"] == before["effective_score"]
    assert before["estimate"]["amount"] == 1959.75
    assert after["estimate"] == dict(currentUnits=19, currentInvestmentAmount=8274.5, units=9, amount=3919.5)
    with pytest.raises(UnverifiableFinal):
        captured_positions(prompt.replace("count: 1", "count: 2"))


@pytest.mark.parametrize("market,expected_units", [("india", 2), ("us", 2.5)])
def test_buy_quote_provenance_and_unavailable_amount(market, expected_units):
    rows = [source_row(**{ACTION_HEADER: "Buy New", "Current Units": "0", "Units Change": "2.5", "Units to Buy": "2.5", "Price Per Unit": "0"})]
    for price, amount in [(12.5, expected_units * 12.5), (None, None)]:
        result = calculate_listing(rows, formula(), market=market, buy_quote={"price":price})
        assert result["estimate"]["units"] == expected_units
        assert result["estimate"]["amount"] == amount


def test_us_snapshot_identity_and_fractional_position():
    from types import SimpleNamespace
    from app.domains.runs.final_us_positions import holding, resolve_listing
    listings = [{"symbol":"ACME", "instrument":"NASDAQ:ACME", "security_id":"a", "listing_mic":"XNAS", "share_class":"A"}]
    key, identity, safe = resolve_listing(("US", "ACME"), listings)
    assert key == ("NASDAQ","ACME") and identity == 'us:["a","XNAS","A"]' and safe
    snap = SimpleNamespace(parse_status="parsed", holdings_count=1, reported_holdings_count=1, holdings=[{"symbol":"ACME","quantity":0.1278,"current_value":23.45}])
    assert holding(snap, key, safe) == (0.1278,23.45,"matched")
    assert holding(snap, key, False) == (None,None,"unresolved")
