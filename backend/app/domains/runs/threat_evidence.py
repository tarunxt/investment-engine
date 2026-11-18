"""Stage 3 evidence contract shared by the India and US threat reports."""
from collections import defaultdict
from datetime import date
from urllib.parse import urlparse

from .threat_scores import event_score, summarize_categories

EVIDENCE_TITLE = "Threat score evidence"
COLUMNS = ["Exchange", "Symbol", "Category", "Scenario", "Trigger", "Likelihood",
           "Impact", "Downside", "Source", "As of", "Confidence", "Rationale"]


def scorecard_instruction(domestic):
    return f"""Preserve the descriptive report and append one final section, ## {EVIDENCE_TITLE}.
Use this exact markdown table header: {' | '.join(COLUMNS)}.
Assess each listing across all eight categories over the next 90 days:
1 geopolitics/trade; 2 global economy; 3 {domestic} economy and monetary conditions;
4 {domestic} policy and regulation; 5 sector/technology; 6 company/governance/balance sheet;
7 physical/operational; 8 liquidity/positioning. Classify a causal event once across all listings.
Use one stable scenario ID, primary category, observable trigger and likelihood across listings.
Likelihood 1 remote, 2 plausible, 3 observable precursors, 4 likely with concrete trigger,
5 confirmed or underway. Use remaining adverse downside from the current price for ongoing events.
Impact 1 below 2%, 2 from 2 to under 5%, 3 from 5 to under 10%, 4 from 10 to under 20%,
5 at least 20%. Use 0 only for documented absence of adverse exposure. Use Unknown when
evidence is inadequate. Use scenario CLEAR only for verified category-wide absence.
Provide dated source URL, ISO evidence date, downside range, rationale, confidence
(high/medium/low), and one row per scenario and listing. Never infer absence from missing news.
After evidence append ## Pairwise comparisons with header Left | Right | Winner | Rationale.
Compare each unordered pair of distinct holdings and contenders once over the same swing horizon,
using trend, relative strength, volume, catalysts and risk/reward. Use EXCHANGE:SYMBOL on both sides.
Winner is one of those exact listing IDs, TIE or UNKNOWN. Explain each judgement."""


def stock_scorecards(rows):
    grouped = defaultdict(dict)
    clear = defaultdict(set)
    conflicts = set()
    identities = {}
    evidence = defaultdict(list)
    for row in rows:
        listing = tuple(row.get(field, "").strip().upper() for field in ("Exchange", "Symbol"))
        if not all(listing):
            continue
        evidence[listing].append(row)
        try:
            category = int(row["Category"])
            if category not in range(1, 9):
                raise ValueError
            scenario = row["Scenario"].strip().casefold()
            if not scenario or scenario == "unknown":
                continue
            if urlparse(row["Source"]).scheme not in ("http", "https") or not urlparse(row["Source"]).hostname:
                continue
            date.fromisoformat(row["As of"])
            if not row["Rationale"].strip() or row["Confidence"].lower() not in {"low", "medium", "high"}:
                continue
            if scenario == "clear" and row["Impact"] == "0":
                clear[listing].add(category)
                continue
            likelihood = int(row["Likelihood"])
            impact = None if row["Impact"].lower() == "unknown" else int(row["Impact"])
            value = event_score(likelihood, impact)
            if identities.setdefault(scenario, (category, likelihood)) != (category, likelihood):
                conflicts.add(scenario)
            events = grouped[listing]
            if scenario in events:
                conflicts.add(scenario)
            events[scenario] = (category, value)
        except (ValueError, KeyError):
            continue
    cards = {}
    for listing, details in evidence.items():
        events = {key: (category, None if key in conflicts else value)
                  for key, (category, value) in grouped[listing].items()}
        occupied = {category for category, _ in events.values()}
        cards[listing] = summarize_categories(events, clear[listing] - occupied)
        cards[listing].update(evidence=details, events=events, clear=clear[listing] - occupied)
    return cards


def comparison_table(rows, listings):
    from .supplemental_scores import pairwise_scores
    valid = set(listings)
    outcomes = {}
    conflicts = set()
    for row in rows:
        left, right = (row.get(key, "").upper().strip() for key in ("Left", "Right"))
        pair = tuple(sorted((left, right)))
        if left == right or left not in valid or right not in valid:
            continue
        outcome = row.get("Winner", "").upper().strip()
        if outcome not in {left, right, "TIE", "UNKNOWN"} or not row.get("Rationale", "").strip():
            continue
        value = {"TIE": "tie", "UNKNOWN": None}.get(outcome, outcome)
        if pair in outcomes and outcomes[pair] != value:
            conflicts.add(pair)
        outcomes[pair] = value
    return pairwise_scores(valid, [(a, b, None if (a, b) in conflicts else value)
                                   for (a, b), value in outcomes.items()])


def snapshot_manifest(snapshot, market, contenders):
    import json
    values = defaultdict(float)
    for row in snapshot.holdings or []:
        if market == "india":
            symbol = row.get("tradingsymbol") or ""
            exchange = row.get("exchange") or ""
            value = (float(row.get("quantity") or 0) + float(row.get("t1_quantity") or 0)) * float(row.get("last_price") or 0)
        else:
            symbol = row.get("symbol") or ""
            exchange = row.get("exchange") or ""
            value = float(row.get("current_value") or 0)
        values[f"{exchange}:{symbol}".upper()] += value
    return "[SCORECARD_UNIVERSE_V1]" + json.dumps({"holdings": dict(values), "contenders": list(contenders)},
                                                   separators=(",", ":"))


def portfolio_summary(cards, values):
    from .threat_scores import portfolio_event
    total = sum(values.values())
    if total <= 0:
        return None
    mapped = {}
    for listing in values:
        exchange, symbol = listing.split(":", 1)
        matches = [card for (ex, sym), card in cards.items() if symbol == sym and (not exchange or ex == exchange)]
        mapped[listing] = matches[0] if len(matches) == 1 else None
    weights = {listing: value / total for listing, value in values.items()}
    scenarios = {}
    for card in mapped.values():
        if card:
            scenarios.update({scenario: category for scenario, (category, _) in card["events"].items()})
    scored = {}
    detail = {}
    for scenario, category in scenarios.items():
        scores = {}
        for listing, card in mapped.items():
            if card and scenario in card["events"]:
                scores[listing] = card["events"][scenario][1]
            elif card and category in card["clear"]:
                scores[listing] = 0
        result = portfolio_event(weights, scores)
        detail[scenario] = result
        scored[scenario] = category, result["score"]
    clear = {n for n in range(1, 9) if all(c and n in c["clear"] for c in mapped.values())}
    summary = summarize_categories(scored, clear)
    leaders = sorted((s for s in detail if detail[s]["score"] is not None),
                     key=lambda s: -detail[s]["score"])
    leader = leaders[0] if leaders else None
    return {"score": summary["score"], "leading_scenario": leader,
            "assessed_weight": sum(weights[key] for key, card in mapped.items() if card and card["score"] is not None),
            "contributors": detail[leader]["contributors"][:3] if leader else []}

def assessment_list(manifest, evidence_listings):
    """Resolve venue-less holdings only when the response identifies one venue."""
    observed = defaultdict(set)
    for exchange, symbol in evidence_listings:
        observed[symbol].add(exchange)
    listings = set()
    for listing in [*manifest["holdings"], *manifest["contenders"]]:
        exchange, separator, symbol = listing.upper().partition(":")
        if not separator or not symbol:
            continue
        if exchange in {"", "US"} and len(observed[symbol]) == 1:
            exchange = next(iter(observed[symbol]))
        listings.add((exchange, symbol))
    return listings
