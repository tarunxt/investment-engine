"""Append an evidence-only revision; historical outputs and baskets are immutable."""
from fastapi import HTTPException
from . import storage
from .technical_output import saved_rows
from .technical_sources import collect
from .universe import digest


async def recover(db, original, owner, username, only=None, commit=True):
    old=original.result_json
    rev_id=original.data["revision_id"]
    rev=await storage.lookup(db,owner,"india","revision",rev_id)
    packet_id=original.data["settings"].get("packet_id")
    packet=await storage.lookup(db,owner,"india","packet",packet_id) if packet_id else None
    previous=packet.data["research"] if packet else {}
    already_v3=old.get("scoring_version")==3
    requested={r["listing"] for r in old["rows"] if not already_v3 or r["coverage"]!="Complete"}
    if only is not None:
        requested.intersection_update(only)
    if not requested:
        return old
    manifest=rev.manifest
    workflow_id=original.row.workflow_id
    run_id=original.row.run_id
    original_id=original.id
    settings=dict(original.data["settings"])
    from .technical_history import prior_bars
    prior=await prior_bars(db,manifest,requested)
    await db.commit()
    if previous and not already_v3:
        # Earlier packets hold raw exchange bars and provider bars of unknown adjustment basis.
        def frozen_bars(rows):
            return [{**bar,"basis":"venue-raw" if "nseindia.com/" in bar.get("url","") or "bseindia.com/" in bar.get("url","") else "unverified-provider"}
                    for bar in rows if bar.get("kind")=="daily_bar"]
        previous={"listings":{key:frozen_bars(rows) for key,rows in previous.get("listings",{}).items()}}
    updated=await collect(manifest,username,{**previous,"prior_bars":prior},requested)
    refs={}
    baselines={}
    annotations=dict(previous.get("original_annotations",{}))
    for r in old["rows"]:
        key=r["listing"]
        if already_v3:
            prior=r["technical_v3"]
            current=updated["technical"][key]
            # Recovery cannot discard already verified portions of a frozen packet.
            if current["coverage_pct"]<prior["coverage_pct"] or (prior["score"] is not None and current["score"] is None):
                updated["technical"][key]=prior
                updated["listings"][key]=previous["listings"].get(key,[])
            if r.get("raw_rows"):
                annotations.setdefault(key,{"row":r["raw_rows"][0],"job":r["commentary_job"],"input_hash":prior["input_hash"]})
            if r["raw_rows"] and updated["technical"][key]["input_hash"]==prior["input_hash"]:
                refs[key]=(r["raw_rows"][0],r["commentary_job"])
        baselines[key]=r.get("legacy_score") if already_v3 else r["score"]
    updated.update(carried_comments=refs,legacy_baselines=baselines,original_annotations=annotations)
    signature=digest([(k,r["input_hash"]) for k,r in sorted(updated["technical"].items())])
    if already_v3 and all(r["technical_v3"]["input_hash"]==updated["technical"][r["listing"]]["input_hash"] for r in old["rows"]):
        return old
    await storage.lookup(db,owner,"india","revision",rev_id,lock=True)
    identity=f"technical/recover/{original_id}/{signature}"
    existing=await storage.by_key(db,"attempt",identity,revision_id=rev_id)
    if existing:
        return existing.result_json
    packet=await storage.append(db,workflow_id,"packet",identity,{"research":updated},revision_id=rev_id)
    settings.update(packet_id=packet.id,parent=None,assignments=[])
    root=original.data.get("technical_root",original_id)
    record=await storage.append(db,workflow_id,"attempt",identity,{"card":"technical","settings":settings,
                                "recovered_from":original_id,"technical_root":root,"data_recovery":True},revision_id=rev_id)
    record.row.run_id=run_id
    result=saved_rows(manifest,updated,refs,[],[])
    counts=result["technical_counts"]
    if annotations:
        counts["commentary"]=len(annotations)
        counts["current_commentary"]=len(refs)
        for row in result["rows"]:
            if row["listing"] in annotations and not row["raw_rows"]:
                row["original_annotation"]=annotations[row["listing"]]
    scored=sum(row["score"] is not None for row in result["rows"])
    status="completed" if counts["complete"]==counts["expected"] else "partial" if scored else "unassessed"
    out={**result,"id":record.id,"revision_id":rev_id,"card":"technical","status":status,"scored":scored,
         "jobs":0,"completed":0,"research_notices":updated["notices"],"recovered_from":original_id,
         "stage4_method":old.get("stage4_method","legacy"),"source_hashes":{}}
    record.row.status=status
    record.row.summary_json={**record.data,"result":out}
    if commit:
        await db.commit()
    else:
        await db.flush()
    return out
