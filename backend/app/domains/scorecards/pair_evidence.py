"""Recover the dated market inputs while keeping original attempts and finals immutable."""
from datetime import datetime
from sqlalchemy import select

from . import storage
from .pair_plan import evidence_detail, project_plan, ready
from .pair_records import evidence_packets
from .technical_v3 import BENCHMARK, normalise
from .universe import digest


async def latest_history(db, revision_id):
    kind = storage.Stage.summary_json["research"]["version"].as_integer()
    row = await db.scalar(select(storage.Stage).where(storage.of_kind("packet", revision_id), kind==3)
                          .order_by(storage.Stage.id.desc()).limit(1))
    return row.summary_json["research"] if row else None


def reconcile(manifest, history, prior):
    """Build comparable features from venue-session bars on the same corporate-action basis."""
    from .signals import features
    cutoff = manifest["as_of"]
    keys = [s["listing"] for s in manifest["stocks"]]
    original = prior.get("packets", {})
    packets = {}
    issues = {}
    gaps = {}
    normalized = {}
    for key in dict.fromkeys([*keys,BENCHMARK]):
        ledger = history.get("technical",{}).get(key,{})
        identity = ledger.get("sources",{}).get("stock",{})
        if key == BENCHMARK and not identity:
            identity = next((v.get("sources",{}).get("benchmark",{}) for v in history.get("technical",{}).values()),{})
        venue = key.split(":")[0]
        calendar = history.get("calendars", {}).get(venue, {})
        dates = sorted(day for day, end in calendar.items() if datetime.fromisoformat(end) <= datetime.fromisoformat(cutoff))
        raw = history.get("listings",{}).get(key,[])
        series, faults = normalise(raw, dates, identity.get("actions",[]), cutoff)
        by_day = {r["as_of"][:10]: r for r in raw if r.get("kind")=="daily_bar"}
        # Never bridge an absent session with an older close. Optional longer factors stay null.
        tail = []
        for day in reversed(dates):
            if day not in series or day in faults:
                if len(tail) < 6:
                    from .technical_sources import archive_url
                    source = by_day.get(day, {}).get("url") or archive_url(venue, day)
                    reason = faults.get(day, "No valid closed-session bar")
                    gaps[key] = f"{day} · {reason} · {source}"
                break
            op, hi, lo, close, volume = series[day]
            tail.append({**by_day[day],"open":op,"high":hi,"low":lo,"close":close,"volume":volume})
        if not dates:
            gaps[key] = f"{venue} completed-session calendar unavailable at {cutoff}"
        normalized[key] = list(reversed(tail))
        if any(r.get("isin") and r["isin"]!=identity.get("instrument") for r in raw):
            issues[key]="Unverified venue instrument"
        elif not identity.get("action_url"):
            issues[key]="Corporate-action history unavailable"
        elif dates and dates[-1] in faults:
            issues[key]=faults[dates[-1]]
    benchmark = normalized.get(BENCHMARK,[]) if BENCHMARK not in issues else []
    for key in keys:
        rows=normalized[key]
        old=original.get(key,{})
        prior_news=[r for r in prior.get("listings",{}).get(key,[]) if r.get("kind") in ("exchange_notice","filing_excerpt")]
        packet=evidence_packets({"listings":{key:rows+prior_news},"benchmark":benchmark},cutoff)[key]
        if key in issues:
            packet["features"]["issue"]=issues[key]
        if not ready(packet) and ready(old) and issues.get(key) in (None,"Corporate-action history unavailable") and not history.get("technical",{}).get(key,{}).get("sources",{}).get("stock",{}).get("actions"):
            # An archived validated packet is still usable when recovery returns no new evidence.
            packet=old
            if benchmark and prior.get("listings",{}).get(key):
                metrics=features(prior["listings"][key],cutoff,benchmark,optional_volume=True)
                if metrics.get("relative_20_pct") is not None:
                    packet={**old,"features":{**old["features"],"relative_20_pct":metrics["relative_20_pct"]}}
        diagnostic=history.get("provider_status",{}).get(key,{}).get("reason")
        if not ready(packet):
            packet["features"]["issue"]=" · ".join(filter(None,[packet["features"].get("issue"),gaps.get(key),diagnostic]))
        if rows and any(r["volume"] is None for r in rows[-21:]):
            packet["features"]["volume_note"] = "Volume unavailable for one or more recent sessions"
        packets[key]=packet
    return {"version":2,"pair_protocol":3,"packets":packets,
            "listings":{k:[*normalized[k],*(r for r in prior.get("listings",{}).get(k,[])
                         if r.get("kind")!="daily_bar")] if ready(packets[k]) and normalized[k]
                         else prior.get("listings",{}).get(k,[]) for k in keys},
            "benchmark":benchmark,"notices":list(dict.fromkeys(history.get("notices",[])+prior.get("notices",[]))),
            "provider_status":history.get("provider_status",{}),"as_of":cutoff,
            "observed_at":datetime.now().astimezone().isoformat()}


async def save_history(db, rev, workflow_id, history):
    identities = sorted((k,v["input_hash"],v.get("sources",{}).get("stock",{}).get("action_url")) for k,v in history["technical"].items())
    key="historical-bars/"+digest(identities)
    found=await storage.by_key(db,"packet",key,revision_id=rev.id)
    if not found:
        await storage.append(db,workflow_id,"packet",key,{"research":history},revision_id=rev.id)


async def attempt_packet(db, original):
    cfg=original.data["settings"]
    if cfg.get("packet_id"):
        record=await db.get(storage.Stage,cfg["packet_id"])
        return record.summary_json["research"]
    return cfg.get("research",{})


