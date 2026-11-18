"""Arithmetic for new workflow scorecards. A missing observation carries no weight."""
from collections import defaultdict
from itertools import combinations
from math import isfinite


def pairwise_scores(instruments, outcomes):
    """Aggregate explicitly judged unordered pairs for a single market/run."""
    listings = sorted(set(instruments))
    valid_pairs = set(combinations(listings, 2))
    points = defaultdict(float)
    counts = defaultdict(int)
    seen = set()
    for left, right, winner in outcomes:
        pair = tuple(sorted((left, right)))
        if pair not in valid_pairs or pair in seen:
            raise ValueError("Unexpected or duplicate pair")
        seen.add(pair)
        if winner is None:
            continue
        if winner not in (left, right, "tie"):
            raise ValueError("Unknown comparison outcome")
        counts[left] += 1
        counts[right] += 1
        if winner == "tie":
            points[left] += 0.5
            points[right] += 0.5
        else:
            points[winner] += 1
    return {
        listing: {
            "score": 100 * points[listing] / counts[listing] if counts[listing] else None,
            "completed": counts[listing],
            "expected": len(listings) - 1,
        }
        for listing in listings
    }


def blend_actionable_score(existing, pairwise=None, threat=None):
    """Blend on the existing signed allocation scale, preserving missing coverage."""
    if existing is None:
        return None
    if isinstance(existing, bool) or not isfinite(existing) or not -3 <= existing <= 3:
        raise ValueError("Existing effective score must be in [-3, 3]")
    components = [existing * 98]
    for supplemental in (pairwise, threat):
        if supplemental is None:
            continue
        if isinstance(supplemental, bool) or not isfinite(supplemental) or not 0 <= supplemental <= 100:
            raise ValueError("Supplemental score must be in [0, 100]")
        components.append(6 * supplemental / 100 - 3)
    if len(components) == 1:
        return existing
    return sum(components) / (97 + len(components))


def actionable_score_100(existing, pairwise=None, stock_threat=None):
    """Convert the existing signed signal and invert adverse stock exposure once."""
    if stock_threat is not None and (isinstance(stock_threat, bool) or
                                     not isfinite(stock_threat) or not 0 <= stock_threat <= 100):
        raise ValueError("Stock threat must be in [0, 100]")
    safety = None if stock_threat is None else 100 - stock_threat
    signed = blend_actionable_score(existing, pairwise, safety)
    return None if signed is None else (signed + 3) * 100 / 6
