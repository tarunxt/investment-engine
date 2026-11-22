import asyncio
from typing import Literal
from datetime import date, datetime, timezone

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
from . import storage, pair_evidence, pair_plan, threat_coverage
from .storage import Stage
from .prompts import build_prompt, batches, CARDS, single_job_card
from .scoring import project
from .technical_output import evidence_ids as technical_evidence_ids
from app.domains.recommendation_audit.schemas import Formula
from .final import DEFAULT_WEIGHTS, calculate_final, compare_formula, policy
from .universe import digest, publish_manifest
from .research import collect as collect_research

router = APIRouter(prefix="/runs/scorecards", tags=["equity-scorecards"])
Portfolio = Literal["india","indmoney_us"]
Card = Literal["rebalance","technical","threats","pairwise"]


_packet_fetches = {}


async def shared_history(revision_id, manifest, username):
    from .technical_sources import collect
    key = (manifest["owner_id"], revision_id)
    task = _packet_fetches.get(key)
    if task is None:
        task = asyncio.create_task(collect(manifest, username))
        _packet_fetches[key] = task
        task.add_done_callback(lambda finished: _packet_fetches.pop(key, None))
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
    pair_mode: Literal['full','balanced'] = 'full'
    estimated_budget_inr: float | None = Field(default=None,gt=0,le=100000,allow_inf_nan=False)


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


@router.get("/india/pairwise-trials")
async def pairwise_trials(db:AsyncSession=Depends(get_async_db),user:User=Depends(get_current_user)):
    from .pair_trial import saved_trials
    return await saved_trials(db,user.id)


@router.get("/india/technical-validation")
async def technical_validation(db:AsyncSession=Depends(get_async_db),user:User=Depends(get_current_user)):
    from .technical_validation import evaluate
    return await evaluate(db,user.id,datetime.now(timezone.utc).date())


class ExecutionObservation(Request):
    decision: date
    listing: str = Field(pattern=r"^(NSE|BSE):[A-Z0-9&. -]{1,40}$")
    status: Literal["filled","skipped","unfilled"]
    entry_session: date | None = None
    exit_session: date | None = None
    entry_fill: float | None = Field(default=None,gt=0,allow_inf_nan=False)
    exit_fill: float | None = Field(default=None,gt=0,allow_inf_nan=False)
    entry_reference: float | None = Field(default=None,gt=0,allow_inf_nan=False)
    exit_reference: float | None = Field(default=None,gt=0,allow_inf_nan=False)
    entry_fees_per_share: float | None = Field(default=None,ge=0,allow_inf_nan=False)
    exit_fees_per_share: float | None = Field(default=None,ge=0,allow_inf_nan=False)


@router.post("/india/technical-execution-review")
async def technical_execution_review(observations:list[ExecutionObservation],db:AsyncSession=Depends(get_async_db),
                                     user:User=Depends(get_current_user)):
    if len(observations)>5000:
        raise HTTPException(422,"At most 5,000 dated observations per evaluation")
    if len({(r.decision,r.listing) for r in observations})!=len(observations):
        raise HTTPException(422,"Duplicate decision and listing in execution observations")
    from .technical_validation import evaluate
    return await evaluate(db,user.id,datetime.now(timezone.utc).date(),executions=observations)


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
    if portfolio=="india" and m["stocks"]:
        from .tasks import warm_rebalance_sources
        from app.core.recovery import recovery_mode
        if not recovery_mode():
            try:
                await asyncio.to_thread(warm_rebalance_sources.delay,user.id,record.id)
            except Exception:
                import logging
                logging.getLogger(__name__).exception("Rebalance prefetch unavailable for revision %s",record.id)
    return out


