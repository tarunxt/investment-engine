"""Revision-3 annotation contract and projection. Model commentary cannot change a factor."""
import json
from collections import Counter
from app.domains.jobs.output_contracts.document import parse_markdown

COLUMNS = ("Listing","Score /100","Coverage","Primary setup","Entry state","Strongest driver",
           "Contrary evidence or missing input","Trigger / invalidation","Evidence IDs","Legacy five-candle trend")
HEADER = "| " + " | ".join(COLUMNS) + " |"


def prompt(revision, keys, research):
    payload=[]
    for key in keys:
        r=research["technical"].get(key,{})
        candles=sorted(research.get("listings",{}).get(key,[]),key=lambda v:v["as_of"])[-5:]
        payload.append({"listing":key,"score":r.get("score"),"coverage":r.get("coverage","Insufficient data"),
                        "factors":{k:{field:v.get(field) for field in ("value","points","inputs","reason")} for k,v in r.get("factors",{}).items()},
                        "sources":{label:{f:(src.get("last_bar") or {}).get(f) for f in ("as_of","url")} for label,src in r.get("sources",{}).items()},
                        "trigger_state":r.get("readiness"),"missing":r.get("reason"),"flags":r.get("flags"),
                        "evidence_ids":evidence_ids(r),"recent_candles":[[v["as_of"],v["open"],v["high"],v["low"],v["close"]] for v in candles]})
    return (f"[INDEPENDENT_SCORECARD:india:technical:{revision.id}]\n[TECHNICAL_V3]\n[STAGE2_SHARED_EVIDENCE_ONLY]\n"
            "Assess the next 20 completed trading sessions for every listing in the frozen order. "
            "Return exactly the table below and no other text. Copy the supplied backend score, coverage and entry state. "
            "Use — for unknown. A numeric zero is valid. Cite only the supplied evidence IDs, comma-separated. "
            "Explain the largest absolute weighted move from 50, the main contrary observation or missing factor, and the confirmed or waiting trigger. "
            "Use one observed setup. The five factors are Trend 25%, Momentum 20%, Relative strength 20%, Volume 15%, Setup 20%. "
            "Trend uses the distance to SMA50 and its five-session slope scaled by the median prior true range. "
            "Momentum uses five-session log return scaled by prior daily MAD. Relative strength uses 20-session log excess versus NSE:NIFTYBEES scaled by prior tracking MAD. "
            "Volume uses signed last-five volume capped at twice the preceding 20-session median. Setup uses two closes against the same earlier 20-session range. "
            "Score = 50 + sum(weight × (observed factor - 50)). Missing optional factors have zero signed contribution. "
            "For the incumbent comparison only, independently rate the latest five supplied candles on the legacy integer scale -3 strongly bearish through 0 mixed to +3 strongly bullish. "
            "Leave this comparison blank unless five dated candles are supplied. It never contributes to the v3 score.\n"
            +HEADER+"\n"+json.dumps({"cutoff":revision.manifest["as_of"],"revision":revision.id,"assignments":payload},ensure_ascii=False,separators=(",",":")))


def evidence_ids(r):
    stock=r.get("sources",{}).get("stock",{})
    ids=["STATUS"]
    if stock.get("last_bar"):
        ids.append("PRICE")
    if r.get("factors",{}).get("Relative strength",{}).get("value") is not None:
        ids.append("BENCH")
    return ids


def annotations(content, assigned):
    blocks,findings=parse_markdown(content or "")
    tables=[b for b in blocks if b.kind=="table" and tuple(b.headers)==COLUMNS]
    if len(tables)!=1 or any(f.severity=="error" for f in findings):
        return {}, "Technical commentary requires the frozen v3 table"
    valid={}
    counts=Counter()
    for cells in tables[0].rows:
        if len(cells)!=len(COLUMNS):
            continue
        r=dict(zip(COLUMNS,cells))
        k=r["Listing"]
        if k not in assigned:
            continue
        counts[k]+=1
        refs={i.strip() for i in r["Evidence IDs"].split(",")}
        if refs and refs <= set(assigned[k]) and r["Strongest driver"].strip() and r["Contrary evidence or missing input"].strip():
            valid[k]=r
    return {k:v for k,v in valid.items() if counts[k]==1},None


def project(manifest, jobs):
    research=jobs[-1][-1]
    accepted=dict(research.get("carried_comments",{}))
    errors=[]
    for job,slot,keys,_,packet in jobs:
        refs={k:evidence_ids(packet["technical"][k]) for k in keys}
        rows,issue=annotations(job.response,refs) if job.status in ("completed","partial") else ({},job.status)
        if issue or rows.keys()!=refs.keys():
            errors.append({"job_id":job.id,"reason":issue or "Missing or invalid listing commentary"})
        accepted.update({k:(v,job.id) for k,v in rows.items()})
    return saved_rows(manifest,research,accepted,errors,[j.id for j,*_ in jobs])


def saved_rows(manifest,research,accepted,errors,job_ids):
    results=[]
    for stock in manifest["stocks"]:
        key=stock["listing"]
        r=research["technical"][key]
        a,job=accepted.get(key,({},None))
        mismatch=False
        if a:
            try:
                copied=None if a["Score /100"] in ("—","-","") else float(a["Score /100"])
                mismatch=copied!=r["score"] or a["Coverage"]!=r["coverage"]
            except ValueError:
                mismatch=True
        legacy=None
        bars={b["as_of"][:10] for b in research["listings"].get(key,[]) if b.get("kind")=="daily_bar"}
        days=list(research["calendars"].get(key.split(":")[0],{}))[-5:]
        if a.get("Legacy five-candle trend") in ("-3","-2","-1","0","1","2","3","+1","+2","+3") and len(days)==5 and set(days)<=bars and "PRICE" in {v.strip() for v in a.get("Evidence IDs","").split(",")}:
            legacy=int(a["Legacy five-candle trend"])
        baseline=research.get("legacy_baselines",{}).get(key)
        if baseline is None and legacy is not None:
            baseline=(legacy+3)*100/6
        results.append({"listing":key,"score":r["score"],"coverage":r["coverage"],"reason":r["reason"],"technical_v3":r,
                        "terms":{k:v["value"] for k,v in r["factors"].items()},"readiness":r["readiness"],
                        "legacy_score":baseline,"signed_terms":{"candles":legacy},
                        "raw_rows":[a] if a else [],"commentary_job":job,"model_disagreement":mismatch})
    groups={}
    for row in results:
        key=row["technical_v3"].get("canonical_listing",row["listing"])
        groups.setdefault(key,[]).append(row)
    # Source references are retained for traceability. A verified same-venue alias counts once.
    count=Counter("Complete" if all(v["coverage"]=="Complete" for v in rows) else
                  "Insufficient data" if any(v["score"] is None for v in rows) else "Provisional"
                  for rows in groups.values())
    counts={"expected":len(groups),"complete":count["Complete"],"provisional":count["Provisional"],
            "insufficient":count["Insufficient data"],"commentary":len(accepted)}
    if len(groups)!=len(results):
        counts["source_rows"]=len(results)
    return {"scoring_version":3,"rows":results,"errors":errors,"model_tables":[],"recovered_pairs":[],
            "job_ids":job_ids,"technical_counts":counts,
            "technical_bullish":sum(all(r["coverage"]=="Complete" and r["score"]>55 for r in refs) for refs in groups.values())}
