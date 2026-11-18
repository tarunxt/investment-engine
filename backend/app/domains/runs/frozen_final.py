"""Verify provenance before freezing a workflow's final calculation."""
import hashlib
import json
import math
import re
from collections import defaultdict
from fastapi import HTTPException
from sqlalchemy import select
from .auto_rebalance_audit import validate_execution
from .models import Run, RunJob
from .run_identity import analysis_run_identity
from app.domains.jobs.models import Job


async def validate_frozen_final(db, payload, *, user_id, portfolio, sequence, allow_legacy=False, rebuild=False):
    if not isinstance(payload, dict) or payload.get('schema') not in {'workflow-final-v1', 'workflow-final-v2'}:
        raise HTTPException(422, 'Unsupported frozen final schema')
    if (payload.get('broker', portfolio) != portfolio
            or payload.get('workflow_sequence', sequence) != sequence):
        raise HTTPException(409, 'Frozen calculation belongs to another workflow')
    if "actionable_ranking" in payload and "scorecard_job_id" not in payload:
        raise HTTPException(422, "Weighted final requires scorecard provenance")
    legacy = payload['schema'] == 'workflow-final-v1'
    if legacy and not allow_legacy:
        raise HTTPException(422, 'New final captures require workflow-final-v2 source recomputation')
    if not legacy and (payload.get('formula_version') != 'score-matrix-v1' or payload.get('scorePolicy') != 'score-matrix-raw-effective-v2'):
        raise HTTPException(422, 'Unsupported final formula or score policy version')
    if len(json.dumps(payload)) > 2_000_000:
        raise HTTPException(422, 'Frozen final exceeds audit size limit')
    if not legacy and (not isinstance(payload.get('rebalance_run_ids'), list) or not 1 <= len(payload['rebalance_run_ids']) <= 20):
        raise HTTPException(422, 'New final capture requires exact rebalance run IDs')
    technical_id = payload.get('technical_run_id')
    rebalance_ids = payload.get('rebalance_run_ids', [payload.get('rebalance_run_id')])
    ids = [*rebalance_ids, technical_id] if isinstance(rebalance_ids, list) else []
    if not ids or any(isinstance(i, bool) or not isinstance(i, int) or i <= 0 for i in ids) or len(ids) != len(set(ids)):
        raise HTTPException(422, 'Frozen final requires distinct exact source run IDs')
    await validate_execution(db, user_id=user_id, portfolio=portfolio, sequence=sequence,
                             stage='technical', run_id=technical_id, job_id=None)
    sources = list((await db.execute(select(Run).where(Run.id.in_(ids), Run.user_id == user_id))).scalars())
    if len(sources) != len(ids):
        raise HTTPException(422, 'Final sources must belong to this user')
    market = 'india' if portfolio == 'india' else 'us'
    for source in sources:
        identity = analysis_run_identity(source)
        if identity.market != market or identity.stage != ('technical' if source.id == technical_id else 'rebalance'):
            raise HTTPException(422, 'Final source market/stage mismatch')
    technical = next(source for source in sources if source.id == technical_id)
    manifest = re.search(r'\[TECHNICAL_REBALANCE_SOURCES_V1\](.*?)\[/TECHNICAL_REBALANCE_SOURCES_V1\]', technical.prompt, re.S)
    try:
        manifest_data = json.loads(manifest[1]) if manifest is not None else None
    except (ValueError, TypeError) as exc:
        raise HTTPException(422, 'Technical source manifest is invalid') from exc
    if manifest is not None and not isinstance(manifest_data, dict):
        raise HTTPException(422, 'Technical source manifest is invalid')
    if manifest_data is not None and manifest_data.get('run_ids') != rebalance_ids:
        raise HTTPException(409, 'Final sources differ from the Technical input manifest')
    jobs = list((await db.execute(select(Job).join(RunJob, RunJob.job_id == Job.id).where(
        RunJob.run_id.in_(ids), Job.user_id == user_id,
    ))).scalars())
    if not jobs or any(str(getattr(j.status, 'value', j.status)).lower() not in {'completed','partial','failed','cancelled'} for j in jobs):
        raise HTTPException(409, 'Final source jobs must be terminal')
    if manifest_data is not None:
        selected = manifest_data.get('job_ids', [])
        technical_jobs = set((await db.execute(select(RunJob.job_id).where(RunJob.run_id == technical_id))).scalars())
        known = {j.id for j in jobs}
        if not isinstance(selected, list) or any(isinstance(i, bool) or not isinstance(i, int) or i not in known or i in technical_jobs for i in selected):
            raise HTTPException(422, 'Technical source job manifest is invalid')
        if not legacy and len(selected) != len(set(selected)):
            raise HTTPException(422, 'Technical source job manifest contains duplicates')
        allowed = set(selected) | technical_jobs
        jobs = [j for j in jobs if j.id in allowed]
    hashes = {str(j.id): hashlib.sha256((j.response or '').encode()).hexdigest() for j in jobs}
    if payload.get('response_hashes') != hashes:
        raise HTTPException(409, 'Final source output revisions changed')
    rows = payload.get('rows')
    if not isinstance(rows, list) or len(rows) > 500:
        raise HTTPException(422, 'Final capture requires a list of up to 500 rows')
    seen = set()
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get('exchange'), str) or not row['exchange'].strip() or not isinstance(row.get('symbol'), str) or not row['symbol'].strip():
            raise HTTPException(422, 'Final row must identify its exchange and symbol')
        key = (row['exchange'], row['symbol'])
        if key in seen:
            raise HTTPException(422, 'Duplicate final listing')
        seen.add(key)
        score = row.get('score')
        if score is not None and (isinstance(score, bool) or not isinstance(score, (int,float)) or not math.isfinite(score)):
            raise HTTPException(422, 'Invalid final score')

    if not legacy:
        # Reconstruct source membership independently; never use client detail
        # as arithmetic evidence. Existing provenance/hash gates above still run.
        from .final_recompute import source_calculations, verify_recomputed_rows
        from .final_source_rows import UnverifiableFinal
        links = list((await db.execute(select(RunJob).where(RunJob.run_id.in_(ids)).order_by(RunJob.id))).scalars())
        known_jobs = {job.id: job for job in jobs}
        if len(known_jobs) > 200:
            raise HTTPException(422, 'Final source set exceeds verification bound')
        jobs_by_run = defaultdict(list)
        memberships = set()
        for link in links:
            if link.job_id in known_jobs and (link.run_id, link.job_id) not in memberships:
                memberships.add((link.run_id, link.job_id))
                jobs_by_run[link.run_id].append(known_jobs[link.job_id])
        try:
            manifest_line = next((line for line in technical.prompt.splitlines() if line.startswith("[WORKFLOW_SCORECARDS_V1]")), None)
            scorecards = {}
            digest = None
            if manifest_line:
                try:
                    manifest = json.loads(manifest_line.removeprefix("[WORKFLOW_SCORECARDS_V1]"))
                    source_id = manifest["job_id"]
                except (KeyError, ValueError, TypeError) as exc:
                    raise HTTPException(422, "Invalid scorecard manifest") from exc
                if not rebuild and payload.get("scorecard_job_id") != source_id:
                    raise HTTPException(409, "Final scorecard job differs from the Technical source")
                payload["scorecard_job_id"] = source_id
                scorecards, digest = await verified_scorecards(db, source_id, user_id, portfolio, sequence)
                for observation in manifest["rows"]:
                    listing = observation["listing"]
                    pair, threat = scorecards.get(listing, (None, None))
                    if observation.get("pairwise") != pair or observation.get("stock_threat") != threat:
                        raise HTTPException(409, "Scorecard observations differ from the saved job")
            elif payload.get("scorecard_job_id") is not None:
                raise HTTPException(409, "Missing Technical scorecard manifest")
            calculations = source_calculations(payload, sources=sources, jobs_by_run=jobs_by_run, market=market, scorecards=scorecards)
            if rebuild:
                from .final_reconciliation import materialize_rows
                if manifest_data is None or not calculations:
                    raise HTTPException(409, "Rebuild requires a saved Technical source manifest and verified listings")
                payload.update(rows=materialize_rows(calculations), rebalance_run_id=rebalance_ids[0],
                               input_listing_count=len(calculations), final_listing_count=len(calculations),
                               excluded_non_buy_listings=[])
                if len(calculations) > 500 or len(json.dumps(payload)) > 2_000_000:
                    raise HTTPException(422, "Rebuilt final exceeds audit size limit")
            verify_recomputed_rows(payload, calculations, raw_field='rawScore', effective_field='effectiveScore')
        except (UnverifiableFinal, ArithmeticError) as exc:
            raise HTTPException(422, f'Final calculation could not be verified: {exc}') from exc

        if "scorecard_job_id" in payload:
            ranking = []
            for row in payload["rows"]:
                listing = row["exchange"] + ":" + row["symbol"]
                pair, threat = scorecards.get(listing, (None, None))
                effective = row["effectiveScore"]
                ranking.append({"listing": listing, "stock_threat": threat, "pairwise": pair,
                                "score": None if effective is None else (effective + 3) * 100 / 6})
            ranking.sort(key=lambda r: (r["score"] is None, -(r["score"] or 0), r["listing"]))
            payload["actionable_ranking"] = {"version": "weighted-98-1-1-v1", "source_hash": digest, "rows": ranking}


