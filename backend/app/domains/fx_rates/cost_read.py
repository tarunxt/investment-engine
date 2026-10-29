"""Authenticated cost-display FX evidence. No source refresh, writes or billing authority."""
from datetime import datetime, timezone
import math
from .service import read_persisted_usd_inr_rate


def cost_fx_projection(owner, assessment, *, now):
    if type(owner) is not int or owner < 1:
        raise ValueError('Current owner required')
    if now.tzinfo is None:raise ValueError('Aware FX observation required')
    as_of=assessment.as_of
    aware=as_of is not None and as_of.tzinfo is not None
    source=assessment.source
    valid=(type(assessment.value) in (int,float) and math.isfinite(assessment.value)
        and assessment.value>0 and isinstance(source,str) and 0<len(source)<=255 and bool(source.strip())
        and aware and as_of<=now and type(assessment.age_seconds) is int
        and assessment.age_seconds>=0 and type(assessment.stale_after_seconds) is int
        and assessment.stale_after_seconds>0 and assessment.status in {'valid','stale'})
    status=assessment.status if valid else 'unavailable'
    if valid and status=='valid' and max(assessment.age_seconds,(now-as_of).total_seconds())>assessment.stale_after_seconds:status='stale'
    return {'schema_version':1,'owner_id':owner,'provider_contacted':False,
        'observed_at':now.isoformat(),'fx':{'pair':'USD/INR',
        'value':assessment.value if valid else None,'source':source if valid else None,
        'as_of':as_of.isoformat() if valid else None,
        'age_seconds':assessment.age_seconds if valid else None,
        'stale_after_seconds':assessment.stale_after_seconds,'status':status},
        'notice':'Persisted source metadata only. No provider refresh, account billing, payment or financial execution is authorised.'}


async def read_cost_fx(db, owner, *, now=None):
    now=now or datetime.now(timezone.utc)
    return cost_fx_projection(owner,await read_persisted_usd_inr_rate(db,now=now),now=now)
