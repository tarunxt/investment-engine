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
