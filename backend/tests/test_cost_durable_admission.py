"""Synthetic SQL/Redis/transport acceptance; no runtime migration or AWS client."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import multiprocessing
from threading import Event

import pytest
from sqlalchemy import create_engine, select, update
from sqlalchemy.orm import Session, sessionmaker

from app.domains.cost_drivers import admission, cache, collection, service
from test_cost_collection_lifecycle import ProcessRedis
from test_cost_dashboard_cache import FakeRedis

T = admission.Intent


def ledger_row(key):
    with admission.SyncSessionLocal() as db:
        return db.execute(select(T).where(T.c.scope_key == key)).mappings().first()


def test_live_owner_blocks_second_after_redis_loss(monkeypatch):
    redis = FakeRedis()
    monkeypatch.setattr(cache, "_redis_client", lambda: redis)
    entered, finish = Event(), Event()
    calls = []
    class Provider:
        def request(self):
            calls.append("issued")
            entered.set()
            assert finish.wait(3)
    def owner():
        with admission.durable_collection("scope") as intent, cache.collection_lease("scope") as check:
            with collection.collection_budget(check, intent):
                collection.MeteredClient(Provider(), "fake").request()
    with ThreadPoolExecutor(max_workers=1) as pool:
        first = pool.submit(owner)
        try:
            assert entered.wait(2)
            redis._values.clear()
            with pytest.raises(cache.CollectionUnavailableError):
                with admission.durable_collection("scope"):
                    pytest.fail("second owner must not issue work")
            assert ledger_row("scope").request_inflight
        finally:
            finish.set()
        first.result(timeout=2)
    assert calls == ["issued"]
    assert ledger_row("scope").state == "idle"
    # Even successful completion does not let lost Redis bypass the cooldown.
    with pytest.raises(cache.RefreshCooldownError):
        with admission.durable_collection("scope"):
            pytest.fail("durable cooldown bypass")


def test_ambiguous_external_acceptance_never_auto_recovers():
    accepted = []
    class Provider:
        def request(self):
            accepted.append(True)
            raise TimeoutError("response lost after synthetic remote acceptance")
    with admission.durable_collection("ambiguous") as intent:
        with collection.collection_budget(intent=intent):
            with pytest.raises(TimeoutError):
                collection.MeteredClient(Provider(), "fake").request()
            with pytest.raises(cache.CollectionUnavailableError):
                collection.MeteredClient(Provider(), "fake").request()
    row = ledger_row("ambiguous")
    assert row.state == "uncertain" and row.request_inflight
    assert accepted == [True]
    with admission.SyncSessionLocal() as db:
        db.execute(update(T).where(T.c.scope_key == "ambiguous").values(next_allowed_at=datetime(2000, 1, 1)))
        db.commit()
    with pytest.raises(cache.CollectionUnavailableError):
        with admission.durable_collection("ambiguous"):
            pytest.fail("elapsed cooldown must not reclaim unresolved acceptance")


@pytest.mark.parametrize("commit_number", [1, 2, 3])
def test_ambiguous_ledger_commit_blocks_replacement(monkeypatch, commit_number):
    normal = admission.SyncSessionLocal
    engine = normal.kw["bind"]
    count, accepted = [], []
    class AmbiguousSession(Session):
        def commit(self):
            super().commit()
            count.append(True)
            if len(count) == commit_number:
                raise RuntimeError("synthetic commit acknowledgement lost")
    monkeypatch.setattr(admission, "SyncSessionLocal", sessionmaker(bind=engine, class_=AmbiguousSession))
    class Provider:
        def request(self):
            accepted.append(True)
            return "response"
    with pytest.raises(cache.CollectionUnavailableError):
        with admission.durable_collection("commit") as intent:
            with collection.collection_budget(intent=intent):
                collection.MeteredClient(Provider(), "fake").request()
    monkeypatch.setattr(admission, "SyncSessionLocal", normal)
    assert len(accepted) == (1 if commit_number == 3 else 0)
    assert ledger_row("commit").state in {"active", "uncertain"}
    with pytest.raises(cache.CollectionUnavailableError):
        with admission.durable_collection("commit"):
            pytest.fail("uncertain durable commit must not enable replacement")


def test_missing_schema_fails_closed_but_passive_get_needs_no_ledger(monkeypatch, tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'unmigrated.db'}")
    monkeypatch.setattr(admission, "SyncSessionLocal", sessionmaker(bind=engine))
    monkeypatch.setattr(cache, "_redis_client", lambda: None)
    monkeypatch.delenv("COST_DASHBOARD_MOCK_MODE", raising=False)
    cache.reset_local_cost_dashboard_cache_state()
    monkeypatch.setattr(service, "_live_dashboard", lambda *args: pytest.fail("unmigrated collector started"))
    monkeypatch.setattr(service, "_aws_client", lambda *args: pytest.fail("provider invoked"))
    with pytest.raises(cache.CollectionUnavailableError, match="Durable collection intent"):
        service.get_dashboard(force_refresh=True, month="2026-07")
    result = service.get_dashboard(month="2026-07")
    assert result["summary"]["monthToDateAwsCost"] is None
    assert result["debug"]["collectionOccurred"] is False
    engine.dispose()


def process_collector(database_url, values, guard, entered, finish, results, calls):
    engine = create_engine(database_url)
    admission.SyncSessionLocal = sessionmaker(bind=engine)
    cache._redis_client = lambda: ProcessRedis(values, guard)
    class Transport:
        def request(self):
            calls.append("issued")
            entered.set()
            assert finish.wait(5)
            return "synthetic response"
    def dashboard(month):
        collection.MeteredClient(Transport(), "fake").request()
        return service._empty_live_dashboard(month)
    service._live_dashboard = dashboard
    try:
        service.get_dashboard(force_refresh=True, month="2026-07")
        results.put("completed")
    except cache.CollectionUnavailableError:
        results.put("unavailable")
    finally:
        engine.dispose()


@pytest.mark.parametrize("crash", [False, True])
def test_process_collector_survives_redis_loss_without_second_dispatch(monkeypatch, crash):
    ctx = multiprocessing.get_context("fork")
    database_url = str(admission.SyncSessionLocal.kw["bind"].url)
    with ctx.Manager() as manager:
        values, guard, calls = manager.dict(), manager.RLock(), manager.list()
        entered, finish, results = ctx.Event(), ctx.Event(), ctx.Queue()
        owner = ctx.Process(target=process_collector, args=(database_url, values, guard, entered, finish, results, calls))
        owner.start()
        try:
            assert entered.wait(3)
            values.clear()  # Redis restart: both lock and cooldown disappear
            if crash:
                owner.terminate()
                owner.join(3)
            monkeypatch.setattr(cache, "_redis_client", lambda: ProcessRedis(values, guard))
            monkeypatch.setattr(service, "_live_dashboard", lambda *args: pytest.fail("replacement collector admitted"))
            with pytest.raises(cache.CollectionUnavailableError, match="Durable collection intent"):
                service.get_dashboard(force_refresh=True, month="2026-07")
            assert list(calls) == ["issued"]
            if crash:
                row = ledger_row("2026-07:live")
                assert row.state == "active" and row.request_inflight
            else:
                finish.set()
                owner.join(3)
                assert owner.exitcode == 0
                assert results.get(timeout=1) == "unavailable"  # lost Redis ownership result rejected
                assert ledger_row("2026-07:live").state == "idle"
        finally:
            # A deliberately killed process may have died holding Event's mutex.
            # Do not touch its synchronization primitive after synthetic SIGTERM.
            if not crash:
                finish.set()
            if owner.is_alive():
                owner.terminate()
            owner.join(3)


def test_first_admission_race_has_exactly_one_owner():
    from threading import Barrier
    start, finish, entered = Barrier(2), Event(), Event()
    def contender():
        start.wait(timeout=2)
        try:
            with admission.durable_collection("new-key"):
                entered.set()
                assert finish.wait(3)
                return "owner"
        except cache.CollectionUnavailableError:
            return "blocked"
    with ThreadPoolExecutor(max_workers=2) as pool:
        attempts = [pool.submit(contender) for _ in range(2)]
        try:
            assert entered.wait(2)
            # The loser finishes while the winning owner is still active.
            from concurrent.futures import wait, FIRST_COMPLETED
            done, _ = wait(attempts, timeout=2, return_when=FIRST_COMPLETED)
            assert len(done) == 1 and next(iter(done)).result() == "blocked"
        finally:
            finish.set()
        assert sorted(a.result(timeout=2) for a in attempts) == ["blocked", "owner"]


def test_transport_cancellation_retains_uncertainty():
    class Transport:
        def request(self):
            raise KeyboardInterrupt("synthetic cancellation after dispatch")
    with pytest.raises(KeyboardInterrupt):
        with admission.durable_collection("cancelled") as intent:
            with collection.collection_budget(intent=intent):
                collection.MeteredClient(Transport(), "fake").request()
    row = ledger_row("cancelled")
    assert row.state == "uncertain" and row.request_inflight
    with pytest.raises(cache.CollectionUnavailableError):
        with admission.durable_collection("cancelled"):
            pytest.fail("cancelled external acceptance must remain unresolved")


def test_ledger_outage_before_dispatch_blocks_provider_and_retains_intent(monkeypatch):
    normal = admission.SyncSessionLocal
    calls = []
    class Transport:
        def request(self):
            calls.append(True)
    with admission.durable_collection("ledger-outage") as intent:
        monkeypatch.setattr(admission, "SyncSessionLocal", lambda: (_ for _ in ()).throw(RuntimeError("synthetic DB outage")))
        with collection.collection_budget(intent=intent):
            with pytest.raises(cache.CollectionUnavailableError):
                collection.MeteredClient(Transport(), "fake").request()
    monkeypatch.setattr(admission, "SyncSessionLocal", normal)
    assert calls == []
    assert ledger_row("ledger-outage").state == "active"
    with pytest.raises(cache.CollectionUnavailableError):
        with admission.durable_collection("ledger-outage"):
            pytest.fail("durable unresolved admission must block after DB recovers")


def test_production_client_factory_rejects_bare_budget_before_construction(monkeypatch):
    import boto3
    monkeypatch.setattr(boto3, "client", lambda *args, **kwargs: pytest.fail("AWS client construction bypassed durable admission"))
    with collection.collection_budget():
        with pytest.raises(RuntimeError, match="requires durable admission"):
            service._aws_client("ce", "us-east-1")
    with pytest.raises(RuntimeError, match="requires durable admission"):
        service._aws_client("ce", "us-east-1")


def test_ambiguous_collection_preserves_stale_good_source_and_unknown_cutoff(monkeypatch):
    redis = FakeRedis()
    monkeypatch.setattr(cache, "_redis_client", lambda: redis)
    monkeypatch.delenv("COST_DASHBOARD_MOCK_MODE", raising=False)
    cache.reset_local_cost_dashboard_cache_state()
    prior = service._empty_live_dashboard("2026-07")
    prior["summary"]["monthToDateAwsCost"] = 42
    prior["debug"]["billingProvenance"] = {"complete": True, "dataCutoff": None,
                                           "collectedAt": "2026-07-01T00:00:00+00:00"}
    source = cache.store_dashboard("2026-07:live", prior, 60)
    accepted = []
    class Transport:
        def request(self):
            accepted.append(True)
            raise TimeoutError("synthetic remote acceptance, response unknown")
    def dashboard(month):
        collection.MeteredClient(Transport(), "fake").request()
    monkeypatch.setattr(service, "_live_dashboard", dashboard)
    with pytest.raises(cache.CollectionUnavailableError):
        service.get_dashboard(force_refresh=True, month="2026-07")
    result = service.get_dashboard(month="2026-07")
    assert result["summary"]["monthToDateAwsCost"] == 42
    assert result["debug"]["lastAwsRefreshTime"] == source
    assert result["debug"]["billingProvenance"]["dataCutoff"] is None
    assert result["debug"]["collectionOccurred"] is False
    assert ledger_row("2026-07:live").state == "uncertain"
    redis._values.clear()
    with pytest.raises(cache.CollectionUnavailableError):
        service.get_dashboard(force_refresh=True, month="2026-07")
    assert accepted == [True]
