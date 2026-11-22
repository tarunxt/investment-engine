import asyncio
from typing import Literal
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import User
from app.domains.runs.models import AutoRebalanceWorkflow as Workflow, RunJob
from app.domains.jobs.models import Job
from app.domains.jobs.output_sources import SOURCE_CONTEXT_KIND
from app.domains.runs.schemas import RunModelTarget as Target
from app.domains.runs.use_cases.create_run import CreateRunUseCase, CreateRunCommand, RunModelTarget
from app.infrastructure.database.session import get_async_db
from app.infrastructure.locks.redis_lock import RedisLock
from app.domains.runs.router import _get_redis
from app.shared.types import UserId
from app.shared.exceptions import AppException
from . import storage
from .storage import Stage
from .prompts import build_prompt, batches, CARDS, single_job_card
from .scoring import project
from app.domains.recommendation_audit.schemas import Formula
from .final import DEFAULT_WEIGHTS, calculate_final, compare_formula, policy
from .universe import digest, publish_manifest
from .research import collect as collect_research

router = APIRouter(prefix="/runs/scorecards", tags=["equity-scorecards"])
Portfolio = Literal["india","indmoney_us"]
Card = Literal["rebalance","technical","threats","pairwise"]


_packet_fetches = {}


async def shared_research(revision_id, manifest, username):
    # Workflow launches Technical and Pairwise concurrently. Share the in-flight fetch.
    key = (manifest["owner_id"],revision_id)
    task = _packet_fetches.get(key)
    if task is None:
        task = asyncio.create_task(collect_research(manifest,"pairwise",username=username))
        _packet_fetches[key] = task
        task.add_done_callback(lambda finished: _packet_fetches.pop(key,None))
    return await asyncio.shield(task)


class Request(BaseModel):
    model_config = ConfigDict(extra="forbid")


class VerifiedListing(Request):
    symbol: str = Field(pattern=r"^[A-Z0-9.-]{1,24}$")
    venue: Literal["NASDAQ","NYSE","NYSEAMERICAN","NYSEARCA"]
    security_id: str = Field(min_length=1,max_length=100)
    share_class: str = Field(min_length=1,max_length=100)
    source_url: str = Field(pattern=r"^https://[^ /]+/[^ ]+$",max_length=1000)


class Publication(Request):
    request_key: str = Field(min_length=1,max_length=80)
    sequence: int = Field(gt=0)
    snapshot_id: int | None = Field(default=None,gt=0)
    captured_at: datetime
    swing_job_ids: list[int] = Field(max_length=500)
    verified_listings: list[VerifiedListing] = Field(default_factory=list,max_length=1000)


class Start(Request):
    request_key: str = Field(min_length=1,max_length=80)
    sequence: int = Field(gt=0)
    targets: list[Target] = Field(min_length=1,max_length=8)
    retry_attempt_id: int | None = Field(default=None,gt=0)
    check_pair_order: bool = False


class Finalize(Request):
    sequence: int = Field(gt=0)
    attempts: dict[Card,int]
    weights: dict[Card,float]
    factors: dict[Card,dict[str,float]] = Field(default_factory=dict)
    actions: dict[str,float] | None = None
    compare_with: Formula | None = None


async def workflow(db, uid, portfolio, sequence):
    w = await db.scalar(select(Workflow).where(Workflow.user_id==uid,Workflow.portfolio==portfolio,Workflow.sequence==sequence).with_for_update())
    if not w:
        raise HTTPException(404,"Workflow not found")
    return w


async def owned(db, uid, portfolio, kind, record_id, *, lock=False):
    record = await storage.lookup(db, uid, portfolio, kind, record_id, lock=lock)
    if not record:
        raise HTTPException(404, "Scorecard record not found")
    return record


@router.get("/{portfolio}/research-performance")
async def research_performance(portfolio:Portfolio, top:int=Query(5,ge=1,le=30), cost_bps:float=Query(10,ge=0,le=100),
                               db:AsyncSession=Depends(get_async_db),user:User=Depends(get_current_user)):
    from .evaluation import evaluate
    return await evaluate(db,user.id,portfolio,top,cost_bps)


@router.get("/{portfolio}/workflows/{sequence}/coverage")
async def workflow_coverage(portfolio:Portfolio, sequence:int, db:AsyncSession=Depends(get_async_db),user:User=Depends(get_current_user)):
    from .coverage import available
    return await available(db,user.id,portfolio,sequence)