async def repair(db, original, owner, username, *, requested=None):
    from .technical_sources import collect
    old=original.result_json
    rev_id=original.data["revision_id"]
    rev=await storage.lookup(db,owner,"india","revision",rev_id)
    manifest=rev.manifest
    wf=original.row.workflow_id
    source_id=original.id
    settings=dict(original.data["settings"])
    prior=await attempt_packet(db,original)
    prior_packets=prior.get("packets",{})
    previous=await latest_history(db,rev_id)
    keys=[s["listing"] for s in manifest["stocks"]]
    # First use any already repaired Technical history before fetching missing listings.
    initial=reconcile(manifest,previous,prior) if previous else prior
    missing={k for k in keys if not ready(initial.get("packets",{}).get(k,{}))}
    if requested is not None:
        missing.intersection_update(requested)
    benchmark_missing=not any(p.get("features",{}).get("relative_20_pct") is not None for p in initial.get("packets",{}).values())
    await db.commit()
    updated=previous
    if missing or benchmark_missing:
        action_only = {k for k in missing if previous and
                       initial.get("packets",{}).get(k,{}).get("features",{}).get("sessions",0)>=6
                       and initial["packets"][k]["features"].get("issue")=="Corporate-action history unavailable"}
        updated=await collect(manifest,username,previous,missing,pair_repair=True,action_only=action_only)
    research=reconcile(manifest,updated,prior) if updated else initial
    signature=digest(research["packets"])
    identity=f"pairwise/evidence/{source_id}/{signature}"
    rev=await storage.lookup(db,owner,"india","revision",rev_id,lock=True)
    if updated:
        await save_history(db,rev,wf,updated)
    if old.get("pair_protocol")==3 and digest(prior_packets)==signature:
        await db.commit()
        return old
    existing=await storage.by_key(db,"attempt",identity,revision_id=rev_id)
    if existing:
        return existing.result_json
    packet=await storage.append(db,wf,"packet",identity,{"research":research},revision_id=rev_id)
    mode=settings.get("pair_mode","full")
    result=project_plan(manifest,research,mode,{"errors":[]},old,prior_packets)
    settings.update(packet_id=packet.id,parent=None,assignments=[],pair_mode=mode)
    record=await storage.append(db,wf,"attempt",identity,{"card":"pairwise","settings":settings,
        "recovered_from":source_id,"data_recovery":True},revision_id=rev_id)
    out=finish(result,record,research,rev_id)
    out["recovered_from"]=source_id
    record.row.summary_json={**record.data,"result":out}
    await db.commit()
    return out


def finish(result,attempt,research,revision_id):
    counts=result["pair_counts"]
    scored=sum(r["score"] is not None for r in result["rows"])
    status="completed" if counts["expected"] and counts["judged"]==counts["expected"] and not counts["errors"] else "partial" if scored else "unassessed"
    out={**result,"id":attempt.id,"revision_id":revision_id,"card":"pairwise","status":status,
         "scored":scored,"jobs":counts["jobs"],"completed":counts["jobs"],"source_hashes":result.get("source_hashes",{}),
         "retry_after":max((v.get("retry_after") or 0 for v in research.get("provider_status",{}).values()),default=0),
         "as_of":research.get("as_of"),"observed_at":research.get("observed_at"),
         "research_notices":research.get("notices",[]),"evidence_readiness":evidence_detail(research["packets"])}
    attempt.row.status=status
    attempt.row.summary_json={**attempt.data,"result":out}
    return out


async def news(manifest):
    import asyncio
    import httpx
    from .research import BSE_NEWS, NSE_NEWS, download, indian_news
    from xml.etree.ElementTree import ParseError
    cutoff=datetime.fromisoformat(manifest["as_of"])
    stocks=manifest["stocks"]
    observations={s["listing"]:[] for s in stocks}
    async with httpx.AsyncClient(timeout=4.5) as client:
        async def fetch(venue,url):
            try:
                raw=await download(client,url)
                for key,item in indian_news(raw,venue,stocks,cutoff):
                    if len(observations[key])<6:
                        observations[key].append(item)
            except (httpx.HTTPError, ValueError, ParseError):
                return f"{venue} announcement feed unavailable"
        notices=await asyncio.gather(fetch("NSE",NSE_NEWS),fetch("BSE",BSE_NEWS))
    return {"listings":observations,"notices":[n for n in notices if n]}


async def check_budget(prompts,target,budget):
    from fastapi import HTTPException
    from app.domains.ai_providers.deepseek import DeepSeekProvider
    from app.domains.ai_providers.openai import OpenAIProvider
    from app.domains.ai_providers.anthropic import AnthropicProvider
    from app.domains.ai_providers.gemini import GeminiProvider
    from app.domains.fx_rates.service import load_persisted_usd_inr_rate
    provider={"deepseek":DeepSeekProvider,"openai":OpenAIProvider,"anthropic":AnthropicProvider,"gemini":GeminiProvider}.get(target.provider)
    fx=await load_persisted_usd_inr_rate()
    if not provider or not fx.value:
        raise HTTPException(422,"Pairwise cost estimate unavailable for this model or INR conversion")
    estimated=sum(provider.estimate_prompt_cost_usd(target.model,p) for p in prompts)*fx.value
    if estimated>budget:
        raise HTTPException(422,f"Estimated INR {estimated:.2f} for {len(prompts)} model calls exceeds the INR {budget:.2f} planning budget")
    return estimated
