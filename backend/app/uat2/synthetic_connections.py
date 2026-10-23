"""Keyless fake connections over existing SQL models; no provider adapters.

Caller owns commit/rollback and installs the explicit session scope. Reconnects
retain old rows for reconciliation and never copy, fetch or erase credentials.
"""
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4, uuid5
from sqlalchemy import select
from app.domains.connections.models import IntegrationConnection
from app.domains.modules.lifecycle import sync_owner_fence
from app.domains.runs.analysis_workflows.contracts import WorkflowDenied, digest
from app.infrastructure.database.outbox.models import OutboxMessage
from app.uat2.policy_bindings import binding_for

TOPIC = 'uat2.synthetic_connection.v1'
NAMESPACE = UUID('f9f7f631-ed1f-41e3-a9ce-c41352dcaa0f')


def describe(row):
    return {'id': row.id, 'owner_id': row.owner_id, 'mode': row.app_ownership_mode,
        'version': row.version, 'is_current': row.is_current, 'status': row.status,
        'simulation_only': True, 'credential_storage': 'none',
        'provider_approval_verified': False, 'financial_execution_granted': False}


def connect(db, owner, *, mode, key, expected_id=None, expected_version=None, now=None):
    if (type(mode) is not str or mode not in {'user_owned', 'platform_managed'} or type(key) is not str
            or not 8 <= len(key) <= 96 or not key.isascii() or not key.isprintable()
            or (expected_id is None) != (expected_version is None)
            or expected_version is not None and (type(expected_version) is not int or expected_version < 1)):
        raise WorkflowDenied('Typed synthetic connection request required')
    if expected_id is not None:
        try: UUID(expected_id)
        except (ValueError, TypeError, AttributeError): raise WorkflowDenied('Expected connection identity required') from None
    now = now or datetime.now(timezone.utc)
    if not isinstance(now, datetime) or now.tzinfo is None:
        raise WorkflowDenied('Aware server clock required')
    binding = binding_for(db)
    if binding is None: raise WorkflowDenied('Explicit simulation session required')
    binding.scope.validate(db, owner)
    sync_owner_fence(db, owner)
    request = {'owner_id': owner, 'mode': mode, 'expected_id': expected_id, 'expected_version': expected_version}
    identifier = uuid5(NAMESPACE, str(owner) + ':' + key)
    previous = db.get(OutboxMessage, identifier)
    if previous is not None:
        payload = previous.payload
        if (previous.topic != TOPIC or type(payload) is not dict or payload.get('request_hash') != digest(request)
                or payload.get('owner_id') != owner):
            raise WorkflowDenied('Synthetic connection key conflict')
        row = db.scalar(select(IntegrationConnection).where(IntegrationConnection.id == payload.get('connection_id'),
            IntegrationConnection.owner_id == owner))
        if (row is None or row.credential_ref is not None or row.provider_account_id != payload.get('account')
                or row.app_ownership_mode != payload.get('mode') or row.version != payload.get('version')):
            raise WorkflowDenied('Synthetic connection receipt mismatch')
        return row
    current = db.scalar(select(IntegrationConnection).where(IntegrationConnection.owner_id == owner,
        IntegrationConnection.provider == 'zerodha', IntegrationConnection.is_current.is_(True))
        .execution_options(populate_existing=True))
    if current is None:
        if expected_id is not None: raise WorkflowDenied('Current connection changed')
    else:
        if current.id != expected_id or current.version != expected_version:
            raise WorkflowDenied('Current connection changed')
        # Explicitly refuse real, legacy, or preview-private credential bindings.
        if current.credential_ref is not None or not (current.provider_account_id or '').startswith('FAKE'):
            raise WorkflowDenied('Existing connection requires separate reviewed migration')
        current.is_current = False
        db.flush()  # release the existing one-current index before replacement
    row = IntegrationConnection(id=str(uuid4()), owner_id=owner, provider='zerodha',
        app_ownership_mode=mode, provider_account_id='FAKE_UAT2_OWNER_' + str(owner), credential_ref=None,
        token_expires_at=now + timedelta(hours=1), status='active', version=1, is_current=True)
    db.add(row); db.flush()
    db.add(OutboxMessage(id=identifier, topic=TOPIC, payload={'schema_version': 1, 'simulation_only': True,
        'owner_id': owner, 'request_hash': digest(request), 'connection_id': row.id,
        'account': row.provider_account_id, 'mode': mode, 'version': row.version,
        'prior_connection_id': expected_id, 'created_at': now.astimezone(timezone.utc).isoformat()}))
    db.flush()
    return row
