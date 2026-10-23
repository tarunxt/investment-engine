"""Network-denied disposable composition; never imported by the real app.

Completed synthetic analysis prepares reviews but never approves them. Actual
Orders guards, HTTP confirmation and Stage15 durable fake execution are reused.
"""
import os
import logging
if os.environ.get('STAGE01_PREVIEW') != 'synthetic-only':
    raise RuntimeError('Local synthetic preview only')
from datetime import datetime, timezone, timedelta
from types import SimpleNamespace
from sqlalchemy import select
from app.domains.ai_limits.contracts import BoundaryDenied
from app.domains.modules.lifecycle import current_sync, WorkIdentity
from app.domains.modules.policy import ModuleFacts
from app.domains.order_intents.models import OrderIntent, OrderLeg
from app.domains.order_intents.service import Orders, MODULE, TOPIC
from scripts.public_launch import preview_execution
from app.domains.order_intents.contracts import digest, OrderDenied
from app.domains.order_intents.router import router, get_runtime, get_read_runtime
from app.domains.zerodha.models import ZerodhaPortfolioSnapshot
from app.infrastructure.database.outbox.models import OutboxMessage
TABLES = (OrderIntent.__table__, OrderLeg.__table__, ZerodhaPortfolioSnapshot.__table__, *preview_execution.TABLES)


def policy(db, identity):
    current_sync(db, identity, capability='execute', boundary='side_effect', facts=ModuleFacts(
        jurisdiction='allowed', plan='allowed', connection='ready', execution_capability=True, action_confirmed=True))


def risk(db, identity, order, connection, now):
    return {'allowed': True, 'synthetic': True, 'owner': identity.owner_id,
            'account': connection.provider_account_id, 'payload_hash': digest(order), 'max_order_quantity': 1000000}

runtime = SimpleNamespace(policy=policy, risk=risk)


def allowed(method, path):
    # No HTTP create, change, cancel, close, force-fill or activation endpoint.
    return (method == 'GET' and (path in {'/order-intents/reviews','/order-intents/positions'} or path.startswith('/order-intents/reviews/'))
            or method == 'POST' and path.startswith('/order-intents/') and path.endswith('/approve'))


def install(app):
    app.dependency_overrides[get_runtime] = lambda: runtime
    app.dependency_overrides[get_read_runtime] = lambda: runtime
    app.include_router(router)


async def seed(db, users):
    def work(session):
        now = datetime.now(timezone.utc)
        for user in users:
            if user.username not in {'usera', 'userb'}:
                continue
            from scripts.public_launch.preview_stage12 import synthetic_acquire
            try:
                synthetic_acquire(session, user.id, now=now)
                session.commit()
            except PermissionError:
                session.rollback()
                logging.getLogger(__name__).warning('Synthetic acquisition unavailable for owner %s; existing evidence preserved', user.id)
            # No instructions or outcomes are seeded. Completed, governed
            # analysis may prepare a review below; only HTTP exact confirmation
            # can approve it. Existing selections are never enabled here.
        session.commit()
    await db.run_sync(work)
    await db.commit()


def prepare_analysis(session, owner, workflow_id, *, now=None):
    """Completed advisory analysis prepares an immutable review, never consent.

    Only the explicit synthetic cash-equity trim subset is convertible. A model
    cannot choose a venue, mode, account, market order, price or execution time.
    """
    from decimal import Decimal
    from scripts.public_launch.preview_stage12 import completed_analysis
    evidence = completed_analysis(session, owner, workflow_id, now=now)
    if evidence['module_id'] != MODULE or evidence['orders_authorized'] is not False:
        raise OrderDenied('SYNTHETIC_INDIA_ANALYSIS_REQUIRED')
    source = evidence['source']
    connection = source['connection']
    legs = []
    for item in evidence['recommendations']:
        if item['action'] == 'hold':
            continue
        if item['instrument'] != 'NSE:SYNTHETIC0' or item['action'] != 'trim':
            raise OrderDenied('SYNTHETIC_TRIM_SUBSET_REQUIRED')
        quantity = Decimal(item['current_units']) - Decimal(item['final_units'])
        if not quantity.is_finite() or quantity <= 0 or quantity != quantity.to_integral_value():
            raise OrderDenied('EXACT_SYNTHETIC_QUANTITY_REQUIRED')
        # This fixed synthetic catalogue price is not a provider quote or a
        # model-supplied instruction. Stage15 independently reads fake risk.
        legs.append(dict(exchange='NSE', symbol='SYNTHETIC0', side='SELL',
                         quantity=int(quantity), limit_price='10.01', product='CNC', order_type='LIMIT'))
    if not legs:
        return None
    provenance = {key: evidence[key] for key in ('workflow_id', 'owner_id', 'module_version', 'source_hash', 'plan_hash', 'actionables_result_hash')}
    key = 'linked-analysis:' + digest(provenance)
    service = Orders(session, policy=policy, risk=risk)
    old = session.scalar(select(OrderIntent).where(OrderIntent.owner_id == owner,
        OrderIntent.operation_key_digest == digest({'operation': 'confirmed_order', 'key': key})))
    if old is not None:
        return old  # terminal/canceled records are never recreated or reopened
    row = service.create(WorkIdentity(owner, MODULE, evidence['module_version']), key,
                         connection['id'], {'sequencing': 'listed', 'legs': legs}, now=now)
    if (row.connection_version, row.account_id, row.app_mode) != (connection['version'], connection['account'], connection['mode']):
        raise OrderDenied('ANALYSIS_CONNECTION_CHANGED')
    service.validate(owner, row.id, now=now)
    service.review(owner, row.id, now=now)
    return row