@router.post("/india/workflows/{sequence}/prepare-swing-source")
async def prepare_saved_swing(sequence: int, db: AsyncSession = Depends(get_async_db), user: User = Depends(get_current_user)):
    from .swing_recovery import prepare_swing_source
    parent = await workflow(db, user.id, "india", sequence)
    revision = await prepare_swing_source(db, user.id, parent)
    manifest = revision.manifest
    result = {"id": revision.id, "sequence": sequence, "listings": len(manifest["stocks"]),
              "snapshot_id": manifest["snapshot_id"], "swing_job_ids": manifest["swing_job_ids"]}
    await db.commit()
    return result


@router.post("/{portfolio}/revisions")
async def publish(portfolio:Portfolio, body:Publication, db:AsyncSession=Depends(get_async_db), user:User=Depends(get_current_user)):
    w=await workflow(db,user.id,portfolio,body.sequence)
    previous=await storage.by_key(db, "revision", body.request_key, workflow_id=w.id)
    if previous:
        m=previous.manifest
        if m.get("verified_listings",[]) != [v.model_dump() for v in body.verified_listings] or body.snapshot_id is not None and m["snapshot_id"]!=body.snapshot_id or m["swing_job_ids"]!=sorted(set(body.swing_job_ids)) or datetime.fromisoformat(m["snapshot_at"])!=body.captured_at:
            raise HTTPException(409,"Publication key already names different source inputs")
        return {"id":previous.id,"manifest":m,"digest":previous.digest}
    m=await publish_manifest(db,user.id,w,body)
    record=await storage.append(db, w.id, "revision", body.request_key, {"digest": digest(m), "manifest": m})
    out={"id":record.id,"manifest":m,"digest":record.digest}
    await db.commit()
    return out


@router.get("/{portfolio}/revisions")
async def revisions(portfolio:Portfolio, db:AsyncSession=Depends(get_async_db),user:User=Depends(get_current_user)):
    records=(await db.execute(select(Stage.id,Workflow.sequence,Stage.created_at).join(Workflow).where(
        storage.of_kind("revision"),Workflow.user_id==user.id,Workflow.portfolio==portfolio).order_by(Stage.id.desc()).limit(100))).all()
    return [{"id":i,"sequence":seq,"created_at":at} for i,seq,at in records]


@router.get("/{portfolio}/revisions/{revision_id}")
async def detail(portfolio:Portfolio,revision_id:int,db:AsyncSession=Depends(get_async_db),user:User=Depends(get_current_user)):
    rev=await owned(db,user.id,portfolio,"revision",revision_id)
    attempts=(await db.execute(select(Stage.id,Stage.summary_json["card"].as_string(),Stage.run_id).where(
        storage.of_kind("attempt",rev.id)).order_by(Stage.id.desc()))).all()
    finals=(await db.execute(select(Stage.id,Stage.summary_json["digest"].as_string()).where(
        storage.of_kind("final",rev.id)).order_by(Stage.id.desc()))).all()
    return {"id":rev.id,"manifest":rev.manifest,"digest":rev.digest,"attempts":[{"id":i,"card":c,"run_id":r} for i,c,r in attempts],
            "finals":[{"id":i,"digest":d} for i,d in finals],"default_weights":DEFAULT_WEIGHTS}


