"""Read only saved outputs from one workflow and Stage 2 revision."""
from collections import Counter
from sqlalchemy import Integer, case, cast, func, select, true
from sqlalchemy.dialects.postgresql import JSONB
from app.domains.runs.models import AutoRebalanceWorkflow as Workflow
from . import storage
from .storage import Stage


def summary(card, rows):
    if card in ("technical","threats"):
        return sum(r.get("score") is not None for r in rows),len(rows)
    # Each verdict appears once on each side of its pair.
    return sum(r.get("valid",0) for r in rows)//2, len(rows)*(len(rows)-1)//2


def output_rank(version, counts, scored, output):
    """Shared by the live board and the paginated Technical catalogue."""
    rank = (counts["complete"], -counts["insufficient"], output) if counts else (scored, 0, output)
    return (version, rank)


async def technical_catalogue(db, owner, portfolio, sequences):
    """Read only compact saved projections for this owner's visible history page."""
    if not sequences:
        return {}
    data = Stage.summary_json
    result = data["result"]
    rows = result["rows"]
    postgres = db.get_bind().dialect.name == "postgresql"
    length = func.jsonb_array_length(cast(rows, JSONB)) if postgres else func.json_array_length(rows)
    if postgres:
        stocks = func.jsonb_array_elements(cast(rows, JSONB)).table_valued("value").alias("stock")
        numeric_score = cast(stocks.c.value, JSONB)["score"].as_string().is_not(None)
    else:
        stocks = func.json_each(rows).table_valued("value").alias("stock")
        numeric_score = func.json_extract(stocks.c.value, "$.score").is_not(None)
    legacy_scored = select(func.count()).select_from(stocks).where(numeric_score).correlate(Stage).scalar_subquery()
    scored = case((data["card"].as_string() == "technical", func.coalesce(
        result["scored"].as_integer(), result["technical_counts"]["complete"].as_integer(), legacy_scored
    )))
    # Use the exact revision policy of available(): newest published revision or
    # revision referenced by the last attempt of ANY card for this workflow.
    docs = (await db.execute(select(
        Workflow.sequence, Stage.stage, Stage.id, Stage.run_id,
        data["revision_id"].as_integer(), data["card"].as_string(),
        result["scoring_version"].as_integer(), result["technical_counts"],
        scored, length,
    ).select_from(Stage).join(Workflow).where(
        Workflow.user_id == owner, Workflow.portfolio == portfolio, Workflow.sequence.in_(sequences),
        storage.of_kind("attempt") | storage.of_kind("revision"),
    ).order_by(Stage.id.desc()))).all()
    revision_ids = {}
    latest_attempts = {}
    for sequence, stage, output, _, revision, *_ in docs:
        if stage.startswith(storage.prefix("revision")):
            revision_ids.setdefault(sequence, output)
        else:
            latest_attempts.setdefault(sequence, revision or 0)
    ranks, summaries = {}, {}
    for sequence, _, output, run, revision, card, version, counts, scored, length in docs:
        if card != "technical" or not length or revision != max(revision_ids.get(sequence, 0), latest_attempts.get(sequence, 0)):
            continue
        rank = output_rank(version == 3, counts, scored or 0, output)
        if sequence in ranks and ranks[sequence] >= rank:
            continue
        ranks[sequence] = rank
        summaries[sequence] = {
            "output_id": output, "run_id": run,
            "expected": counts["expected"] if counts else length,
            "scored": counts["complete"] + counts["provisional"] if counts else scored,
            "complete": counts["complete"] if counts else None,
            "provisional": counts["provisional"] if counts else None,
        }
    return summaries


