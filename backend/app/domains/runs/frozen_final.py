"""Verify provenance before freezing a workflow's final calculation."""
import hashlib
import json
import math
import re
from collections import defaultdict
from fastapi import HTTPException
from sqlalchemy import select
from .auto_rebalance_audit import validate_execution
from .final_score_math import DIRECTIONAL_SIZING, ORIGINAL_SIZING
from .models import Run, RunJob
from .run_identity import analysis_run_identity
from app.domains.jobs.models import Job


async def validate_frozen_final(db, payload, *, user_id, portfolio, sequence, allow_legacy=False, rebuild=False, scorecard_evidence=None, stored_record=False):
    if isinstance(payload,dict) and payload.get("schema")=="independent-scorecards-v1":
        from app.domains.scorecards.storage import lookup
        if set(payload)!={"schema","final_id","workflow_sequence"} or type(payload["final_id"]) is not int or payload["workflow_sequence"]!=sequence:
            raise HTTPException(422,"Invalid independent final reference")
        final = await lookup(db,user_id,portfolio,"final",payload["final_id"],sequence=sequence)
        if not final:
            raise HTTPException(409,"Independent final source belongs to a different workflow")
        return final
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
    if not legacy and (payload.get('formula_version') not in {'score-matrix-v1', 'score-matrix-v2'} or payload.get('scorePolicy') != 'score-matrix-raw-effective-v2'):
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
        from .final_recompute import equivalent, source_calculations, verify_recomputed_rows
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
            diagnostics = {} if scorecard_evidence is None else scorecard_evidence
            scorecards = {}
            if manifest_line:
                try:
                    manifest = json.loads(manifest_line.removeprefix("[WORKFLOW_SCORECARDS_V1]"))
                    source_id = manifest["job_id"]
                except (KeyError, ValueError, TypeError) as exc:
                    raise HTTPException(422, "Invalid scorecard manifest") from exc
                if not rebuild and payload.get("scorecard_job_id") != source_id:
                    raise HTTPException(409, "Final scorecard job differs from the Technical source")
                payload["scorecard_job_id"] = source_id
                scorecards = await verified_scorecards(db, source_id, user_id, portfolio, sequence, legacy_evidence=payload.get("formula_version") == "score-matrix-v1", evidence=diagnostics)
                observations = manifest.get("rows")
                if not isinstance(observations, list) or len(observations) > 500:
                    raise HTTPException(422, "Invalid scorecard observations")
                observed_listings = set()
                for observation in observations:
                    if not isinstance(observation, dict) or not isinstance(observation.get("listing"), str):
                        raise HTTPException(422, "Invalid scorecard listing")
                    listing = observation["listing"]
                    if listing in observed_listings:
                        raise HTTPException(409, f"Duplicate scorecard observation for {listing}")
                    observed_listings.add(listing)
                    pair, threat = scorecards.get(listing, (None, None))
                    if observation.get("pairwise") != pair or observation.get("stock_threat") != threat:
                        raise HTTPException(409, "Scorecard observations differ from the saved job")
            elif payload.get("scorecard_job_id") is not None:
                raise HTTPException(409, "Missing Technical scorecard manifest")
            from .final_positions import POSITION_POLICY, captured_positions
            if not stored_record and not rebuild and market == "india" and manifest_line and payload.get("formula_version") == "score-matrix-v2":
                payload.setdefault("position_policy", POSITION_POLICY)
            use_positions = payload.get("position_policy") == POSITION_POLICY
            from .final_us_positions import US_POSITION_POLICY, load_us_snapshot
            us_positions = payload.get("position_policy") == US_POSITION_POLICY and market == "us"
            us_context = None
            if us_positions:
                from app.domains.indmoney_us.alpaca_quotes import read_verified_listings
                prefix = "[VERIFIED_US_LISTINGS_V1]"
                lines = [line[len(prefix):] for line in technical.prompt.splitlines() if line.startswith(prefix)]
                if len(lines) != 1 or not manifest_line:
                    raise UnverifiableFinal("Missing US registry or Stage 3 snapshot evidence")
                registry = json.loads(lines[0])
                if not isinstance(registry, list) or len(registry) > 1000:
                    raise UnverifiableFinal("Invalid US listing registry")
                if not stored_record and not rebuild and registry != read_verified_listings(user_id)["listings"]:
                    raise UnverifiableFinal("US listing registry differs from verified owner metadata")
                if rebuild and registry != payload.get("us_verified_listings", read_verified_listings(user_id)["listings"]):
                    raise UnverifiableFinal("US listing registry differs from captured evidence")
                payload["us_verified_listings"] = registry
                prompt = await db.scalar(select(Job.prompt).where(Job.id == source_id, Job.user_id == user_id))
                us_context = registry, await load_us_snapshot(db, user_id, prompt or "")
            if "position_policy" in payload and not us_positions and (not use_positions or market != "india" or not manifest_line):
                raise UnverifiableFinal("Unsupported holding valuation policy or missing Stage 3 source")
            positions = None
            if use_positions:
                prompt = await db.scalar(select(Job.prompt).where(Job.id == source_id, Job.user_id == user_id))
                positions = captured_positions(prompt or "")
            from .final_score_math import BUY_PRICE_POLICY
            if "buy_price_policy" in payload and payload["buy_price_policy"] != BUY_PRICE_POLICY:
                raise UnverifiableFinal("Unsupported buy quote policy")
            policy = payload.get("sizing_policy", DIRECTIONAL_SIZING)
            if policy != DIRECTIONAL_SIZING and not (stored_record and policy == ORIGINAL_SIZING):
                raise UnverifiableFinal("Unsupported final sizing policy")
            context = dict(sources=sources, jobs_by_run=jobs_by_run, market=market, scorecards=scorecards, positions=positions, us_context=us_context)
            calculations = source_calculations(payload, **context, sizing_policy=policy)
            if rebuild:
                from .final_reconciliation import materialize_rows
                if manifest_data is None or not calculations:
                    raise HTTPException(409, "Rebuild requires a saved Technical source manifest and verified listings")
                payload.update(rows=materialize_rows(calculations), rebalance_run_id=rebalance_ids[0],
                               input_listing_count=len(calculations), final_listing_count=len(calculations),
                               excluded_non_buy_listings=[])
                if len(calculations) > 500 or len(json.dumps(payload)) > 2_000_000:
                    raise HTTPException(422, "Rebuilt final exceeds audit size limit")
            fields = dict(raw_field="rawScore", effective_field="effectiveScore")
            try:
                verify_recomputed_rows(payload, calculations, **fields)
            except UnverifiableFinal as current_error:
                # Only database-owned, untagged snapshots span both releases. Match
                # an entire record against one policy, including every numeric field.
                if not stored_record or "sizing_policy" in payload or rebuild:
                    raise
                historical = source_calculations(payload, **context, sizing_policy=ORIGINAL_SIZING)
                try:
                    verify_recomputed_rows(payload, historical, **fields)
                except UnverifiableFinal as historical_error:
                    raise UnverifiableFinal(f"{current_error} (historical check: {historical_error})") from historical_error
                calculations, policy = historical, ORIGINAL_SIZING
            payload["sizing_policy"] = policy
            if payload.get("formula_version") == "score-matrix-v2":
                for row in payload["rows"]:
                    if "buy_price_policy" in payload:
                        quote = calculations[(row["exchange"], row["symbol"])]["buy_quote"]
                        if stored_record and not equivalent(row.get("buy_quote"), quote):
                            raise UnverifiableFinal("Saved buy quote differs from provider evidence")
                        row["buy_quote"] = quote
                    if use_positions or us_positions:
                        provenance = calculations[(row["exchange"], row["symbol"])]["position_valuation"]
                        if stored_record and row.get("position_valuation") != provenance:
                            raise UnverifiableFinal("Saved holding valuation provenance differs from Stage 3")
                        row["position_valuation"] = provenance
                    row["source_coverage"] = calculations[(row["exchange"], row["symbol"])]["source_coverage"]
        except (UnverifiableFinal, ArithmeticError) as exc:
            raise HTTPException(422, f'Final calculation could not be verified: {exc}') from exc

        if "scorecard_job_id" in payload:
            ranking = []
            for row in payload["rows"]:
                listing = row["exchange"] + ":" + row["symbol"]
                pair, threat = scorecards.get(listing, (None, None))
                effective = row["effectiveScore"]
                detail = diagnostics.get(listing, {})
                reason = detail.get("threat_reason") if detail else ("Missing stock threat row" if manifest_line else "No scorecard manifest")
                ranking.append({"threat_reason": reason, "listing": listing, "stock_threat": threat, "pairwise": pair,
                                "score": None if effective is None else (effective + 3) * 100 / 6})
            ranking.sort(key=lambda r: (r["score"] is None, -(r["score"] or 0), r["listing"]))
            payload["actionable_ranking"] = {"version": "weighted-98-1-1-v1", "rows": ranking}


