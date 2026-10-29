"""Verify provenance before freezing a workflow's final calculation."""
import hashlib
import json
import math
import re
from fastapi import HTTPException
from sqlalchemy import select
from .auto_rebalance_audit import validate_execution
from .models import Run, RunJob
from .run_identity import analysis_run_identity
from app.domains.jobs.models import Job


async def validate_frozen_final(db, payload, *, user_id, portfolio, sequence):
    if not isinstance(payload, dict) or payload.get('schema') != 'workflow-final-v1':
        raise HTTPException(422, 'Unsupported frozen final schema')
    if len(json.dumps(payload)) > 2_000_000:
        raise HTTPException(422, 'Frozen final exceeds audit size limit')
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
        if not isinstance(selected, list) or any(not isinstance(i, int) or i not in known or i in technical_jobs for i in selected):
            raise HTTPException(422, 'Technical source job manifest is invalid')
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
