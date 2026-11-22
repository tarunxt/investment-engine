"""Project archived Threats jobs into auditable listing/category assessments."""
import json
from collections import defaultdict
from urllib.parse import urlsplit

from .prompts import CATEGORIES
from .scoring import json_items, parse_rows, threats, threats_by_slot


def target_gaps(rows):
    return {r["listing"]:missing for r in rows
            if (missing := [f"C{i}" for i, label in enumerate(CATEGORIES,1) if (r.get("categories") or {}).get(label) is None])}


def new_evidence_targets(packet, previous):
    return {key:changed for key, cats in packet["targets"].items()
            if (changed := [cat for cat in cats if set(packet["matrix"][key][cat]) - set(previous.get(key,{}).get(cat,[]))])}


def project(manifest, jobs):
    keys = [s["listing"] for s in manifest["stocks"]]
    rows_seen, audits, seen_sources = defaultdict(list), defaultdict(list), defaultdict(lambda:defaultdict(set))
    slots, accepted_categories, definitions = defaultdict(dict), defaultdict(set), defaultdict(dict)
    errors, failed_assignments, returned = [], {}, set()
    catalogue = {}
    for job, slot, assigned, _, *packets in jobs:
        packet = (packets[0] if packets else None) or {}
        modern = packet.get("threat_version") == 2
        parsed, error = parse_rows(job.response, "threats", set(assigned))
        if job.status not in ("partial","completed") and "invalid output contract" not in str(getattr(job,"error_message","")):
            parsed, error = {}, getattr(job,"error_message",None) or job.status
        for key in assigned:
            for cat, ids in packet.get("matrix",{}).get(key,{}).items():
                seen_sources[key][cat].update(ids)
            if key in parsed:
                failed_assignments.pop((slot,key),None)
            else:
                failed_assignments[slot,key] = {"job_id":job.id,"reason":error or f"Missing or duplicate row for {key}"}
        shared = {}
        for row in parsed.values():
            for event in json_items(row.get("Evidence")):
                identifier = str(event.get("scenario_id","")).strip().lower()
                if identifier and identifier!="clear" and event.get("trigger") and event.get("likelihood"):
                    shared.setdefault(identifier,{k:event[k] for k in ("category","trigger","likelihood","source_id") if k in event})
        supported = {}
        source_refs = {}
        for key,row in parsed.items():
            returned.add(key)
            rows_seen[key].append({k:v for k,v in row.items() if k!="Evidence"})
            items = []
            allowed = {r["url"] for r in packet.get("listings",{}).get(key,[]) if r["kind"]!="filing_index"} | set(getattr(job,"web_sources",None) or [])
            for item in json_items(row.get("Evidence")):
                if modern:
                    item = {**shared.get(str(item.get("scenario_id","")).strip().lower(),{}),**item}
                cat = str(item.get("category","")).strip().upper()
                cat = "C"+cat if cat.isdigit() else cat
                sid = str(item.get("source_id",""))
                reason = None
                scenario = str(item.get("scenario_id","")).strip().lower()
                if modern:
                    if cat not in packet["targets"].get(key,[]) or sid not in packet["matrix"].get(key,{}).get(cat,[]):
                        reason = "Source is outside the assigned listing/category evidence"
                    elif sid in packet["sources"]:
                        doc = packet["sources"][sid]
                        item = {**item,"source_url":doc["url"],"published_at":doc["as_of"]}
                        source_refs[key,cat,scenario] = sid
                    else:
                        reason = "Frozen source is missing"
                elif packet and item.get("source_url") not in allowed:
                    reason = "URL was absent from the archived source set"
                elif not modern and urlsplit(str(item.get("source_url",""))).path.strip("/").lower() in ("","chart"):
                    reason = "Generic page cannot establish a dated scenario"
                if cat in accepted_categories[slot,key]:
                    reason = "Category already resolved by an earlier attempt"
                definition = (cat,str(item.get("likelihood")))
                if scenario!="clear" and scenario in definitions[slot] and definitions[slot][scenario]!=definition:
                    reason = "Scenario conflicts with its frozen category or likelihood"
                if reason:
                    audits[key].append({"Category":cat,"Scenario":scenario,"Source":str(item.get("source_url","")),
                                        "Disposition":"Excluded: "+reason,"job_id":job.id})
                else:
                    items.append({**item,"category":cat})
            supported[key] = {"Evidence":json.dumps(items)}
        _, records = threats_by_slot(supported,manifest["as_of"])
        accepted = defaultdict(list)
        for record in records:
            key = record["Exchange"]+":"+record["Symbol"]
            cat = "C"+record.get("Category ID",record["Category"])
            scenario = record["Scenario"].strip().lower()
            entry = {**record,"job_id":job.id,"source_id":source_refs.get((key,cat,scenario))}
            if entry.get("source_id") in packet.get("sources",{}):
                doc=packet["sources"][entry["source_id"]]
                entry.update(source_title=doc.get("title"),excerpt=doc.get("excerpt"),document_hash=doc.get("document_hash"))
            audits[key].append(entry)
            if record["Disposition"]=="Accepted":
                accepted[key].append(record)
                accepted_categories[slot,key].add(cat)
                if scenario!="clear":
                    definitions[slot][scenario] = (cat,record["Likelihood"])
                    catalogue.setdefault(f"{slot}:{scenario}",{"scenario":record["Scenario"],"category":cat,
                        "trigger":record["Trigger"],"likelihood":record["Likelihood"],"slot":slot+1})
        for key, items in accepted.items():
            slots[slot].setdefault(key,[]).extend(items)
    from app.domains.runs.threat_evidence import stock_scorecards
    tables = [({":".join(k):v for k,v in stock_scorecards([r for rows in group.values() for r in rows]).items()}, []) for group in slots.values()]
    result = []
    for key in keys:
        row = threats(key,tables,rows_seen[key])
        row["evidence"] = audits[key]
        row["extreme"] = any(v.get("Impact")=="5" and v["Disposition"]=="Accepted" for v in audits[key])
        row["source_ids"] = {cat:sorted(ids) for cat,ids in seen_sources[key].items()}
        row["listing"] = key
        if row["score"] is None:
            row.update(coverage="Unassessed",reason="Insufficient verified risk categories")
        result.append(row)
    errors.extend(failed_assignments.values())
    counts = {"expected":len(keys),"returned":len(returned),"scored":sum(r["score"] is not None for r in result),
              "complete":sum(r["coverage"]=="Complete" for r in result),
              "verified_cells":sum(r["assessed"] for r in result),"jobs_passed":sum(j.status=="completed" for j,*_ in jobs)}
    return {"threat_version":2,"scenarios":list(catalogue.values()),"rows":result,"threat_counts":counts,"errors":errors,"job_ids":[j.id for j,*_ in jobs]}
