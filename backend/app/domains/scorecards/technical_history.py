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
