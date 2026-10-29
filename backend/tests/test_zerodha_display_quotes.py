import asyncio
from types import SimpleNamespace
import pytest
from fastapi import HTTPException
from app.domains.zerodha.display_quotes import read_display_quotes, validate_instruments
from app.domains.zerodha import router


def test_exact_quote_batch_has_no_close_average_or_cross_venue_fallback():
    class Service:
        calls = []
        async def get_quotes(self, token, instruments):
            self.calls.append((token, instruments))
            return {'NSE:CDSL': {'last_price': 1234.5}, 'BSE:CDSL': {'last_price': 999}, 'NSE:ZERO': {'last_price': 0, 'close': 50}, 'NSE:AVG': {'average_price': 100}, 'NSE:NAN': {'last_price': float('nan')}, 'NSE:BOOL': {'last_price': True}}
    service = Service()
    keys = validate_instruments(['NSE:CDSL','NSE:CDSL','NSE:ZERO','NSE:AVG','NSE:NAN','NSE:BOOL'])
    result = asyncio.run(read_display_quotes(service, 'synthetic-token', keys))
    assert len(service.calls) == 1
    assert len(result['quotes']) == 1
    assert result['quotes'][0]['instrument'] == 'NSE:CDSL'
    assert result['quotes'][0]['price'] == 1234.5
    assert '+00:00' in result['quotes'][0]['as_of']
    assert 'server receipt' in result['quotes'][0]['source']
    assert set(result['missing']) == set(keys) - {'NSE:CDSL'}
    for invalid in [[], ['NSE:ABC']*501, ['NASDAQ:ABC'], ['NSE:ABC&BSE:OTHER'], ['NSE:'], ['NSE:ABC/DEF']]:
        with pytest.raises(ValueError): validate_instruments(invalid)


def test_quote_route_uses_authenticated_owner_and_never_prepares_or_submits_orders(monkeypatch):
    owners = []
    class Repo:
        def __init__(self, db): pass
        async def get_plaintext_token(self, user_id): owners.append(user_id); return 'synthetic-token'
    class Service:
        async def get_quotes(self, token, instruments): return {'NSE:CDSL': {'last_price': 100}}
    monkeypatch.setattr(router, 'ZerodhaCredentialRepository', Repo)
    monkeypatch.setattr(router, '_svc', Service())
    result = asyncio.run(router.portfolio_display_quotes(['NSE:CDSL'], object(), SimpleNamespace(id=73)))
    assert owners == [73]
    assert result['quotes'][0]['price'] == 100
    class Disconnected(Repo):
        async def get_plaintext_token(self, user_id): return None
    monkeypatch.setattr(router, 'ZerodhaCredentialRepository', Disconnected)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(router.portfolio_display_quotes(['NSE:CDSL'], object(), SimpleNamespace(id=74)))
    assert exc.value.status_code == 401


def test_existing_recovery_read_boundary_remains_intact(monkeypatch):
    from app.core.recovery import recovery_http_allowed
    monkeypatch.setenv('CREDX_RECOVERY_MODE', '1')
    assert recovery_http_allowed('GET', '/zerodha/portfolio/quotes')
    assert not recovery_http_allowed('POST', '/zerodha/orders/prepare-basket')
    assert not recovery_http_allowed('POST', '/zerodha/portfolio/quotes')


def test_quote_permission_failure_never_becomes_requested_limit_price(monkeypatch):
    class Repo:
        def __init__(self, db): pass
        async def get_plaintext_token(self, user_id): return 'synthetic-token'
    class Service:
        async def get_quotes(self, token, instruments): raise router.KiteError('Synthetic quote permission unavailable')
    monkeypatch.setattr(router, 'ZerodhaCredentialRepository', Repo)
    monkeypatch.setattr(router, '_svc', Service())
    with pytest.raises(HTTPException) as exc:
        asyncio.run(router.portfolio_display_quotes(['NSE:CDSL'], object(), SimpleNamespace(id=73)))
    assert exc.value.status_code == 400
    assert 'unavailable' in exc.value.detail
