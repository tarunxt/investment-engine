"""Owner-selected targets, never statutory periods or a live deletion grant.

No default legal applicability/inventory mapping is inferred from a table name.
An explicit bounded review covers every store; missing duties or holds fail closed.
"""
from dataclasses import dataclass
from datetime import datetime, timedelta
import re
from uuid import UUID
from app.domains.ai_limits.contracts import BoundaryDenied, digest, utc
from .sql_privacy_plan import RetentionSchedule

VERSION = 'category-targets-v1'
TARGET_DAYS = 30  # Owner-selected design target, not a mandatory legal period.
CATEGORIES = frozenset({'profile', 'upload', 'analysis', 'restricted_audit', 'identity',
                        'credential', 'financial', 'backup', 'unmapped'})
TARGETED = frozenset({'profile', 'upload', 'analysis'})
# These classifications describe actual producers, not blanket erase eligibility.
SOURCE_CATEGORIES = {
    'user_profiles': 'profile',
    'indmoney_us_portfolio_snapshots': 'upload',
    'zerodha_portfolio_snapshots': 'upload',
    'jobs': 'analysis', 'runs': 'analysis', 'run_jobs': 'analysis',
    'auto_rebalance_workflows': 'analysis', 'auto_rebalance_workflow_stages': 'analysis',
    'users': 'identity', 'activity_logs': 'restricted_audit', 'outbox': 'restricted_audit',
    'api_keys': 'credential', 'user_sessions': 'credential',
}


def _hash(value):
    return type(value) is str and re.fullmatch('[a-f0-9]{64}', value) is not None


def _date(value):
    if type(value) is not datetime or value.tzinfo is None or value.utcoffset() is None:
        raise BoundaryDenied('POLICY_AWARE_DATE_REQUIRED')
    return utc(value)


@dataclass(frozen=True)
class StoreReview:
    store: str
    category: str
    # Complete applicable-duty and ownership review is separately supplied.
    ownership_verified: bool = False
    applicable_duties_verified: bool = False
    legal_hold: bool = False
    retain_until: datetime | None = None
    erase_by: datetime | None = None  # A reviewed earlier deadline can beat target.


@dataclass(frozen=True)
class PolicyReview:
    inventory_hash: str
    source_mapping_hash: str
    reference_hash: str
    expires_at: datetime
    stores: tuple[StoreReview, ...]
    owner_id: int
    request_id: str
    eligible_at: datetime
    eligibility_reference_hash: str

    def validate(self, names, inventory_hash, source_mapping_hash, now, owner_id, request_id, eligible_at):
        if (not all(_hash(v) for v in (self.inventory_hash, self.source_mapping_hash, self.reference_hash, self.eligibility_reference_hash))
                or type(self.owner_id) is not int or self.owner_id != owner_id or self.request_id != request_id
                or _date(self.eligible_at) != eligible_at
                or self.inventory_hash != inventory_hash or self.source_mapping_hash != source_mapping_hash
                or _date(self.expires_at) <= now or type(self.stores) is not tuple
                or len(self.stores) > 256 or any(type(s) is not StoreReview for s in self.stores)
                or len({s.store for s in self.stores}) != len(self.stores)
                or {s.store for s in self.stores} != set(names)):
            raise BoundaryDenied('COMPLETE_CATEGORY_POLICY_REVIEW_REQUIRED')
        for s in self.stores:
            if (s.category not in CATEGORIES or s.category != SOURCE_CATEGORIES.get(s.store, 'unmapped')
                    or any(type(v) is not bool for v in
                           (s.ownership_verified, s.applicable_duties_verified, s.legal_hold))):
                raise BoundaryDenied('SOURCE_CATEGORY_MAPPING_REQUIRED')
            if s.retain_until is not None: _date(s.retain_until)
            if s.erase_by is not None: _date(s.erase_by)


def source_mapping_hash(names):
    return digest({n: SOURCE_CATEGORIES.get(n, 'unmapped') for n in sorted(names)})


