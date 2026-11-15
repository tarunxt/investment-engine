import asyncio
import gzip
import json
from datetime import datetime, timezone

import httpx
import pytest

from app.domains.zerodha import upstox_quotes as upstox
from app.domains.zerodha.display_quotes import read_display_quotes

NOW = datetime(2026, 10, 30, 8, tzinfo=timezone.utc)
KEY = 'NSE_EQ|INE123456789'


def quote(**updates):
    return {'instrument_token': KEY, 'last_price': 125,
            'last_trade_time': str(int(NOW.timestamp() * 1000)), **updates}


def test_exact_mapping_rejects_ambiguous_or_cross_venue_instruments():
    rows = [{'segment': 'NSE_EQ', 'trading_symbol': 'ABC', 'instrument_key': KEY},
            {'segment': 'BSE_EQ', 'trading_symbol': 'ABC', 'instrument_key': 'BSE_EQ|INE123456789'},
            {'segment': 'NSE_FO', 'trading_symbol': 'ABC', 'instrument_key': 'NSE_FO|123'}]
    assert upstox.instrument_map(rows) == {'NSE:ABC': KEY, 'BSE:ABC': 'BSE_EQ|INE123456789'}
    assert 'NSE:ABC' not in upstox.instrument_map(rows + [{**rows[0], 'instrument_key': 'NSE_EQ|INE987654321'}])


@pytest.mark.parametrize('changes', [
    {'last_price': 0}, {'last_price': True}, {'last_price': float('nan')},
    {'last_price': float('inf')}, {'last_trade_time': None}, {'last_trade_time': 'bad'},
    {'last_trade_time': True}, {'last_trade_time': '0'},
    {'last_trade_time': str(int((NOW.timestamp() + 1) * 1000))},
    {'instrument_token': 'BSE_EQ|INE123456789'}, {'instrument_token': []},
])
def test_invalid_or_future_prices_never_become_quotes(changes):
    assert upstox.normalize_quotes({'untrusted-response-key': quote(**changes)}, {'NSE:ABC': KEY}, NOW) == []


def test_provenance_uses_trade_time_and_exact_token_not_response_key():
    result = upstox.normalize_quotes({'arbitrary': quote()}, {'NSE:ABC': KEY}, NOW)
    assert result[0]['as_of'] == NOW.isoformat()
    assert 'Upstox' in result[0]['source'] and 'last trade time' in result[0]['source']
    assert not upstox.normalize_quotes({'a': quote(), 'b': quote()}, {'NSE:ABC': KEY}, NOW)


@pytest.mark.parametrize('age', [121, 8 * 3600, 3 * 24 * 3600])
def test_after_hours_and_illiquid_last_trades_are_explicit_display_prices(age):
    traded = datetime.fromtimestamp(NOW.timestamp() - age, timezone.utc)
    result = upstox.normalize_quotes({'row': quote(last_trade_time=str(int(traded.timestamp() * 1000)))}, {'NSE:ABC': KEY}, NOW)
    assert result[0]['price'] == 125
    assert result[0]['as_of'] == traded.isoformat()
    assert 'older last trade' in result[0]['source']
    assert f'trade age {age}s' in result[0]['source']
    assert f'retrieved {NOW.isoformat()}' in result[0]['source']
    assert 'not an execution quote' in result[0]['source']


@pytest.mark.parametrize('broker_fails', [False, True])
def test_only_missing_kite_prices_use_fallback(monkeypatch, broker_fails):
    calls = []
    class Broker:
        async def get_quotes(self, token, instruments):
            if broker_fails:
                raise RuntimeError('synthetic broker failure')
            return {'NSE:KEEP': {'last_price': 100}}
    async def fallback(owner, instruments):
        calls.append((owner, instruments))
        return [{'instrument': 'NSE:ABC', 'price': 125, 'as_of': NOW.isoformat(), 'source': 'Upstox'}]
    monkeypatch.setattr(upstox, 'read_upstox_quotes', fallback)
    result = asyncio.run(read_display_quotes(Broker(), 'synthetic', ['NSE:KEEP', 'NSE:ABC', 'NSE:MISSING'], user_id=73))
    assert calls == [(73, ['NSE:KEEP', 'NSE:ABC', 'NSE:MISSING'])]
    assert result['upstox_quotes'][0]['price'] == 125
    assert result['missing'] == (['NSE:KEEP', 'NSE:MISSING'] if broker_fails else ['NSE:MISSING'])
    if not broker_fails:
        assert result['quotes'][0]['price'] == 100