@router.post("/india/revisions/{revision_id}/rebalance/readiness")
async def rebalance_preflight(revision_id:int,db:AsyncSession=Depends(get_async_db),user:User=Depends(get_current_user)):
    from .rebalance_readiness import prepare, checklist
    rev=await owned(db,user.id,"india","revision",revision_id)
    packet=await prepare(db,rev,user.id,user.username)
    return checklist(packet.data["research"])


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
    if portfolio=="india" and card=="pairwise" and body.retry_attempt_id:
        identity=f"pairwise/resume/{body.sequence}/{body.retry_attempt_id}/{body.pair_mode}"
    technical_v3 = portfolio == "india" and card == "technical"
    india_threats = portfolio == "india" and card == "threats"
    pair_v3 = portfolio == "india" and card == "pairwise"
    rebalance_v2 = portfolio == "india" and card == "rebalance"
    packet_key = "rebalance-preflight-v1" if rebalance_v2 else "pairwise-v3" if pair_v3 else "technical-v3" if technical_v3 else "market-v2"
    shared = portfolio=="india" and card in ("technical","pairwise","rebalance")
    repair_fields={}
    if rebalance_v2 and body.retry_attempt_id:
        from .rebalance_recovery import gaps
        original=await owned(db,owner,portfolio,"attempt",body.retry_attempt_id)
        if original.data.get("revision_id")!=rev.id or original.data.get("card")!=card or not original.result_json:
            raise HTTPException(422,"Select a finished Rebalance output from this Stage 2 revision")
        if original.data["settings"].get("targets") != [t.model_dump() for t in body.targets]:
            raise HTTPException(422,"Use the original Rebalance model slots for repair")
        repair_fields=gaps(original.result_json)
        if not repair_fields:
            raise HTTPException(422,"All applicable Rebalance factors and sizing fields are present")
        identity=f"rebalance/repair/{body.retry_attempt_id}/{body.request_key}"
        packet_key="rebalance/repair/"+str(body.retry_attempt_id)+"/"+body.request_key
    packet = await storage.by_key(db,"packet",packet_key,revision_id=rev.id) if shared else None
    if india_threats and not body.retry_attempt_id:
        packet = await storage.by_key(db,"packet","threats-v3",revision_id=rev.id)
    already_started = await storage.by_key(db,"attempt",identity,revision_id=rev.id)
    if not already_started and single_job_card(portfolio, card):
        if len(body.targets) != 1:
            raise HTTPException(422, "Choose exactly one model for this scorecard.")
        if body.check_pair_order:
            raise HTTPException(422, "Pairwise runs use one model job. Extra reversed-order jobs are disabled.")
    research = packet.data["research"] if packet else {}
    prior_packet = None
    history = None
    if not already_started and not packet and not (pair_v3 and body.retry_attempt_id):
        manifest = rev.manifest
        username = user.username
        wanted = None
        if india_threats and body.retry_attempt_id:
            from .threat_output import target_gaps
            prior = await owned(db,owner,portfolio,"attempt",body.retry_attempt_id)
            if prior.data["revision_id"] != rev.id or prior.data["card"] != "threats" or not prior.result_json:
                raise HTTPException(422,"Select a finished Threats output from this revision")
            if body.targets[0].model_dump() not in prior.data["settings"]["targets"]:
                raise HTTPException(422,"Select the original Threats model for recovery")
            prior_packet = await pair_evidence.attempt_packet(db, prior)
            wanted = target_gaps(prior.result_json["rows"])
            if not wanted:
                raise HTTPException(422,"All Threats categories are resolved")
        history = await pair_evidence.latest_history(db,rev.id) if shared or india_threats else None
        await db.commit()
        if india_threats:
            from .threat_sources import collect
            research = await collect(manifest, username, wanted, previous=prior_packet, venue_history=history)
        elif rebalance_v2:
            from .rebalance_readiness import prepare
            previous = None
            if body.retry_attempt_id:
                previous = await pair_evidence.attempt_packet(db,original)
            if body.retry_attempt_id and original.data.get("data_recovery") and previous:
                packet=await owned(db,owner,portfolio,"packet",original.data["settings"]["packet_id"])
            else:
                packet=await prepare(db,rev,owner,username,previous,refresh=bool(body.retry_attempt_id))
            research=packet.data["research"]
        elif shared:
            history = history or await shared_history(revision_id,manifest,username)
            if pair_v3:
                research = pair_evidence.reconcile(manifest,history,await pair_evidence.news(manifest))
            else:
                research = history
        else:
            research = await collect_research(manifest,card,username=username)
    w=await workflow(db,owner,portfolio,body.sequence)
    rev=await owned(db,owner,portfolio,"revision",revision_id,lock=True)
    config={"targets":[t.model_dump() for t in body.targets],"parent":body.retry_attempt_id}
    if rebalance_v2 and packet:
        config["packet_id"]=packet.id
    if pair_v3:
        config.update(pair_mode=body.pair_mode,estimated_budget_inr=body.estimated_budget_inr)
    existing=await storage.by_key(db,"attempt",identity,revision_id=rev.id)
    if existing:
        if bool(existing.data["settings"].get("check_pair_order"))!=body.check_pair_order or existing.row.workflow_id!=w.id or any(existing.data["settings"].get(k, "full" if k=="pair_mode" else None)!=v for k,v in config.items() if k!="packet_id"):
            raise HTTPException(409,"Attempt key already names different inputs")
        return {"id":existing.id,"run_id":existing.row.run_id,**({"scoring_version":3} if technical_v3 else {})}
    if body.check_pair_order:
        raise HTTPException(422, "Extra reversed-order jobs are disabled.")
    parent=None
    missing=None
    if body.retry_attempt_id:
        parent=await owned(db,user.id,portfolio,"attempt",body.retry_attempt_id)
        if india_threats:
            # Compare against sources actually sent, including archived ancestors. A free
            # evidence refresh can make a listing eligible without consuming those sources.
            attempted = {}
            for _, _, keys, _, evidence in await observations(db, parent, owner, portfolio):
                if not isinstance(evidence,dict):
                    continue
                for key in keys:
                    seen = attempted.setdefault(key,set())
                    for cat in evidence.get("targets",{}).get(key,[]):
                        seen.update((cat,sid) for sid in evidence["matrix"][key][cat])
                    seen.update(("issuer",sid) for sid in evidence.get("issuer_sources",{}).get(key,[]))
            ready = threat_coverage.plan(research, parent.result_json["rows"])
            eligible = {key:cats for key,cats in ready.items() if
                        any((cat,sid) not in attempted.get(key,set()) for cat in cats for sid in research["matrix"][key][cat])
                        or any(("issuer",sid) not in attempted.get(key,set()) for sid in research.get("issuer_sources",{}).get(key,[]))}
            if not eligible:
                raise HTTPException(422,"No new evidence can produce or improve a stock score yet. Refresh missing sources. No model job started.")
            research["targets"] = eligible
        elif rebalance_v2:
            from .rebalance_recovery import with_evidence
            repair_fields=with_evidence(repair_fields,research["packets"])
            if not repair_fields:
                raise HTTPException(422,"No new source evidence for the missing fields. No model jobs were queued.")
            config["repair_fields"]=repair_fields
        elif technical_v3:
            if parent.data["revision_id"]!=rev.id or parent.data["card"]!=card or not parent.result_json or parent.result_json.get("scoring_version")!=3:
                raise HTTPException(422,"Select a finished Technical v3 attempt from this revision")
            retry_keys={r["listing"] for r in parent.result_json["rows"] if not r["raw_rows"] or r.get("model_disagreement")}
            if not retry_keys:
                raise HTTPException(422,"All Technical commentary is complete")
            config["packet_id"]=parent.data["settings"]["packet_id"]
            research=(await owned(db,owner,portfolio,"packet",config["packet_id"])).data["research"]
        else:
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
            if pair_v3:
                if body.pair_mode != parent.data["settings"].get("pair_mode","full"):
                    raise HTTPException(422,"Resume the original Pairwise schedule")
                research=await pair_evidence.attempt_packet(db,parent)
                if not research.get("packets"):
                    raise HTTPException(422,"Repair missing evidence before judging legacy comparisons")
                config["packet_id"]=parent.data["settings"].get("packet_id")
            if not missing and not pair_v3:
                raise HTTPException(422,"All pair assignments have been resolved")
    assignments=list(batches(rev.manifest["stocks"],card,pairs=missing,portfolio=portfolio))
    if india_threats:
        if body.retry_attempt_id:
            assignments = [(sorted(research["targets"]),[])]
        elif not research["sources"]:
            assignments = []
    if rebalance_v2:
        from .rebalance_readiness import checklist
        readiness=checklist(research)
        eligible={r["listing"] for r in readiness["rows"] if r["state"]=="ready"}
        if repair_fields:
            repair_fields={k:v for k,v in repair_fields.items() if k in eligible}
            config["repair_fields"]=repair_fields
            if not repair_fields:
                raise HTTPException(422,"No newly ready Rebalance fields. Check source recovery before scoring.")
            eligible=set(repair_fields)
        assignments=[(sorted(eligible),[])] if eligible else []
    if technical_v3 and body.retry_attempt_id:
        # Commentary recovery reuses the exact packet, including its factor calculations.
        assignments=[([k for k in keys if k in retry_keys],[]) for keys,_ in assignments if any(k in retry_keys for k in keys)]
    if india_threats and not body.retry_attempt_id:
        packet = await storage.by_key(db,"packet","threats-v3",revision_id=rev.id)
        if not packet:
            packet = await storage.append(db,w.id,"packet","threats-v3",{"research":research},revision_id=rev.id)
        research = packet.data["research"]
        config["packet_id"] = packet.id
        ready = threat_coverage.plan(research)
        assignments = [(sorted(ready),[])] if ready else []
    elif shared and research.get("version") in (2,3,4):
        packet = (packet if rebalance_v2 and packet else await owned(db,owner,portfolio,"packet",config["packet_id"]) if config.get("packet_id") else
                  await storage.by_key(db,"packet",packet_key,revision_id=rev.id))
        if not packet:
            packet = await storage.append(db,w.id,"packet",packet_key,{"research":research},revision_id=rev.id)
        research = packet.data["research"]
        config["packet_id"]=packet.id
        if card=="technical" and research["version"]==2:
            eligible = {k for k,v in research["packets"].items() if not v["features"]["issue"]}
            assignments = [(subset, []) for keys,_ in assignments if (subset := [k for k in keys if k in eligible])]
            if not assignments:
                raise HTTPException(422,"No listings have sufficient verified candles. Check the historical data sources and retry.")
    else:
        config["research"]=research
    if pair_v3:
        if history is not None:
            await pair_evidence.save_history(db,rev,w.id,history)
        keys=[s["listing"] for s in rev.manifest["stocks"]]
        previous=research["packets"] if parent else None
        selected,carried=pair_plan.plan(keys,research,body.pair_mode,parent.result_json if parent else None,previous)
        complete_inputs=all(pair_plan.ready(research["packets"].get(k,{})) for k in keys)
        assignments=list(pair_plan.assigned_batches(selected)) if complete_inputs or parent else []
        config["pair_protocol"]=3
        if parent and not selected:
            raise HTTPException(422,"No new eligible pairs. Repair the remaining evidence first.")
    if technical_v3:
        from .technical_validation import stage4_validated
        config["technical_validated"] = await stage4_validated(db, owner, rev.manifest["as_of"])
    config["assignments"]=assignments
    if india_threats and body.retry_attempt_id:
        retry_identity = f"threats/retry/{body.retry_attempt_id}/" + digest({"targets":research["targets"],"sources":sorted(research["sources"])})
        previous_retry = await storage.by_key(db,"attempt",retry_identity,workflow_id=w.id,revision_id=rev.id)
        if previous_retry:
            return {"id":previous_retry.id,"run_id":previous_retry.row.run_id}
        identity = retry_identity
    attempt=await storage.append(db,w.id,"attempt",identity,{"card":card,"settings":config},revision_id=rev.id)
    if rebalance_v2 and not assignments:
        from .rebalance_output import project as project_records
        from .rebalance_readiness import annotate
        empty=project_records(rev.manifest,[])
        result=annotate({**empty,"id":attempt.id,"card":card,"revision_id":rev.id,"status":"unassessed",
            "jobs":0,"completed":0,"scored":0,"source_hashes":{},"research_notices":research["notices"]},research)
        attempt.row.summary_json={**attempt.data,"result":result,"data_recovery":True}
        attempt.row.status="unassessed"
        await db.commit()
        return {"id":attempt.id,"run_id":None}
    if pair_v3 and not assignments:
        data=pair_plan.project_plan(rev.manifest,research,body.pair_mode,{"errors":[]})
        pair_evidence.finish(data,attempt,research,rev.id)
        attempt.row.summary_json={**attempt.data,"data_recovery":True}
        await db.commit()
        if len(keys)>1 and not complete_inputs:
            await pair_evidence.queue_repair(owner,attempt.id)
        return {"id":attempt.id,"run_id":None}
    if india_threats and not assignments:
        from .threat_output import project as empty_threats
        out = {**threat_coverage.annotate(empty_threats(rev.manifest,[]),research),"id":attempt.id,"revision_id":rev.id,"card":card,
               "status":"unassessed","scored":0,"jobs":0,"completed":0,"source_hashes":{},
               "research_notices":[*research["notices"],"No listing has three evidence-backed categories. Collect missing sources before scoring."]}
        attempt.row.summary_json = {**attempt.data,"result":out}
        attempt.row.status = "unassessed"
        await db.commit()
        return {"id":attempt.id,"run_id":None}
    absent = {r["listing"] for r in rev.manifest["stocks"] if r["origin"] == "contender" and r["units"] == 0}
    batch_contexts = tuple({
        "kind": SOURCE_CONTEXT_KIND,
        "market": rev.manifest["market"],
        "scorecard_batch": {
            "kind": "equity_scorecard_batch_v1", "card": card, "listings": keys,
            "absent_contenders": sorted(absent.intersection(keys)),
            **({"rebalance_v2":rev.id,"repair_fields":repair_fields} if rebalance_v2 else {}),
            **({"technical_v3":{k:technical_evidence_ids(research["technical"][k]) for k in keys}}
               if technical_v3 else {}),
            **({"pairs_v2":pairs,"as_of":rev.manifest["as_of"],"packet_sources":{
                k:{"sources":{i:{"url":r["url"],"as_of":r["as_of"]} for i,r in research["packets"][k]["sources"].items()}} for k in keys}}
               if card=="pairwise" and pairs and research.get("version")==2 else {}),
        },
    } for keys, pairs in assignments)
    prompts=tuple(build_prompt(rev,card,keys,pairs,research) for keys,pairs in assignments)
    if pair_v3 and body.estimated_budget_inr is not None:
        await pair_evidence.check_budget(prompts,body.targets[0],body.estimated_budget_inr)
    redis=_get_redis()
    try:
        result=await CreateRunUseCase(db,RedisLock(redis)).execute(CreateRunCommand(
            prompt=prompts[0],batch_prompts=prompts,scorecard_batches=batch_contexts,scorecard_attempt_id=attempt.id,targets=[RunModelTarget(**t.model_dump()) for t in body.targets],
            stagger_gemini=not (portfolio == "india" and card == "rebalance"),
            user_id=UserId(user.id),allow_parallel=True,auto_rebalance_portfolio=portfolio,auto_rebalance_sequence=w.sequence,
            auto_rebalance_label=f"{w.label} ({card.title()} Scan)"))
    except AppException as exc:
        if technical_v3 and exc.code=="VALIDATION_ERROR" and exc.message=="A selected scorecard model is temporarily unavailable":
            from .technical_output import saved_rows
            data=saved_rows(rev.manifest,research,research.get("carried_comments",{}),[],[])
            counts=data["technical_counts"]
            status="partial" if counts["complete"]+counts["provisional"] else "unassessed"
            out={**data,"id":attempt.id,"revision_id":rev.id,"card":card,"status":status,
                 "jobs":0,"completed":0,"scored":counts["complete"]+counts["provisional"],"source_hashes":{},
                 "stage4_method":"v3" if config["technical_validated"] else "legacy","research_notices":[*research.get("notices",[]),exc.message]}
            attempt.row.summary_json={**attempt.data,"settings":{**config,"assignments":[]},"result":out,"data_recovery":True}
            attempt.row.status=status
            await db.commit()
            return {"id":attempt.id,"run_id":None,"scoring_version":3}
        raise HTTPException(exc.status_code,exc.message) from exc
    finally:
        await redis.aclose()
    return {"id":attempt.id,"run_id":result.id,**({"scoring_version":3} if technical_v3 else {})}


