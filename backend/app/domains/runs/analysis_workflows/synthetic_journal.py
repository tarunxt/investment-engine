"""Immutable synthetic acquisitions across reconnects, using existing SQL only.

This topic is evidence, never a dispatch topic. Reads never acquire or backfill.
The source digest binds exact current connection identity/mode/version and bytes.
"""
from copy import deepcopy
from datetime import datetime, timezone
from uuid import UUID, uuid5
from sqlalchemy import func, select
from app.domains.connections.models import IntegrationConnection
from app.domains.modules.lifecycle import WorkIdentity
from app.infrastructure.database.outbox.models import OutboxMessage
from .acquisition import sane_capture
from .contracts import WorkflowDenied, digest, naive, utc
from .synthetic_sources import SimulationSourceScope
from .synthetic_price_history import build as build_price_history,validate_if_present as validate_price_history

TOPIC = 'uat2.synthetic_acquisition.v1'
NAMESPACE = UUID('f0650d82-4dcd-4e68-9093-57f5ef98af47')


def connection(db, owner, scope, now):
    scope.validate(db, owner)
    row = db.scalar(select(IntegrationConnection).where(IntegrationConnection.owner_id == owner,
        IntegrationConnection.provider == 'zerodha', IntegrationConnection.is_current.is_(True))
        .execution_options(populate_existing=True))
    if (row is None or row.credential_ref is not None or row.status != 'active'
            or row.token_expires_at is None or utc(row.token_expires_at) <= now
            or not (row.provider_account_id or '').startswith('FAKE')
            or row.app_ownership_mode not in {'user_owned', 'platform_managed'}):
        raise WorkflowDenied('Current credential-free fake connection required')
    return row


def binding(row):
    return {'id': row.id, 'version': row.version, 'account': row.provider_account_id,
        'mode': row.app_ownership_mode}


def validated(message, owner, current, now):
    payload = message.payload
    try:
        source = payload['source']
        raw = {k: v for k, v in source.items() if k != 'content_hash'}
        if (message.topic != TOPIC or payload['schema_version'] != 1 or payload['simulation_only'] is not True
                or payload['owner_id'] != owner or type(payload['sequence']) is not int or payload['sequence'] < 1
                or source['source_receipt_id'] != str(message.id) or source['owner_id'] != owner
                or source['portfolio'] != 'india' or source['snapshot_id'] is not None
                or source['connection'] != binding(current) or source['simulation_only'] is not True
                or source['content_hash'] != digest(raw) or payload['source_hash'] != digest(source)):
            raise WorkflowDenied('Synthetic acquisition integrity or binding mismatch')
        sane_capture(datetime.fromisoformat(source['captured_at']), now=now)
        validate_price_history(source)
        return deepcopy(source)
    except (KeyError, TypeError, ValueError, AttributeError):
        raise WorkflowDenied('Synthetic acquisition receipt invalid') from None


def proposed_source(owner, current, identifier, captured_at):
    source = {'owner_id': owner, 'portfolio': 'india', 'snapshot_id': None,
        'source_receipt_id': str(identifier), 'captured_at': utc(captured_at).isoformat(), 'currency': 'INR',
        'holdings': [{'exchange': 'NSE', 'tradingsymbol': 'SYNTHETIC0', 'quantity': 3,
            'last_price': '10.01', 'currency': 'INR'}], 'net_positions': [], 'day_positions': [],
        'connection': binding(current), 'simulation_only': True}
    source['price_history'] = build_price_history(source)
    source['content_hash'] = digest(source)
    return source


def acquire(db, owner, *, scope, authorize, key, now=None, reviewed_capture=None, expected_source_hash=None):
    if (type(scope) is not SimulationSourceScope or not callable(authorize) or type(key) is not str
            or not 8 <= len(key) <= 96 or not key.isascii() or not key.isprintable()):
        raise WorkflowDenied('Explicit synthetic acquisition scope and key required')
    now = utc(now or datetime.now(timezone.utc))
    if (reviewed_capture is None) != (expected_source_hash is None):
        raise WorkflowDenied('Reviewed source requires both capture and content identity')
    captured = now
    if reviewed_capture is not None:
        if not isinstance(reviewed_capture, datetime) or reviewed_capture.tzinfo is None:
            raise WorkflowDenied('Reviewed capture must be timezone-aware')
        captured = sane_capture(reviewed_capture, now=now)
    scope.validate(db, owner)
    identity = authorize(db, owner, 'india')  # canonical owner selection lock held through commit
    if (type(identity) is not WorkIdentity or identity.owner_id != owner
            or identity.module_id != 'zerodha_rebalance' or type(identity.version) is not int or identity.version < 1):
        raise WorkflowDenied('Current canonical source authorization required')
    current = connection(db, owner, scope, now)
    identifier = uuid5(NAMESPACE, str(owner) + ':' + key)
    prior = db.get(OutboxMessage, identifier)
    if prior is not None:
        if prior.topic != TOPIC: raise WorkflowDenied('Synthetic acquisition key conflict')
        result = validated(prior, owner, current, now)
        if expected_source_hash is not None and result['content_hash'] != expected_source_hash:
            raise WorkflowDenied('Existing acquisition differs from reviewed source')
        return result
    owned = (OutboxMessage.topic == TOPIC) & (OutboxMessage.payload['owner_id'].as_integer() == owner)
    count = db.scalar(select(func.count()).select_from(OutboxMessage).where(owned))
    if count >= 4096: raise WorkflowDenied('Synthetic acquisition history bound reached; reviewed retention required')
    sequence = (db.scalar(select(func.max(OutboxMessage.payload['sequence'].as_integer())).where(owned)) or 0) + 1
    source = proposed_source(owner, current, identifier, captured)
    if expected_source_hash is not None and source['content_hash'] != expected_source_hash:
        # Exact compatibility for a still-valid persisted proposal from before
        # the optional generated-study field existed. Never copy caller bytes,
        # change account/capture identity, or accept an arbitrary mismatched hash.
        prior={k:v for k,v in source.items() if k not in {'price_history','content_hash'}}
        prior['content_hash']=digest(prior)
        if prior['content_hash'] != expected_source_hash:
            raise WorkflowDenied('Current acquisition differs from reviewed source')
        source=prior
    message = OutboxMessage(id=identifier, topic=TOPIC, created_at=naive(now), payload={
        'schema_version': 1, 'simulation_only': True, 'owner_id': owner, 'sequence': sequence,
        'source': source, 'source_hash': digest(source)})
    db.add(message); db.flush()
    return validated(message, owner, current, now)


def latest(db, owner, *, scope, snapshot_id=None, now=None):
    if type(scope) is not SimulationSourceScope or snapshot_id is not None:
        raise WorkflowDenied('Journal source requires current owned receipt, not a legacy snapshot ID')
    now = utc(now or datetime.now(timezone.utc))
    current = connection(db, owner, scope, now)
    message = db.scalar(select(OutboxMessage).where(OutboxMessage.topic == TOPIC,
        OutboxMessage.payload['owner_id'].as_integer() == owner)
        .order_by(OutboxMessage.payload['sequence'].as_integer().desc()).limit(1)
        .execution_options(populate_existing=True))
    if message is None: raise WorkflowDenied('Explicit synthetic acquisition required')
    return validated(message, owner, current, now)