@pytest.mark.parametrize('mode', ['ok', '401', '403', '429', 'timeout', 'malformed', 'empty'])
def test_read_is_owner_scoped_bounded_get_only_and_fails_closed(monkeypatch, mode, caplog):
    monkeypatch.setenv('UPSTOX_LTP_OWNER_USER_ID', '73')
    monkeypatch.setenv('UPSTOX_ANALYTICS_TOKEN', 'synthetic-sensitive-value')
    calls = []
    # Isolate wire/normalization fixture from shared infrastructure. Guard itself
    # is tested against actual Lua separately in test_upstox_quote_guard.py.
    from app.domains.zerodha import upstox_quote_guard
    class Guard:
        async def admit(self): return True
        async def count(self, field): pass
        async def backoff(self, value): pass
    async def guarded(owner, instruments, fetch): return await fetch(Guard())
    monkeypatch.setattr(upstox_quote_guard, 'guarded_quotes', guarded)
    async def master(client): return {'NSE:ABC': KEY}
    monkeypatch.setattr(upstox, 'load_instruments', master)
    real_client = httpx.AsyncClient
    def handler(request):
        calls.append(request)
        assert request.method == 'GET'
        assert request.url.host == 'api.upstox.com'
        assert request.url.params['instrument_key'] == KEY
        if mode == 'timeout': raise httpx.ReadTimeout('synthetic-sensitive-value')
        if mode.isdigit(): return httpx.Response(int(mode), text='synthetic-sensitive-value')
        if mode == 'malformed': return httpx.Response(200, text='invalid JSON')
        stamp = str(int(datetime.now(timezone.utc).timestamp() * 1000))
        return httpx.Response(200, json={'status': 'success', 'data': {} if mode == 'empty' else {'row': quote(last_trade_time=stamp)}})
    monkeypatch.setattr(upstox.httpx, 'AsyncClient', lambda **kwargs: real_client(transport=httpx.MockTransport(handler), **kwargs))
    assert asyncio.run(upstox.read_upstox_quotes(74, ['NSE:ABC'])) == []
    assert not calls
    result = asyncio.run(upstox.read_upstox_quotes(73, ['NSE:ABC', 'BSE:ABC']))
    assert bool(result) == (mode == 'ok')
    assert len(calls) == 1
    assert 'synthetic-sensitive-value' not in caplog.text


def test_master_cache_has_expiry_and_never_sends_auth(monkeypatch):
    monkeypatch.setattr(upstox, '_master', ({}, 0))
    calls = []
    def handler(request):
        calls.append(request)
        assert 'authorization' not in request.headers
        body = [{'segment': 'NSE_EQ', 'trading_symbol': 'ABC', 'instrument_key': KEY}]
        return httpx.Response(200, content=gzip.compress(json.dumps(body).encode()))
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            assert await upstox.load_instruments(client) == {'NSE:ABC': KEY}
            await upstox.load_instruments(client)
            monkeypatch.setattr(upstox, '_master', (upstox._master[0], -upstox.MASTER_TTL))
            await upstox.load_instruments(client)
    asyncio.run(run())
    assert len(calls) == 2


def test_original_kite_error_survives_when_upstox_is_unavailable(monkeypatch):
    error = RuntimeError('synthetic broker failure')
    class Broker:
        async def get_quotes(self, token, instruments): raise error
    monkeypatch.delenv('UPSTOX_ANALYTICS_TOKEN', raising=False)
    with pytest.raises(RuntimeError) as caught:
        asyncio.run(read_display_quotes(Broker(), 'synthetic', ['NSE:ABC'], user_id=73))
    assert caught.value is error


def test_comparison_reads_upstox_even_when_kite_has_every_price(monkeypatch):
    class Broker:
        async def get_quotes(self, token, instruments): return {'NSE:ABC': {'last_price': 10}}
    async def fallback(owner, requested):
        assert requested == ['NSE:ABC']
        return [{'instrument': 'NSE:ABC', 'price': 125, 'as_of': NOW.isoformat(), 'source': 'Upstox'}]
    monkeypatch.setattr(upstox, 'read_upstox_quotes', fallback)
    result = asyncio.run(read_display_quotes(Broker(), 'synthetic', ['NSE:ABC'], user_id=73))
    assert result['missing'] == [] and result['quotes'][0]['price'] == 10
    assert result['upstox_quotes'][0]['price'] == 125


def test_authenticated_route_passes_owner_to_fallback_on_kite_permission_denial(monkeypatch):
    from types import SimpleNamespace
    from app.domains.zerodha import router
    class Repo:
        def __init__(self, db): pass
        async def get_plaintext_token(self, user_id): return 'synthetic-kite'
    class Broker:
        async def get_quotes(self, token, instruments):
            raise router.KiteError('Insufficient permission', 'PermissionException')
    async def fallback(owner, instruments):
        assert owner == 73 and instruments == ['NSE:ABC']
        return [{'instrument': 'NSE:ABC', 'price': 125, 'as_of': NOW.isoformat(), 'source': 'Upstox'}]
    monkeypatch.setattr(router, 'ZerodhaCredentialRepository', Repo)
    monkeypatch.setattr(router, '_svc', Broker())
    monkeypatch.setattr(upstox, 'read_upstox_quotes', fallback)
    result = asyncio.run(router.portfolio_display_quotes(['NSE:ABC'], object(), SimpleNamespace(id=73)))
    assert result['missing'] == [] and result['quotes'][0]['source'] == 'Upstox'


def test_quote_capabilities_are_owner_scoped_and_expose_no_credential(monkeypatch):
    from types import SimpleNamespace
    from app.domains.zerodha import router
    monkeypatch.setenv('UPSTOX_ANALYTICS_TOKEN', 'synthetic-sensitive-value')
    monkeypatch.setenv('UPSTOX_LTP_OWNER_USER_ID', '73')
    assert asyncio.run(router.portfolio_quote_capabilities(SimpleNamespace(id=73))) == {'upstox_ltp_enabled': True}
    assert asyncio.run(router.portfolio_quote_capabilities(SimpleNamespace(id=74))) == {'upstox_ltp_enabled': False}
    monkeypatch.delenv('UPSTOX_ANALYTICS_TOKEN')
    assert asyncio.run(router.portfolio_quote_capabilities(SimpleNamespace(id=73))) == {'upstox_ltp_enabled': False}
