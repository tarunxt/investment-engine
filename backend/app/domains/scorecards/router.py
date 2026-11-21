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
from app.domains.runs.schemas import RunModelTarget as Target
from app.domains.runs.use_cases.create_run import CreateRunUseCase, CreateRunCommand, RunModelTarget
from app.infrastructure.database.session import get_async_db
from app.infrastructure.locks.redis_lock import RedisLock
from app.domains.runs.router import _get_redis
from app.shared.types import UserId
from app.shared.exceptions import AppException
from .models import ScorecardRevision as Revision, ScorecardAttempt as Attempt, ScorecardBatch as Batch, ScorecardFinal as Final
from .prompts import build_prompt, batches, CARDS
from .scoring import project
from app.domains.recommendation_audit.schemas import Formula
from .final import DEFAULT_WEIGHTS, calculate_final, compare_formula, policy
from .universe import digest, publish_manifest

router = APIRouter(prefix="/runs/scorecards", tags=["equity-scorecards"])
Portfolio = Literal["india","indmoney_us"]
Card = Literal["rebalance","technical","threats","pairwise"]


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


async def owned(db, uid, portfolio, model, record_id):
    record = await db.scalar(select(model).join(Workflow,Workflow.id==model.workflow_id)
                             .where(model.id==record_id,Workflow.user_id==uid,Workflow.portfolio==portfolio))
    if not record:
        raise HTTPException(404,"Scorecard record not found")
    return record


@router.post("/{portfolio}/revisions")
async def publish(portfolio:Portfolio, body:Publication, db:AsyncSession=Depends(get_async_db), user:User=Depends(get_current_user)):
    w=await workflow(db,user.id,portfolio,body.sequence)
    previous=await db.scalar(select(Revision).where(Revision.workflow_id==w.id,Revision.request_key==body.request_key))
    if previous:
        m=previous.manifest
        if m.get("verified_listings",[]) != [v.model_dump() for v in body.verified_listings] or body.snapshot_id is not None and m["snapshot_id"]!=body.snapshot_id or m["swing_job_ids"]!=sorted(set(body.swing_job_ids)) or datetime.fromisoformat(m["snapshot_at"])!=body.captured_at:
            raise HTTPException(409,"Publication key already names different source inputs")
        return {"id":previous.id,"manifest":m,"digest":previous.digest}
    m=await publish_manifest(db,user.id,w,body)
    record=Revision(workflow_id=w.id,request_key=body.request_key,digest=digest(m),manifest=m)
    db.add(record)
    await db.flush()
    out={"id":record.id,"manifest":m,"digest":record.digest}
    await db.commit()
    return out


@router.get("/{portfolio}/revisions")
async def revisions(portfolio:Portfolio, db:AsyncSession=Depends(get_async_db),user:User=Depends(get_current_user)):
    records=(await db.execute(select(Revision.id,Workflow.sequence,Revision.created_at).join(Workflow).where(
        Workflow.user_id==user.id,Workflow.portfolio==portfolio).order_by(Revision.id.desc()).limit(100))).all()
    return [{"id":i,"sequence":seq,"created_at":at} for i,seq,at in records]


@router.get("/{portfolio}/revisions/{revision_id}")
async def detail(portfolio:Portfolio,revision_id:int,db:AsyncSession=Depends(get_async_db),user:User=Depends(get_current_user)):
    rev=await owned(db,user.id,portfolio,Revision,revision_id)
    attempts=(await db.execute(select(Attempt.id,Attempt.card,Batch.run_id).join(Batch,Batch.attempt_id==Attempt.id).where(
        Attempt.revision_id==rev.id).order_by(Attempt.id.desc()))).all()
    finals=(await db.execute(select(Final.id,Final.digest).where(Final.revision_id==rev.id).order_by(Final.id.desc()))).all()
    return {"id":rev.id,"manifest":rev.manifest,"digest":rev.digest,"attempts":[{"id":i,"card":c,"run_id":r} for i,c,r in attempts],
            "finals":[{"id":i,"digest":d} for i,d in finals],"default_weights":DEFAULT_WEIGHTS}


