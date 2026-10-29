"""Bounded, read-only coeval holding values from persisted simulation evidence.

No interpolation, live acquisition, current-rate backfill, cash/return inference,
or authorization to execute. Different source instants remain explicit gaps.
"""
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, localcontext
from math import isfinite

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.exc import DBAPIError

from app.domains.auth.dependencies import get_current_user
from app.domains.fx_rates.models import FxRate
from app.domains.fx_rates.service import USD_INR_STALE_AFTER
from app.domains.indmoney_us.import_validation import require_recommendation_snapshot, utc
from app.domains.indmoney_us.models import IndMoneyUsPortfolioSnapshot as UsSnapshot
from app.domains.indmoney_us.repository import accepted_snapshot_predicate
from app.domains.modules.lifecycle import ModuleLifecycleDenied, sync_snapshot
from app.domains.runs.analysis_workflows.contracts import WorkflowDenied
from app.domains.runs.analysis_workflows.synthetic_journal import TOPIC
from app.infrastructure.database.outbox.models import OutboxMessage
from app.infrastructure.database.session import get_async_db
from app.shared.exceptions import ValidationException
from .event_history import authorize
from .http_bindings import request_binding
from .journal_history import historical_source
from .journal_portfolio import project_snapshot

router = APIRouter(prefix='/uat2/simulation/combined-history', tags=['owned-combined-history'])
SOURCE_LIMIT = 100
FX_LIMIT = 400
METRIC = 'coeval_recorded_holdings_inr_v1'