async def observations(db, attempt, uid, portfolio):
    chain=[]
    while attempt:
        chain.append(attempt)
        parent=None if attempt.data["settings"].get("pair_protocol")==3 or attempt.data["settings"].get("repair_fields") else attempt.data["settings"].get("parent")
        attempt=await owned(db,uid,portfolio,"attempt",parent) if parent else None
    evidence=[]
    for a in reversed(chain):
        if a.data.get("data_recovery"):
            continue
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
    from .rebalance_audit import replay
    if a.result_json:
        if portfolio=="india" and a.data["card"]=="pairwise" and not a.result_json.get("pair_counts"):
            packet=await pair_evidence.attempt_packet(db,a)
            if packet.get("packets"):
                out=a.result_json
                counts=pair_plan.summarize(out["rows"],packet["packets"],"full",calls=out["jobs"],errors=len(out.get("errors",[])))
                return {**out,"pair_counts":counts,"evidence_readiness":pair_plan.evidence_detail(packet["packets"])}
        if portfolio=="india" and a.data["card"]=="rebalance" and not a.result_json.get("rebalance_readiness"):
            from .rebalance_readiness import annotate
            frozen=await pair_evidence.attempt_packet(db,a) if a.data.get("settings") else {}
            if frozen.get("packets") and frozen.get("version")==4:
                return replay(annotate(dict(a.result_json),frozen))
        if portfolio=="india" and a.data["card"]=="threats":
            targets = a.data["settings"]["targets"]
            return {**a.result_json, "threat_target":targets[0] if targets else None,
                    "threat_diagnostics":a.result_json.get("threat_diagnostics") or threat_coverage.diagnostics(a.result_json["rows"])}
        return replay(a.result_json) if portfolio=="india" else a.result_json
    jobs=await observations(db,a,user.id,portfolio)
    done=sum(j.status in ("partial","completed","failed","cancelled") for j,*_ in jobs)
    base={"id":a.id,"revision_id":a.data["revision_id"],"card":a.data["card"],"jobs":len(jobs),"completed":done}
    if done!=len(jobs):
        return {**base,"status":"processing","rows":[]}
    rev=await owned(db,user.id,portfolio,"revision",a.data["revision_id"])
    result=project(a.data["card"],rev.manifest,jobs)
    if a.data["settings"].get("pair_protocol")==3:
        settings=a.data["settings"]
        packet=await pair_evidence.attempt_packet(db,a)
        parent=await owned(db,user.id,portfolio,"attempt",settings["parent"]) if settings.get("parent") else None
        previous=await pair_evidence.attempt_packet(db,parent) if parent else {}
        result=pair_plan.project_plan(rev.manifest,packet,settings["pair_mode"],result,
                   parent.result_json if parent else None,previous.get("packets"),jobs=len(jobs))
        result["source_hashes"]={str(j.id):digest(j.response or "") for j,*_ in jobs}
        costs=[j.estimated_cost for j,*_ in jobs]
        if costs and all(v is not None for v in costs):
            from app.domains.fx_rates.service import load_persisted_usd_inr_rate
            fx=await load_persisted_usd_inr_rate()
            result["attempt_cost_inr"]=round(sum(costs)*fx.value,2) if fx.value else None
        if jobs and all(j.created_at and j.updated_at for j,*_ in jobs):
            result["attempt_elapsed_seconds"]=max(0,(max(j.updated_at for j,*_ in jobs)-min(j.created_at for j,*_ in jobs)).total_seconds())
        out=pair_evidence.finish(result,a,packet,rev.id)
        await db.commit()
        return out
    if a.data["settings"].get("repair_fields"):
        from .rebalance_recovery import combine
        parent=await owned(db,user.id,portfolio,"attempt",a.data["settings"]["parent"])
        result=combine(parent.result_json,result,a.data["settings"]["repair_fields"])
    scored=sum(r["score"] is not None for r in result["rows"])
    research = jobs[-1][-1] if jobs else None
    out={**base,**result,"status":"completed" if all(r["coverage"]=="Complete" for r in result["rows"]) and not result["errors"] else "partial" if scored else "unassessed",
                   "research_notices":(research or {}).get("notices",[]),"scored":scored,"source_hashes":{str(j.id):digest(j.response or "") for j,*_ in jobs}}
    if a.data["card"]=="rebalance" and portfolio=="india" and research and research.get("readiness_version"):
        from .rebalance_readiness import annotate
        annotate(out,research)
    if result.get("scoring_version")==3:
        out["stage4_method"] = "v3" if a.data["settings"].get("technical_validated") else "legacy"
    retry_seconds=None
    if out.get("scoring_version")==3 and out["technical_counts"]["complete"]<out["technical_counts"]["expected"]:
        limits=[v["retry_after"] for v in (research or {}).get("provider_status",{}).values() if v.get("retry_after")]
        if limits:
            from app.core.recovery import recovery_mode
            if not recovery_mode():
                retry_seconds=max(limits)
                out["recovery"]={"state":"scheduled","after_seconds":retry_seconds}
    a.row.summary_json={**a.data,"result":out}
    a.row.status=out["status"]
    await db.commit()
    if retry_seconds:
        from .tasks import recover_technical_history
        try:
            await asyncio.to_thread(recover_technical_history.apply_async,args=[user.id,a.id],countdown=retry_seconds)
        except Exception:
            import logging
            logging.getLogger(__name__).exception("Could not queue Technical history recovery for %s",a.id)
            out["recovery"]={"state":"queue unavailable; manual recovery available"}
            a.row.summary_json={**a.data,"result":out}
            await db.commit()
    return replay(out) if portfolio=="india" else out


