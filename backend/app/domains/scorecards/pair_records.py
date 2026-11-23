"""Read independent pair records. One malformed line only affects its assignment."""
import json
from collections import Counter
from datetime import datetime


def stamped(value, cutoff):
    try:
        stamp = datetime.fromisoformat(value)
        return stamp.tzinfo is not None and stamp <= datetime.fromisoformat(cutoff)
    except (TypeError, ValueError):
        return False


def records(text, pairs, packets, cutoff):
    allowed = {"~".join(sorted(pair)):tuple(sorted(pair)) for pair in pairs}
    counts, valid = Counter(), {}
    for line in (text or "").splitlines():
        try:
            row = json.loads(line.strip())
        except ValueError:
            continue
        if isinstance(row, list) and len(row) == 5:
            number, winner, reason, first_sources, second_sources = row
            if type(number) is not int or not 1 <= number <= len(pairs):
                continue
            first, second = sorted(pairs[number - 1])
            row = {"pair_id": first + "~" + second, "result": winner, "rationale": reason,
                   "evidence": {first: first_sources, second: second_sources}}
        if not isinstance(row, dict) or not isinstance(row.get("pair_id"), str):
            continue
        key = row["pair_id"]
        if key not in allowed:
            continue
        counts[key] += 1
        left, right = allowed[key]
        verdict = row.get("result")
        if verdict not in (left,right,"TIE","UNKNOWN") or not isinstance(row.get("rationale"),str) or not row["rationale"].strip():
            continue
        refs = []
        for side in (left,right):
            citations = row.get("evidence",{})
            ids = citations.get(side) if isinstance(citations,dict) else None
            packet = packets.get(side,{})
            known = packet.get("sources",{})
            if isinstance(ids,list):
                refs.extend({**known[i],"listing":side} for i in dict.fromkeys(x for x in ids if isinstance(x,str))
                            if i in known and stamped(known[i]["as_of"],cutoff))
        if verdict != "UNKNOWN" and {r["listing"] for r in refs} != {left,right}:
            continue
        valid[key] = {"opponent_id":right,"result":verdict,"rationale":row["rationale"],"source_refs":refs}
    return {allowed[k]:v for k,v in valid.items() if counts[k]==1}


def evidence_packets(research, cutoff):
    from .signals import features
    packets = {}
    for listing, observations in research["listings"].items():
        daily = sorted((r for r in observations if r["kind"]=="daily_bar"), key=lambda r:r["as_of"])
        sources = {}
        for obs in [*daily[-1:], *(r for r in observations if r["kind"] in ("exchange_notice","filing_excerpt"))]:
            if obs.get("url") and stamped(obs.get("as_of"),cutoff):
                sources[str(len(sources)+1)] = {k:obs[k] for k in ("url","as_of","title","summary","text","kind") if k in obs}
        metric = features(observations,cutoff,research.get("benchmark",[]),optional_volume=True)
        packets[listing] = {"features":{k:v for k,v in metric.items() if k!="shadow_score"},"sources":sources}
    return packets
