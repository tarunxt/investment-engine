import multiprocessing
import time
import pytest
from app.domains.cost_drivers import cache, service, collection
from test_cost_dashboard_cache import FakeRedis


@pytest.fixture
def shared(monkeypatch):
    fake = FakeRedis()
    monkeypatch.setattr(cache, "_redis_client", lambda: fake)
    monkeypatch.delenv("COST_DASHBOARD_MOCK_MODE", raising=False)
    cache.reset_local_cost_dashboard_cache_state()
    return fake


@pytest.mark.parametrize("month", ["2026-11", "2026-07"])
def test_passive_absent_expired_warm_and_stale(shared, monkeypatch, month):
    monkeypatch.setattr(service, "_aws_client", lambda *args: pytest.fail("AWS call from GET"))
    assert service.get_dashboard(month=month)["summary"]["monthToDateAwsCost"] is None
    data = service._empty_live_dashboard(month)
    data["summary"]["monthToDateAwsCost"] = 7
    data["debug"]["billingProvenance"] = {"complete": True, "dataCutoff": None, "collectedAt": "2026-07-01T00:00:00+00:00"}
    source = cache.store_dashboard(month + ":live", data, 1)
    assert service.get_dashboard(month=month)["debug"]["collectionOccurred"] is False
    key = cache._cache_key("dashboard", month + ":live")
    shared._values[key] = (shared._values[key][0], time.time() - 1)
    stale = service.get_dashboard(month=month)
    assert stale["summary"]["monthToDateAwsCost"] == 7
    assert stale["debug"]["lastAwsRefreshTime"] == source
    assert stale["debug"]["billingProvenance"]["dataCutoff"] is None
    assert stale["debug"]["servedStaleData"] is True
    assert stale["debug"]["collectionOccurred"] is False


def test_shared_lease_excludes_owner_and_releases_on_cancel(shared):
    with pytest.raises(KeyboardInterrupt):
        with cache.collection_lease("key"):
            with pytest.raises(cache.CollectionUnavailableError, match="already in progress"):
                with cache.collection_lease("key"):
                    pytest.fail("duplicate owner")
            raise KeyboardInterrupt()
    with cache.collection_lease("key"):
        pass


def test_collector_failure_retains_stale_good_and_cooldown(shared, monkeypatch):
    month = "2026-07"
    data = service._empty_live_dashboard(month)
    data["summary"]["monthToDateAwsCost"] = 42
    source = cache.store_dashboard(month + ":live", data, 60)
    failed = service._empty_live_dashboard(month)
    failed["diagnostics"] = [{"service": "Cost Explorer", "status": "error", "message": "synthetic failure"}]
    monkeypatch.setattr(service, "_live_dashboard", lambda month: failed)
    result = service.get_dashboard(force_refresh=True, month=month)
    assert result["summary"]["monthToDateAwsCost"] == 42
    assert result["debug"]["lastAwsRefreshTime"] == source
    assert result["debug"]["collectionOccurred"] is True
    with pytest.raises(cache.RefreshCooldownError):
        service.get_dashboard(force_refresh=True, month=month)


def test_actual_provider_calls_including_failure_are_metered_and_capped():
    class Client:
        calls = 0
        def request(self):
            self.calls += 1
            if self.calls == 1:
                raise RuntimeError("synthetic provider failure")
    fake = Client()
    client = collection.MeteredClient(fake, "fake")
    with collection.collection_budget() as meter:
        with pytest.raises(RuntimeError):
            client.request()
        for _ in range(99):
            client.request()
        with pytest.raises(RuntimeError, match="budget exhausted"):
            client.request()
    assert fake.calls == meter["requests"] == 100
    assert meter["byService"] == {"fake": 100}
    assert meter["sdkRetries"] == 0


class ProcessRedis(FakeRedis):
    def __init__(self, values, guard):
        self._values, self._guard = values, guard


def process_owner(values, guard, ready, release, results):
    fake = ProcessRedis(values, guard)
    cache._redis_client = lambda: fake
    try:
        with cache.collection_lease("process-key"):
            results.put("owner")
            ready.set()
            release.wait(5)
    except cache.CollectionUnavailableError:
        results.put("excluded")


