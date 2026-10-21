"""Deterministic recommendations are advisory and cannot become orders."""
from datetime import timedelta
from decimal import Decimal
import re
from app.domains.jobs.output_contracts.validation import number as existing_number, _sum
from .contracts import BoundaryDenied, digest, utc

def number(value):
    if isinstance(value,str) and len(value)>128:return None
    return existing_number(value)


def validate_source(source, *, owner_id,module_id,now):
    if not isinstance(source,dict) or type(source.get('owner_id')) is not int or source.get('owner_id') != owner_id or source.get('module_id') != module_id:
        raise BoundaryDenied('FOREIGN_SOURCE')
    captured = utc(source['captured_at']); now = utc(now)
    if not now-timedelta(hours=48) <= captured <= now+timedelta(seconds=60):
        raise BoundaryDenied('STALE_OR_FUTURE_SOURCE')
    if source.get('currency') not in {'INR','USD'}:
        raise BoundaryDenied('CURRENCY_MISMATCH')
    required={'indmoney_us':'USD','zerodha_rebalance':'INR'}.get(module_id)
    if required is not None and source['currency']!=required:raise BoundaryDenied('MODULE_CURRENCY_MISMATCH')
    expected = source.get('provenance')
    if not isinstance(expected, dict) or set(expected) != {'provider','model','prompt_hash','input_hash','prompt_version'} or not all(isinstance(v,str) and v for v in expected.values()) or any(not re.fullmatch('[0-9a-f]{64}',expected[k]) for k in ['prompt_hash','input_hash']) or not isinstance(source.get('content_hash'),str) or not re.fullmatch('[0-9a-f]{64}',source['content_hash']):
        raise BoundaryDenied('PROVENANCE_MISMATCH')
    holdings=source.get('holdings')
    if not isinstance(holdings,dict) or len(holdings)>200 or any(not isinstance(k,str) or number(v) is None or number(v)<0 for k,v in holdings.items()):
        raise BoundaryDenied('HOLDINGS_REQUIRED')
    return expected


def validate_recommendations(document, *, source, owner_id, module_id, now,
                             allowed_instruments, max_allocation=Decimal('.25')):
    """All policy/source inputs are trusted server values, never model fields."""
    if not isinstance(document, dict) or set(document) != {'schema_version','currency','recommendations','provenance'} or type(document['schema_version']) is not int or document['schema_version'] != 1:
        raise BoundaryDenied('RECOMMENDATION_SCHEMA')
    output_hash=digest(document) # byte/depth/finite JSON guard before arithmetic
    expected=validate_source(source,owner_id=owner_id,module_id=module_id,now=now)
    if document['currency']!=source['currency']:raise BoundaryDenied('CURRENCY_MISMATCH')
    if document['provenance']!=expected:raise BoundaryDenied('PROVENANCE_MISMATCH')
    rows = document['recommendations']
    if not isinstance(rows,list) or not 1 <= len(rows) <= 200:
        raise BoundaryDenied('RECOMMENDATION_COUNT')
    cap = number(max_allocation)
    if cap is None or not 0 < cap <= 1:
        raise BoundaryDenied('ALLOCATION_POLICY')
    holdings = source.get('holdings')
    if not isinstance(holdings,dict):
        raise BoundaryDenied('HOLDINGS_REQUIRED')
    total = Decimal(0); seen = set()
    for row in rows:
        if not isinstance(row,dict) or set(row) != {'instrument','action','current_units','final_units','allocation'}:
            raise BoundaryDenied('RECOMMENDATION_ROW_SCHEMA')
        instrument = row['instrument']
        if not isinstance(instrument,str) or instrument not in allowed_instruments or instrument in seen:
            raise BoundaryDenied('INSTRUMENT_NOT_ALLOWED_OR_DUPLICATE')
        markets={'INR':{'NSE','BSE'},'USD':{'US','NYSE','NASDAQ','NYSEARCA','NYSEAMERICAN','AMEX'}}
        if ':' not in instrument or instrument.split(':',1)[0] not in markets[source['currency']]:
            raise BoundaryDenied('INSTRUMENT_CURRENCY_MISMATCH')
        seen.add(instrument)
        current, final, allocation = (number(row[k]) for k in ('current_units','final_units','allocation'))
        held = number(holdings.get(instrument,0))
        if None in (current,final,allocation,held) or min(current,final,held,allocation) < 0 or current != held:
            raise BoundaryDenied('HOLDINGS_OR_FINITE_NUMBERS')
        action = row['action']
        if action not in {'hold','buy','trim','sell'} or (action=='hold' and final!=current) or (action=='buy' and final<=current) or (action=='trim' and not 0<final<current) or (action=='sell' and (current<=0 or final!=0)):
            raise BoundaryDenied('ACTION_HOLDINGS_CONFLICT')
        if allocation > cap or (final==0 and allocation!=0) or (final>0 and allocation==0):
            raise BoundaryDenied('ALLOCATION_LIMIT')
        total = _sum(total,allocation)
    if total > 1:
        raise BoundaryDenied('TOTAL_ALLOCATION_LIMIT')
    if not {k for k,v in holdings.items() if number(v)>0}<=seen:
        raise BoundaryDenied('HOLDINGS_COVERAGE_REQUIRED')
    return {'schema_version':1,'valid':True,'advisory_only':True,'orders_authorized':False,
            'source_hash':source['content_hash'],'output_hash':output_hash,'provenance':dict(expected)}
