from itertools import combinations, islice
import json
from pathlib import Path

from app.domains.jobs.output_contracts.schemas import REBALANCE_COLUMNS

ROOT = Path(__file__).resolve().parents[3] / "prompts"
CATALOGUE = json.loads(Path(__file__).with_name("catalogue.json").read_text())
CARDS = ("rebalance", "technical", "threats", "pairwise")
CATEGORIES = ("Geopolitics/trade", "Global financial conditions", "Domestic economy", "Domestic policy",
              "Sector/technology", "Company/governance", "Physical/operational", "Liquidity/positioning")

HEADERS = {
    "rebalance": tuple(c.label for c in REBALANCE_COLUMNS),
    "technical": ("Exchange Symbol", "Stock Symbol", "Primary Setup", "Secondary Setups", "Bias", "Premarket trend",
                  "Last 5 candles trend", "Confidence Score", "Trigger Level", "Invalidation Level", "Evidence source and as-of", "Technical rationale"),
    "pairwise": ("Exchange Symbol", "Stock Symbol", "Assigned pairs", "Judged pairs", "Judgments"),
    "threats": ("Exchange Symbol", "Stock Symbol", *(f"C{i}" for i in range(1, 9)), "Leading threat", "Trigger or event date", "Evidence"),
}


def single_job_card(portfolio, card):
    return portfolio == "india" and card in ("technical", "threats", "pairwise")


def batches(stocks, card, *, pairs=None, portfolio=None):
    keys = sorted(row["listing"] for row in stocks)
    if portfolio == "india" and card == "rebalance":
        # One full-universe assignment per selected model slot, including repeats.
        yield keys, []
        return
    if single_job_card(portfolio, card):
        if card == "technical":
            # Keep the original manifest order. Budget for journal-sized output per listing.
            ordered = [row["listing"] for row in stocks]
            for i in range(0, len(ordered), 40):
                yield ordered[i:i+40], []
        elif card == "threats":
            yield keys, []
        elif pairs is None:
            yield keys, list(combinations(keys, 2))
        elif pairs:
            yield sorted({listing for pair in pairs for listing in pair}), list(pairs)
        return
    if card == "pairwise":
        source = iter(pairs) if pairs is not None else combinations(keys, 2)
        while block := list(islice(source, 24)):
            yield sorted({key for pair in block for key in pair}), block
        if len(keys) == 1:
            yield keys, []
    else:
        size = 4 if card == "threats" else 12 if card == "rebalance" else 20
        for start in range(0, len(keys), size):
            yield keys[start:start + size], []