def test_shared_fake_coordination_across_processes():
    ctx = multiprocessing.get_context("fork")
    with ctx.Manager() as manager:
        values, guard = manager.dict(), manager.RLock()
        ready, release, results = ctx.Event(), ctx.Event(), ctx.Queue()
        first = ctx.Process(target=process_owner, args=(values, guard, ready, release, results))
        second = ctx.Process(target=process_owner, args=(values, guard, ready, release, results))
        first.start()
        try:
            assert ready.wait(3)
            second.start()
            second.join(3)
            assert second.exitcode == 0
        finally:
            release.set()
            first.join(3)
            if second.pid and second.is_alive():
                second.terminate()
        assert first.exitcode == 0
        assert sorted([results.get(timeout=1), results.get(timeout=1)]) == ["excluded", "owner"]


def test_unhandled_collector_failure_keeps_snapshot(shared, monkeypatch):
    data = service._empty_live_dashboard("2026-07")
    data["summary"]["monthToDateAwsCost"] = 42
    cache.store_dashboard("2026-07:live", data, 60)
    def fail(month):
        raise RuntimeError("synthetic unhandled collector failure")
    monkeypatch.setattr(service, "_live_dashboard", fail)
    result = service.get_dashboard(force_refresh=True, month="2026-07")
    assert result["summary"]["monthToDateAwsCost"] == 42
    assert result["debug"]["servedStaleData"] is True
    assert result["debug"]["lastCollectionAttemptMeter"]["requests"] == 0


def test_partial_snapshot_does_not_overwrite_last_good(shared):
    data = service._empty_live_dashboard("2026-07")
    data["summary"]["monthToDateAwsCost"] = 42
    cache.store_dashboard("2026-07:live", data, 60)
    partial = service._empty_live_dashboard("2026-07")
    partial["debug"]["billingProvenance"] = {"complete": False}
    cache.store_dashboard("2026-07:live", partial, 60)
    assert cache.load_stale_good_dashboard("2026-07:live").data["summary"]["monthToDateAwsCost"] == 42


def test_lost_lock_stops_old_owner_and_preserves_successor(shared):
    key = cache._cache_key("collector", "lost")
    class Client:
        calls = 0
        def request(self):
            self.calls += 1
    provider = Client()
    with cache.collection_lease("lost") as require_owner:
        with collection.collection_budget(require_owner) as meter:
            client = collection.MeteredClient(provider, "fake")
            client.request()
            shared._values.pop(key)
            with cache.collection_lease("lost") as require_successor:
                with pytest.raises(cache.CollectionUnavailableError, match="ownership lost"):
                    client.request()
                require_successor()
                assert provider.calls == meter["requests"] == 1


def test_old_owner_cleanup_cannot_release_new_owner(shared):
    key = cache._cache_key("collector", "replacement")
    first = cache.collection_lease("replacement")
    first.__enter__()
    shared._values.pop(key)
    with cache.collection_lease("replacement") as successor:
        first.__exit__(None, None, None)
        successor()
        assert key in shared._values


def test_redis_outage_stops_next_call_and_does_not_mask_cancel(shared, monkeypatch):
    closed = []
    monkeypatch.setattr(shared, "close", lambda: closed.append(True))
    class Client:
        def request(self):
            pytest.fail("unverifiable owner must not call provider")
    with pytest.raises(KeyboardInterrupt):
        with cache.collection_lease("outage") as require_owner:
            monkeypatch.setattr(shared, "get", lambda key: (_ for _ in ()).throw(RuntimeError("synthetic Redis outage")))
            with collection.collection_budget(require_owner) as meter:
                with pytest.raises(cache.CollectionUnavailableError, match="cannot be verified"):
                    collection.MeteredClient(Client(), "fake").request()
            assert meter["requests"] == 0
            raise KeyboardInterrupt()
    assert closed == [True]


def test_lost_lock_result_never_overwrites_stale_good(shared, monkeypatch):
    month, key = "2026-07", "2026-07:live"
    prior = service._empty_live_dashboard(month)
    prior["summary"]["monthToDateAwsCost"] = 42
    cache.store_dashboard(key, prior, 60)
    def lose_lock(month):
        shared._values.pop(cache._cache_key("collector", key))
        result = service._empty_live_dashboard(month)
        result["summary"]["monthToDateAwsCost"] = 99
        return result
    monkeypatch.setattr(service, "_live_dashboard", lose_lock)
    with pytest.raises(cache.CollectionUnavailableError, match="ownership lost"):
        service.get_dashboard(force_refresh=True, month=month)
    assert cache.load_stale_good_dashboard(key).data["summary"]["monthToDateAwsCost"] == 42
    assert service.get_dashboard(month=month)["summary"]["monthToDateAwsCost"] == 42


