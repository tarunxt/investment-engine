"""Explicit local Stage15 composition. Never imported by a deployed runtime.

The venue is a separate durable disposable SQLite store. No broker SDK, network,
credentials, automatic approval or implicit reconciliation-to-submission exists.
"""
import os
from datetime import datetime, timezone
from pathlib import Path
from sqlalchemy import create_engine
from app.domains.order_intents.execution import ExecutionWorker, venue_binding
from app.domains.order_intents.execution_fake import VenueBase, ExecutionBrokerFake, MarketDataFake
from app.domains.order_intents.execution_models import ExecutionFence, ExecutionRun, ExecutionAttempt
from app.domains.order_intents.service import Orders

if os.environ.get('STAGE01_PREVIEW') != 'synthetic-only':
    raise RuntimeError('Local synthetic preview only')

TABLES = tuple(m.__table__ for m in (ExecutionFence, ExecutionRun, ExecutionAttempt))
ROOT = Path(__file__).resolve().parents[2]
VENUE_PATH = ROOT / '.runtime/stage01-preview/execution-venue.sqlite3'
_venue = None


def venue():
    global _venue
    if _venue is None:
        VENUE_PATH.parent.mkdir(parents=True, exist_ok=True)
        _venue = create_engine('sqlite:///' + str(VENUE_PATH))
        VenueBase.metadata.create_all(_venue)
    return _venue


def close():
    global _venue
    if _venue is not None:
        _venue.dispose()
        _venue = None


def market(row, now):
    """Explicit fake authoritative observation, not a user price fallback."""
    return MarketDataFake(dict(
        owner_id=row.owner_id, account_id=row.account_id, connection_id=row.connection_id,
        connection_version=row.connection_version, app_mode=row.app_mode,
        source='synthetic_authoritative', as_of=now, funds='100000.00', exposure='0.00',
        instruments={leg['exchange'] + ':' + leg['symbol']: dict(
            tradable=True, market_open=True, product='CNC', quote=leg['limit_price'],
            tick='0.01', lot=1, lower='1.00', upper='100000.00', holdings=100)
            for leg in row.payload_json['legs']}))


def worker(session, row, *, policy, risk, outcomes=(), engine=None, now=None):
    now = now or datetime.now(timezone.utc)
    orders = Orders(session, policy=policy, risk=risk, clock=lambda: now)
    broker = ExecutionBrokerFake(engine if engine is not None else venue(), venue_binding(row), outcomes)
    return ExecutionWorker(orders, broker, market(row, now))
