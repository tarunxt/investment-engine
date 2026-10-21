"""Exact decimal fresh risk checks, independent of the frozen review digest."""
from dataclasses import dataclass, asdict
from datetime import timedelta
from decimal import Decimal, InvalidOperation
from .contracts import OrderDenied, utc, digest
from .execution_fake import MarketDataFake


@dataclass(frozen=True)
class ExecutionLimits:
    max_notional: str = '100000.00'
    max_exposure: str = '1000000.00'
    max_submissions_per_minute: int = 10
    quote_max_age_seconds: int = 5

    def values(self):
        number(self.max_notional); number(self.max_exposure)
        if type(self.max_submissions_per_minute) is not int or not 1 <= self.max_submissions_per_minute <= 100:
            raise OrderDenied('INVALID_EXECUTION_LIMITS')
        if type(self.quote_max_age_seconds) is not int or not 1 <= self.quote_max_age_seconds <= 30:
            raise OrderDenied('INVALID_EXECUTION_LIMITS')
        return asdict(self)


def number(value, *, zero=False):
    if not isinstance(value, str) or len(value) > 40:
        raise OrderDenied('EXACT_RISK_DECIMAL_REQUIRED')
    try:
        result = Decimal(value)
        if not result.is_finite() or result < 0 or (not zero and result == 0) or result > Decimal('1000000000000') or result.as_tuple().exponent < -8:
            raise OrderDenied('INVALID_RISK_DECIMAL')
        return result
    except InvalidOperation:
        raise OrderDenied('INVALID_RISK_DECIMAL') from None


def fresh_risk(source, row, position, now, limits):
    if type(source) is not MarketDataFake:
        raise OrderDenied('FAKE_TRUSTED_MARKET_SOURCE_REQUIRED')
    data = source.read()
    try:
        if set(data) != {'owner_id', 'account_id', 'connection_id', 'connection_version', 'app_mode', 'as_of', 'funds', 'exposure', 'instruments', 'source'}:
            raise OrderDenied('EXACT_MARKET_SNAPSHOT_REQUIRED')
        if type(data['owner_id']) is not int or type(data['connection_version']) is not int or data['source'] != 'synthetic_authoritative' or (data['owner_id'], data['account_id'], data['connection_id'], data['connection_version'], data['app_mode']) != (row.owner_id, row.account_id, row.connection_id, row.connection_version, row.app_mode):
            raise OrderDenied('MARKET_SOURCE_BINDING_MISMATCH')
        age = now - utc(data['as_of'])
        if not timedelta(0) <= age <= timedelta(seconds=limits.quote_max_age_seconds):
            raise OrderDenied('FRESH_TRUSTED_QUOTES_REQUIRED')
        legs = row.payload_json['legs']
        total = sum(number(leg['limit_price']) * leg['quantity'] for leg in legs)
        if total > number(limits.max_notional):
            raise OrderDenied('NOTIONAL_LIMIT')
        leg = legs[position]
        item = data['instruments'][leg['exchange'] + ':' + leg['symbol']]
        if set(item) != {'tradable', 'market_open', 'product', 'quote', 'tick', 'lot', 'lower', 'upper', 'holdings'} or item['tradable'] is not True or item['market_open'] is not True or item['product'] != leg['product']:
            raise OrderDenied('MARKET_PRODUCT_UNAVAILABLE')
        price, quote, tick = number(leg['limit_price']), number(item['quote']), number(item['tick'])
        if type(item['lot']) is not int or item['lot'] < 1 or leg['quantity'] % item['lot'] or price % tick:
            raise OrderDenied('LOT_TICK_INVALID')
        lower, upper = number(item['lower']), number(item['upper'])
        if not lower <= price <= upper or not lower <= quote <= upper or abs(price - quote) > quote * Decimal('.05'):
            raise OrderDenied('CIRCUIT_PROTECTED_PRICE_INVALID')
        funds, exposure = number(data['funds'], zero=True), number(data['exposure'], zero=True)
        notional = price * leg['quantity']
        remaining_buys = sum(number(item['limit_price']) * item['quantity'] for item in legs[position:] if item['side'] == 'BUY')
        if leg['side'] == 'BUY' and (funds < remaining_buys or exposure + remaining_buys > number(limits.max_exposure)):
            raise OrderDenied('FUNDS_EXPOSURE_LIMIT')
        if type(item['holdings']) is not int or item['holdings'] < 0 or (leg['side'] == 'SELL' and item['holdings'] < leg['quantity']):
            raise OrderDenied('HOLDINGS_LIMIT')
        # Store only a hash of this exact observation, never user fallback data.
        return digest({**data, 'as_of': utc(data['as_of']).isoformat()})
    except (KeyError, TypeError, InvalidOperation):
        raise OrderDenied('INVALID_MARKET_SNAPSHOT') from None
