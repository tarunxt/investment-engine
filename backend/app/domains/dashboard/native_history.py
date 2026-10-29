"""Additive owned USD observation metadata; no rate lookup or data mutation.

Legacy ``value`` remains its historical compatibility presentation. Concept F
uses recorded_value (holding value only), and never turns an unknown wallet or
missing holding value into a verified zero observation.
"""
import math
import re
from app.domains.indmoney_us.import_validation import utc
from .schemas import DashboardUsdHistoryPoint


def owned_us_history_point(row,owner):
    if type(owner) is not int or owner<1:raise ValueError('Owned history subject required')
    parent=row.supersedes_id
    if parent is not None and row.owned_supersedes_id!=parent:
        raise ValueError('Owned correction lineage required')
    provenance=row.import_provenance
    source_hash=provenance.get('source_hash') if type(provenance) is dict else None
    admitted=(type(provenance) is dict and provenance.get('currency')=='USD'
        and type(source_hash) is str and re.fullmatch('[0-9a-f]{64}',source_hash))
    raw=row.current_value
    if raw is not None and (isinstance(raw,bool) or not math.isfinite(raw) or raw<0):raise ValueError('Finite nonnegative recorded value required')
    legacy=(raw or 0)+(row.wallet_balance or 0)
    if not math.isfinite(legacy):raise ValueError('Finite legacy projection required')
    return DashboardUsdHistoryPoint(captured_at=utc(row.captured_at),value=legacy,
        metric='accepted_us_portfolio_value_v1' if admitted else None,
        currency='USD' if admitted else None,owner_id=owner,snapshot_id=row.id,
        supersedes_id=parent,import_source_hash=source_hash if admitted else None,
        recorded_value=raw if admitted else None,recorded_value_known=bool(admitted and raw is not None))