@router.post("/india/attempts/{attempt_id}/repair-pair-evidence")
async def repair_pair_evidence(attempt_id:int, db:AsyncSession=Depends(get_async_db),user:User=Depends(get_current_user)):
    original=await owned(db,user.id,"india","attempt",attempt_id)
    if original.data["card"]!="pairwise" or not original.result_json:
        raise HTTPException(409,"Select a saved Pairwise output")
    return await pair_evidence.repair(db,original,user.id,user.username)


@router.post("/india/attempts/{attempt_id}/repair-threat-evidence")
async def repair_threat_evidence(attempt_id:int, db:AsyncSession=Depends(get_async_db), user:User=Depends(get_current_user)):
    from copy import deepcopy
    from .threat_sources import collect
    from .threat_output import target_gaps
    original = await owned(db,user.id,"india","attempt",attempt_id)
    if original.data["card"]!="threats" or not original.result_json:
        raise HTTPException(409,"Select a saved Threats scorecard")
    result = deepcopy(original.result_json)
    if result.get("assessment_version") != 3:
        result = await recover_pairs("india",attempt_id,db,user)
        original = await owned(db,user.id,"india","attempt",result["id"])
        result = deepcopy(result)
    wanted = target_gaps(result["rows"])
    if not wanted:
        return result
    revision_id = original.data["revision_id"]
    revision = await owned(db,user.id,"india","revision",revision_id)
    prior = await pair_evidence.attempt_packet(db,original)
    wf, parent, settings, manifest = original.row.workflow_id, original.id, dict(original.data["settings"]), revision.manifest
    owner, username = user.id,user.username
    history = await pair_evidence.latest_history(db,revision_id)
    await db.commit()
    packet = await collect(manifest,username,wanted,previous=prior,venue_history=history)
    identity = f"threats/evidence/{parent}/"+digest([packet["matrix"],packet.get("issuer_sources"),packet["history_gaps"]])
    if all(packet.get(k)==prior.get(k) for k in ("matrix","issuer_sources","history_gaps","targets","exposure_required")):
        return result
    await owned(db,owner,"india","revision",revision_id,lock=True)
    found = await storage.by_key(db,"attempt",identity,revision_id=revision_id)
    if found:
        return found.result_json
    stored = await storage.append(db,wf,"packet",identity,{"research":packet},revision_id=revision_id)
    settings.update(packet_id=stored.id,parent=parent,assignments=[])
    settings.pop("research",None)
    record = await storage.append(db,wf,"attempt",identity,{"card":"threats","settings":settings,
                                  "data_recovery":True,"recovered_from":parent},revision_id=revision_id)
    threat_coverage.annotate(result,packet)
    result.update(id=record.id,recovered_from=parent,research_notices=packet["notices"],jobs=0,completed=0,
                  attempt_cost_inr=0,attempt_elapsed_seconds=None)
    record.row.status = result["status"]
    record.row.summary_json = {**record.data,"result":result}
    await db.commit()
    return result


