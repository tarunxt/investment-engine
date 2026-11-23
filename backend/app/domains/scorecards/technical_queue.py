"""Durable, leased recovery for Technical market evidence only. No model or order dispatch."""
import asyncio
import logging
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from sqlalchemy import select
from app.domains.auth.models import User
from app.domains.runs.models import AutoRebalanceWorkflow as Workflow
from . import storage
from .storage import Stage

log = logging.getLogger(__name__)
LIMIT = 6
LEASE = 150
WAIT, WORK = "tech_wait", "tech_work"


def now():
    return datetime.now(timezone.utc)


def remaining(result, previous, timestamp, attempted=(), immediate=False):
    items={}
    for row in result["rows"]:
        if row["coverage"]=="Complete":
            continue
        key=row["listing"]
        prior=previous.get(key,{})
        count=prior.get("attempts",0)+int(key in attempted)
        reason=row.get("reason") or "Incomplete Technical evidence"
        provider=(row.get("technical_v3") or {}).get("provider_status",{})
        wait=max(30*2**min(count,5), int(provider.get("retry_after") or 0))
        if "Decision-session candle missing" in reason:
            # Final daily files can arrive hours after close. Preserve bounded retries.
            wait = max(wait, min(4 * 3600, 300 * 2**min(count, 6)))
        if "Exact venue instrument unavailable" in reason:
            from app.domains.zerodha.upstox_quotes import MASTER_TTL
            wait = max(wait, MASTER_TTL)
        due=(timestamp+timedelta(seconds=0 if immediate else wait)).isoformat()
        if prior and key not in attempted:
            due=prior["due"]
        items[key]={"attempts":count,"reason":reason,"due":due}
    return items


def save(record, state):
    active=[v["due"] for v in state["pending"].values() if v["attempts"]<LIMIT]
    if state.get("lease"):
        label=WORK
    else:
        label=WAIT if active else "exhausted" if state["pending"] else "completed"
    state["next"]=state["lease"]["until"] if label==WORK else min(active,default=None)
    record.row.status=label
    record.row.summary_json={**record.data,**state}


def summary(record):
    if not record:
        return None
    data=record.data
    return {"state":{WAIT:"scheduled",WORK:"recovering"}.get(record.row.status,record.row.status),
            "next_retry":data.get("next") if record.row.status==WAIT else None,"pending":data["pending"],
            "output_id":data["latest"]}


async def work_for(db, original):
    root=original.data.get("technical_root",original.id)
    return await storage.by_key(db,"technical_work",str(root),workflow_id=original.row.workflow_id,
                                revision_id=original.data["revision_id"])


async def enqueue(db, original, result, *, immediate=False):
    if result.get("scoring_version")!=3 or all(r["coverage"]=="Complete" for r in result["rows"]):
        return None
    root=original.data.get("technical_root",original.id)
    await db.scalar(select(Stage.id).where(Stage.id==root).with_for_update())
    work=await work_for(db,original)
    if work:
        return work
    work=await storage.append(db,original.row.workflow_id,"technical_work",str(root),{},revision_id=original.data["revision_id"])
    save(work,{"root":root,"latest":original.id,"pending":remaining(result,{},now(),immediate=immediate),"lease":None})
    return work


async def locked(db, job_id):
    row=await db.scalar(select(Stage).where(Stage.id==job_id,storage.of_kind("technical_work"))
                        .execution_options(populate_existing=True).with_for_update())
    return storage.Document(row) if row else None


async def process(db, job_id, owner, username, *, manual=False):
    work=await locked(db,job_id)
    state=dict(work.data)
    stamp=now()
    pending=state["pending"]
    token=uuid4().hex
    busy=state.get("lease") and state["lease"]["until"]>stamp.isoformat()
    due=[k for k,item in pending.items() if item["attempts"]<LIMIT and item["due"]<=stamp.isoformat()]
    if manual and not busy:
        # A manual check may refresh public data. All broker requests still use the shared guard.
        due=[k for k,v in pending.items() if v["attempts"]<LIMIT]
    if manual and work.row.status=="exhausted":
        pending={k:{**v,"attempts":0,"due":stamp.isoformat()} for k,v in pending.items()}
        state["pending"]=pending
        due=list(pending)
    source=await storage.lookup(db,owner,"india","attempt",state["latest"])
    if source is None:
        raise ValueError("Technical recovery source missing")
    previous=source.result_json
    if busy or not due:
        current={**(previous or {"id":source.id,"status":"processing","rows":[]}),"recovery":summary(work)}
        await db.commit()
        return current
    state["lease"]={"token":token,"until":(stamp+timedelta(seconds=LEASE)).isoformat()}
    save(work,state)
    await db.commit()
    if previous is None:
        # Materialise the original job even when the browser has closed. No model dispatch.
        from .router import attempt_result
        from types import SimpleNamespace
        projected=await attempt_result("india",source.id,db,SimpleNamespace(id=owner,username=username))
        if projected.get("status")=="processing":
            work=await locked(db,job_id)
            state=dict(work.data)
            if (state.get("lease") or {}).get("token")==token:
                due_at=(now()+timedelta(seconds=30)).isoformat()
                pending={k:{**v,"due":due_at} for k,v in state["pending"].items()}
                save(work,{**state,"pending":pending,"lease":None})
            await db.commit()
            return projected
        previous=projected
    from .technical_recovery import recover
    try:
        result=await asyncio.wait_for(recover(db,source,owner,username,only=due,commit=False),timeout=100)
    except Exception:
        await db.rollback()
        log.exception("Evidence retrieval failed for Technical work item %s",job_id)
        result=previous
    work=await locked(db,job_id)
    state=dict(work.data)
    if (state.get("lease") or {}).get("token")!=token:
        latest=state["latest"]
        await db.rollback()
        current_source=await storage.lookup(db,owner,"india","attempt",latest)
        return current_source.result_json
    state.update(lease=None, latest=result["id"],pending=remaining(result,pending,now(),due))
    save(work,state)
    current={**result,"recovery":summary(work)}
    await db.commit()
    return current


async def run_due(sessions):
    # Only explicit Technical work items are eligible. An expired lease is replayed after a restart.
    async with sessions() as db:
        query=(select(Stage.id,Workflow.user_id,User.username).select_from(Stage)
               .join(Workflow,Workflow.id==Stage.workflow_id).join(User,User.id==Workflow.user_id)
               .where(storage.of_kind("technical_work"),Workflow.portfolio=="india",Stage.status.in_((WAIT,WORK)),
                      Stage.summary_json["next"].as_string()<=now().isoformat())
               .order_by(Stage.summary_json["next"].as_string(),Stage.id).limit(1))
        item=(await db.execute(query)).first()
        if item:
            await process(db,*item)
        return bool(item)


async def serve(sessions):
    while True:
        await asyncio.sleep(5)
        try:
            await run_due(sessions)
        except Exception:
            log.exception("Technical market evidence queue check failed")