@router.post("/{portfolio}/revisions/{revision_id}/{card}/start")
async def start(portfolio:Portfolio,revision_id:int,card:Card,body:Start,db:AsyncSession=Depends(get_async_db),user:User=Depends(get_current_user)):
    owner = user.id
    rev = await owned(db,owner,portfolio,"revision",revision_id)
    if not rev.manifest["stocks"]:
        raise HTTPException(422,"Resolve the flagged Stage 2 listing identities before scoring")
    identity = card + "/" + body.request_key
    shared = portfolio=="india" and card in ("technical","pairwise")
    packet = await storage.by_key(db,"packet","market-v2",revision_id=rev.id) if shared else None
    already_started = await storage.by_key(db,"attempt",identity,revision_id=rev.id)
    if not already_started and single_job_card(portfolio, card):
        if len(body.targets) != 1:
            raise HTTPException(422, "Choose exactly one model for this scorecard.")
        if body.check_pair_order:
            raise HTTPException(422, "Pairwise runs use one model job. Extra reversed-order jobs are disabled.")
    research = packet.data["research"] if packet else {}
    if not already_started and not packet:
        manifest = rev.manifest
        username = user.username
        await db.commit()
        research = await shared_research(revision_id,manifest,username) if shared else await collect_research(manifest,card,username=username)
    w=await workflow(db,owner,portfolio,body.sequence)
    rev=await owned(db,owner,portfolio,"revision",revision_id,lock=True)
    config={"targets":[t.model_dump() for t in body.targets],"parent":body.retry_attempt_id}
    existing=await storage.by_key(db,"attempt",identity,revision_id=rev.id)
    if existing:
        if bool(existing.data["settings"].get("check_pair_order"))!=body.check_pair_order or existing.row.workflow_id!=w.id or any(existing.data["settings"].get(k)!=v for k,v in config.items()):
            raise HTTPException(409,"Attempt key already names different inputs")
        return {"id":existing.id,"run_id":existing.row.run_id}
    if body.check_pair_order:
        raise HTTPException(422, "Extra reversed-order jobs are disabled.")
    missing=None
    if body.retry_attempt_id:
        parent=await owned(db,user.id,portfolio,"attempt",body.retry_attempt_id)
        if card!="pairwise" or parent.data["revision_id"]!=rev.id or parent.data["card"]!=card or not parent.result_json:
            raise HTTPException(422,"Select a finished Pairwise attempt with the same inputs and model slots")
        original_targets = parent.data["settings"]["targets"]
        if single_job_card(portfolio, card):
            if config["targets"][0] not in original_targets:
                raise HTTPException(422, "Retry with a model from the original Pairwise run.")
            config["vote_slot"] = parent.data["settings"].get("vote_slot", original_targets.index(config["targets"][0]))
        elif original_targets != config["targets"]:
            raise HTTPException(422, "Retry with the original Pairwise model slots.")
        if not parent.data["settings"].get("packet_id"):
            # Legacy assignments and sources must keep their original contract across a retry.
            research=parent.data["settings"].get("research",{})
        missing=[(r["listing"],v["opponent"]) for r in parent.result_json["rows"] for v in r["comparisons"]
                 if v["verdict"]=="UNKNOWN" and r["listing"]<v["opponent"]]
        if not missing:
            raise HTTPException(422,"All pair assignments have been resolved")
    assignments=list(batches(rev.manifest["stocks"],card,pairs=missing,portfolio=portfolio))
    if shared and research.get("version")==2:
        packet = await storage.by_key(db,"packet","market-v2",revision_id=rev.id)
        if not packet:
            packet = await storage.append(db,w.id,"packet","market-v2",{"research":research},revision_id=rev.id)
        research = packet.data["research"]
        config["packet_id"]=packet.id
        if card=="technical":
            eligible = {k for k,v in research["packets"].items() if not v["features"]["issue"]}
            assignments = [(subset, []) for keys,_ in assignments if (subset := [k for k in keys if k in eligible])]
            if not assignments:
                raise HTTPException(422,"No listings have sufficient verified candles. Check the historical data sources and retry.")
    else:
        config["research"]=research
    config["assignments"]=assignments
    attempt=await storage.append(db,w.id,"attempt",identity,{"card":card,"settings":config},revision_id=rev.id)
    absent = {r["listing"] for r in rev.manifest["stocks"] if r["origin"] == "contender" and r["units"] == 0}
    batch_contexts = tuple({
        "kind": SOURCE_CONTEXT_KIND,
        "market": rev.manifest["market"],
        "scorecard_batch": {
            "kind": "equity_scorecard_batch_v1", "card": card, "listings": keys,
            "absent_contenders": sorted(absent.intersection(keys)),
            **({"pairs_v2":pairs,"as_of":rev.manifest["as_of"],"packet_sources":{
                k:{"sources":{i:{"url":r["url"],"as_of":r["as_of"]} for i,r in research["packets"][k]["sources"].items()}} for k in keys}}
               if card=="pairwise" and pairs and research.get("version")==2 else {}),
        },
    } for keys, pairs in assignments)
    prompts=tuple(build_prompt(rev,card,keys,pairs,research) for keys,pairs in assignments)
    redis=_get_redis()
    try:
        result=await CreateRunUseCase(db,RedisLock(redis)).execute(CreateRunCommand(
            prompt=prompts[0],batch_prompts=prompts,scorecard_batches=batch_contexts,scorecard_attempt_id=attempt.id,targets=[RunModelTarget(**t.model_dump()) for t in body.targets],
            stagger_gemini=not (portfolio == "india" and card == "rebalance"),
            user_id=UserId(user.id),allow_parallel=True,auto_rebalance_portfolio=portfolio,auto_rebalance_sequence=w.sequence,
            auto_rebalance_label=f"{w.label} ({card.title()} Scan)"))
    except AppException as exc:
        raise HTTPException(exc.status_code,exc.message) from exc
    finally:
        await redis.aclose()
    return {"id":attempt.id,"run_id":result.id}