def build_prompt(revision, card, keys, pairs, research=None, *, reverse_order=False):
    manifest = revision.manifest
    if card == "rebalance" and research and research.get("version") == 4:
        from .rebalance_output import instructions
        context={k:manifest.get(k) for k in ("funds","research_horizon_weeks","currency")}
        context["portfolio_value"]=sum(s.get("value") or 0 for s in manifest["stocks"])
        listings={}
        for stock in manifest["stocks"]:
            k=stock["listing"]
            if k in keys:
                listings[k]={**research["packets"][k],"holding":{f:stock.get(f) for f in ("origin","value","weight","average_cost")},
                    "swing":[{"job":e.get("job_id"),"model":e.get("model"),"thesis":str(e.get("original_row",{}).get("Rationale Cruxx",""))[:300]}
                             for e in manifest.get("evidence",[]) if e["listing"]==k]}
        return instructions(revision.id, {"as_of":manifest["as_of"],"context":context,"listings":listings})
    if card == "technical" and research and research.get("version") == 3:
        from .technical_output import prompt
        return prompt(revision, keys, research)
    context = {k: v for k, v in manifest.items() if k not in ("stocks", "evidence", "unresolved")}
    context.pop("owner_id", None)
    context.pop("verified_listings", None)
    context["revision_hash"] = revision.digest
    rows = [r for r in manifest["stocks"] if r["listing"] in keys]
    if card == "technical":
        rows = [{k: row[k] for k in ("listing","exchange","symbol","price")} for row in rows]
    evidence = [r for r in manifest["evidence"] if r["listing"] in keys] if card in ("rebalance", "pairwise") else []
    header = "| " + " | ".join(column.label for column in REBALANCE_COLUMNS) + " |"
    fields = {"MARKET": manifest["market"], "REVISION": str(revision.id), "AS_OF_WITH_TIMEZONE": manifest["as_of"],
              "STAGE2_CONTEXT": "the attached run context", "STAGE2_ROWS": "the attached assigned listings",
              "STAGE2_SWING_EVIDENCE": "the attached original Swing evidence", "DATE": manifest["as_of"][:10],
              "MODEL": "your actual model name", "REBALANCE_HEADER": header,
              "APPROVED_SETUP_CATALOGUE": "the attached setup catalogue", "ASSIGNED_PAIRS": "the attached pair assignments"}
    template = (ROOT / "scorecard-common.txt").read_text() + "\n" + (ROOT / f"scorecard-{card}.txt").read_text()
    for key, value in fields.items():
        template = template.replace("{{" + key + "}}", value)
    marker = f"[INDEPENDENT_SCORECARD:{manifest['market']}:{card}:{revision.id}]"
    bundle = {"context": context, "listings": rows}
    if card == "pairwise" and pairs and research and research.get("version") == 2:
        # A pair ID is invariant under reversal of the presentation order.
        from hashlib import sha256
        assigned = []
        for left, right in pairs:
            identity = "~".join(sorted((left,right)))
            reverse = sha256((revision.digest+identity).encode()).digest()[0] % 2
            assigned.append({"n": len(assigned) + 1, "pair_id": identity, "listings":[right,left] if bool(reverse) != reverse_order else [left,right]})
        instructions = ("Compare each assigned pair independently over 2–12 weeks using only its frozen listing evidence. "
            "Consider trend, relative strength, liquidity, volatility, and dated catalysts symmetrically. "
            "Return one compact JSON array per assigned pair on its own line: "
            '[n, winning_listing_or_TIE_or_UNKNOWN, "short rationale", [first_source_id], [second_source_id]]. '
            "Use the assignment number n. The source arrays follow the listing IDs in pair_id, split at ~. "
            "Use exact source IDs from those listings. Cite both sides for a winner or TIE. "
            "TIE requires evidence of equivalence. Use UNKNOWN for inadequate evidence. "
            "Return no surrounding text. Features use NIFTYBEES as the benchmark proxy.")
        return marker+"\n[PAIR_RECORDS_V2]\n[STAGE2_SHARED_EVIDENCE_ONLY]\n"+instructions+"\n"+json.dumps({
            "as_of":manifest["as_of"],"packets":{k:research["packets"][k] for k in keys},
            "assigned_pairs":assigned}, ensure_ascii=False,separators=(",",":"))
    if card == "threats" and research and research.get("threat_version") == 2:
        from .threat_coverage import CONFIDENCE_CONTRACT
        targets = {k:research["targets"][k] for k in keys}
        matrix = {k:{c:research["matrix"][k][c] for c in targets[k]} for k in keys}
        ids = {sid for cells in matrix.values() for sources in cells.values() for sid in sources}
        anchors = {k:research.get("issuer_sources",{}).get(k,[]) for k in keys}
        ids.update(sid for refs in anchors.values() for sid in refs)
        bundle["issuer_sources"] = anchors
        if research.get("exposure_required"):
            template += (" For an official release provide exposure_source_id from this listing's issuer_sources "
                         "and exposure_quote copied from that issuer document, showing the affected business, market or facility. "
                         "Explain the causal link. For a physical alert match the location. For CLEAR include clear_quote copied from the assigned source explicitly establishing zero exposure "
                         "for the whole category. An empty search is unknown.")
        bundle.update(category_sources=matrix, sources={sid:research["sources"][sid] for sid in sorted(ids)})
        template += "\n"+CONFIDENCE_CONTRACT+"\n"
        template += ("\nUse only the supplied frozen sources for the assigned categories. Cite source_id in each Evidence "
                     "JSON object. Source IDs point to documents and prices, never to an assumed exposure. Give each "
                     "shared scenario one stable ID, category and likelihood. Define its trigger and likelihood once; other listings may reference that ID with their own impact, downside, confidence and source. Explain the causal exposure for each "
                     "listing in rationale. Use only the excerpt or observations provided. A release mentioning "
                     "another issuer alone cannot justify exposure. For every unsupported category return a dash. "
                     "Leave unassigned categories empty. The server computes all scores.\n")
    elif research is not None:
        bundle["fresh_research"] = {k:research.get("listings",{}).get(k,[]) for k in keys}
        bundle["research_notices"] = research.get("notices",[])
        template += "\nCite an exact retrieved URL and its observation time. A filing index establishes filing identity and date only. Use the underlying document or exchange notice for substantive claims. A five-candle trend requires five supported completed sessions on a consistent price scale. Report any missing or unverified signal.\n"
    if evidence:
        bundle["swing_evidence"] = evidence
    if card == "technical":
        bundle["setup_catalogue"] = CATALOGUE
        if research and research.get("version")==2:
            bundle["computed_features"] = {k:research["packets"][k]["features"] for k in keys}
            bundle["fresh_research"] = {k:[r for r in v if r["kind"]=="daily_bar"][:10] for k,v in bundle["fresh_research"].items()}
            template += "\nUse frozen features; the 20-session relative return uses NIFTYBEES. Report missing observations. The setup rating comes from the catalogue."
    if card == "pairwise":
        bundle["assigned_pairs"] = pairs
    if card != "rebalance":
        template += "\nExact Markdown header (one line)\n| " + " | ".join(HEADERS[card]) + " |\n"
    if card == "pairwise":
        template += 'Each source_refs entry must contain url and as_of (ISO 8601). The first listing owns each ordered pair.\n'
    if card == "technical":
        template += 'Evidence source and as-of must contain the underlying URL and ISO 8601 candle or quote timestamp including time zone.\n'
    # Keep the provider's standard holdings validator on the same Stage 2 batch.
    if card == "rebalance":
        template += "\nAnalyst/Source must include the specific source URL and an ISO 8601 publication or quote time with a zone.\n"
        template += "\n## 1. Latest Portfolio Snapshot\n| Exchange | Stock Symbol | Current Units |\n|---|---|---|\n"
        template += "\n".join(f"| {r['exchange']} | {r['symbol']} | {r['units']} |" for r in rows if r["origin"] in ("holding","both"))
        template += "\n## 2. Stage 2 evidence\n"
    web_marker = "\n" if card=="threats" and research and research.get("threat_version")==2 else "\n[ENABLE_WEB_SEARCH]\n"
    return marker + web_marker + template + "\n" + json.dumps(bundle, ensure_ascii=False, separators=(",", ":"))

