"""Exact normalized financial payloads; no inference or automatic substitution."""
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, localcontext
import re
from app.infrastructure.messaging.idempotency import canonical_digest

class OrderDenied(ValueError):
    pass

def utc(value):
    if not isinstance(value, datetime) or value.tzinfo is None:raise OrderDenied('AWARE_TIME_REQUIRED')
    return value.astimezone(timezone.utc)

def stored_utc(value):
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else utc(value)

def amount(value):
    if not isinstance(value,str) or len(value)>32:raise OrderDenied('EXACT_DECIMAL_REQUIRED')
    try:
        with localcontext() as ctx:
            ctx.prec=40
            d=Decimal(value)
            if not d.is_finite() or d<=0 or d>Decimal('10000000') or d.as_tuple().exponent < -2:raise OrderDenied('INVALID_PRICE')
            return format(d.quantize(Decimal('.01')),'f')
    except InvalidOperation:raise OrderDenied('INVALID_PRICE') from None

def payload(value):
    if not isinstance(value,dict) or set(value)!={'legs','sequencing'}:raise OrderDenied('INVALID_ORDER_PAYLOAD')
    legs=value['legs']
    if not isinstance(legs,list) or not 1<=len(legs)<=20 or value['sequencing'] not in {'listed','sell_then_buy'}:raise OrderDenied('INVALID_BASKET')
    out=[];symbols=set()
    for leg in legs:
        if not isinstance(leg,dict) or set(leg)!={'exchange','symbol','side','quantity','limit_price','product','order_type'}:raise OrderDenied('INVALID_LEG')
        if leg['exchange'] not in {'NSE','BSE'} or leg['side'] not in {'BUY','SELL'} or leg['product']!='CNC' or leg['order_type']!='LIMIT':raise OrderDenied('UNSUPPORTED_ORDER')
        if not isinstance(leg['symbol'],str) or not re.fullmatch(r'[A-Z0-9][A-Z0-9_.-]{0,31}',leg['symbol']):raise OrderDenied('INVALID_SYMBOL')
        if type(leg['quantity']) is not int or not 1<=leg['quantity']<=1000000:raise OrderDenied('INVALID_QUANTITY')
        key=(leg['exchange'],leg['symbol'])
        if key in symbols:raise OrderDenied('DUPLICATE_INSTRUMENT')
        symbols.add(key);out.append({**leg,'limit_price':amount(leg['limit_price'])})
    if value['sequencing']=='sell_then_buy' and any(a['side']=='BUY' and b['side']=='SELL' for i,a in enumerate(out) for b in out[i+1:]):raise OrderDenied('SEQUENCING_MUST_BE_DISPLAYED')
    return {'legs':out,'sequencing':value['sequencing']}

def digest(value):
    try:return canonical_digest(value)
    except (ValueError,TypeError,RecursionError):raise OrderDenied('INVALID_BOUND_INPUT') from None

def require_live_financial_disabled():
    # No environment flag, module toggle, recovery exception or legacy context
    # can turn the Stage14 synthetic approval system into real financial access.
    from fastapi import HTTPException
    raise HTTPException(503,'Financial execution unavailable: reviewed order approval runtime is not activated')


def receipt(value,leg,reference):
    """No status label is quantitative proof of a fill or leg identity."""
    fields={'state','broker_order_id','filled_quantity','client_reference','payload_digest'}
    if not isinstance(value,dict) or set(value)!=fields:raise OrderDenied('INVALID_BROKER_RECEIPT')
    state=value['state'];quantity=value['filled_quantity'];requested=leg['quantity']
    if not isinstance(state,str) or state not in {'acknowledged','filled','partial','rejected'} or type(quantity)is not int or not 0<=quantity<=requested:raise OrderDenied('INVALID_BROKER_RECEIPT')
    if (state=='filled' and quantity!=requested) or (state=='partial' and not 0<quantity<requested) or (state in {'acknowledged','rejected'} and quantity!=0):raise OrderDenied('INCOHERENT_FILL_STATE')
    if not isinstance(value['broker_order_id'],str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,100}',value['broker_order_id']):raise OrderDenied('BROKER_ORDER_ID_REQUIRED')
    if value['client_reference']!=reference or value['payload_digest']!=digest(leg):raise OrderDenied('BROKER_RECEIPT_LEG_MISMATCH')
    return dict(value)
