"""A durable, private synthetic venue in a separate disposable SQLAlchemy DB.

The caller creates VenueBase metadata explicitly. No URLs, SDKs, credentials,
network, sleeps, runtime registry or live fallback exist in this adapter.
"""
from copy import deepcopy
from sqlalchemy import String, JSON, select
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, Session
from .contracts import digest, OrderDenied


class VenueBase(DeclarativeBase):
    pass


class FakeVenueOrder(VenueBase):
    __tablename__ = 'synthetic_venue_orders'
    reference: Mapped[str] = mapped_column(String(64), primary_key=True)
    binding: Mapped[str] = mapped_column(String(64), nullable=False)
    receipt: Mapped[dict] = mapped_column(JSON, nullable=False)
    trades: Mapped[list] = mapped_column(JSON, nullable=False, default=list)


class ExecutionBrokerFake:
    def __init__(self, engine, binding, outcomes=()):
        if engine.dialect.name != 'sqlite':
            raise OrderDenied('ISOLATED_SQLITE_FAKE_VENUE_REQUIRED')
        self.engine, self.binding = engine, binding
        self.outcomes = list(outcomes)
        self.calls = []
        self.read_fault = None

    def submit(self, leg, reference, binding):
        if binding != self.binding:
            raise OrderDenied('FAKE_ACCOUNT_BINDING_MISMATCH')
        with Session(self.engine) as db:
            if db.get(FakeVenueOrder, reference):
                raise OrderDenied('NO_SUBMISSION_REPLAY')
            self.calls.append(reference)
            outcome = self.outcomes.pop(0) if self.outcomes else 'filled'
            if outcome in {'before_acceptance', 'rate_limit'}:
                raise TimeoutError('Synthetic pre-acceptance uncertainty')
            state = 'filled' if outcome == 'after_acceptance' else outcome
            if state not in {'filled', 'partial', 'acknowledged', 'rejected'}:
                raise OrderDenied('INVALID_SYNTHETIC_OUTCOME')
            quantity = leg['quantity'] if state == 'filled' else (1 if state == 'partial' else 0)
            receipt = dict(state=state, broker_order_id='fake-' + reference,
                           filled_quantity=quantity, client_reference=reference,
                           payload_digest=digest(leg))
            trades = [dict(trade_id='trade-'+reference, broker_order_id=receipt['broker_order_id'],
                           client_reference=reference, payload_digest=digest(leg), quantity=quantity)] if quantity else []
            db.add(FakeVenueOrder(reference=reference, binding=binding, receipt=receipt, trades=trades))
            db.commit()
            if outcome == 'after_acceptance':
                raise TimeoutError('Synthetic acceptance followed by lost response')
            return deepcopy(receipt)

    def reconcile(self, reference, binding):
        if binding != self.binding:
            raise OrderDenied('FAKE_ACCOUNT_BINDING_MISMATCH')
        if self.read_fault == 'timeout':
            raise TimeoutError('Synthetic read timeout')
        if self.read_fault == 'ambiguous':
            return {'matches': [], 'trades': [], 'ambiguous': True}
        with Session(self.engine) as db:
            row = db.scalar(select(FakeVenueOrder).where(FakeVenueOrder.reference == reference))
            if row and row.binding != binding:
                raise OrderDenied('FAKE_ACCOUNT_BINDING_MISMATCH')
            return {'matches': [deepcopy(row.receipt)] if row else [], 'trades': deepcopy(row.trades) if row else [], 'ambiguous': False}


class MarketDataFake:
    """Explicit fake-only authoritative snapshot; never a request fallback price."""
    def __init__(self, snapshot):
        self.snapshot = deepcopy(snapshot)

    def read(self):
        return deepcopy(self.snapshot)