def amount(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        number = Decimal(str(value))
        return number if number.is_finite() and number >= 0 and isfinite(float(number)) else None
    except (InvalidOperation, ValueError, TypeError, OverflowError):
        return None


def compose(india, us, rates, *, now, fx_truncated=False, source_truncated=None):
    """Inputs are already ownership/integrity admitted by the store adapter."""
    now = utc(now)
    groups = {}
    for market, rows in (('india', india), ('us', us)):
        for row in rows:
            at = utc(row['at'])
            if at > now:
                continue
            groups.setdefault(at, {'india': [], 'us': []})[market].append(row)
    points = []
    for at, pair in sorted(groups.items()):
        reasons = [market + '_source_bound_exceeded' for market in ('india','us') if (source_truncated or {}).get(market)]
        for market in ('india', 'us'):
            if len(pair[market]) != 1:
                reasons.append(market + ('_source_missing' if not pair[market] else '_source_ambiguous'))
        left = pair['india'][0] if len(pair['india']) == 1 else None
        right = pair['us'][0] if len(pair['us']) == 1 else None
        inr = amount(left['value']) if left else None
        usd = amount(right['value']) if right else None
        if left and inr is None:
            reasons.append('india_value_unknown')
        if right and usd is None:
            reasons.append('us_value_unknown')
        candidates = []
        for row in rates:
            rate = amount(row.rate)
            if (row.verified is True and row.base_currency == 'USD' and row.quote_currency == 'INR'
                    and isinstance(row.source, str) and row.source.strip() and rate is not None and rate > 0
                    and utc(row.fetched_at) <= now and utc(row.source_as_of) <= at
                    and at - utc(row.source_as_of) <= USD_INR_STALE_AFTER):
                candidates.append(row)
        fx = None
        if fx_truncated:
            reasons.append('fx_bound_exceeded')
        elif not candidates:
            reasons.append('dated_fx_unavailable')
        else:
            latest = max(utc(row.source_as_of) for row in candidates)
            chosen = [row for row in candidates if utc(row.source_as_of) == latest]
            # Different persisted records at the same effective instant must
            # not be silently selected by id/source, even at the same rate.
            if len(chosen) != 1:
                reasons.append('dated_fx_ambiguous')
            else:
                fx = chosen[0]
        total = None
        if not reasons:
            with localcontext() as context:
                context.prec = 400
                total = inr + usd * Decimal(str(fx.rate))
            if amount(total) is None:
                total = None
                reasons.append('combined_value_out_of_range')
            elif Decimal(str(float(total))) != total:
                total = None
                reasons.append('combined_value_not_representable')
        points.append({'captured_at': at.isoformat(), 'value': float(total) if total is not None else None,
                       'value_exact': (format(total, 'f').rstrip('0').rstrip('.') if '.' in format(total, 'f') else format(total, 'f')) if total is not None else None,
                       'known': total is not None, 'reasons': reasons,
                       'india': left['receipt'] if left else None, 'us': right['receipt'] if right else None,
                       'fx': {'id': fx.id, 'pair': 'USD/INR', 'rate': str(fx.rate),
                              'source': fx.source, 'as_of': utc(fx.source_as_of).isoformat(),
                              'fetched_at': utc(fx.fetched_at).isoformat()} if fx else None})
    return points


def project(db, owner, binding, *, now=None):
    authorize(db, owner, 'india', binding)
    authorize(db, owner, 'indmoney_us', binding)
    version = sync_snapshot(db, owner).version
    now = utc(now or datetime.now(timezone.utc))
    messages = db.scalars(select(OutboxMessage).where(OutboxMessage.topic == TOPIC,
        OutboxMessage.payload['owner_id'].as_integer() == owner).order_by(
        OutboxMessage.payload['sequence'].as_integer().desc(), OutboxMessage.id.desc()).limit(SOURCE_LIMIT + 1)).all()
    snapshots = db.scalars(select(UsSnapshot).where(UsSnapshot.user_id == owner,
        accepted_snapshot_predicate()).order_by(UsSnapshot.captured_at.desc(), UsSnapshot.id.desc()).limit(SOURCE_LIMIT + 1)).all()
    india, us = [], []
    rejected = {'india': 0, 'us': 0}
    for message in messages[:SOURCE_LIMIT]:
        try:
            source = historical_source(db, message, owner, now=now)
            view = project_snapshot(source, historical=True)
            at = datetime.fromisoformat(source['captured_at'])
            if utc(at) > now:
                raise WorkflowDenied('Future observation')
            india.append({'at': at, 'value': view['holdings_market_value_exact'],
                          'receipt': {'id': str(message.id), 'source_hash': view['source_hash'], 'captured_at': utc(at).isoformat(), 'currency': 'INR', 'value_exact': view['holdings_market_value_exact']}})
        except (WorkflowDenied, ValueError, KeyError, TypeError):
            rejected['india'] += 1
    for row in snapshots[:SOURCE_LIMIT]:
        try:
            if utc(row.captured_at) > now:
                raise WorkflowDenied('Future observation')
            # Validate at its recorded instant, never as current/research-ready.
            require_recommendation_snapshot(row, now=utc(row.captured_at))
            seen = {row.id}
            parent = row.supersedes_id
            while parent is not None:
                if parent in seen or len(seen) > SOURCE_LIMIT:
                    raise WorkflowDenied('Ambiguous correction lineage')
                seen.add(parent)
                ancestor = db.scalar(select(UsSnapshot).where(UsSnapshot.id == parent, UsSnapshot.user_id == owner))
                if ancestor is None or ancestor.acceptance_state != 'accepted':
                    raise WorkflowDenied('Owned accepted correction lineage required')
                parent = ancestor.supersedes_id
            us.append({'at': utc(row.captured_at), 'value': row.current_value,
                       'receipt': {'id': row.id, 'source_hash': row.import_provenance['source_hash'],
                                   'content_hash': row.content_hash, 'supersedes_id': row.supersedes_id, 'captured_at': utc(row.captured_at).isoformat(), 'currency': 'USD', 'value_exact': str(row.current_value) if row.current_value is not None else None}})
        except (WorkflowDenied, ValidationException, ValueError, KeyError, TypeError):
            rejected['us'] += 1
    times = [utc(row['at']) for row in india + us]
    rates = []
    if times:
        rates = db.scalars(select(FxRate).where(FxRate.base_currency == 'USD', FxRate.quote_currency == 'INR',
            FxRate.verified.is_(True), FxRate.source_as_of >= min(times) - USD_INR_STALE_AFTER,
            FxRate.source_as_of <= max(times)).order_by(FxRate.source_as_of.desc(), FxRate.id.desc()).limit(FX_LIMIT + 1)).all()
    truncated = {'india': len(messages) > SOURCE_LIMIT, 'us': len(snapshots) > SOURCE_LIMIT}
    points = compose(india, us, rates[:FX_LIMIT], now=now, fx_truncated=len(rates) > FX_LIMIT, source_truncated=truncated)
    # Re-read current policy before disclosure; no identity-map lifetime bypass.
    authorize(db, owner, 'india', binding)
    authorize(db, owner, 'indmoney_us', binding)
    if sync_snapshot(db, owner).version != version:
        raise WorkflowDenied('Module selection changed during history read')
    return {'schema_version': 1, 'owner_id': owner, 'module_version': version, 'simulation_only': True, 'read_only': True,
            'orders_authorized': False, 'metric': METRIC, 'currency': 'INR',
            'alignment': 'exact_capture_instant_only', 'history_complete': False,
            'source_limit': SOURCE_LIMIT, 'fx_limit': FX_LIMIT, 'fx_stale_after_seconds': int(USD_INR_STALE_AFTER.total_seconds()),
            'has_more': {**truncated, 'fx': len(rates) > FX_LIMIT}, 'rejected_sources': rejected,
            'continuity_verified': not any(rejected.values()) and not any(truncated.values()) and len(rates) <= FX_LIMIT, 'points': points,
            'notice': 'Recorded holdings only, not cash, returns, live balances or complete investment performance. '
                      'Only exactly coeval owned sources are combined using dated persisted FX; no carry-forward or interpolation.'}


@router.get('')
async def combined_history(request: Request, response: Response, user=Depends(get_current_user), db=Depends(get_async_db)):
    binding = request_binding(request)
    if binding is None:
        raise HTTPException(503, 'Installed simulation history unavailable')
    response.headers['Cache-Control'] = 'private, no-store'
    response.headers['Vary'] = 'Cookie, Authorization'
    try:
        return await db.run_sync(lambda session: project(session, user.id, binding))
    except (PermissionError, ModuleLifecycleDenied, WorkflowDenied):
        raise HTTPException(403, 'Both owned selected-module views are required') from None
    except DBAPIError:
        raise HTTPException(503, 'Combined recorded history unavailable; no empty or zero result inferred') from None