async def observations(db, attempt, uid, portfolio):
    chain=[]
    while attempt:
        chain.append(attempt)
        parent=attempt.data["settings"].get("parent")
        attempt=await owned(db,uid,portfolio,"attempt",parent) if parent else None
    evidence=[]
    for a in reversed(chain):
        jobs=(await db.execute(select(Job).join(RunJob,RunJob.job_id==Job.id)
                               .where(RunJob.run_id==a.row.run_id,RunJob.stage==1).order_by(Job.id))).scalars().all()
        count=len(a.data["settings"]["targets"])
        assignments=a.data["settings"]["assignments"]
        if len(jobs)!=count*len(assignments):
            raise HTTPException(409,"Scorecard batch coverage is incomplete")
        settings = a.data["settings"]
        research = settings.get("research")
        if settings.get("packet_id"):
            packet = await owned(db,uid,portfolio,"packet",settings["packet_id"])
            research = packet.data["research"]
        evidence.extend((job,settings.get("vote_slot", i%count),*assignments[i//count],
                         {**research,"order_check":True} if research and i//count>=settings.get("primary_batches",len(assignments)) else research) for i,job in enumerate(jobs))
    return evidence


@router.get("/{portfolio}/attempts/{attempt_id}")
async def attempt_result(portfolio:Portfolio,attempt_id:int,db:AsyncSession=Depends(get_async_db),user:User=Depends(get_current_user)):
    a=await owned(db,user.id,portfolio,"attempt",attempt_id,lock=True)
    if a.result_json:
        return a.result_json
    jobs=await observations(db,a,user.id,portfolio)
    done=sum(j.status in ("partial","completed","failed","cancelled") for j,*_ in jobs)
    base={"id":a.id,"revision_id":a.data["revision_id"],"card":a.data["card"],"jobs":len(jobs),"completed":done}
    if done!=len(jobs):
        return {**base,"status":"processing","rows":[]}
    rev=await owned(db,user.id,portfolio,"revision",a.data["revision_id"])
    result=project(a.data["card"],rev.manifest,jobs)
    scored=sum(r["score"] is not None for r in result["rows"])
    research = jobs[-1][-1] if jobs else None
    out={**base,**result,"status":"completed" if all(r["coverage"]=="Complete" for r in result["rows"]) and not result["errors"] else "partial" if scored else "unassessed",
                   "research_notices":(research or {}).get("notices",[]),"scored":scored,"source_hashes":{str(j.id):digest(j.response or "") for j,*_ in jobs}}
    a.row.summary_json={**a.data,"result":out}
    a.row.status=out["status"]
    await db.commit()
    return out


@router.post("/{portfolio}/attempts/{attempt_id}/recover")
async def recover_pairs(portfolio:Portfolio,attempt_id:int,db:AsyncSession=Depends(get_async_db),user:User=Depends(get_current_user)):
    original=await owned(db,user.id,portfolio,"attempt",attempt_id,lock=True)
    if original.data["card"]!="pairwise" or not original.result_json:
        raise HTTPException(409,"A terminal Pairwise output is required")
    rev_id=original.data["revision_id"]
    identity=f"pairwise/recover-v2/{attempt_id}"
    existing=await storage.by_key(db,"attempt",identity,workflow_id=original.row.workflow_id,revision_id=rev_id)
    if existing:
        return existing.result_json
    rev=await owned(db,user.id,portfolio,"revision",rev_id)
    jobs=await observations(db,original,user.id,portfolio)
    result=project("pairwise",rev.manifest,jobs)
    if not result["recovered_pairs"] or sum(r["valid"] for r in result["rows"])<=sum(r["valid"] for r in original.result_json["rows"]):
        return original.result_json
    record=await storage.append(db,original.row.workflow_id,"attempt",identity,
        {"card":"pairwise","settings":original.data["settings"],"recovered_from":attempt_id},revision_id=rev_id)
    record.row.run_id=original.row.run_id
    scored=sum(r["score"] is not None for r in result["rows"])
    status="completed" if all(r["coverage"]=="Complete" for r in result["rows"]) and not result["errors"] else "partial"
    out={**original.result_json,**result,"id":record.id,"scored":scored,"status":status}
    record.row.status=status
    record.row.summary_json={**record.data,"result":out}
    await db.commit()
    return out


@router.get("/{portfolio}/finals/{final_id}")
async def saved_final(portfolio:Portfolio,final_id:int,db:AsyncSession=Depends(get_async_db),user:User=Depends(get_current_user)):
    item=await owned(db,user.id,portfolio,"final",final_id)
    return {"id":item.id,**item.result_json}


@router.post("/{portfolio}/revisions/{revision_id}/final")
async def finalize(portfolio:Portfolio,revision_id:int,body:Finalize,db:AsyncSession=Depends(get_async_db),user:User=Depends(get_current_user)):
    w=await workflow(db,user.id,portfolio,body.sequence)
    rev=await owned(db,user.id,portfolio,"revision",revision_id)
    try:
        cfg=policy(body.weights,body.factors,body.actions)
    except ValueError as exc:
        raise HTTPException(422,str(exc)) from exc
    outputs={}
    run_ids={}
    for card,i in body.attempts.items():
        a=await owned(db,user.id,portfolio,"attempt",i)
        if a.data["card"]!=card or a.data["revision_id"]!=rev.id or not a.result_json:
            raise HTTPException(409,"All selected scorecard outputs must be terminal and use this Stage 2 revision")
        outputs[card]=a.result_json
        run_ids[card]=a.row.run_id
    if not outputs:
        raise HTTPException(422,"Select at least one saved output")
    rows=calculate_final(rev.manifest,outputs,cfg)
    if body.compare_with is not None:
        return {"comparison":compare_formula(rows,outputs,body.compare_with)}
    key=digest([rev.digest,body.attempts,cfg])
    item=await storage.by_key(db,"final",key,workflow_id=w.id,revision_id=rev.id)
    if not item:
        result={"schema":"independent-scorecards-v1","portfolio":portfolio,"sequence":w.sequence,"revision_id":rev.id,
                "manifest_hash":rev.digest,"attempts":body.attempts,"source_runs":run_ids,"policy":cfg,
                "rows":rows}
        item=await storage.append(db,w.id,"final",key,{"digest":key,"result":result},revision_id=rev.id)
    out={"id":item.id,**item.result_json}
    await db.commit()
    return out


@router.get("/{portfolio}/revisions/{revision_id}/{card}/prompt")
async def prompt_preview(portfolio:Portfolio,revision_id:int,card:Card,db:AsyncSession=Depends(get_async_db),user:User=Depends(get_current_user)):
    rev=await owned(db,user.id,portfolio,"revision",revision_id)
    first=next(batches(rev.manifest["stocks"],card,portfolio=portfolio),([],[]))
    packet = await storage.by_key(db,"packet","market-v2",revision_id=rev.id) if card in ("technical","pairwise") else None
    research = packet.data["research"] if packet else None
    if research is None and portfolio=="india" and card=="pairwise":
        research = {"version":2,"packets":{k:{"sources":{},"features":{}} for k in first[0]}}
    return {"prompt":build_prompt(rev,card,*first,research)}


@router.get("/{portfolio}/saved-policy")
async def saved_policy(portfolio:Portfolio,db:AsyncSession=Depends(get_async_db),user:User=Depends(get_current_user)):
    item=await storage.latest_final(db,user.id,portfolio)
    return item.result_json["policy"] if item else None


@router.get("/{portfolio}/latest-final")
async def latest_final(portfolio:Portfolio,sequence:int|None=None,db:AsyncSession=Depends(get_async_db),user:User=Depends(get_current_user)):
    item=await storage.latest_final(db,user.id,portfolio,sequence)
    return {"id":item.id,**item.result_json} if item else None