@router.post("/{portfolio}/attempts/{attempt_id}/recover")
async def recover_pairs(portfolio:Portfolio,attempt_id:int,db:AsyncSession=Depends(get_async_db),user:User=Depends(get_current_user)):
    original=await owned(db,user.id,portfolio,"attempt",attempt_id,lock=True)
    if portfolio=="india" and original.data["card"]=="rebalance" and original.result_json:
        from .rebalance_readiness import recover
        return await recover(db,original,user.id,user.username)
    if portfolio=="india" and original.data["card"]=="threats" and original.result_json:
        if original.result_json.get("assessment_version")==3:
            return original.result_json
        key = f"threats/replay-v3/{attempt_id}"
        rev_id = original.data["revision_id"]
        existing = await storage.by_key(db,"attempt",key,workflow_id=original.row.workflow_id,revision_id=rev_id)
        if existing:
            return existing.result_json
        from .threat_output import project as project_threats
        revision = await owned(db,user.id,portfolio,"revision",rev_id)
        projected = project_threats(revision.manifest,await observations(db,original,user.id,portfolio))
        threat_coverage.annotate(projected, await pair_evidence.attempt_packet(db, original))
        counts = projected["threat_counts"]
        status = "completed" if counts["complete"]==counts["expected"] and not projected["errors"] else "partial" if counts["scored"] else "unassessed"
        record = await storage.append(db,original.row.workflow_id,"attempt",key,
            {"card":"threats","settings":original.data["settings"],"recovered_from":attempt_id},revision_id=rev_id)
        record.row.run_id = original.row.run_id
        out = {**original.result_json,**projected,"id":record.id,"recovered_from":attempt_id,"scored":counts["scored"],"status":status}
        record.row.status = status
        record.row.summary_json = {**record.data,"result":out}
        await db.commit()
        return out
    if portfolio=="india" and original.data["card"]=="technical" and original.result_json:
        from .technical_recovery import recover
        return await recover(db, original, user.id, user.username)
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
    packet_key = {"technical":"technical-v3","pairwise":"pairwise-v3","threats":"threats-v3","rebalance":"rebalance-v2"}.get(card,"market-v2") if portfolio=="india" else "market-v2"
    packet = await storage.by_key(db,"packet",packet_key,revision_id=rev.id) if card in ("technical","pairwise","rebalance") or (portfolio=="india" and card=="threats") else None
    if packet is None and portfolio=="india" and card=="threats":
        packet = await storage.by_key(db,"packet","threats-v2",revision_id=rev.id)
    research = packet.data["research"] if packet else None
    if portfolio=="india" and card=="threats" and research and research.get("exposure_required"):
        ready = threat_coverage.plan(research)
        if not ready:
            return {"prompt":"Awaiting sources for at least three categories on a listing."}
        first = (sorted(ready), [])
    if research is None and portfolio=="india" and card=="technical":
        research={"version":3,"technical":{},"listings":{}}
    if research is None and portfolio=="india" and card=="pairwise":
        research = {"version":2,"packets":{k:{"sources":{},"features":{}} for k in first[0]}}
    if portfolio=="india" and card=="pairwise" and research and research.get("pair_protocol")==3:
        keys=[s["listing"] for s in rev.manifest["stocks"]]
        selected,_=pair_plan.plan(keys,research,"full")
        first=next(pair_plan.assigned_batches(selected),([],[]))
        if not first[1]:
            return {"prompt":"Awaiting evidence for both sides of an assigned pair."}
    return {"prompt":build_prompt(rev,card,*first,research)}


@router.get("/{portfolio}/saved-policy")
async def saved_policy(portfolio:Portfolio,db:AsyncSession=Depends(get_async_db),user:User=Depends(get_current_user)):
    item=await storage.latest_final(db,user.id,portfolio)
    return item.result_json["policy"] if item else None


@router.get("/{portfolio}/latest-final")
async def latest_final(portfolio:Portfolio,sequence:int|None=None,db:AsyncSession=Depends(get_async_db),user:User=Depends(get_current_user)):
    item=await storage.latest_final(db,user.id,portfolio,sequence)
    return {"id":item.id,**item.result_json} if item else None
