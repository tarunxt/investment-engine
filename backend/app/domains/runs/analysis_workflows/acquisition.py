"""Read-only acquisition validation. Never infer lineage from today's connection.

Legacy writers do not issue receipts. An approved future acquisition adapter must
persist its verified provider-account/connection receipt in its acquisition
transaction; no public request or repair/backfill route can produce one here.
"""
from copy import deepcopy
from datetime import datetime,timezone,timedelta
from .contracts import digest,utc,WorkflowDenied

MAX_AGE=timedelta(hours=48)
MAX_FUTURE=timedelta(seconds=60)


def sane_capture(captured_at,*,now=None):
    if not isinstance(captured_at,datetime):raise WorkflowDenied('Snapshot time unavailable')
    now=utc(now or datetime.now(timezone.utc));captured=utc(captured_at)
    if captured>now+MAX_FUTURE:raise WorkflowDenied('Snapshot is in the future')
    if captured<now-MAX_AGE:raise WorkflowDenied('Stale portfolio')
    return captured


def acquisition_payload(snapshot):
    # All quantities/financial inputs used by this analysis are covered. Identity,
    # date and source prevent copying the receipt onto a different snapshot.
    return {'owner_id':snapshot.user_id,'snapshot_id':snapshot.id,
            'snapshot_date':snapshot.snapshot_date.isoformat(),'captured_at':utc(snapshot.captured_at).isoformat(),
            'source':snapshot.source,'holdings':deepcopy(snapshot.holdings),
            'net_positions':deepcopy(snapshot.net_positions),'day_positions':deepcopy(snapshot.day_positions),
            'holdings_count':snapshot.holdings_count,'net_positions_count':snapshot.net_positions_count,
            'day_positions_count':snapshot.day_positions_count,
            'holdings_market_value':snapshot.holdings_market_value,'holdings_pnl':snapshot.holdings_pnl,
            'holdings_day_change_value':snapshot.holdings_day_change_value,'available_margin':snapshot.available_margin,
            'positions_pnl':snapshot.positions_pnl,'positions_m2m':snapshot.positions_m2m,
            'holdings_invested_value':snapshot.holdings_invested_value,
            'dashboard_top_holdings':deepcopy(snapshot.dashboard_top_holdings)}


def validate_acquisition(snapshot,connection,owner,*,now=None):
    sane_capture(snapshot.captured_at,now=now)
    receipt=snapshot.acquisition_json
    if snapshot.source!='connection_sync' or not isinstance(receipt,dict):
        raise WorkflowDenied('Verified acquisition provenance unavailable; legacy/manual snapshot cannot be relabelled')
    expected={'schema_version':1,'kind':'connection_acquisition_v1','owner_id':owner,
              'snapshot_id':snapshot.id,'connection_id':connection.id,'connection_version':connection.version,
              'provider':'zerodha','provider_account_id':connection.provider_account_id,
              'app_mode':connection.app_ownership_mode,'captured_at':utc(snapshot.captured_at).isoformat()}
    if (snapshot.user_id!=owner or connection.owner_id!=owner or not connection.provider_account_id
        or any(type(receipt.get(k)) is not type(v) or receipt.get(k)!=v for k,v in expected.items())):
        raise WorkflowDenied('Acquisition connection/account/version mismatch')
    try:matches=digest(acquisition_payload(snapshot))==receipt.get('content_hash')
    except (TypeError,ValueError):matches=False
    if not matches:raise WorkflowDenied('Acquired snapshot content changed')
    return deepcopy(receipt)