def prepare_completed(session):
    from app.domains.runs.models import AutoRebalanceWorkflow
    for flow in session.scalars(select(AutoRebalanceWorkflow).where(
            AutoRebalanceWorkflow.status == 'completed',
            AutoRebalanceWorkflow.portfolio == 'india',
            AutoRebalanceWorkflow.orchestration_kind == 'analysis_v1')):
        try:
            prepare_analysis(session, flow.user_id, flow.id)
            session.commit()
        except (OrderDenied, BoundaryDenied, PermissionError):
            session.rollback()
            logging.getLogger(__name__).warning('Completed synthetic analysis cannot prepare a review: %s', flow.id)


def reconcile_one(session, *, engine=None, now=None):
    """Bounded read-only recovery; never resumes remaining basket legs."""
    from app.domains.order_intents.execution_models import ExecutionRun, ExecutionAttempt
    now = now or datetime.now(timezone.utc)
    ids = list(session.scalars(select(OrderIntent.id).join(ExecutionRun).join(ExecutionAttempt,
        ExecutionAttempt.intent_id == OrderIntent.id).where(
        OrderIntent.state.in_(['submitting', 'unknown', 'partial', 'acknowledged']),
        ExecutionAttempt.polls < 5, ExecutionAttempt.next_poll_at <= now,
        ExecutionAttempt.claimed_at >= now - timedelta(minutes=10)
    ).order_by(ExecutionAttempt.next_poll_at)))
    for intent_id in dict.fromkeys(ids):
        row = session.get(OrderIntent, intent_id, populate_existing=True)
        runner = preview_execution.worker(session, row, policy=policy, risk=risk, engine=engine, now=now)
        try:
            return runner.reconcile(row.owner_id, row.id)
        except (OrderDenied, PermissionError):
            session.rollback()
            logging.getLogger(__name__).warning('Synthetic reconciliation is blocked: %s', intent_id)
    return None


def advance(session, *, engine=None, now=None, outcomes=None):
    # A stale approval is not running work and must not starve another owner.
    # Do not rewrite it as cancelled or refresh its approval behind the user.
    candidates = list(session.scalars(select(OrderIntent.id).where(
        OrderIntent.state == 'approved').order_by(OrderIntent.created_at, OrderIntent.id)))
    for intent_id in candidates:
        row = session.get(OrderIntent, intent_id, populate_existing=True)
        event = session.scalar(select(OutboxMessage).where(OutboxMessage.topic == TOPIC,
            OutboxMessage.payload['intent_id'].as_string() == row.id))
        if event is None:
            logging.getLogger(__name__).warning('Synthetic approval has no dispatch receipt: %s', intent_id)
            continue
        selected_outcomes = outcomes
        if selected_outcomes is None:
            fault = os.environ.get('STAGE01_EXECUTION_FAULT', 'filled')
            if fault not in {'filled', 'partial', 'after_acceptance'}:
                raise OrderDenied('INVALID_SYNTHETIC_OUTCOME')
            selected_outcomes = [fault]
        runner = preview_execution.worker(session, row, policy=policy, risk=risk,
                                          outcomes=selected_outcomes, engine=engine, now=now)
        try:
            runner.dispatch(event.id)
        except TimeoutError:
            # Stage15 committed unknown evidence; never retry submission here.
            pass
        except (OrderDenied, PermissionError):
            session.rollback()
            logging.getLogger(__name__).info('Synthetic approved intent is currently blocked: %s', intent_id)
            continue
        return intent_id
    return None


async def tick(db):
    try:
        await db.run_sync(prepare_completed)
        await db.run_sync(reconcile_one)
        await db.run_sync(advance)
        await db.commit()
    except (OrderDenied, PermissionError):
        await db.rollback()
