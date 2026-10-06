import os
import time

os.environ.setdefault("DATABASE_URL", "sqlite:///./test.db")
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

from app.domains.cost_drivers import cache, service
from app.domains.cost_drivers.cache import RefreshCooldownError


class FakeRedis:
    def __init__(self):
        self._values: dict[str, tuple[str, float | None]] = {}

    def get(self, key: str):
        record = self._values.get(key)
        if not record:
            return None
        value, expires_at = record
        if expires_at is not None and time.time() >= expires_at:
            self._values.pop(key, None)
            return None
        return value

    def set(self, key: str, value: str, ex: int | None = None, nx: bool = False):
        if nx and self.get(key) is not None:
            return None
        expires_at = time.time() + ex if ex else None
        self._values[key] = (value, expires_at)
        return True

    def ttl(self, key: str) -> int:
        record = self._values.get(key)
        if not record:
            return -2
        _value, expires_at = record
        if expires_at is None:
            return -1
        return max(int(expires_at - time.time()), 0)

    def close(self):
        return None


def test_shared_refresh_cooldown_uses_redis_state(monkeypatch):
    fake_redis = FakeRedis()
    monkeypatch.setattr(cache.sync_redis, "from_url", lambda *args, **kwargs: fake_redis)

    cache.claim_refresh_cooldown("dashboard:2026-07")

    try:
        cache.claim_refresh_cooldown("dashboard:2026-07")
    except RefreshCooldownError as exc:
        assert exc.retry_after_seconds <= 900
        assert exc.retry_after_seconds >= 0
    else:
        raise AssertionError("Expected RefreshCooldownError on the second shared refresh claim")


def test_get_dashboard_reads_and_writes_shared_cache(monkeypatch):
    fake_redis = FakeRedis()
    monkeypatch.setattr(cache.sync_redis, "from_url", lambda *args, **kwargs: fake_redis)
    cache.reset_local_cost_dashboard_cache_state()
    monkeypatch.delenv("COST_DASHBOARD_MOCK_MODE", raising=False)

    calls = {"count": 0}

    def fake_live_dashboard(month: str | None = None):
        calls["count"] += 1
        return {
            "summary": {"monthToDateAwsCost": 10},
            "dailyCostTrend": [],
            "dataTransferTrend": [],
            "topServices": [{"name": "AWS Data Transfer", "cost": 10, "usageQuantity": 12, "unit": "GB"}],
            "topUsageTypes": [],
            "costDrivers": [],
            "traffic": [],
            "recommendations": [],
            "inventory": {"instances": [], "volumes": [], "logGroups": [], "publicIpv4Addresses": [], "lightsail": {"instances": [], "staticIps": [], "disks": [], "snapshots": []}, "missingPermissions": []},
            "diagnostics": [],
            "debug": {"mockMode": False},
        }

    monkeypatch.setattr(service, "_live_dashboard", fake_live_dashboard)

    first = service.get_dashboard(month="2026-07")
    second = service.get_dashboard(month="2026-07")

    assert calls["count"] == 1
    assert first["summary"]["monthToDateAwsCost"] == 10
    assert second["summary"]["monthToDateAwsCost"] == 10
    assert second["debug"]["lastAwsRefreshTime"] is not None


def test_get_dashboard_preserves_stale_good_data_when_live_refresh_fails(monkeypatch):
    fake_redis = FakeRedis()
    monkeypatch.setattr(cache.sync_redis, "from_url", lambda *args, **kwargs: fake_redis)
    cache.reset_local_cost_dashboard_cache_state()
    monkeypatch.delenv("COST_DASHBOARD_MOCK_MODE", raising=False)
    monkeypatch.setattr(service, "claim_refresh_cooldown", lambda *args, **kwargs: None)

    live_good = {
        "summary": {"monthToDateAwsCost": 42},
        "dailyCostTrend": [],
        "dataTransferTrend": [],
        "topServices": [{"name": "AWS Data Transfer", "cost": 18.4, "usageQuantity": 89.15, "unit": "GB"}],
        "topUsageTypes": [],
        "costDrivers": [],
        "traffic": [],
        "recommendations": [],
        "inventory": {"instances": [], "volumes": [], "logGroups": [], "publicIpv4Addresses": [], "lightsail": {"instances": [], "staticIps": [], "disks": [], "snapshots": []}, "missingPermissions": []},
        "diagnostics": [],
        "debug": {"mockMode": False},
    }

    live_failed = service._empty_live_dashboard("2026-07")
    live_failed["diagnostics"] = [
        {"service": "Cost Explorer", "status": "error", "message": "temporary aws failure"}
    ]
    live_failed["debug"] = {"mockMode": False}

    states = iter([live_good, live_failed])
    monkeypatch.setattr(service, "_live_dashboard", lambda month=None: next(states))

    seeded = service.get_dashboard(force_refresh=True, month="2026-07")
    fallback = service.get_dashboard(force_refresh=True, month="2026-07")

    assert seeded["summary"]["monthToDateAwsCost"] == 42
    assert fallback["summary"]["monthToDateAwsCost"] == 42
    assert fallback["debug"]["servedStaleData"] is True
    assert fallback["diagnostics"][-1]["status"] == "stale"


