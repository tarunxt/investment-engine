"""Threat scoring for one frozen market snapshot and a common 90-day horizon."""

from math import isfinite


def event_score(likelihood, impact):
    """None denotes insufficient evidence. Zero impact denotes verified absence."""
    if type(likelihood) is not int or likelihood not in range(1, 6):
        raise ValueError("Likelihood must be an integer from 1 to 5")
    if impact is None:
        return None
    if type(impact) is not int or impact not in range(6):
        raise ValueError("Impact must be unknown or an integer from 0 to 5")
    return 4 * likelihood * impact


def summarize_categories(events, verified_clear=()):
    """events maps unique scenario IDs to (primary category, score)."""
    clear = set(verified_clear)
    categories = set(range(1, 9))
    if not clear <= categories:
        raise ValueError("Invalid clear category")
    grouped = {category: [] for category in categories}
    for scenario, (category, score) in events.items():
        if category not in categories or category in clear:
            raise ValueError("Invalid or contradictory event category")
        if score is not None and (not isfinite(score) or not 0 <= score <= 100):
            raise ValueError("Invalid event score")
        grouped[category].append((scenario, score))
    rows = {}
    for category, entries in grouped.items():
        known = sorted((entry for entry in entries if entry[1] is not None),
                       key=lambda entry: (-entry[1], entry[0]))
        rows[category] = {
            "score": known[0][1] if known else (0 if category in clear else None),
            "leading_events": known[:2],
            "complete": category in clear or bool(entries) and len(known) == len(entries),
        }
    ranked = sorted((row["score"] for row in rows.values() if row["score"] is not None),
                    reverse=True)
    score = None
    if len(ranked) >= 3:
        score = sum(weight * value for weight, value in zip((0.7, 0.2, 0.1), ranked))
    return {"score": score, "provisional": any(not row["complete"] for row in rows.values()),
            "categories": rows}


def portfolio_event(weights, scores):
    """Use fixed snapshot weights. Partial results represent known contributions."""
    if any(not isfinite(w) or not 0 <= w <= 1 for w in weights.values()) or sum(weights.values()) > 1.0000001:
        raise ValueError("Invalid snapshot weights")
    contributions = {}
    coverage = 0.0
    for instrument, weight in weights.items():
        score = scores.get(instrument)
        if score is None:
            continue
        if not isfinite(score) or not 0 <= score <= 100:
            raise ValueError("Invalid holding score")
        contributions[instrument] = weight * score
        coverage += weight
    return {"score": sum(contributions.values()) if coverage else None,
            "assessed_weight": coverage,
            "contributors": sorted(contributions.items(), key=lambda item: -item[1])}