@router.post("/{portfolio}/revisions/{revision_id}/{card}/start")
async def start(portfolio:Portfolio,revision_id:int,card:Card,body:Start,db:AsyncSession=Depends(get_async_db),user:User=Depends(get_current_user)):
    w=await workflow(db,user.id,portfolio,body.sequence)
    rev=await owned(db,user.id,portfolio,Revision,revision_id)
    if not rev.manifest["stocks"]:
        raise HTTPException(422,"Resolve the flagged Stage 2 listing identities before scoring")
    config={"targets":[t.model_dump() for t in body.targets],"parent":body.retry_attempt_id}
    existing=await db.scalar(select(Attempt).where(Attempt.revision_id==rev.id,Attempt.card==card,Attempt.request_key==body.request_key))
    if existing:
        if existing.workflow_id!=w.id or any(existing.settings_json.get(k)!=v for k,v in config.items()):
            raise HTTPException(409,"Attempt key already names different inputs")
        run=await db.scalar(select(Batch.run_id).where(Batch.attempt_id==existing.id))
        return {"id":existing.id,"run_id":run}
    missing=None
    if body.retry_attempt_id:
        parent=await owned(db,user.id,portfolio,Attempt,body.retry_attempt_id)
        if card!="pairwise" or parent.revision_id!=rev.id or parent.card!=card or not parent.result_json or parent.settings_json["targets"]!=config["targets"]:
            raise HTTPException(422,"Select a finished Pairwise attempt with the same inputs and model slots")
        missing=[(r["listing"],v["opponent"]) for r in parent.result_json["rows"] for v in r["comparisons"]
                 if v["verdict"]=="UNKNOWN" and r["listing"]<v["opponent"]]
        if not missing:
            raise HTTPException(422,"All pair assignments have been resolved")
    assignments=list(batches(rev.manifest["stocks"],card,pairs=missing))
    config["assignments"]=assignments
    attempt=Attempt(workflow_id=w.id,revision_id=rev.id,card=card,request_key=body.request_key,settings_json=config)
    db.add(attempt)
    await db.flush()
    prompts=tuple(build_prompt(rev,card,keys,pairs) for keys,pairs in assignments)
    redis=_get_redis()
    try:
        result=await CreateRunUseCase(db,RedisLock(redis)).execute(CreateRunCommand(
            prompt=prompts[0],batch_prompts=prompts,scorecard_attempt_id=attempt.id,targets=[RunModelTarget(**t.model_dump()) for t in body.targets],
            user_id=UserId(user.id),allow_parallel=True,auto_rebalance_portfolio=portfolio,auto_rebalance_sequence=w.sequence,
            auto_rebalance_label=f"{w.label} ({card.title()} Scan)"))
    except AppException as exc:
        raise HTTPException(exc.status_code,exc.message) from exc
    finally:
        await redis.aclose()
    return {"id":attempt.id,"run_id":result.id}


