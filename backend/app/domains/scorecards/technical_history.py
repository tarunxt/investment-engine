"""Bootstrap a cold Technical cache from this owner's already frozen evidence."""
from datetime import datetime, timedelta, timezone
from sqlalchemy import select
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
    # Load saved score rows once per output. Raw candle packets are much larger
    # and querying their JSON separately for every symbol timed out on live runs.
    wanted = {k: v for k, v in pending.items() if v.get("sources", {}).get("stock", {}).get("instrument")}
    previous = {}
    if wanted:
        stage = storage.Stage
        documents = (select(stage.summary_json["result"]["rows"]).select_from(stage).join(Workflow)
                     .where(Workflow.user_id == owner, Workflow.portfolio == "india",
                            storage.of_kind("attempt"), stage.id < result["id"],
                            stage.summary_json["card"].as_string() == "technical")
                     .order_by(stage.id.desc()).execution_options(yield_per=4))
        async for rows in await db.stream_scalars(documents):
            for prior in rows or ():
                key = prior["listing"]
                if key not in wanted or prior.get("coverage") != "Complete" or prior.get("score") is None:
                    continue
                old = prior.get("technical_v3") or {}
                session = old.get("session")
                if not session or session >= wanted[key]["session"]:
                    continue
                if old.get("sources", {}).get("stock", {}).get("instrument") != wanted[key]["sources"]["stock"]["instrument"]:
                    continue
                if key not in previous or session > previous[key]["session"]:
                    previous[key] = {"session": session, "score": prior["score"]}
    return {**result, "rows":[{**r, "closing_pending":pending[r["listing"]]["session"],
                               "previous_close_score":previous.get(r["listing"])}
                              if r["listing"] in pending else r for r in result["rows"]]}


async def pairwise_prior_bars(db, manifest, keys):
    """Find this owner's earlier raw session histories, even if Technical lacked other factors."""
    from .technical_sources import session_calendar
    cutoff = datetime.fromisoformat(manifest["as_of"])
    boundary = cutoff.astimezone(timezone.utc).replace(tzinfo=None)
    wanted = set(keys)
    venues = {key.split(":")[0] for key in wanted}
    sessions = {venue: set(session_calendar(cutoff, venue, [], 6)) for venue in venues}
    data = storage.Stage.summary_json["research"]
    query = (select(Workflow.sequence, data["technical"], data["listings"])
             .select_from(storage.Stage).join(Workflow)
             .where(Workflow.user_id == manifest["owner_id"], Workflow.portfolio == "india",
                    Workflow.sequence < manifest["sequence"], storage.of_kind("packet"),
                    data["version"].as_integer() == 3, storage.Stage.created_at <= boundary,
                    storage.Stage.created_at >= boundary - timedelta(days=7))
             .order_by(storage.Stage.id.desc()).limit(36).execution_options(yield_per=2))
    result = {}
    async for sequence, ledgers, listings in await db.stream(query):
        for key in wanted:
            source = (ledgers or {}).get(key, {}).get("sources", {}).get("stock", {})
            instrument = source.get("instrument")
            if not instrument or not source.get("action_url"):
                continue
            bars = [dict(row, reused_workflow=sequence) for row in (listings or {}).get(key, [])
                    if row.get("kind") == "daily_bar" and row.get("url")
                    and row.get("isin", instrument) == instrument and datetime.fromisoformat(row["as_of"]) <= cutoff]
            days = {row["as_of"][:10] for row in bars}
            required = sessions[key.split(":")[0]]
            coverage = len(days & required)
            if coverage > result.get(key, {}).get("matched", 0):
                result[key] = {"instrument": instrument, "stock": source, "bars": bars,
                               "matched": coverage, "as_of": (ledgers or {})[key].get("as_of")}
        wanted -= {key for key in wanted if result.get(key, {}).get("matched") == 6}
        if not wanted:
            break
    return result
