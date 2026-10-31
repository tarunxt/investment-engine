"""Offline distributed fixtures: actual Lua against fakeredis, no provider/network."""
import asyncio
from datetime import datetime, timezone

import fakeredis.aioredis
import pytest
from redis.exceptions import ConnectionError

from app.domains.zerodha import upstox_quote_guard as guard


async def established(g):
    # Fixture models an existing account with a fully elapsed quiet window.
    sec, micro = await g.redis.time()
    await g.redis.set(g.base + ':history', sec * 1000 + micro // 1000 - 1_800_001)


def test_all_sliding_windows_and_recovery(monkeypatch):
    async def run():
        for window, limit in guard.LIMITS:
            async with fakeredis.aioredis.FakeRedis(decode_responses=True) as redis:
                g = guard.QuoteGuard(redis, 73, 'dummy', ['NSE:ABC'])
                sec, micro = await redis.time()
                now = sec * 1000 + micro // 1000
                await established(g)
                # Place history outside shorter windows but inside this one.
                score = now - (0 if window == 1000 else 2000 if window == 60000 else 61000)
                await redis.zadd(g.base + ':requests', {str(i): score for i in range(limit)})
                assert not await g.admit()
                await redis.zadd(g.base + ':requests', {str(i): now - window - 10 for i in range(limit)})
                assert await g.admit()
                assert await redis.hget(g.stats, 'quota_blocked') == '1'
    asyncio.run(run())


def test_concurrent_processes_cannot_exceed_budget_or_reset_on_rotation():
    async def run():
        server = fakeredis.FakeServer()
        clients = [fakeredis.aioredis.FakeRedis(server=server, decode_responses=True) for _ in range(40)]
        try:
            guards = [guard.QuoteGuard(r, 73, str(i), ['NSE:ABC']) for i, r in enumerate(clients)]
            await established(guards[0])
            assert sum(await asyncio.gather(*(g.admit() for g in guards))) == 20
            assert len({g.base for g in guards}) == 1
            assert len({g.cache for g in guards}) == 40
        finally:
            await asyncio.gather(*(r.aclose() for r in clients))
    asyncio.run(run())


def test_cache_stampede_failure_expiry_and_scope(monkeypatch):
    monkeypatch.setattr(guard, 'CACHE_SECONDS', 1)
    monkeypatch.setattr(guard, 'FAILURE_SECONDS', 1)
    async def run():
        server = fakeredis.FakeServer()
        calls = []
        rows = [{'instrument': 'NSE:ABC', 'price': 125, 'as_of': '2026-10-30T08:00:00+00:00',
                 'source': 'Upstox retrieved 2026-10-30T08:01:00+00:00; display only'}]
        async def fetch(g):
            calls.append(1)
            await asyncio.sleep(.02)
            return rows
        clients = [fakeredis.aioredis.FakeRedis(server=server, decode_responses=True) for _ in range(20)]
        try:
            guards = [guard.QuoteGuard(r, 73, 'dummy', ['NSE:ABC']) for r in clients]
            await established(guards[0])
            results = await asyncio.gather(*(g.run(fetch) for g in guards))
            assert len(calls) == 1 and all(r[0]['price'] == 125 for r in results)
            cached = await guards[0].run(fetch)
            assert cached[0]['as_of'] == rows[0]['as_of']
            assert rows[0]['source'] in cached[0]['source'] and 'cached display' in cached[0]['source']
            for owner, generation, instrument in [(74, 'dummy', 'NSE:ABC'), (73, 'rotated', 'NSE:ABC'), (73, 'dummy', 'BSE:ABC')]:
                other = guard.QuoteGuard(clients[0], owner, generation, [instrument])
                assert await other.cached() is None
            await asyncio.sleep(1.05)
            await guards[0].run(fetch)
            assert len(calls) == 2
            async def empty(g):
                calls.append(1)
                return []
            await clients[0].delete(guards[0].cache)
            assert await guards[0].run(empty) == []
            assert await guards[0].run(fetch) == [] and len(calls) == 3
        finally:
            await asyncio.gather(*(r.aclose() for r in clients))
    asyncio.run(run())


def test_retry_after_and_account_wide_backoff():
    now = datetime(2026, 10, 31, 10, tzinfo=timezone.utc)
    for value in [None, '', 'bad', '-1', 'nan', 'inf', '0']:
        assert guard.retry_after_seconds(value, now) == 60
    assert guard.retry_after_seconds('120', now) == 120
    assert guard.retry_after_seconds('Sat, 31 Oct 2026 10:03:00 GMT', now) == 180
    async def run():
        async with fakeredis.aioredis.FakeRedis(decode_responses=True) as redis:
            g = guard.QuoteGuard(redis, 73, 'dummy', ['NSE:ABC'])
            await established(g)
            await g.backoff('120')
            await g.backoff('60')
            assert await redis.pttl(g.cooldown) > 119000
            other = guard.QuoteGuard(redis, 73, 'rotated', ['BSE:XYZ'])
            assert not await other.admit()
            assert await redis.hget(g.stats, 'provider_429') == '2'
            await redis.delete(g.cooldown)  # fake clock expiry, no provider retry
            assert await other.admit()
    asyncio.run(run())


def test_redis_failure_is_closed_and_never_logs_credentials(monkeypatch, caplog):
    monkeypatch.setenv('UPSTOX_ANALYTICS_TOKEN', 'dummy-private-token')
    calls = []
    def unavailable():
        raise ConnectionError('dummy-private-token redis://sensitive')
    monkeypatch.setattr(guard, 'redis_client', unavailable)
    async def fetch(g): calls.append(1)
    assert asyncio.run(guard.guarded_quotes(73, ['NSE:ABC'], fetch)) == []
    assert not calls and 'dummy-private-token' not in caplog.text and 'redis://' not in caplog.text


def test_cancelled_leader_releases_lock_and_counts_consumed_budget():
    async def run():
        async with fakeredis.aioredis.FakeRedis(decode_responses=True) as redis:
            g = guard.QuoteGuard(redis, 73, 'dummy', ['NSE:ABC'])
            await established(g)
            started = asyncio.Event()
            async def fetch(g):
                assert await g.admit()
                started.set()
                await asyncio.Future()
            task = asyncio.create_task(g.run(fetch))
            await started.wait()
            task.cancel()
            with pytest.raises(asyncio.CancelledError): await task
            assert not await redis.exists(g.lock)
            assert await redis.hget(g.stats, 'admitted') == '1'
    asyncio.run(run())


def test_fake_clock_cold_start_loss_and_window_boundaries(monkeypatch):
    import time
    clock = [1_800_000_000.0]
    monkeypatch.setattr(time, 'time', lambda: clock[0])
    async def run():
        async with fakeredis.aioredis.FakeRedis(decode_responses=True) as redis:
            g = guard.QuoteGuard(redis, 73, 'dummy', ['NSE:ABC'])
            assert not await g.admit()  # Unknown pre-release history, fail closed.
            clock[0] += 1800.001
            assert await g.admit()
            # Exact sliding-second boundary frees the first reservation.
            for _ in range(19):
                g.token = __import__('uuid').uuid4().hex
                assert await g.admit()
            g.token = 'next'
            assert not await g.admit()
            clock[0] += 1
            assert await g.admit()
            # Partial state eviction cannot erase recently consumed quota.
            await redis.delete(g.base + ':requests')
            assert not await g.admit()
            clock[0] += 1800.001
            assert await g.admit()
            # Full Redis history loss also starts a conservative quiet window.
            await redis.flushdb()
            assert not await g.admit()
    asyncio.run(run())


@pytest.mark.parametrize('status', [200, 429, 503])
def test_complete_adapter_uses_shared_guard_without_external_requests(monkeypatch, status, caplog):
    import httpx
    from app.domains.zerodha import upstox_quotes as quotes
    monkeypatch.setenv('UPSTOX_LTP_OWNER_USER_ID', '73')
    monkeypatch.setenv('UPSTOX_ANALYTICS_TOKEN', 'dummy-secret-do-not-log')
    server = fakeredis.FakeServer()
    monkeypatch.setattr(guard, 'redis_client', lambda: fakeredis.aioredis.FakeRedis(server=server, decode_responses=True))
    key = 'NSE_EQ|INE123456789'
    async def master(client): return {'NSE:ABC': key, 'BSE:OTHER': 'BSE_EQ|INE123456789'}
    monkeypatch.setattr(quotes, 'load_instruments', master)
    real_client = httpx.AsyncClient
    calls = []
    def handler(request):
        calls.append(request)
        assert request.url.host == 'api.upstox.com'
        stamp = int(datetime.now(timezone.utc).timestamp() * 1000)
        return httpx.Response(status, headers={'Retry-After': '90'}, json={
            'status': 'success', 'data': {'row': {'instrument_token': key, 'last_price': 125, 'last_trade_time': stamp}}})
    monkeypatch.setattr(quotes.httpx, 'AsyncClient', lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw))
    async def run():
        async with guard.redis_client() as redis:
            g = guard.QuoteGuard(redis, 73, 'fixture', ['NSE:ABC'])
            await established(g)
            first = await quotes.read_upstox_quotes(73, ['NSE:ABC'])
            second = await quotes.read_upstox_quotes(73, ['NSE:ABC'])
            assert bool(first) == (status == 200)
            assert bool(second) == bool(first) and len(calls) == 1
            if status == 200:
                assert first[0]['as_of'] == second[0]['as_of']
                assert 'cached display' in second[0]['source']
            if status == 429:
                assert await quotes.read_upstox_quotes(73, ['BSE:OTHER']) == []
                assert len(calls) == 1
                assert await redis.hget(g.stats, 'provider_429') == '1'
            assert await quotes.read_upstox_quotes(74, ['NSE:ABC']) == []
            assert len(calls) == 1
            assert await redis.hget(g.stats, 'admitted') == '1'
    asyncio.run(run())
    assert 'dummy-secret-do-not-log' not in caplog.text


def test_admission_follows_slow_mapping_and_precedes_send(monkeypatch):
    import httpx
    from app.domains.zerodha import upstox_quotes as quotes
    monkeypatch.setenv('UPSTOX_ANALYTICS_TOKEN', 'offline-dummy')
    events = []
    async def master(client):
        events.append('mapping')
        await asyncio.sleep(.01)
        return {'NSE:ABC': 'NSE_EQ|INE123456789'}
    class Guard:
        async def admit(self):
            events.append('admission')
            return True
        async def count(self, field): pass
    def send(request):
        events.append('send')
        return httpx.Response(200, json={'status': 'success', 'data': {}})
    real = httpx.AsyncClient
    monkeypatch.setattr(quotes, 'load_instruments', master)
    monkeypatch.setattr(quotes.httpx, 'AsyncClient', lambda **kw: real(transport=httpx.MockTransport(send), **kw))
    asyncio.run(quotes._fetch_quotes(['NSE:ABC'], Guard()))
    assert events == ['mapping', 'admission', 'send']
