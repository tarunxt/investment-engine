"""Existing network-denied preview delegates to scoped application services."""
import os
import re
from app.domains.modules.policy import ModuleFacts
from app.domains.runs.analysis_router import router, optional_analysis_runtime
from app.domains.runs.analysis_workflows.runtime import policy
from app.domains.runs.analysis_workflows.synthetic_composition import SyntheticAnalysis, CATALOGUE
from app.domains.runs.analysis_workflows.synthetic_sources import acquire, SimulationSourceScope
from app.domains.recommendation_audit.models import SpendAccount, SpendAttempt
from app.domains.zerodha.models import ZerodhaPortfolioSnapshot

if os.environ.get('STAGE01_PREVIEW') != 'synthetic-only':
    raise RuntimeError('Local synthetic preview only')

TABLES = (SpendAccount.__table__, SpendAttempt.__table__, ZerodhaPortfolioSnapshot.__table__)
FACTS = ModuleFacts(jurisdiction='allowed', plan='allowed', connection='not_required')
def fixture_material(db, connection):
    """Verify exact existing disposable material, never a real-secret fallback."""
    from uuid import UUID
    from app.domains.auth.models import User
    from app.domains.connections.models import ConnectionCredential
    from app.domains.connections.service import validate_claims
    from app.domains.connections.crypto import ConnectionFault
    try:
        if str(UUID(connection.credential_ref)) != connection.credential_ref: return False
        from scripts.public_launch.preview_stage09 import ring
        user = db.get(User, connection.owner_id)
        if user.username not in {'usera', 'userb'}: return False
        secret = db.get(ConnectionCredential, connection.credential_ref)
        if secret is None or secret.owner_id != connection.owner_id or secret.connection_id != connection.id: return False
        value = ring.open(secret.ciphertext, secret.key_version)
        validate_claims(connection, value)
        if value.get('token') != 'synthetic-token-' + user.username: return False
        if connection.app_ownership_mode == 'user_owned':
            return (value.get('app_key') == 'synthetic-key-' + user.username
                and value.get('app_secret') == 'synthetic-secret-' + user.username)
        return value.get('platform_ref') == 'synthetic-approved-platform'
    except (ValueError, TypeError, ConnectionFault): return False

scope = SimulationSourceScope('preview', fixture_material=fixture_material)
analysis = SyntheticAnalysis(scope=scope,
    policy=lambda db, owner, portfolio, **kwargs: policy(db, owner, portfolio, facts=FACTS, **kwargs))
runtime, governance = analysis.runtime, analysis.governance
source, plan = analysis.source, analysis.plan
recommendation_source, fake_provider = analysis.recommendation_source, analysis.fake_provider
publish_governed_job, completed_analysis, advance = analysis.publish_governed_job, analysis.completed_analysis, analysis.advance


def synthetic_acquire(db, owner, *, now=None):
    return acquire(db, owner, scope=scope, authorize=runtime.policy, now=now)


def allowed(method, path):
    return (method == 'POST' and path in {'/runs/analysis-workflows/synthetic-source','/runs/analysis-workflows/candidate-preview'}
            or method == 'GET' and re.fullmatch(r'/runs/analysis-workflows(?:/config|/setup-context|/[1-9][0-9]*)?', path) is not None
            or method == 'POST' and re.fullmatch(r'/runs/analysis-workflows(?:/[1-9][0-9]*/controls)?', path) is not None)


def install(app):
    app.dependency_overrides[optional_analysis_runtime] = lambda: runtime
    app.include_router(router)


async def tick(db):
    await db.run_sync(advance)
    await db.commit()
