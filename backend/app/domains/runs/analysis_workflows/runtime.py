"""Default closed composition. A flag/request can never activate a provider."""
from copy import deepcopy
from datetime import datetime,timezone,timedelta
from sqlalchemy import select
from app.domains.modules.lifecycle import sync_owner_fence,current_sync,WorkIdentity,analysis_module,ModuleLifecycleDenied
from app.domains.modules.models import UserModule
from app.domains.connections.models import IntegrationConnection
from app.domains.indmoney_us.models import IndMoneyUsPortfolioSnapshot
from app.domains.indmoney_us.repository import accepted_snapshot_predicate
from app.domains.indmoney_us.import_validation import require_recommendation_snapshot
from app.domains.zerodha.models import ZerodhaPortfolioSnapshot
from .contracts import WorkflowDenied,utc,digest

# No public API registers runtimes. Current application/UAT2 composition remains
# unavailable until a separately reviewed plan/calendar/entitlement binding exists.
_registered=None

def configured_runtime():return _registered

def policy(db,owner,portfolio,*,version=None,scheduled=False,facts=None):
    try:
        sync_owner_fence(db,owner)
        module=analysis_module(portfolio)
        row=db.scalar(select(UserModule).where(UserModule.user_id==owner,UserModule.module_id==module).execution_options(populate_existing=True))
        if row is None:raise WorkflowDenied('Module not selected')
        expected=row.version if version is None else version
        current_sync(db,WorkIdentity(owner,module,expected),scheduled=scheduled,facts=facts)
        return WorkIdentity(owner,module,expected)
    except ModuleLifecycleDenied:raise WorkflowDenied('Current policy or token unavailable') from None


def owned_source(db,owner,portfolio,snapshot_id=None):
    if portfolio=='indmoney_us':
        snapshot=db.scalar(select(IndMoneyUsPortfolioSnapshot).where(IndMoneyUsPortfolioSnapshot.user_id==owner,accepted_snapshot_predicate()).order_by(IndMoneyUsPortfolioSnapshot.captured_at.desc(),IndMoneyUsPortfolioSnapshot.id.desc()).limit(1).execution_options(populate_existing=True))
        if snapshot is None or snapshot_id is not None and snapshot.id!=snapshot_id:raise WorkflowDenied('Current accepted portfolio required')
        try:require_recommendation_snapshot(snapshot)
        except Exception:raise WorkflowDenied('Accepted portfolio validation failed') from None
        return {'owner_id':owner,'portfolio':portfolio,'snapshot_id':snapshot.id,'content_hash':snapshot.content_hash,'captured_at':utc(snapshot.captured_at).isoformat(),'currency':'USD','holdings':deepcopy(snapshot.holdings),'connection':None}
    if portfolio!='india':raise WorkflowDenied('Unknown portfolio')
    snapshot=db.scalar(select(ZerodhaPortfolioSnapshot).where(ZerodhaPortfolioSnapshot.user_id==owner).order_by(ZerodhaPortfolioSnapshot.captured_at.desc(),ZerodhaPortfolioSnapshot.id.desc()).limit(1).execution_options(populate_existing=True))
    connection=db.scalar(select(IntegrationConnection).where(IntegrationConnection.owner_id==owner,IntegrationConnection.provider=='zerodha',IntegrationConnection.is_current.is_(True)).execution_options(populate_existing=True))
    if not snapshot or snapshot_id is not None and snapshot.id!=snapshot_id:raise WorkflowDenied('Current portfolio required')
    if not connection or connection.status!='active' or not connection.token_expires_at or utc(connection.token_expires_at)<=datetime.now(timezone.utc):raise WorkflowDenied('Valid current connection required')
    if datetime.now(timezone.utc)-utc(snapshot.captured_at)>timedelta(hours=48):raise WorkflowDenied('Stale portfolio')
    body={'owner_id':owner,'portfolio':portfolio,'snapshot_id':snapshot.id,'captured_at':utc(snapshot.captured_at).isoformat(),'currency':'INR','holdings':deepcopy(snapshot.holdings),'net_positions':deepcopy(snapshot.net_positions),'day_positions':deepcopy(snapshot.day_positions),'connection':{'id':connection.id,'version':connection.version,'account':connection.provider_account_id,'mode':connection.app_ownership_mode}}
    body['content_hash']=digest(body);return body
