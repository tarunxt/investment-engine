"""Read saved score observations only. No materialization or scoring provider calls."""
from datetime import datetime, timedelta, timezone
import math
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from sqlalchemy import and_, select
from app.domains.runs.models import FinalActionableHistory, Run
from app.domains.runs.run_identity import analysis_run_identity
from app.domains.recommendation_audit.models import DecisionRecord
from app.domains.runs.final_actionable_history import normalize_stock_symbol, status_value, normalize_header


def saved_venue(history):
    native = history.formula_inputs_json or {}
    if native.get('stockExchange'): return str(native['stockExchange']).upper()
    venues = set()
    for row in (history.snapshot_json or {}).get('rows', []):
        if not isinstance(row, dict) or not isinstance(row.get('raw'), dict): continue
        raw = {normalize_header(k): v for k, v in row['raw'].items()}
        if normalize_stock_symbol(raw.get('stock symbol', '')) == history.stock_symbol:
            venue = raw.get('exchange symbol')
            if venue: venues.add(str(venue).upper())
    return next(iter(venues)) if len(venues) == 1 else None


def score_history_view(session, *, user_id, market, symbols, days, as_of, timezone_name):
    if as_of.tzinfo is None: raise ValueError('An offset-aware as-of timestamp is required')
    if days < 1 or days > 3650: raise ValueError('Choose between 1 and 3650 past days')
    try: ZoneInfo(timezone_name)
    except (ZoneInfoNotFoundError, ValueError): raise ValueError('The profile timezone is invalid')
    end = as_of.astimezone(timezone.utc)
    if end > datetime.now(timezone.utc) + timedelta(minutes=1): raise ValueError('The as-of timestamp cannot be in the future')
    start = end - timedelta(days=days)
    symbols = sorted({normalize_stock_symbol(s) for s in symbols})
    if not symbols or len(symbols) > 500: raise ValueError('Select between 1 and 500 stock symbols')
    rows = session.execute(select(FinalActionableHistory, Run).outerjoin(Run, and_(Run.id == FinalActionableHistory.rebalance_run_id, Run.user_id == user_id)).where(FinalActionableHistory.user_id == user_id, FinalActionableHistory.market == market, FinalActionableHistory.stock_symbol.in_(symbols), FinalActionableHistory.covered_at > start, FinalActionableHistory.covered_at <= end).order_by(FinalActionableHistory.covered_at, FinalActionableHistory.id).limit(10001)).all()
    observations = []
    for history, run in rows[:10000]:
        identity = analysis_run_identity(run) if run else None
        score = history.score
        completed = run is not None and status_value(run.status) == 'completed' and identity.market == market and identity.stage == 'rebalance'
        valid = isinstance(score, (int, float)) and not isinstance(score, bool) and math.isfinite(score)
        observations.append({'id': history.id, 'run_id': history.rebalance_run_id, 'symbol': history.stock_symbol, 'exchange': saved_venue(history), 'covered_at': history.covered_at.replace(tzinfo=timezone.utc).isoformat() if history.covered_at.tzinfo is None else history.covered_at.isoformat(), 'score': score if valid else None, 'action': history.action, 'formula_version': history.formula_version, 'completed': completed, 'coverage_status': history.coverage_status})
    # An immutable completed decision is also a recorded score. Never choose a
    # latest revision: disagreeing complete captures for one run remain ambiguous.
    represented = {(row['symbol'], row['exchange'], row['run_id']) for row in observations}
    # Run inherits TimestampMixin's naive UTC DateTime storage. asyncpg cannot
    # bind aware datetimes to TIMESTAMP WITHOUT TIME ZONE. Keep history bounds
    # aware (covered_at is TIMESTAMPTZ), but adapt these UTC binds to Run storage.
    run_start, run_end = start.replace(tzinfo=None), end.replace(tzinfo=None)
    captures = session.execute(select(DecisionRecord, Run).join(Run, and_(Run.id == DecisionRecord.run_id, Run.user_id == user_id)).where(DecisionRecord.user_id == user_id, DecisionRecord.market == market, DecisionRecord.symbol.in_(symbols), Run.created_at > run_start, Run.created_at <= run_end).order_by(DecisionRecord.id).limit(10001)).all()
    groups = {}
    for capture, run in captures[:10000]:
        identity = analysis_run_identity(run)
        if status_value(run.status) != 'completed' or identity.market != market or identity.stage != 'rebalance' or not (capture.provenance in {'terminal', 'prospective'} or capture.provenance.startswith('technical:')): continue
        payload = capture.payload
        coverage = payload.get('coverage') or {}
        attempted = coverage.get('attempted', 0)
        if not attempted or coverage.get('successful') != attempted or coverage.get('captured_terminal') != attempted: continue
        calc = payload.get('calculation') or {}
        if calc.get('formula_action') not in {'Sell All', 'Trim', 'Hold', 'Add more', 'Buy New'} or any(finding.get('severity') == 'error' for finding in calc.get('findings', [])): continue
        score = calc.get('score')
        if isinstance(score, bool): continue
        try: score = float(score)
        except (TypeError, ValueError): continue
        if not math.isfinite(score) or not payload.get('formula') or (payload.get('run_id'), payload.get('market'), payload.get('symbol'), payload.get('exchange')) != (run.id, market, capture.symbol, capture.exchange): continue
        key = (capture.symbol, capture.exchange, run.id)
        groups.setdefault(key, []).append((capture, run, score))
    ambiguous = 0
    for key, candidates in groups.items():
        if key in represented: continue
        if len({value[2] for value in candidates}) != 1:
            ambiguous += 1; continue
        capture, run, score = candidates[0]
        when = run.created_at.replace(tzinfo=timezone.utc) if run.created_at.tzinfo is None else run.created_at
        observations.append({'id': f'audit:{capture.id}', 'run_id': run.id, 'symbol': capture.symbol, 'exchange': capture.exchange, 'covered_at': when.isoformat(), 'score': score, 'action': capture.payload['calculation'].get('formula_action'), 'formula_version': 'immutable-captured-formula', 'completed': True, 'coverage_status': 'suggested'})
    return {'market': market, 'symbols': symbols, 'as_of': end.isoformat(), 'window_start': start.isoformat(), 'timezone': timezone_name, 'days': days, 'truncated': len(rows) > 10000 or len(captures) > 10000, 'ambiguous_complete_runs': ambiguous, 'observations': observations, 'notes': ['Rolling N × 24-hour window: start exclusive, as-of inclusive. Each saved completed-run score counts once, without daily averaging.', 'Unknown/deleted run status, ambiguous venue and invalid scores are excluded. Missing observations are never zero.', 'History is scoped to the authenticated owner and market. No history is regenerated or overwritten.', 'Complete immutable terminal captures may supply an original recorded score when no saved summary exists. Disagreeing complete scores for a run are excluded rather than selecting the latest.']}
