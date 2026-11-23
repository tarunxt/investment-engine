"""Bootstrap a cold Technical cache from this owner's already frozen evidence."""
from datetime import datetime, timedelta, timezone
from sqlalchemy import literal, select, union_all
from app.domains.runs.models import AutoRebalanceWorkflow as Workflow
from . import storage
from .technical_v3 import BENCHMARK


async def prior_bars(db, manifest, keys):
    cutoff=datetime.fromisoformat(manifest["as_of"]).astimezone(timezone.utc).replace(tzinfo=None)
    data=storage.Stage.summary_json["research"]
    packets=(await db.execute(select(data["technical"],data["listings"]).select_from(storage.Stage).join(Workflow)
        .where(Workflow.user_id==manifest["owner_id"],Workflow.portfolio=="india",storage.of_kind("packet"),
               data["version"].as_integer()==3,storage.Stage.created_at<=cutoff,
               storage.Stage.created_at>=cutoff-timedelta(days=7))
        .order_by(storage.Stage.id.desc()).limit(3))).all()
    result={}
    for ledgers,listings in packets:
        for key in set(keys)|{BENCHMARK}:
            if key in result:
                continue
            ledger=(ledgers or {}).get(key,{})
            source=ledger.get("sources",{}).get("stock",{})
            if not source.get("instrument") or ledger.get("coverage")!="Complete":
                continue
            rows=(listings or {}).get(key,[])
            result[key]={"instrument":source["instrument"],"bars":rows,"stock":source,"as_of":ledger.get("as_of")}
    return result

async def closing_display(db, owner, result):
    """Attach dated reference values only. Current score and coverage stay authoritative."""
    pending = {}
    for row in result["rows"]:
        ledger = row.get("technical_v3") or {}
        if row.get("score") is None and ledger.get("session") and "Decision-session candle missing" in (ledger.get("reason") or ""):
            pending[row["listing"]] = ledger
    if not pending:
        return result
    queries = []
    for key, ledger in pending.items():
        isin = ledger.get("sources", {}).get("stock", {}).get("instrument")
        if not isin:
            continue
        source = storage.Stage.summary_json["research"]["technical"][key]
        session = source["session"].as_string()
        candidate = (select(literal(key).label("listing"), session.label("session"),
                            source["score"].as_float().label("score"))
                     .select_from(storage.Stage).join(Workflow)
                     .where(Workflow.user_id == owner, Workflow.portfolio == "india",
                            storage.of_kind("packet"), storage.Stage.id < result["id"],
                            source["coverage"].as_string() == "Complete",
                            source["sources"]["stock"]["instrument"].as_string() == isin,
                            session < ledger["session"], source["score"].as_float().is_not(None))
                     .order_by(session.desc(), storage.Stage.id.desc()).limit(1).subquery())
        queries.append(select(candidate))
    records = await db.execute(union_all(*queries)) if queries else []
    previous = {key: {"session":session, "score":value} for key, session, value in records}
    return {**result, "rows":[{**r, "closing_pending":pending[r["listing"]]["session"],
                               "previous_close_score":previous.get(r["listing"])}
                              if r["listing"] in pending else r for r in result["rows"]]}
