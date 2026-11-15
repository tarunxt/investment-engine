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
    actual = calculate_listing(rows, config, technical, direction="bullish", market="india")
    # 13*3 rationale + 10 confidence + 5*3 trend + 4*2.5 action = 74.
    assert actual["raw_score"] == 74 / 30
    config["detailedRationaleDenominator"] = 24
    actual = calculate_listing(rows, config, technical, direction="bullish", market="india")
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
        expected = calculate_listing(fixture["rows"], fixture["formula"], technical,
                                     direction="bullish" if scan else None, market=fixture["market"])
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
    result = calculate_listing(rows, config, scan, direction='bearish', market='india')
    assert result['raw_score'] == -74 / 24
    assert result['effective_score'] == -3
    assert result['action'] == 'Sell All'
    assert result['estimate'] == {'currentUnits':10, 'currentInvestmentAmount':1000, 'units':10, 'amount':1000}
