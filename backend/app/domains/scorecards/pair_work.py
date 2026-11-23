"""Durable, owner-scoped continuation of a single frozen Pairwise schedule."""
import logging
import time
from datetime import datetime
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import select

from app.domains.auth.models import User
from . import pair_evidence, storage
from .universe import digest

log = logging.getLogger(__name__)
MAX_PASSES = 12
HISTORY_BATCH = 6
LEASE_SECONDS = 180


def missing_items(rows):
    gaps = {}
    for r in rows:
        if r["ready"]:
            continue
        reason = r.get("reason") or "Missing verified observations"
        needs = []
        if "instrument" in reason.lower():
            needs.append("venue instrument")
        if not r["sessions"] or "candle" in reason.lower():
            needs.append("price sessions")
        if "corporate-action" in reason.lower():
            needs.append("corporate actions")
        gaps[r["listing"]] = {"needs": needs or ["verified observations"], "reason": reason}
    return gaps


async def register(db, attempt, owner, sequence, budget=None, *, judge_ready=False, admission_error=None):
    """Called under the revision lock, in the same transaction as the first attempt."""
    identity = f"pairwise/work/{attempt.id}"
    revision = attempt.data["revision_id"]
    found = await storage.by_key(db, "pair_work", identity, revision_id=revision)
    if found:
        if found.row.status=="failed" and not budget and not found.data["budget"]:
            now = int(time.time())
            found.row.status="queued"
            found.row.summary_json={**found.data,"gaps":{},"failures":0,"phase":"queued","next_at":now}
        return found
    now = int(time.time())
    record = await storage.append(db, attempt.row.workflow_id, "pair_work", identity, {
        "owner": owner, "sequence": sequence, "root": attempt.id, "current": attempt.id,
        "budget": budget, "judge_ready": judge_ready, "target": digest(attempt.data["settings"]["targets"]),
        "mode":attempt.data["settings"].get("pair_mode","full"), "spent_estimate": 0, "model_retries": 0,
        "gaps": {}, "next_at": now, "phase": "queued", "started": now,
    }, revision_id=revision)
    initial = attempt.result_json
    if initial:
        state = dict(record.data)
        refresh_gaps(state, initial.get("evidence_readiness",[]), now)
        observed = initial.get("observed_at")
        if observed and initial.get("retry_after"):
            reset = int(datetime.fromisoformat(observed).timestamp()) + initial["retry_after"]
            for gap in state["gaps"].values():
                if "quota" in gap["reason"].lower() or "429" in gap["reason"]:
                    gap["next_retry"] = max(now,reset)
        if state["gaps"]:
            state["phase"] = "waiting for market evidence"
        record.row.summary_json = state
    if admission_error:
        record.row.summary_json = {**record.data, "phase":"judging blocked", "admission_error":admission_error}
    record.row.status = "queued"
    return record


def due(now):
    return (storage.of_kind("pair_work"), storage.Stage.status.in_(("queued", "processing")),
            storage.Stage.summary_json["next_at"].as_integer() <= now)


async def advance(db, work_id):
    """Lease fencing and deterministic attempt IDs make worker redelivery safe."""
    now = int(time.time())
    row = await db.scalar(select(storage.Stage).where(storage.Stage.id == work_id, *due(now)).with_for_update())
    if not row:
        return
    work = dict(row.summary_json)
    token = uuid4().hex
    row.status = "processing"
    row.summary_json = {**work, "lease": token, "next_at": now + LEASE_SECONDS}
    await db.commit()
    status, delay = "queued", 60
    try:
        status, delay = await step(db, work, now, work_id, token)
        work.pop("error", None)
        work["failures"] = 0
    except Exception as exc:
        await db.rollback()
        log.exception("Pairwise continuation %s failed", work_id)
        work["failures"] = work.get("failures", 0) + 1
        work["error"] = str(exc.detail)[:240] if isinstance(exc,HTTPException) else type(exc).__name__
        if (isinstance(exc,HTTPException) and exc.status_code in (400,401,403,404,422)) or work["failures"] >= 5:
            status, delay = "failed", 0
            work["phase"] = "needs attention"
        else:
            delay = min(900, 60 * 2 ** work["failures"])
    row = await db.scalar(select(storage.Stage).where(storage.Stage.id==work_id).with_for_update()
                          .execution_options(populate_existing=True))
    if row.summary_json.get("lease") == token:
        row.status = status
        row.summary_json = {**work, "published_at":None,"next_at": int(time.time())+delay if delay else 0}
    await db.commit()


def refresh_gaps(work, rows, now, visited=(), wait=0):
    prior = work["gaps"]
    gaps = missing_items(rows)
    for key, gap in gaps.items():
        old = prior.get(key, {})
        touched = key in visited
        attempts = old.get("attempts", 0) + int(touched)
        gap.update(attempts=attempts, last_attempt=now if touched else old.get("last_attempt"),
                   next_retry=(now+max(wait, min(3600,60*2**min(attempts,6))) if touched else old.get("next_retry",now)))
        gap["last_success"] = now if old.get("needs") and set(old["needs"])-set(gap["needs"]) else old.get("last_success")
    work["gaps"] = gaps


