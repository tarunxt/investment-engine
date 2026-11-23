"""Freeze Pairwise assignments and count coverage independently of provider job status."""
from hashlib import sha256
from itertools import combinations, islice

from .scoring import pair_results
from .universe import digest

BATCH_SIZE = 24


def pair_schedule(keys, mode="full"):
    ordered = sorted(keys)
    if mode == "full" or len(ordered) <= 9:
        return list(combinations(ordered, 2))
    ring = sorted(ordered, key=lambda key: sha256(key.encode()).digest())
    return sorted({tuple(sorted((key, ring[(i + step) % len(ring)])))
                   for i, key in enumerate(ring) for step in range(1, 5)})


def ready(packet):
    metrics = packet.get("features", {})
    return bool(packet.get("sources") and not metrics.get("issue")
                and metrics.get("return_5_pct") is not None)


def assigned_batches(pairs):
    remaining = iter(pairs)
    while block := list(islice(remaining, BATCH_SIZE)):
        yield sorted({k for pair in block for k in pair}), block


def saved_votes(rows):
    votes = {}
    for row in rows:
        left = row["listing"]
        for item in row.get("comparisons", []):
            right = item["opponent"]
            if left < right:
                votes[left, right] = {v["slot"]: v for v in item["evidence"] if v}
    return votes


def plan(keys, research, mode, parent=None, previous=None):
    packets = research["packets"]
    eligible = {k for k in keys if ready(packets.get(k, {}))}
    pairs = pair_schedule(keys, mode)
    carried = {}
    if parent and previous:
        unchanged = {k for k in eligible if digest(packets[k]) == digest(previous.get(k, {}))}
        for pair, records in saved_votes(parent["rows"]).items():
            if set(pair) <= unchanged and records and all(v["result"] != "UNKNOWN" for v in records.values()):
                carried[pair] = records
    selected = [p for p in pairs if set(p) <= eligible and p not in carried]
    return selected, carried


def summarize(rows, packets, mode, *, calls=0, errors=0):
    keys = [row["listing"] for row in rows]
    available = {k for k in keys if ready(packets.get(k, {}))}
    pairs = pair_schedule(keys, mode)
    eligible = sum(a in available and b in available for a,b in pairs)
    one = sum((a in available) != (b in available) for a,b in pairs)
    projected = {r["listing"]:r for r in rows}
    records = saved_votes(rows)
    returned = sum(bool(records.get(p)) for p in pairs)
    judged = sum(r["valid"] for r in rows)//2
    return dict(mode=mode, listings=len(keys), ready=len(available), expected=len(pairs),
                eligible=eligible, judged=judged, returned=returned, one_missing=one,
                both_missing=len(pairs)-eligible-one, complete_stocks=sum(
                    projected[k]["coverage"]=="Complete" for k in keys),
                jobs=calls, errors=errors, benchmark_ready=sum(
                    packets.get(k,{}).get("features",{}).get("relative_20_pct") is not None for k in keys))


def project_plan(manifest, research, mode, fresh, parent=None, previous=None, jobs=0):
    keys = [s["listing"] for s in manifest["stocks"]]
    _, inherited = plan(keys, research, mode, parent, previous)
    pairs = pair_schedule(keys, mode)
    votes = {pair: inherited.get(pair, {}) for pair in pairs}
    for pair, records in saved_votes(fresh.get("rows", [])).items():
        if pair in votes and records:
            votes[pair] = records
    scored = pair_results(votes, keys)
    for row in scored.values():
        row["expected"] = len(row["comparisons"])
        n, d = row["valid"], row["expected"]
        row["coverage_pct"] = 100*n/d if d else None
        row["coverage"] = "Complete" if d and n==d else "Partial" if n else "Unassessed"
    rows = [{"listing":k, **scored[k]} for k in keys]
    stats = summarize(rows, research["packets"], mode, calls=jobs, errors=len(fresh.get("errors",[])))
    stats["carried"] = sum(bool(inherited.get(pair)) for pair in pairs)
    from .evaluation import sparse_agreement
    return {**fresh, "rows":rows, "pair_counts":stats, "pair_protocol":3,
            "balanced_schedule":sparse_agreement(rows) if mode=="full" else None}


def evidence_detail(packets, candle_sources=None):
    return [{"listing":k, "ready":ready(v), **({"closing_candle":candle_sources[k]} if candle_sources and k in candle_sources else {}), "sessions":v["features"].get("sessions",0),
             "last_session":v["features"].get("as_of"), "sources":len(v.get("sources",{})),
             "reason":v["features"].get("issue") or ("" if ready(v) else "Missing verified observations"),
             "volume_note":v["features"].get("volume_note"),
             "benchmark_relative":v["features"].get("relative_20_pct") is not None}
            for k,v in sorted(packets.items())]
