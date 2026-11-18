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