async def observations(db, attempt):
    chain=[]
    while attempt:
        chain.append(attempt)
        parent=attempt.settings_json.get("parent")
        attempt=await db.get(Attempt,parent) if parent else None
    evidence=[]
    for a in reversed(chain):
        jobs=(await db.execute(select(Job).join(RunJob,RunJob.job_id==Job.id).join(Batch,Batch.run_id==RunJob.run_id)
                               .where(Batch.attempt_id==a.id,RunJob.stage==1).order_by(Job.id))).scalars().all()
        count=len(a.settings_json["targets"])
        assignments=a.settings_json["assignments"]
        if len(jobs)!=count*len(assignments):
            raise HTTPException(409,"Scorecard batch coverage is incomplete")
        evidence.extend((job,i%count,*assignments[i//count]) for i,job in enumerate(jobs))
    return evidence


@router.get("/{portfolio}/attempts/{attempt_id}")
async def attempt_result(portfolio:Portfolio,attempt_id:int,db:AsyncSession=Depends(get_async_db),user:User=Depends(get_current_user)):
    a=await owned(db,user.id,portfolio,Attempt,attempt_id)
    if a.result_json:
        return a.result_json
    jobs=await observations(db,a)
    done=sum(j.status in ("partial","completed","failed","cancelled") for j,*_ in jobs)
    base={"id":a.id,"revision_id":a.revision_id,"card":a.card,"jobs":len(jobs),"completed":done}
    if done!=len(jobs):
        return {**base,"status":"processing","rows":[]}
    rev=await db.get(Revision,a.revision_id)
    result=project(a.card,rev.manifest,jobs)
    scored=sum(r["score"] is not None for r in result["rows"])
    a.result_json={**base,**result,"status":"completed" if all(r["coverage"]=="Complete" for r in result["rows"]) and not result["errors"] else "partial" if scored else "unassessed",
                   "scored":scored,"source_hashes":{str(j.id):digest(j.response or "") for j,*_ in jobs}}
    out=a.result_json
    await db.commit()
    return out


@router.get("/{portfolio}/finals/{final_id}")
async def saved_final(portfolio:Portfolio,final_id:int,db:AsyncSession=Depends(get_async_db),user:User=Depends(get_current_user)):
    item=await owned(db,user.id,portfolio,Final,final_id)
    return {"id":item.id,**item.result_json}


@router.post("/{portfolio}/revisions/{revision_id}/final")
async def finalize(portfolio:Portfolio,revision_id:int,body:Finalize,db:AsyncSession=Depends(get_async_db),user:User=Depends(get_current_user)):
    w=await workflow(db,user.id,portfolio,body.sequence)
    rev=await owned(db,user.id,portfolio,Revision,revision_id)
    try:
        cfg=policy(body.weights,body.factors,body.actions)
    except ValueError as exc:
        raise HTTPException(422,str(exc)) from exc
    outputs={}
    run_ids={}
    for card,i in body.attempts.items():
        a=await owned(db,user.id,portfolio,Attempt,i)
        if a.card!=card or a.revision_id!=rev.id or not a.result_json:
            raise HTTPException(409,"All selected scorecard outputs must be terminal and use this Stage 2 revision")
        outputs[card]=a.result_json
        run_ids[card]=await db.scalar(select(Batch.run_id).where(Batch.attempt_id==a.id))
    if not outputs:
        raise HTTPException(422,"Select at least one saved output")
    rows=calculate_final(rev.manifest,outputs,cfg)
    if body.compare_with is not None:
        return {"comparison":compare_formula(rows,outputs,body.compare_with)}
    key=digest([rev.digest,body.attempts,cfg])
    item=await db.scalar(select(Final).where(Final.workflow_id==w.id,Final.digest==key))
    if not item:
        result={"schema":"independent-scorecards-v1","portfolio":portfolio,"sequence":w.sequence,"revision_id":rev.id,
                "manifest_hash":rev.digest,"attempts":body.attempts,"source_runs":run_ids,"policy":cfg,
                "rows":rows}
        item=Final(workflow_id=w.id,revision_id=rev.id,digest=key,result_json=result)
        db.add(item)
        await db.flush()
    out={"id":item.id,**item.result_json}
    await db.commit()
    return out


@router.get("/{portfolio}/revisions/{revision_id}/{card}/prompt")
async def prompt_preview(portfolio:Portfolio,revision_id:int,card:Card,db:AsyncSession=Depends(get_async_db),user:User=Depends(get_current_user)):
    rev=await owned(db,user.id,portfolio,Revision,revision_id)
    first=next(batches(rev.manifest["stocks"],card),([],[]))
    return {"prompt":build_prompt(rev,card,*first)}


@router.get("/{portfolio}/saved-policy")
async def saved_policy(portfolio:Portfolio,db:AsyncSession=Depends(get_async_db),user:User=Depends(get_current_user)):
    item=await db.scalar(select(Final).join(Workflow).where(Workflow.user_id==user.id,Workflow.portfolio==portfolio).order_by(Final.id.desc()).limit(1))
    return item.result_json["policy"] if item else None


@router.get("/{portfolio}/latest-final")
async def latest_final(portfolio:Portfolio,sequence:int|None=None,db:AsyncSession=Depends(get_async_db),user:User=Depends(get_current_user)):
    query=select(Final).join(Workflow).where(Workflow.user_id==user.id,Workflow.portfolio==portfolio)
    if sequence is not None:
        query=query.where(Workflow.sequence==sequence)
    item=await db.scalar(query.order_by(Final.id.desc()).limit(1))
    return {"id":item.id,**item.result_json} if item else None