def test_crashed_process_leaves_nonexpiring_ownership_for_operator(monkeypatch):
    ctx = multiprocessing.get_context("fork")
    with ctx.Manager() as manager:
        values, guard = manager.dict(), manager.RLock()
        ready, release, results = ctx.Event(), ctx.Event(), ctx.Queue()
        owner = ctx.Process(target=process_owner, args=(values, guard, ready, release, results))
        owner.start()
        try:
            assert ready.wait(3)
            assert results.get(timeout=1) == "owner"
            owner.terminate()
            owner.join(3)
            assert owner.exitcode is not None
            fake = ProcessRedis(values, guard)
            monkeypatch.setattr(cache, "_redis_client", lambda: fake)
            with pytest.raises(cache.CollectionUnavailableError, match="already in progress"):
                with cache.collection_lease("process-key"):
                    pytest.fail("orphan lock must not auto-recover")
            assert values[cache._cache_key("collector", "process-key")][1] is None
        finally:
            if owner.is_alive():
                owner.terminate()
                owner.join(3)


def test_redis_lock_loss_can_overlap_an_already_inflight_request(shared):
    """Known acceptance gap: Redis ownership cannot fence a remote AWS request."""
    from threading import Event
    from concurrent.futures import ThreadPoolExecutor
    entered, finish = Event(), Event()
    active, maximum, requests = [], [], []
    class Provider:
        def request(self, owner):
            requests.append(owner)
            active.append(owner)
            maximum.append(len(active))
            if owner == "old":
                entered.set()
                assert finish.wait(3)
            active.remove(owner)
    provider = Provider()
    def old_owner():
        with cache.collection_lease("inflight") as require_owner:
            with collection.collection_budget(require_owner):
                client = collection.MeteredClient(provider, "fake")
                client.request("old")
                with pytest.raises(cache.CollectionUnavailableError, match="ownership lost"):
                    client.request("old-after-loss")
    with ThreadPoolExecutor(max_workers=1) as workers:
        old = workers.submit(old_owner)
        try:
            assert entered.wait(2)
            shared._values.clear()  # restart loses lock and cooldown state
            with cache.collection_lease("inflight") as require_new:
                with collection.collection_budget(require_new):
                    collection.MeteredClient(provider, "fake").request("new")
            assert max(maximum) == 2  # evidence of remaining gap, not exclusion
        finally:
            finish.set()
        old.result(timeout=2)
    assert requests == ["old", "new"]


def test_passive_read_after_total_redis_loss_stays_unknown_without_collection(shared, monkeypatch):
    data = service._empty_live_dashboard("2026-07")
    data["summary"]["monthToDateAwsCost"] = 42
    cache.store_dashboard("2026-07:live", data, 60)
    shared._values.clear()
    monkeypatch.setattr(service, "_aws_client", lambda *args: pytest.fail("passive read must not recover by collection"))
    monkeypatch.setattr(service, "_live_dashboard", lambda *args: pytest.fail("passive read must not collect"))
    result = service.get_dashboard(month="2026-07")
    assert result["summary"]["monthToDateAwsCost"] is None
    assert result["debug"]["snapshotState"] == "not_collected"
    assert result["debug"]["collectionOccurred"] is False


def test_passive_read_during_redis_outage_retains_local_source_age(monkeypatch):
    cache.reset_local_cost_dashboard_cache_state()
    monkeypatch.delenv("COST_DASHBOARD_MOCK_MODE", raising=False)
    monkeypatch.setattr(cache, "_redis_client", lambda: None)
    data = service._empty_live_dashboard("2026-07")
    data["summary"]["monthToDateAwsCost"] = 42
    data["debug"]["billingProvenance"] = {"complete": True, "dataCutoff": None,
                                           "collectedAt": "2026-07-01T00:00:00+00:00"}
    source = cache.store_dashboard("2026-07:live", data, 60)
    class Outage:
        def get(self, key):
            raise RuntimeError("synthetic Redis outage")
        def close(self):
            pass
    monkeypatch.setattr(cache, "_redis_client", Outage)
    monkeypatch.setattr(service, "_aws_client", lambda *args: pytest.fail("passive AWS call"))
    result = service.get_dashboard(month="2026-07")
    assert result["summary"]["monthToDateAwsCost"] == 42
    assert result["debug"]["lastAwsRefreshTime"] == source
    assert result["debug"]["sourceAgeSeconds"] > 0
    assert result["debug"]["billingProvenance"]["dataCutoff"] is None
    assert result["debug"]["collectionOccurred"] is False