async def available(db, owner, portfolio, sequence):
    def scoped(*cols):
        return select(*cols).select_from(Stage).join(Workflow).where(
            Workflow.user_id==owner, Workflow.portfolio==portfolio, Workflow.sequence==sequence)
    rev = await db.scalar(scoped(Stage.id).where(storage.of_kind("revision")).order_by(Stage.id.desc()).limit(1))
    attempt_revision = await db.scalar(scoped(Stage.summary_json["revision_id"].as_integer())
                            .where(storage.of_kind("attempt")).order_by(Stage.id.desc()).limit(1))
    rev=max((i for i in (rev,attempt_revision) if i),default=None)
    if not rev:
        return {"revision_id":None,"cards":{}}
    data = Stage.summary_json
    final = (await db.execute(scoped(Stage.id,data["result"]["attempts"]).where(storage.of_kind("final",rev))
                             .order_by(Stage.id.desc()).limit(1))).first()
    rows_expr = data["result"]["rows"]
    postgres = db.get_bind().dialect.name=="postgresql"
    stocks = data["manifest"]["stocks"]
    count = func.jsonb_array_length(cast(stocks, JSONB)) if postgres else func.json_array_length(stocks)
    listing_count = await db.scalar(select(count).select_from(Stage).join(Workflow).where(
        Stage.id == rev, storage.of_kind("revision"), Workflow.user_id == owner, Workflow.portfolio == portfolio))
    if postgres:
        # Aggregate historical JSON on the server. The dashboard never needs raw responses.
        arr=func.jsonb_array_elements(cast(rows_expr,JSONB)).table_valued("value").alias("stock")
        valid=select(func.sum(cast(cast(arr.c.value,JSONB)["valid"].as_string(),Integer))).select_from(arr).correlate(Stage).scalar_subquery()
        stock=cast(arr.c.value,JSONB)
        def count_rows(condition):
            return select(func.count()).select_from(arr).where(condition).correlate(Stage).scalar_subquery()
        returned=count_rows(func.jsonb_array_length(stock["raw_rows"])>0)
        complete=count_rows(stock["coverage"].as_string()=="Complete")
        projections=[func.jsonb_array_length(cast(rows_expr,JSONB)),data["result"]["scored"].as_integer(),valid,returned,complete]
    else:
        projections=[rows_expr]
    items = (await db.execute(scoped(Stage.id,Stage.run_id,data["card"].as_string(),data["result"]["scoring_version"].as_integer(),data["result"]["pair_counts"],data["result"]["technical_counts"],data["result"]["technical_bullish"].as_integer(),data["result"]["status"].as_string(),data["result"]["threat_diagnostics"],*projections)
             .where(storage.of_kind("attempt",rev),data["card"].as_string().in_(["technical","pairwise","threats"] if portfolio=="india" else ["technical","pairwise"]))
             .order_by(Stage.id.desc()))).all()
    cards = {}
    ranks={}
    for output,run,card,version,pair_counts,technical_counts,bullish,status,threat_diagnostics,*info in items:
        if not info[0]:
            continue
        if postgres:
            n,scored,judgments,returned,complete=info
            got,total=(scored or 0,n) if card in ("technical","threats") else ((judgments or 0)//2,n*(n-1)//2)
        else:
            got,total=summary(card,info[0])
            returned=sum(bool(r.get("raw_rows")) for r in info[0])
            complete=sum(r.get("coverage")=="Complete" for r in info[0])
        if card=="threats" and card in cards:
            continue
        if pair_counts:
            got,total=pair_counts["judged"],pair_counts["expected"]
        v3=(card=="technical" and version==3) or bool(pair_counts)
        rank=output_rank(v3,technical_counts,got,output)
        if card in cards and ranks[card]>=rank:
            continue
        ranks[card]=rank
        cards[card] = {"output_id":output,"run_id":run,"covered":got,"expected":total,
                       "used_output_id":(final[1] or {}).get(card) if final else None,"final_id":final[0] if final else None,**({"pair_counts":pair_counts} if pair_counts else {})}
        if technical_counts and card=="technical":
            cards[card]["technical_counts"]={**technical_counts,"bullish":bullish}
        if card=="threats":
            cards[card].update(threat_returned=returned,threat_complete=complete,threat_status=status)
            if threat_diagnostics:
                cards[card]["threat_diagnostics"] = threat_diagnostics
    threats = cards.get("threats")
    if threats and "threat_diagnostics" not in threats:
        from .threat_coverage import diagnostics
        source = await storage.lookup(db,owner,portfolio,"attempt",threats["output_id"])
        threats["threat_diagnostics"] = diagnostics(source.result_json["rows"])
    technical=cards.get("technical")
    if technical and technical.get("technical_counts"):
        root=await db.scalar(scoped(data["technical_root"].as_integer()).where(Stage.id==technical["output_id"]))
        work=await storage.by_key(db,"technical_work",str(root or technical["output_id"]),revision_id=rev)
        if work:
            from .technical_queue import summary as work_summary
            technical["technical_recovery"]=work_summary(work)
    pair=cards.get("pairwise")
    if pair and portfolio=="india":
        from .pair_work import progress
        workflow_id = await db.scalar(select(Stage.workflow_id).where(Stage.id==rev))
        active = await progress(db,rev,workflow_id)
        if active:
            pair["recovery"] = active
    if pair and portfolio=="india" and not pair.get("pair_counts"):
        from .pair_evidence import attempt_packet
        from .pair_plan import summarize
        source=await storage.lookup(db,owner,portfolio,"attempt",pair["output_id"])
        packet=await attempt_packet(db,source)
        result=source.result_json
        if packet.get("packets"):
            pair["pair_counts"]=summarize(result["rows"],packet["packets"],"full",calls=result["jobs"],errors=len(result.get("errors",[])))
    out={"revision_id":rev,"listing_count":listing_count,"cards":cards}
    if portfolio=="india":
        rebalance, final_summary = await rebalance_summary(db,scoped,rev,postgres,owner,portfolio)
        if rebalance:
            cards["rebalance"]=rebalance
        if final_summary:
            if pair and final and final[0]==final_summary["id"] and (used:=(final[1] or {}).get("pairwise")):
                used_counts=await db.scalar(scoped(data["result"]["pair_counts"]).where(Stage.id==used,storage.of_kind("attempt",rev)))
                if used_counts:
                    final_summary["pairwise"]={"used":used,"judged":used_counts["judged"],"expected":used_counts["expected"]}
                    available_counts=pair.get("pair_counts") or {}
                    if (pair["output_id"]!=used and available_counts.get("mode")=="full" and pair["expected"] and
                            pair["covered"]==pair["expected"] and not available_counts.get("errors")):
                        final_summary["pairwise"]["completed_output"]=pair["output_id"]
            out["final_summary"]=final_summary
    return out


async def rebalance_summary(db, scoped, revision, postgres, owner, portfolio):
    from .rebalance_audit import coverage_counts, final_counts
    data = Stage.summary_json
    result = data["result"]
    readiness=result["rebalance_readiness"]
    latest = (await db.execute(scoped(Stage.id,Stage.run_id, result["phase_seconds"].label("phase_seconds"),readiness["leading_factor"].as_string().label("leading_factor"),readiness["affected"].as_integer().label("affected"), *(readiness[k].as_integer().label(k) for k in ("ready","provisional","awaiting"))).where(storage.of_kind("attempt",revision),
              data["card"].as_string()=="rebalance", result["status"].as_string().in_(["completed","partial","unassessed"]))
              .order_by(Stage.id.desc()).limit(1))).first()
    final = (await db.execute(scoped(Stage.id,result["attempts"]["rebalance"].as_integer()).where(storage.of_kind("final",revision))
              .order_by(Stage.id.desc()).limit(1))).first()
    async def read_rows(record,fields, kind):
        def specific(*columns):
            return select(*columns).select_from(Stage).join(Workflow).where(Stage.id==record,
                storage.of_kind(kind,revision),Workflow.user_id==owner,Workflow.portfolio==portfolio)
        query = specific(result["rows"])
        if not postgres:
            return (await db.scalar(query)) or []
        # Transfer only small scalar columns from the selected snapshot.
        arr=func.jsonb_array_elements(cast(result["rows"],JSONB)).table_valued("value").lateral()
        obj=cast(arr.c.value,JSONB)
        q=specific(*(obj[name].as_string().label(name) for name in fields)).join(arr, true())
        return (await db.execute(q)).mappings().all()
    has_output=None
    if latest:
        rows=await read_rows(latest.id,("score","coverage","action"),"attempt")
        counts=coverage_counts(rows)
        has_output={"output_id":latest.id,"run_id":latest.run_id,"covered":counts["assessed"],"expected":len(rows),
                    "used_output_id":final[1] if final else None,"final_id":final[0] if final else None,
                    "counts":counts,"actions":dict(Counter(r.get("action") or "Unavailable" for r in rows))}
        if latest.phase_seconds:
            has_output["phase_seconds"] = latest.phase_seconds
        if latest.leading_factor:
            has_output["leading_factor"] = latest.leading_factor
            has_output["affected"] = latest.affected
        elif latest.ready is not None and (latest.provisional or latest.awaiting):
            # Historical snapshots predate the compact leading-factor summary.
            saved = await db.scalar(scoped(readiness["rows"]).where(Stage.id == latest.id))
            blockers = Counter(f for row in saved or [] for f in row.get("missing", {}))
            if blockers:
                has_output["leading_factor"], has_output["affected"] = blockers.most_common(1)[0]
        if latest.ready is not None:
            has_output["readiness"]={k:getattr(latest,k) for k in ("ready","provisional","awaiting")}
    summary=None
    if final:
        used=final[1]
        inputs=(has_output["expected"] if latest and used==latest.id else
                len(await read_rows(used,("coverage",),"attempt")) if used else None)
        rows=await read_rows(final[0],("status","action","sizing_reason","final"),"final")
        summary={"id":final[0],"rebalance_output":used,"rebalance_inputs":inputs,**final_counts(rows)}
        if any(r.get("final") is not None for r in rows):
            summary["scored"]=sum(r.get("final") is not None for r in rows)
        elif rows and all(r.get("status")=="Unassessed" for r in rows):
            summary["scored"]=0
    return has_output,summary