async def verified_scorecards(db, job_id, user_id, portfolio, sequence, *, legacy_evidence=False, evidence=None):
    from app.domains.zerodha.threats import parse_zerodha_threat_report

    tables = {}
    if job_id is None:
        raise HTTPException(422, "Scorecard manifest is missing its job identity")
    if job_id is not None:
        if type(job_id) is not int or job_id <= 0:
            raise HTTPException(422, "Invalid scorecard job identity")
        await validate_execution(db, user_id=user_id, portfolio=portfolio, sequence=sequence,
                                 stage="threats", run_id=None, job_id=job_id)
        job = (await db.execute(select(Job).where(Job.id == job_id, Job.user_id == user_id))).scalar_one()
        if str(getattr(job.status, "value", job.status)).lower() not in {"completed", "partial"}:
            raise HTTPException(409, "Scorecard job is not complete")
        report = parse_zerodha_threat_report(job.response, job.prompt or "", legacy_evidence=legacy_evidence) or {}
        tables = {table["key"]: table["rows"] for table in report.get("tables", [])}
    def unique_scores(rows, listing_key, score_key):
        scores = {}
        for row in rows:
            listing = listing_key(row)
            value = row.get(score_key)
            if listing in scores:
                scores[listing] = None
                continue
            try:
                number = float(value)
            except (ValueError, TypeError):
                number = None
            scores[listing] = number if number is not None and math.isfinite(number) and 0 <= number <= 100 else None
        return scores

    threat_rows = tables.get("stock_threat_scores", [])
    counts = defaultdict(int)
    assessment_reasons = {}
    for row in threat_rows:
        listing = row["Exchange"] + ":" + row["Stock Symbol"]
        counts[listing] += 1
        assessment_reasons[listing] = row.get("Assessment reason")
    threats = unique_scores(threat_rows,
                            lambda row: row["Exchange"] + ":" + row["Stock Symbol"], "Stock Threat /100")
    pairs = unique_scores(tables.get("pairwise_scores", []), lambda row: row["Listing"], "Pairwise /100")
    if evidence is not None:
        comparisons = {}
        for row in tables.get("pairwise_scores", []):
            listing = row["Listing"]
            count = str(row.get("Valid comparisons", "")).strip()
            comparisons[listing] = int(count) if listing not in comparisons and count.isdecimal() else None
        for listing in pairs.keys() | threats.keys():
            count = counts[listing]
            reason = ("Duplicate stock threat rows" if count > 1 else (assessment_reasons.get(listing) or "Invalid stock threat score") if count and threats.get(listing) is None else None if count else "Missing stock threat row")
            evidence[listing] = {"threat_reason": reason, "job_id": job_id, "comparisons": comparisons.get(listing),
                                 "pairwise": pairs.get(listing), "stock_threat": threats.get(listing)}
    return {key: (pairs.get(key), threats.get(key)) for key in pairs.keys() | threats.keys()}