def assess(*, owner_id, request_id, names, inventory_hash, eligible_at, now, review=None):
    """Read-only complete-store proposal. Eligibility clock is request/purpose end.

    Does not turn request age into lawfulness, change permissions, or execute rows.
    Relational holds are additionally propagated by the existing SQL planner.
    """
    if type(owner_id) is not int or owner_id <= 0:
        raise BoundaryDenied('ACTIVE_OWNER_REQUIRED')
    try: request_id = str(UUID(str(request_id)))
    except (ValueError, TypeError): raise BoundaryDenied('OWNED_POLICY_REQUEST_REQUIRED') from None
    now, eligible_at = _date(now), _date(eligible_at)
    if (eligible_at > now or not _hash(inventory_hash) or type(names) not in {set, frozenset}
            or not 1 <= len(names) <= 256 or any(type(n) is not str or not re.fullmatch('[a-z][a-z0-9_]{0,95}', n) for n in names)):
        raise BoundaryDenied('POLICY_INVENTORY_AND_ELIGIBILITY_REQUIRED')
    mapping = source_mapping_hash(names)
    if review is not None:
        if type(review) is not PolicyReview: raise BoundaryDenied('COMPLETE_CATEGORY_POLICY_REVIEW_REQUIRED')
        review.validate(names, inventory_hash, mapping, now, owner_id, request_id, eligible_at)
    reviews = {s.store: s for s in review.stores} if review else {}
    result = {}
    for name in sorted(names):
        category = SOURCE_CATEGORIES.get(name, 'unmapped'); r = reviews.get(name)
        target = eligible_at + timedelta(days=TARGET_DAYS) if category in TARGETED else None
        due = min(target, _date(r.erase_by)) if target and r and r.erase_by else target
        reason = ('RESTRICTED_ANCHOR_OR_SPECIAL_ADAPTER' if category in {'identity','restricted_audit','credential','financial'}
                  else 'UNMAPPED_STORE' if category == 'unmapped'
                  else 'APPLICABLE_DUTIES_AND_OWNERSHIP_UNVERIFIED' if not r or not r.ownership_verified or not r.applicable_duties_verified
                  else 'LEGAL_HOLD' if r.legal_hold
                  else 'CONFLICTING_REVIEWED_DUTIES' if r.retain_until and r.erase_by and _date(r.retain_until) > _date(r.erase_by)
                  else 'RETAIN_UNTIL' if r.retain_until and now < _date(r.retain_until)
                  else 'TARGET_PENDING' if due and now < due else 'SYNTHETIC_CANDIDATE_ONLY')
        result[name] = {'category': category, 'reason': reason,
                        'target_at': target.isoformat() if target else None,
                        'due_at': due.isoformat() if due else None,
                        'retain_until': _date(r.retain_until).isoformat() if r and r.retain_until else None}
    claims = {'owner_id':owner_id,'request_id':request_id,'review_expires_at':review.expires_at.isoformat() if review else None,'version':VERSION,'inventory_hash':inventory_hash,'source_mapping_hash':mapping,
              'review_hash':None,'eligible_at':eligible_at.isoformat(),
              'stores':result,'target_days':TARGET_DAYS,'target_is_law':False,
              'legal_approval':False,'real_deletion_enabled':False,'complete_erasure':False}
    # dataclasses aren't JSON: the review fingerprint is defined explicitly below.
    if review:
        claims['review_hash'] = digest({'owner_id':review.owner_id,'request_id':review.request_id,
            'eligible_at':review.eligible_at.isoformat(),'eligibility_reference_hash':review.eligibility_reference_hash,'reference_hash':review.reference_hash,'expires_at':review.expires_at.isoformat(),
            'stores':[{**vars(s),'retain_until':s.retain_until.isoformat() if s.retain_until else None,
                       'erase_by':s.erase_by.isoformat() if s.erase_by else None} for s in review.stores]})
    claims['policy_hash'] = digest(claims)
    return claims


def synthetic_schedule(proposal, *, expires_at, review, now):
    """Bridge into the existing disposable planner; every unknown store is held."""
    if type(review) is not PolicyReview:
        raise BoundaryDenied('COMPLETE_CATEGORY_POLICY_REVIEW_REQUIRED')
    expected=assess(owner_id=review.owner_id,request_id=review.request_id,
        names={s.store for s in review.stores},inventory_hash=review.inventory_hash,
        eligible_at=review.eligible_at,now=now,review=review)
    if proposal != expected:raise BoundaryDenied('CATEGORY_POLICY_REVIEW_CHANGED')
    claims = {k:v for k,v in proposal.items() if k != 'policy_hash'}
    if (digest(claims) != proposal.get('policy_hash') or proposal.get('version') != VERSION
            or proposal.get('real_deletion_enabled') is not False or proposal.get('legal_approval') is not False):
        raise BoundaryDenied('CATEGORY_POLICY_BINDING_CHANGED')
    try: review_expiry = _date(datetime.fromisoformat(proposal['review_expires_at']))
    except (KeyError, ValueError, TypeError): raise BoundaryDenied('COMPLETE_CATEGORY_POLICY_REVIEW_REQUIRED') from None
    held = frozenset(n for n,s in proposal['stores'].items() if s['reason'] not in {'SYNTHETIC_CANDIDATE_ONLY','TARGET_PENDING','RETAIN_UNTIL'})
    dates=[]
    for n,s in proposal['stores'].items():
        values=[datetime.fromisoformat(v) for v in (s['due_at'],s['retain_until']) if v]
        dates.append((n,max(values) if values else None))
    return RetentionSchedule('synthetic-category:'+proposal['policy_hash'][:64],min(_date(expires_at),review_expiry),held,tuple(dates))
