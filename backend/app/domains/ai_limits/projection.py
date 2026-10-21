"""Recommendation facts derived from immutable workflow bytes, never a label.

The whole source digest still binds snapshot/connection and other input facts.
This projection binds the exact holdings, currency and capture used for semantic
validation. Unsupported or incomplete sources cannot be filled by a resolver.
"""
from datetime import datetime
import re
from .contracts import BoundaryDenied,digest,utc
from .validation import number

MARKETS={'USD':frozenset({'US','NYSE','NASDAQ','NYSEARCA','NYSEAMERICAN','AMEX'}),
         'INR':frozenset({'NSE','BSE'})}


def captured(value):
    try:
        return utc(datetime.fromisoformat(value) if isinstance(value,str) else value)
    except (ValueError,TypeError,OverflowError):
        raise BoundaryDenied('FROZEN_CAPTURE_REQUIRED') from None


def quantity(value):
    value=number(value)
    if value is None or value<0:raise BoundaryDenied('FROZEN_QUANTITY_REQUIRED')
    if value==0:return '0'
    # Decimal.normalize() would use the ambient precision and could round.
    # Strip only insignificant zeroes from the exact tuple instead.
    sign,digits,exponent=value.as_tuple();digits=list(digits)
    while digits[-1]==0:digits.pop();exponent+=1
    result=(''.join(map(str,digits)))+'e'+str(exponent)
    if len(result)>128:raise BoundaryDenied('FROZEN_QUANTITY_PRECISION')
    return result


def instrument(value,currency):
    if not isinstance(value,str) or not re.fullmatch(r'[A-Z]+:[A-Z0-9&_.-]{1,64}',value) or value.split(':',1)[0] not in MARKETS[currency]:
        raise BoundaryDenied('FROZEN_INSTRUMENT_REQUIRED')
    return value


def holdings(value,currency,module):
    if not isinstance(value,(dict,list)) or len(value)>200:raise BoundaryDenied('FROZEN_HOLDINGS_REQUIRED')
    result={}
    if isinstance(value,dict):
        pairs=list(value.items())
    else:
        pairs=[]
        for row in value:
            if not isinstance(row,dict) or row.get('currency',currency)!=currency:
                raise BoundaryDenied('FROZEN_HOLDING_SCHEMA')
            if module=='indmoney_us':
                market=row.get('exchange','US');symbol=row.get('symbol')
            else:
                market=row.get('exchange');symbol=row.get('tradingsymbol')
            if not isinstance(market,str) or not isinstance(symbol,str):raise BoundaryDenied('FROZEN_HOLDING_SCHEMA')
            pairs.append((market+':'+symbol,row.get('quantity')))
    for key,value in pairs:
        key=instrument(key,currency)
        if key in result:raise BoundaryDenied('FROZEN_HOLDING_DUPLICATE')
        result[key]=quantity(value)
    return dict(sorted(result.items()))


def projection(source,*,owner,module):
    expected={'indmoney_us':'USD','zerodha_rebalance':'INR'}.get(module)
    if not isinstance(source,dict) or type(source.get('owner_id')) is not int or source['owner_id']!=owner:
        raise BoundaryDenied('FROZEN_OWNER_REQUIRED')
    if expected is None or source.get('currency')!=expected or source.get('module_id',module)!=module:
        raise BoundaryDenied('FROZEN_MODULE_CURRENCY')
    if 'captured_at' not in source or 'holdings' not in source:raise BoundaryDenied('FROZEN_INPUT_REQUIRED')
    return {'owner_id':owner,'module_id':module,'currency':expected,
            'captured_at':captured(source['captured_at']),
            'holdings':holdings(source['holdings'],expected,module)}


def frozen_projection(row):
    e=row.execution_json
    if not isinstance(e,dict) or not isinstance(e.get('source'),dict) or digest(e['source'])!=e.get('source_hash'):
        raise BoundaryDenied('FROZEN_SOURCE_INTEGRITY')
    expected={'indmoney_us':'indmoney_us','zerodha_rebalance':'india'}.get(row.module_id)
    if row.portfolio!=expected or e['source'].get('portfolio',expected)!=expected:
        raise BoundaryDenied('FROZEN_PORTFOLIO_REQUIRED')
    return projection(e['source'],owner=row.user_id,module=row.module_id)
