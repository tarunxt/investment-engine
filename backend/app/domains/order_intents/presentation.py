"""Owner-only persisted order views. Reading never authorizes financial work.

The normal read path invokes no broker, policy adapter, token, queue or mutation.
A private synthetic composition can additionally check current policy/risk. Stored records
are observations, not proof of current provider state or permission to resubmit.
"""
from copy import deepcopy
from datetime import datetime, timezone
from decimal import Decimal
from sqlalchemy import select, case
from .contracts import OrderDenied, digest, payload, stored_utc, receipt
from .models import OrderIntent, OrderLeg

UNRESOLVED = {'submitting', 'acknowledged', 'unknown', 'partial'}


def project(row, legs, now):
    warnings = []
    safe_legs = []
    integrity = True
    try:
        order = payload(deepcopy(row.payload_json))
        bound = {key: getattr(row, key) for key in ('owner_id', 'module_id', 'module_version', 'connection_id', 'connection_version', 'account_id', 'app_mode')}
        bound['payload'] = order
        if order != row.payload_json or digest(bound) != row.request_digest:
            raise OrderDenied('CHANGED_RECORD')
        if len(legs) != len(order['legs']):
            raise OrderDenied('CHANGED_LEGS')
        broker_ids = set()
        for i, (leg, instruction) in enumerate(zip(legs, order['legs'])):
            if leg.position != i or leg.payload_digest != digest(instruction) or leg.client_reference != digest({'intent': row.id, 'leg': i}):
                raise OrderDenied('CHANGED_LEG')
            if type(leg.filled_quantity) is not int or not 0 <= leg.filled_quantity <= instruction['quantity']:
                raise OrderDenied('INVALID_FILL')
            safe_legs.append({**instruction, 'position': i, 'state': leg.state, 'filled_quantity': leg.filled_quantity})
            if leg.state in {'filled', 'partial', 'acknowledged', 'rejected'}:
                evidence = leg.reconciliation_json
                if not isinstance(evidence, dict) or evidence.get('simulation') is not True:
                    raise OrderDenied('FILL_EVIDENCE_REQUIRED')
                value = receipt(evidence.get('receipt'), instruction, leg.client_reference)
                if value['broker_order_id'] in broker_ids:raise OrderDenied('DUPLICATE_FILL_RECEIPT')
                broker_ids.add(value['broker_order_id'])
                if (value['state'], value['filled_quantity'], value['broker_order_id']) != (leg.state, leg.filled_quantity, leg.broker_order_id):
                    raise OrderDenied('FILL_EVIDENCE_CHANGED')
        if row.state == 'filled' and any(leg.state != 'filled' for leg in legs):
            raise OrderDenied('INCOMPLETE_BASKET')
        if row.state != 'draft':
            if not isinstance(row.risk_json, dict) or row.risk_json.get('allowed') is not True or digest({'request': row.request_digest, 'risk': row.risk_json}) != row.review_digest:
                raise OrderDenied('FROZEN_REVIEW_CHANGED')
        if row.state in {'approved', 'submitting', 'acknowledged', 'unknown', 'partial', 'filled', 'rejected'}:
            from .service import Orders
            if row.approval_digest != Orders(None).approval_hash(row):
                raise OrderDenied('APPROVAL_BINDING_CHANGED')
        notional = format(sum((Decimal(x['limit_price']) * x['quantity'] for x in order['legs']), Decimal(0)), '.2f')
    except (OrderDenied, TypeError, ValueError, KeyError, ArithmeticError):
        integrity = False
        safe_legs = []
        notional = None
        warnings.append('Stored instruction integrity is unavailable. Do not submit or retry this record.')
    if row.state in UNRESOLVED:
        warnings.append('Submission may have reached the broker. A timeout is not a safe failure; do not resubmit. Await reconciliation.')
    expires = stored_utc(row.expires_at) if row.expires_at else None
    stale = bool(expires and expires <= now)
    if stale:
        warnings.append('Approval expired. Any further financial instruction requires a fresh review and explicit confirmation.')
    warnings.append('Execution is disabled. This is recorded activity, not a live broker or positions reconciliation.')
    return {
        'id': row.id, 'state': row.state if integrity else 'unverified', 'module_id': row.module_id,
        'account_label': '••••' + str(row.account_id)[-2:] if row.account_id and len(str(row.account_id)) >= 4 else '••••',
        'connection_mode': row.app_mode, 'connection_version': row.connection_version,
        'created_at': stored_utc(row.created_at).isoformat(),
        'approved_at': stored_utc(row.approved_at).isoformat() if row.approved_at else None,
        'approval_expires_at': expires.isoformat() if expires else None,
        'approval_stale': stale, 'integrity_checked': integrity, 'legs': safe_legs,
        'estimated_gross_notional': notional, 'currency': 'INR',
        'notional_notice': 'Gross limit-price estimate; fees, taxes and actual fills may differ.',
        'warnings': warnings, 'unresolved': row.state in UNRESOLVED or not integrity,
        'actions': {'confirm': False, 'retry': False, 'resume': False, 'cancel': False, 'close_position': False},
    }


def owned_reviews(db, owner, *, intent_id=None, now=None, runtime=None):
    """At most 50 owner records, including module-disabled and unresolved history."""
    now = stored_utc(now or datetime.now(timezone.utc))
    query = select(OrderIntent).where(OrderIntent.owner_id == owner)
    if intent_id is not None:
        query = query.where(OrderIntent.id == intent_id)
    rows = list(db.scalars(query.order_by(case((OrderIntent.state.in_(UNRESOLVED), 0), else_=1), OrderIntent.created_at.desc(), OrderIntent.id).limit(51)))
    limited = len(rows) > 50
    rows = rows[:50]
    ids = [row.id for row in rows]
    by_id = {id: [] for id in ids}
    if ids:
        for leg in db.scalars(select(OrderLeg).where(OrderLeg.intent_id.in_(ids)).order_by(OrderLeg.position)):
            by_id[leg.intent_id].append(leg)
    views = []
    for row in rows:
        view = project(row, by_id[row.id], now)
        view['review_digest'] = None
        if runtime is not None and view['integrity_checked'] and row.state == 'awaiting_approval':
            from .service import Orders
            try:
                Orders(db, policy=runtime.policy, risk=runtime.risk).checked(owner, row.id, now)
                view['actions']['confirm'] = True
                view['review_digest'] = row.review_digest
                view['warnings'] = [w for w in view['warnings'] if not w.startswith('Execution is disabled.')]
                view['warnings'].append('Synthetic confirmation only. Current policy and risk are checked again at approval and dispatch.')
            except (OrderDenied, PermissionError):
                view['warnings'].append('Current account, module or risk conditions changed. Confirmation unavailable.')
        views.append(view)
    return {'schema_version': 1, 'owner_id': owner, 'runtime_enabled': runtime is not None,
            'simulation_only': True, 'observed_at': now.isoformat(), 'has_more': limited,
            'complete_positions_reconciliation': False,
            'intents': views}