def test_redis_cache_waits_are_bounded_without_retries():
    # Construction is lazy and never opens a Redis connection.
    client = cache._redis_client()
    assert client is not None
    try:
        config = client.connection_pool.connection_kwargs
        assert config["socket_connect_timeout"] == 0.5
        assert config["socket_timeout"] == 0.5
        assert config["retry"].get_retries() == 0
        assert not config.get("retry_on_timeout", False)
    finally:
        client.close()


def test_cache_socket_timeout_preserves_local_fallback(monkeypatch):
    cache.reset_local_cost_dashboard_cache_state()
    monkeypatch.setattr(cache, "_redis_client", lambda: None)
    payload = {"summary": {"monthToDateAwsCost": 10}, "debug": {}}
    cache.store_dashboard("fixture", payload, ttl_seconds=60)
    closed = []

    class TimedOutRedis:
        def get(self, _key):
            raise cache.sync_redis.TimeoutError("synthetic cache timeout")

        def close(self):
            closed.append(True)

    monkeypatch.setattr(cache, "_redis_client", TimedOutRedis)
    assert cache.load_cached_dashboard("fixture").data == payload
    assert cache.load_stale_good_dashboard("fixture").data == payload
    assert closed == [True, True]
    cache.reset_local_cost_dashboard_cache_state()


def test_concurrent_cache_misses_collect_once(monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event

    cache.reset_local_cost_dashboard_cache_state()
    monkeypatch.setattr(cache, "_redis_client", lambda: None)
    monkeypatch.delenv("COST_DASHBOARD_MOCK_MODE", raising=False)
    started = Event()
    release = Event()
    second_attempted = Event()
    calls = []

    def live_dashboard(month):
        calls.append(month)
        started.set()
        release.wait(timeout=2)
        return service._empty_live_dashboard(month)

    def second_read():
        second_attempted.set()
        return service.get_dashboard(month="2026-07")

    monkeypatch.setattr(service, "_live_dashboard", live_dashboard)
    with ThreadPoolExecutor(max_workers=2) as workers:
        first = workers.submit(service.get_dashboard, month="2026-07")
        try:
            assert started.wait(timeout=1)
            second = workers.submit(second_read)
            assert second_attempted.wait(timeout=1)
            # Let the second request reach the same missing cache while the
            # first request still owns collection.
            time.sleep(0.05)
            assert calls == ["2026-07"]
        finally:
            release.set()
        assert first.result(timeout=1) == second.result(timeout=1)
    assert calls == ["2026-07"]
    assert "2026-07:live" not in service._DASHBOARD_LOCKS
    cache.reset_local_cost_dashboard_cache_state()


def test_concurrent_manual_refresh_preserves_local_cooldown(monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    cache.reset_local_cost_dashboard_cache_state()
    monkeypatch.setattr(cache, "_redis_client", lambda: None)
    monkeypatch.delenv("COST_DASHBOARD_MOCK_MODE", raising=False)
    callers = Barrier(2)
    calls = []

    def live_dashboard(month):
        calls.append(month)
        return service._empty_live_dashboard(month)

    def refresh():
        callers.wait(timeout=1)
        try:
            service.get_dashboard(force_refresh=True, month="2026-07")
            return "ok"
        except RefreshCooldownError as exc:
            assert 0 <= exc.retry_after_seconds <= 900
            return "cooldown"

    monkeypatch.setattr(service, "_live_dashboard", live_dashboard)
    with ThreadPoolExecutor(max_workers=2) as workers:
        results = list(workers.map(lambda _index: refresh(), range(2)))
    assert sorted(results) == ["cooldown", "ok"]
    assert calls == ["2026-07"]
    cache.reset_local_cost_dashboard_cache_state()
