from app.domains.runs.threat_scores import event_score, portfolio_event, summarize_categories


def test_score_and_coverage():
    assert event_score(3, 4) == 48
    assert event_score(3, None) is None
    assert event_score(3, 0) == 0
    assert event_score(1, 5) == 20
    summary = summarize_categories({"policy": (4, 80), "sector": (5, 45), "issuer": (6, 30)})
    assert summary["score"] == 68
    assert summary["provisional"]
    assert summarize_categories({})["score"] is None


def test_shared_event():
    weights = {"A": 0.25, "B": 0.15, "C": 0.60}
    result = portfolio_event(weights, {"A": 80, "B": 60, "C": 0})
    assert result["score"] == 29
    assert result["assessed_weight"] == 1
    assert result["contributors"][:2] == [("A", 20), ("B", 9)]
    partial = portfolio_event(weights, {"A": 80, "B": 60})
    assert partial["assessed_weight"] == 0.4
    assert partial["score"] == 29
