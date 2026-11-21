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


def batches(stocks, card, *, pairs=None):
    keys = sorted(row["listing"] for row in stocks)
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


def build_prompt(revision, card, keys, pairs):
    manifest = revision.manifest
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
    if evidence:
        bundle["swing_evidence"] = evidence
    if card == "technical":
        bundle["setup_catalogue"] = CATALOGUE
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
    return marker + "\n[ENABLE_WEB_SEARCH]\n" + template + "\n" + json.dumps(bundle, ensure_ascii=False, separators=(",", ":"))