async def step(db, work, now, work_id, token):
    from .router import attempt_result
    owner, revision = work["owner"], work["revision_id"]
    current = await storage.lookup(db, owner, "india", "attempt", work["current"], sequence=work["sequence"])
    if not current or current.data["card"] != "pairwise" or current.data["revision_id"] != revision:
        raise HTTPException(422,"Pairwise output does not belong to this workflow and revision")
    user = await db.get(User, owner)
    if not user:
        raise HTTPException(404, "Pairwise workflow owner unavailable")
    if work.get("launch"):
        return await dispatch_wave(db, work, user)
    settings = current.data["settings"]
    out = current.result_json or await attempt_result("india", current.id, db, user)
    if out["status"] == "processing":
        work["phase"] = "judging"
        # Warm only the missing frozen components while the current wave is running.
        packet = await pair_evidence.attempt_packet(db,current)
        from .pair_plan import evidence_detail
        rows = evidence_detail(packet["packets"])
        if not work["gaps"] and not work.get("warmed"):
            refresh_gaps(work,rows,now)
        wanted = pending(work,now)
        if wanted and work.get("warmed") != current.id:
            from .technical_sources import collect
            rev = await storage.lookup(db,owner,"india","revision",revision)
            history = await pair_evidence.latest_history(db,revision)
            await db.commit()
            updated = await collect(rev.manifest,user.username,history,set(wanted),pair_repair=True)
            await storage.lookup(db,owner,"india","revision",revision,lock=True)
            await pair_evidence.save_history(db,rev,rev.row.workflow_id,updated)
            await db.commit()
            work["warmed"] = current.id
        return "queued", 45
    if current.row.run_id and work.get("accounted") != current.id:
        work["spent_estimate"] += max(settings.get("wave_estimate",0),out.get("attempt_cost_inr") or 0)
        work["accounted"] = current.id
    if out["status"] == "completed":
        work["phase"], work["gaps"] = "complete", {}
        return "completed", 0
    refresh_gaps(work,out.get("evidence_readiness",[]),now)
    wanted = pending(work,now)
    eligible_now = out["pair_counts"]["eligible"] > out["pair_counts"]["judged"]
    can_judge = not work.get("admission_error") and bool(work["budget"] or work.get("judge_ready"))
    if wanted and not (can_judge and eligible_now):
        out = await pair_evidence.repair(db,current,owner,user.username,requested=set(wanted))
        work["current"] = out["id"]
        refresh_gaps(work,out["evidence_readiness"],now,wanted,out.get("retry_after",0))
    counts = out["pair_counts"]
    if can_judge and counts["eligible"] > counts["judged"]:
        # Reserve the larger of estimated and recorded cost for each finished wave.
        remaining = work["budget"] - work["spent_estimate"] if work["budget"] is not None else None
        if remaining is not None and remaining <= 0:
            raise HTTPException(422,"Pairwise planning budget exhausted")
        if current.row.run_id and work["current"] == current.id:
            if work["model_retries"] >= 2:
                raise HTTPException(422,"Unresolved model judgments remain after two retries")
            work["model_retries"] += 1
        work["launch"] = {"sequence":work["sequence"], "request_key":f'continue-{work["current"]}',
                          "retry_attempt_id":work["current"], "targets":settings["targets"],
                          "pair_mode":settings["pair_mode"], "estimated_budget_inr":remaining}
        # Commit the exact parent and reservation before any broker or paid side effect.
        row = await db.scalar(select(storage.Stage).where(storage.Stage.id==work_id).with_for_update()
                              .execution_options(populate_existing=True))
        if row.summary_json.get("lease") != token:
            return "queued", 30
        row.summary_json = {**work,"lease":token,"next_at":int(time.time())+LEASE_SECONDS}
        await db.commit()
        return await dispatch_wave(db,work,user)
    if work["gaps"]:
        remaining = [v["next_retry"] for v in work["gaps"].values() if v["attempts"] < MAX_PASSES]
        if remaining:
            work["phase"] = "judging blocked" if work.get("admission_error") else "waiting for market evidence"
            return "queued", max(15, min(remaining)-now)
        work["phase"] = "evidence recovery exhausted"
        return "failed", 0
    if work.get("admission_error"):
        work["phase"] = "judging blocked"
        return "failed", 0
    work["phase"] = "awaiting judgments" if counts["judged"]<counts["expected"] else "complete"
    return "completed", 0


async def dispatch_wave(db,work,user):
    from .router import Start, start_scorecard
    child = await start_scorecard("india",work["revision_id"],"pairwise",Start(**work["launch"]),db,user,managed=True)
    work["current"], work["phase"] = child["id"], "judging"
    del work["launch"]
    return "queued", 45


def pending(work, now):
    eligible = [(v["attempts"],v["next_retry"],k) for k,v in work["gaps"].items()
                if v["attempts"] < MAX_PASSES and v["next_retry"]<=now]
    return [key for _,_,key in sorted(eligible)[:HISTORY_BATCH]]


async def progress(db, revision, workflow_id):
    row = await db.scalar(select(storage.Stage).where(storage.of_kind("pair_work",revision),
                          storage.Stage.workflow_id==workflow_id).order_by(storage.Stage.id.desc()).limit(1))
    if not row:
        return None
    w = row.summary_json
    return {"output":w["current"],"root":w["root"],"phase":w["phase"],"next_at":w["next_at"],
            "error":w.get("error") or w.get("admission_error"),"listings":{
                k:{**v,"next_retry":v["next_retry"] if v["attempts"]<MAX_PASSES and row.status!="failed" else None}
                for k,v in w["gaps"].items()}}
