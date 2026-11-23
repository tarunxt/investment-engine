"""Frozen source readiness independent of model execution and trade decisions."""
import asyncio
from time import monotonic
from uuid import uuid4

from redis.exceptions import RedisError
from app.domains.zerodha.upstox_quote_guard import redis_client
from . import storage
from .rebalance_output import FACTORS
from .universe import digest


def checklist(research):
    rows = []
    for key, packet in research.get("packets", {}).items():
        allowed = packet["allowed"]
        missing = {f:packet.get("source_gaps",{}).get(f,"No qualifying source") for f in FACTORS if not allowed.get(f)}
        if packet.get("units") is None:
            missing["action"] = "Position quantity unavailable"
        state = "ready" if not missing else "provisional" if any(allowed.get(f) for f in FACTORS) else "awaiting"
        rows.append({"listing":key,"verified_listing":packet.get("verified_listing",key),"state":state,
                     "sessions":packet.get("history_sessions") or {f:max((packet["refs"][r].get("sessions",0) for r in refs if r in packet.get("refs",{})),default=0) for f,refs in allowed.items() if f.startswith("technical-")},"missing":missing})
    counts = {}
    for row in rows:
        for factor in row["missing"]:
            counts[factor] = counts.get(factor, 0) + 1
    leading = max(counts, key=counts.get) if counts else None
    return {"leading_factor":leading, "affected":counts.get(leading, 0), "rows":rows, **{s:sum(r["state"]==s for r in rows) for s in ("ready","provisional","awaiting")}}


def supported_listings(research):
    # Each scored factor must still cite its own allowed, dated source in the output contract.
    return {key for key, packet in research["packets"].items()
            if any(packet["allowed"].get(factor) for factor in FACTORS if factor != "cruxx")}


def merge_sources(previous, current):
    """Retain dated evidence on intermittent upstream failures without mixing reference IDs."""
    for key, old in previous.get("packets",{}).items():
        if key not in current["packets"]:
            continue
        packet=current["packets"][key]
        for factor, ids in old["allowed"].items():
            if not ids or packet["allowed"].get(factor):
                continue
            saved=[]
            for ref in ids:
                if ref not in old["refs"]:
                    continue
                doc=old["refs"][ref]
                new_id=ref if packet["refs"].get(ref,doc)==doc else "saved-"+digest(doc)[:16]
                packet["refs"][new_id]=doc
                saved.append(new_id)
            if saved:
                packet["allowed"][factor]=saved
                packet.get("source_gaps",{}).pop(factor,None)
                if factor.startswith("technical-") and "history_sessions" in packet:
                    packet["history_sessions"][factor]=packet["refs"][saved[0]].get("sessions",0)
        if packet.get("price") is None:
            packet["price"]=old.get("price")
    return current


async def prepare(db, rev, owner, username, previous=None, refresh=False):
    if refresh:
        return await _collect_packet(db,rev,owner,username,previous,True)
    cached=await storage.by_key(db,"packet","rebalance-preflight-v1",revision_id=rev.id)
    if cached:
        return cached
    # Stage 2 prefetch and the first Run click may arrive on different processes.
    token=uuid4().hex
    key=f"rebalance:preflight:{owner}:{rev.id}"
    redis=None
    acquired=False
    try:
        try:
            redis=redis_client()
            deadline=monotonic()+140
            while not (acquired:=await redis.set(key,token,ex=145,nx=True)):
                await db.commit()
                await asyncio.sleep(.75)
                cached=await storage.by_key(db,"packet","rebalance-preflight-v1",revision_id=rev.id)
                if cached:
                    return cached
                if monotonic()>=deadline:
                    break
        except (RuntimeError,RedisError):
            pass
        return await _collect_packet(db,rev,owner,username,previous,False)
    finally:
        if redis is not None:
            try:
                if acquired:
                    await redis.eval("if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) end return 0",1,key,token)
            except RedisError:
                pass
            await redis.aclose()


async def _collect_packet(db, rev, owner, username, previous, refresh):
    from .rebalance_evidence import collect
    from .pair_evidence import latest_history
    revision_id, workflow_id,manifest = rev.id,rev.row.workflow_id,rev.manifest
    if not refresh:
        ready=await storage.by_key(db,"packet","rebalance-preflight-v1",revision_id=revision_id)
        if ready:
            return ready
    history=await latest_history(db,revision_id)
    await db.commit()
    started = monotonic()
    research=await collect(manifest,username,history,refresh=refresh)
    research['collection_seconds'] = round(monotonic() - started, 3)
    if previous:
        research=merge_sources(previous,research)
    identity="rebalance-preflight-v1" if not refresh else "rebalance-source/"+digest(research["packets"])
    await storage.lookup(db,owner,"india","revision",revision_id,lock=True)
    ready=await storage.by_key(db,"packet",identity,revision_id=revision_id)
    if not ready:
        ready=await storage.append(db,workflow_id,"packet",identity,{"research":research},revision_id=revision_id)
    await db.commit()
    return ready


def annotate(result,research, *, score_supported_factors=False):
    from .rebalance_recovery import gaps, with_evidence
    state=checklist(research)
    gaps_by_key=gaps(result)
    eligible=with_evidence(gaps_by_key,research["packets"])
    scorable_keys={r["listing"] for r in state["rows"] if r["state"]=="ready"}
    if score_supported_factors:
        scorable_keys.update(supported_listings(research))
    state["repairable"]=len(scorable_keys.intersection(eligible))
    result["rebalance_readiness"]=state
    return result


async def recover(db, original, owner, username):
    from .rebalance_audit import replay
    rev_id=original.data["revision_id"]
    rev=await storage.lookup(db,owner,"india","revision",rev_id)
    settings=dict(original.data["settings"])
    parent=original.result_json
    if "unassessed_trace" not in parent and original.row.run_id and not original.data.get("data_recovery"):
        from .router import observations
        from .rebalance_output import project
        jobs = await observations(db, original, owner, "india")
        historical = project(rev.manifest, jobs)["unassessed_trace"]
        parent = {**parent, "unassessed_trace":historical}
    orig_id,workflow_id=original.id,original.row.workflow_id
    prior=await storage.lookup(db,owner,"india","packet",settings.get("packet_id")) if settings.get("packet_id") else None
    packet=await prepare(db,rev,owner,username,prior.data["research"] if prior else {},refresh=True)
    def refreshed(result):
        return annotate(dict(result), packet.data["research"],
                        score_supported_factors=settings.get("score_supported_factors", False))

    if original.data.get("data_recovery") and settings.get("packet_id")==packet.id:
        return replay(refreshed(parent))
    await storage.lookup(db,owner,"india","revision",rev_id,lock=True)
    identity=f"rebalance/evidence/{orig_id}/{packet.id}"
    exists=await storage.by_key(db,"attempt",identity,revision_id=rev_id)
    if exists:
        return replay(refreshed(exists.result_json))
    settings.update(packet_id=packet.id,assignments=[],parent=None)
    child=await storage.append(db,workflow_id,"attempt",identity,{"card":"rebalance","settings":settings,
        "data_recovery":True,"recovered_from":orig_id},revision_id=rev_id)
    result=refreshed({**parent,"phase_seconds":{"sources":packet.data["research"]["collection_seconds"]} if "collection_seconds" in packet.data["research"] else {},"id":child.id,"recovered_from":orig_id,"evidence_only":True,"jobs":0,"completed":0})
    child.row.summary_json={**child.data,"result":result}
    child.row.status=result["status"]
    await db.commit()
    return replay(result)