async def verified_scorecards(db, job_id, user_id, portfolio, sequence):
    from app.domains.zerodha.threats import parse_zerodha_threat_report

    tables = {}
    digest = None
    if job_id is not None:
        if type(job_id) is not int or job_id <= 0:
            raise HTTPException(422, "Invalid scorecard job identity")
        await validate_execution(db, user_id=user_id, portfolio=portfolio, sequence=sequence,
                                 stage="threats", run_id=None, job_id=job_id)
        job = (await db.execute(select(Job).where(Job.id == job_id, Job.user_id == user_id))).scalar_one()
        if str(getattr(job.status, "value", job.status)).lower() not in {"completed", "partial"}:
            raise HTTPException(409, "Scorecard job is not complete")
        digest = hashlib.sha256((job.response or "").encode()).hexdigest()
        report = parse_zerodha_threat_report(job.response) or {}
        tables = {table["key"]: table["rows"] for table in report.get("tables", [])}
    threats = {row["Exchange"] + ":" + row["Stock Symbol"]: float(row["Stock Threat /100"])
               for row in tables.get("stock_threat_scores", []) if row["Stock Threat /100"] != "Unknown"}
    pairs = {row["Listing"]: float(row["Pairwise /100"]) for row in tables.get("pairwise_scores", [])
             if row["Pairwise /100"] != "Unknown"}
    return {key: (pairs.get(key), threats.get(key)) for key in pairs.keys() | threats.keys()}, digest
