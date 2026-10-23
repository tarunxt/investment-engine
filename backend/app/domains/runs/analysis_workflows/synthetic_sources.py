"""Shared synthetic acquisition service; no provider or credential adapters.

An explicit caller-owned scope and current module authorization are mandatory.
The hosted scope validates the existing dedicated UAT2 database and owner. The
preview scope remains confined to its existing disposable SQLite files. Merely
importing this module registers no runtime, route, worker or schedule.
"""
from dataclasses import dataclass
from datetime import datetime, timezone
import os
from pathlib import Path
import re
import tempfile

from sqlalchemy import func, select
from app.domains.auth.models import User
from app.domains.connections.models import IntegrationConnection
from app.domains.modules.lifecycle import WorkIdentity
from app.domains.zerodha.models import ZerodhaPortfolioSnapshot
from .acquisition import acquisition_payload, validate_acquisition
from .contracts import WorkflowDenied, digest, utc


@dataclass(frozen=True)
class SimulationSourceScope:
    mode: str

    def validate(self, db, owner):
        if type(owner) is not int or owner < 1:
            raise WorkflowDenied('Explicit synthetic owner required')
        url = db.get_bind().url
        if self.mode == 'preview':
            if (os.getenv('ENVIRONMENT') != 'test' or os.getenv('STAGE01_PREVIEW') != 'synthetic-only'
                    or url.get_backend_name() != 'sqlite' or not url.database or url.database == ':memory:'):
                raise WorkflowDenied('Disposable synthetic source scope required')
            path = Path(url.database).resolve()
            fixture = (Path(tempfile.gettempdir()).resolve() in path.parents
                and any(re.fullmatch('pytest-of-[^/]+', part) for part in path.parts))
            root = Path(__file__).resolve().parents[5]
            if not fixture and path != root / '.runtime/stage01-preview/preview.sqlite3':
                raise WorkflowDenied('Disposable synthetic source scope required')
        elif self.mode == 'hosted':
            from app.core.uat2 import uat2_mode, validate_uat2_startup
            if not uat2_mode() or os.getenv('ENVIRONMENT') != 'uat2' or url.get_backend_name() != 'postgresql':
                raise WorkflowDenied('Dedicated owner-only UAT2 scope required')
            try: validate_uat2_startup()
            except RuntimeError: raise WorkflowDenied('Dedicated owner-only UAT2 scope required') from None
            native = os.getenv('UAT2_RUNTIME', 'compose') == 'native'
            expected = ('127.0.0.1', 5542) if native else ('postgres', 5432)
            if ((url.host, url.port or 5432) != expected
                    or url.database != 'credx_uat2' or url.username != 'credx_uat2'
                    or db.execute(select(func.current_database(), func.current_user(), func.current_schema())).one()
                       != ('credx_uat2', 'credx_uat2', 'public')):
                raise WorkflowDenied('Dedicated owner-only UAT2 database required')
        else:
            raise WorkflowDenied('Known synthetic source scope required')
        user = db.scalar(select(User).where(User.id == owner).execution_options(populate_existing=True))
        if user is None or user.is_active is not True or user.is_verified is not True:
            raise WorkflowDenied('Verified active synthetic owner required')
        if self.mode == 'hosted':
            from app.core.uat2 import OWNER_EMAIL
            if user.email != OWNER_EMAIL: raise WorkflowDenied('UAT2 owner required')
        elif user.email not in {'usera@stage01.example.com', 'userb@stage01.example.com'}:
            raise WorkflowDenied('Disposable fixture owner required')


def acquire(db, owner, *, scope, authorize, now=None):
    """Create provenance for the fixed fixture only; never bless legacy rows.

    authorize is the server-owned canonical module/lifecycle policy callback.
    It must keep the selection fence through the caller's transaction. No
    request parameter can supply this callback, scope or fake instrument data.
    """
    if type(scope) is not SimulationSourceScope or not callable(authorize):
        raise WorkflowDenied('Explicit synthetic source scope required')
    scope.validate(db, owner)
    identity = authorize(db, owner, 'india')
    if (type(identity) is not WorkIdentity or identity.owner_id != owner
            or identity.module_id != 'zerodha_rebalance' or type(identity.version) is not int or identity.version < 1):
        raise WorkflowDenied('Current canonical module authorization required')
    now = utc(now or datetime.now(timezone.utc))
    connection = db.scalar(select(IntegrationConnection).where(
        IntegrationConnection.owner_id == owner, IntegrationConnection.provider == 'zerodha',
        IntegrationConnection.is_current.is_(True)).execution_options(populate_existing=True))
    if (connection is None or connection.status != 'active' or not connection.token_expires_at
            or utc(connection.token_expires_at) <= now or connection.credential_ref is not None
            or connection.app_ownership_mode not in {'user_owned', 'platform_managed'}
            or not (connection.provider_account_id or '').startswith('FAKE')):
        raise WorkflowDenied('Current credential-free synthetic connection required')
    existing = db.scalar(select(ZerodhaPortfolioSnapshot).where(
        ZerodhaPortfolioSnapshot.user_id == owner, ZerodhaPortfolioSnapshot.snapshot_date == now.date()))
    if existing is not None:
        if not isinstance(existing.acquisition_json, dict) or existing.acquisition_json.get('simulation') is not True:
            raise WorkflowDenied('Existing snapshot cannot be relabelled as synthetic acquisition')
        validate_acquisition(existing, connection, owner, now=now)
        return existing
    snapshot = ZerodhaPortfolioSnapshot(
        user_id=owner, snapshot_date=now.date(), captured_at=now, source='connection_sync',
        holdings_count=1, holdings_market_value=30.03, holdings_invested_value=30.03,
        holdings=[{'exchange': 'NSE', 'tradingsymbol': 'SYNTHETIC0', 'quantity': 3,
                   'last_price': '10.01', 'currency': 'INR'}], net_positions=[], day_positions=[])
    db.add(snapshot); db.flush()
    snapshot.acquisition_json = {
        'schema_version': 1, 'kind': 'connection_acquisition_v1', 'simulation': True,
        'owner_id': owner, 'snapshot_id': snapshot.id, 'connection_id': connection.id,
        'connection_version': connection.version, 'provider': 'zerodha',
        'provider_account_id': connection.provider_account_id, 'app_mode': connection.app_ownership_mode,
        'captured_at': utc(snapshot.captured_at).isoformat(), 'content_hash': digest(acquisition_payload(snapshot))}
    db.flush()
    return snapshot
