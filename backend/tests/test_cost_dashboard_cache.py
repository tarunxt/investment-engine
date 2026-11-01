import os
import time
from threading import Lock
from uuid import uuid4

os.environ.setdefault("DATABASE_URL", "sqlite:///./test.db")
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

from app.domains.cost_drivers import cache, service
from app.domains.cost_drivers.cache import RefreshCooldownError


class FakeRedis:
    def __init__(self):
        self._values: dict[str, tuple[str, float | None]] = {}
        self._guard = Lock()

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

    def lock(self, key, timeout=None, blocking=False):
        parent = self
        class Lease:
            token = uuid4().hex
            def acquire(self, blocking=False):
                with parent._guard:
                    return bool(parent.set(key, self.token, nx=True))
            def owned(self):
                return parent.get(key) == self.token
            def release(self):
                with parent._guard:
                    if parent.get(key) != self.token:
                        raise RuntimeError("synthetic ownership lost")
                    parent._values.pop(key, None)
        return Lease()

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

    first = service.get_dashboard(force_refresh=True, month="2026-07")
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

    cache.store_dashboard("2026-07:live", live_good, 60)
    seeded = service.get_dashboard(month="2026-07")
    next(states)  # seeded the good snapshot directly; refresh now fails
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


def test_concurrent_cache_misses_never_collect(monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    cache.reset_local_cost_dashboard_cache_state()
    monkeypatch.setattr(cache, "_redis_client", lambda: None)
    monkeypatch.delenv("COST_DASHBOARD_MOCK_MODE", raising=False)
    def forbidden(*args):
        raise AssertionError("passive reads must not collect")
    monkeypatch.setattr(service, "_aws_client", forbidden)
    monkeypatch.setattr(service, "_live_dashboard", forbidden)
    with ThreadPoolExecutor(max_workers=4) as workers:
        results = list(workers.map(lambda _: service.get_dashboard(month="2026-07"), range(8)))
    assert all(r["summary"]["monthToDateAwsCost"] is None for r in results)
    assert all(r["debug"]["collectionOccurred"] is False for r in results)


def test_refresh_fails_closed_without_shared_coordination(monkeypatch):
    import pytest
    monkeypatch.setattr(cache, "_redis_client", lambda: None)
    monkeypatch.delenv("COST_DASHBOARD_MOCK_MODE", raising=False)
    monkeypatch.setattr(service, "_live_dashboard", lambda *args: pytest.fail("must not collect"))
    with pytest.raises(cache.CollectionUnavailableError):
        service.get_dashboard(force_refresh=True, month="2026-07")
