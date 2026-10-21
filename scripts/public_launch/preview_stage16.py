"""Network-denied disposable composition; never imported by the real app.

Public fixture approvals/history are synthetic, not live acceptance. Actual
Orders guards and HTTP confirmation handlers are reused without a broker SDK.
"""
import os
if os.environ.get('STAGE01_PREVIEW') != 'synthetic-only':
    raise RuntimeError('Local synthetic preview only')
from datetime import datetime, timezone
from types import SimpleNamespace
from sqlalchemy import select
from app.domains.connections.models import IntegrationConnection
from app.domains.modules.models import UserModule, UserModulePreferences
from app.domains.modules.lifecycle import current_sync, WorkIdentity
from app.domains.modules.policy import ModuleFacts
from app.domains.order_intents.models import OrderIntent, OrderLeg
from app.domains.order_intents.service import Orders, MODULE, TOPIC
from app.domains.order_intents.fake import FakeBroker
from app.domains.order_intents.contracts import digest, OrderDenied
from app.domains.order_intents.authority import authenticated_confirmation
from app.domains.order_intents.router import router, get_runtime, get_read_runtime
from app.domains.zerodha.models import ZerodhaPortfolioSnapshot
from app.infrastructure.database.outbox.models import OutboxMessage
TABLES = (OrderIntent.__table__, OrderLeg.__table__, ZerodhaPortfolioSnapshot.__table__)


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
            # Private disposable observations only. The production snapshot
            # schema/migrations and provider acquisition remain untouched.
            snapshot = session.scalar(select(ZerodhaPortfolioSnapshot.id).where(
                ZerodhaPortfolioSnapshot.user_id == user.id,
                ZerodhaPortfolioSnapshot.snapshot_date == now.date()))
            if snapshot is None:
                session.add(ZerodhaPortfolioSnapshot(
                    user_id=user.id, snapshot_date=now.date(), captured_at=now,
                    source='stage16_synthetic',
                    holdings=[{'tradingsymbol':'SYNTHETIC_'+user.username.upper(), 'quantity':3}],
                    net_positions=[{'tradingsymbol':'SYNTHETIC_SHORT_'+user.username.upper(), 'quantity':-1}],
                    day_positions=[]))
            if session.scalar(select(OrderIntent.id).where(OrderIntent.owner_id == user.id).limit(1)):
                continue
            header = session.get(UserModulePreferences, user.id)
            if not header:
                header = UserModulePreferences(user_id=user.id, version=1)
                session.add(header)
            header.version = max(1, header.version)
            session.flush()
            module = session.scalar(select(UserModule).where(UserModule.user_id == user.id, UserModule.module_id == MODULE))
            if not module:
                module = UserModule(user_id=user.id, module_id=MODULE, enabled=True, version=header.version, config={})
                session.add(module)
            module.enabled = True
            module.version = header.version
            session.flush()
            connection = session.scalar(select(IntegrationConnection).where(IntegrationConnection.owner_id == user.id, IntegrationConnection.is_current.is_(True)))
            service = Orders(session, policy=policy, risk=risk)
            for state in ('review', 'unknown', 'partial'):
                order = {'sequencing': 'listed', 'legs': [dict(exchange='NSE', symbol='SYNTHETIC'+str(i), side='BUY' if i else 'SELL', quantity=3, limit_price='10.01', product='CNC', order_type='LIMIT') for i in range(2)]}
                row = service.create(WorkIdentity(user.id, MODULE, module.version), 'stage16-'+state, connection.id, order, now=now)
                service.validate(user.id, row.id, now=now)
                review = service.review(user.id, row.id, now=now)
                if state != 'review':
                    with authenticated_confirmation(user, row.id, review['review_digest']):
                        service.approve(user.id, row.id, review['review_digest'], action='confirm_exact_order_or_basket', now=now)
                    session.commit()
                    event = session.scalar(select(OutboxMessage).where(OutboxMessage.topic == TOPIC, OutboxMessage.payload['intent_id'].as_string() == row.id))
                    try:service.dispatch(event.id, FakeBroker(['timeout' if state == 'unknown' else 'partial']), now=now)
                    except TimeoutError:pass
            if user.username == 'userb':module.enabled = False
        session.commit()
    await db.run_sync(work)
    await db.commit()


async def tick(db):
    def advance(session):
        row = session.scalar(select(OrderIntent).where(OrderIntent.state == 'approved').order_by(OrderIntent.created_at).limit(1))
        if row:
            event = session.scalar(select(OutboxMessage).where(OutboxMessage.topic == TOPIC, OutboxMessage.payload['intent_id'].as_string() == row.id))
            try:Orders(session, policy=policy, risk=risk).dispatch(event.id, FakeBroker(['filled', 'rejected']))
            except (OrderDenied, PermissionError):session.rollback()
    await db.run_sync(advance)
    await db.commit()
