"""Paged, owner-scoped original source observations; never backfill history."""
import re
import json
from sqlalchemy import select
from app.domains.jobs.models import Job
from app.domains.runs.models import Run, RunJob
from app.domains.runs.run_identity import analysis_run_identity
from app.domains.runs.final_actionable_history import normalize_stock_symbol, normalize_header, status_value
from app.domains.recommendation_audit.models import EvidenceRecord
from app.domains.recommendation_audit.capture import digest
from app.domains.jobs.output_contracts.document import parse_markdown, parse_json, MISSING


def matching_rows(text, symbol):
    # Reuse the lossless contract fragment parser. No padding, truncation or
    # action-column requirement: technical and swing tables are observations too.
    blocks, findings = parse_json(text) if text.lstrip().startswith(('[', '{')) else parse_markdown(text)
    matches = []
    for block in blocks:
        if block.kind != 'table': continue
        headers = [normalize_header(str(header)) for header in block.headers]
        positions = [index for index, header in enumerate(headers) if header in {'stock symbol', 'symbol', 'ticker', 'stock'}]
        for index, cells in enumerate(block.rows):
            if not any(position < len(cells) and normalize_stock_symbol(str(cells[position])) == normalize_stock_symbol(symbol) for position in positions): continue
            malformed = len(cells) != len(headers) or len(set(headers)) != len(headers) or bool(findings)
            values = {'source contract status': 'Malformed/ambiguous source row; financial fields are not mapped', 'original headers': list(block.headers), 'original cells': list(cells), 'original source fragment': block.text} if malformed else {header: cell for header, cell in zip(headers, cells) if cell is not MISSING}
            try: json.dumps(values, allow_nan=False)
            except (ValueError, TypeError): values = {'source contract status': 'Source contains non-JSON/missing values; financial fields are not mapped', 'original source fragment': block.text}
            matches.append((f'{block.index}.{index}', values))
    if not matches and re.search(r'(?<![A-Za-z0-9])' + re.escape(normalize_stock_symbol(symbol)) + r'(?![A-Za-z0-9])', text, re.IGNORECASE):
        matches.append(('unparsed', {'source contract status': 'Symbol mentioned in unparsed output; no financial fields inferred', 'original source text': text}))
    return matches


def rows_for_source(*, text, symbol, run_id, job_id, revision, stage, run_status, job_status, provider, model, created_at, source):
    return [{'id': f'{run_id}:{job_id}:{revision}:{index}', 'run_id': run_id, 'job_id': job_id, 'stage': stage, 'run_status': run_status, 'job_status': job_status, 'provider': provider, 'model': model, 'created_at': created_at, 'source': source, 'cells': row} for index, row in matching_rows(text, symbol)]


def stock_observation_page(session, *, user_id, market, symbol, cursor=None, limit=50):
    phase, after = (cursor or 'jobs:0').split(':', 1)
    if phase not in {'jobs', 'audit'} or limit < 1 or limit > 100: raise ValueError('Invalid observation cursor or limit')
    result = []
    if phase == 'jobs':
        if not after.isdigit(): raise ValueError('Invalid job cursor')
        records = session.execute(select(RunJob, Run, Job).join(Run, Run.id == RunJob.run_id).join(Job, Job.id == RunJob.job_id).where(Run.user_id == user_id, Job.user_id == user_id, RunJob.id < (int(after) or 9223372036854775807)).order_by(RunJob.id.desc()).limit(limit + 1)).all()
        for link, run, job in records[:limit]:
            identity = analysis_run_identity(run)
            if identity.market != market: continue
            result.extend(rows_for_source(text=job.response or '', symbol=symbol, run_id=run.id, job_id=job.id, revision=digest(job.response or ''), stage=identity.stage or 'unknown', run_status=status_value(run.status), job_status=status_value(job.status), provider=job.provider, model=job.model, created_at=job.created_at.isoformat(), source='retained_job'))
        next_cursor = f'jobs:{records[limit - 1][0].id}' if len(records) > limit else 'audit:'
    else:
        records = list(session.scalars(select(EvidenceRecord).where(EvidenceRecord.user_id == user_id, EvidenceRecord.kind == 'output', EvidenceRecord.id < (after or chr(0x10ffff))).order_by(EvidenceRecord.id.desc()).limit(limit + 1)))
        run_ids = {record.run_id for record in records[:limit]}
        inputs = list(session.scalars(select(EvidenceRecord).where(EvidenceRecord.user_id == user_id, EvidenceRecord.kind == 'input', EvidenceRecord.run_id.in_(run_ids)))) if run_ids else []
        for record in records[:limit]:
            contexts = [item.payload for item in inputs if item.run_id == record.run_id]
            identities = {(item.get('market'), item.get('stage')) for item in contexts}
            if len(identities) != 1 or next(iter(identities))[0] != market: continue
            payload = record.payload
            text = record.content
            if text:
                result.extend(rows_for_source(text=text, symbol=symbol, run_id=record.run_id, job_id=record.job_id, revision=payload.get('response_hash') or record.content_hash, stage=next(iter(identities))[1] or 'unknown', run_status='original run status unavailable', job_status=payload.get('status', 'unknown'), provider=payload.get('provider'), model=payload.get('model'), created_at=payload.get('created_at'), source='retained_immutable_output'))
            else:
                for index, saved in enumerate(payload.get('rows') or []):
                    values = saved.get('source_values') or saved.get('row') or {}
                    if normalize_stock_symbol(values.get('stock_symbol', '')) != normalize_stock_symbol(symbol): continue
                    result.append({'id': f'{record.run_id}:{record.job_id}:{payload.get("response_hash") or record.content_hash}:{index}', 'run_id': record.run_id, 'job_id': record.job_id, 'stage': next(iter(identities))[1] or 'unknown', 'run_status': 'original run status unavailable', 'job_status': payload.get('status', 'unknown'), 'provider': payload.get('provider'), 'model': payload.get('model'), 'created_at': payload.get('created_at'), 'source': 'immutable_saved_source_values', 'cells': values})
        next_cursor = f'audit:{records[limit - 1].id}' if len(records) > limit else None
    return {'market': market, 'symbol': normalize_stock_symbol(symbol), 'items': result, 'next_cursor': next_cursor, 'has_more': next_cursor is not None, 'examined_sources': min(len(records), limit), 'coverage_note': 'All retained owned sources are scanned across pages. Deleted uncaptured outputs and sources with unknown market identity cannot be reconstructed. No provider call or history write is performed.'}
