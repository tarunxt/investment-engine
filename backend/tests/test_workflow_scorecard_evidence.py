from app.domains.runs.threat_evidence import comparison_table, portfolio_summary, stock_scorecards


def observation(symbol, category, scenario, likelihood, impact):
    return dict(Exchange="NSE", Symbol=symbol, Category=str(category), Scenario=scenario,
                Likelihood=str(likelihood), Impact=str(impact), Source="https://example.com/filing",
                Confidence="high", Rationale="Evidence of exposure", **{"As of": "2026-11-18"})


def test_shared_event_excludes_contenders_from_portfolio():
    rows = [observation(symbol, 4, "policy", 5, impact) for symbol, impact in (("A", 4), ("B", 3), ("C", 0), ("D", 5))]
    rows += [observation(symbol, category, "CLEAR", 1, 0) for symbol in "ABCD" for category in (1, 2, 3, 5, 6, 7, 8)]
    cards = stock_scorecards(rows)
    assert cards["NSE", "A"]["score"] == 56
    summary = portfolio_summary(cards, {"NSE:A": 25, "NSE:B": 15, "NSE:C": 60})
    assert abs(summary["score"] - 20.3) < 1e-8
    assert summary["contributors"][:2] == [("NSE:A", 20), ("NSE:B", 9)]
    assert summary["assessed_weight"] == 1


def test_pairwise_ignores_unknown_and_reports_coverage():
    rows = [{"Left": "NSE:A", "Right": "NSE:B", "Winner": "TIE", "Rationale": "Similar opportunities"}]
    result = comparison_table(rows, ["NSE:A", "NSE:B", "NSE:C"])
    assert result["NSE:A"] == {"score": 50, "expected": 2, "completed": 1}
    assert result["NSE:C"]["score"] is None


def test_weighted_final_matches_renderer_in_both_markets():
    import json
    import shutil
    import subprocess
    from pathlib import Path
    from math import isclose
    from app.domains.recommendation_audit.schemas import Formula
    from app.domains.runs.final_score_math import ACTION_HEADER, RATIONALE_HEADERS, calculate_listing

    root = Path(__file__).resolve().parents[2]
    if not shutil.which("node") or not (root / "frontend/node_modules/typescript").exists():
        import pytest
        pytest.skip("Component parity requires installed frontend dependencies")
    config = json.loads(json.dumps(Formula().model_dump(), default=float))
    fixtures = []
    for market, exchange in [("india", "NSE"), ("us", "NASDAQ")]:
        source = {**dict.fromkeys(RATIONALE_HEADERS.values(), "0"), "Exchange Symbol": exchange,
                  "Stock Symbol": "TEST", ACTION_HEADER: "Hold", "Current Units": "10"}
        technical = {"stockSymbol": "TEST", "exchangeSymbol": exchange, "runId": 20, "jobId": 21,
                     "primarySetup": "Support bounce", "secondarySetups": "", "bias": "bullish",
                     "confidenceScore": "0", "premarketTrend": "0", "last5CandlesTrend": "0",
                     "supplementalInputs": {"stock_threat": 68, "pairwise": 100}}
        fixtures.append({"rows": [source], "technical": technical, "formula": config, "market": market})
    result = subprocess.run(["node", str(root / "frontend/tests/helpers/frozenFinalArithmetic.mjs")],
                            input=json.dumps(fixtures), text=True, capture_output=True, check=True)
    for fixture, rendered in zip(fixtures, json.loads(result.stdout), strict=True):
        calculated = calculate_listing(fixture["rows"], config, {"Confidence Score": "0", "Premarket trend": "0",
                                       "Last 5 candles trend": "0"}, direction="bullish",
                                       market=fixture["market"], supplemental=(100, 68))
        signed = rendered["detail"]["calculatedScore"]
        assert isclose(signed, calculated["effective_score"])
        assert isclose((signed + 3) * 100 / 6, 50.32)
        assert rendered["detail"]["calculatedAction"] == calculated["action"]
