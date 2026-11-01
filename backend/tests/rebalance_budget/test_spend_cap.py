from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from decimal import Decimal as D
from threading import Barrier
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from app.domains.rebalance_budget import ledger, policy, runtime
from app.domains.rebalance_budget.models import RebalanceSpendAttempt, RebalanceSpendScope
from app.domains.api_usage.metering import ApiAttempt, metered_call


def bind(factory, user=1, market="india", sequence=1):
    with factory() as db:
        scope = ledger.bind_scope(db, user_id=user, portfolio=market, sequence=sequence)
        db.commit()
        return scope.id


def reserve(factory, scope, key="first", amount="12", job=1, user=1):
    with factory() as db:
        return ledger.reserve(db, scope_id=scope, user_id=user, job_id=job, attempt_key=key,
            provider="synthetic", model="fixture", upper_inr=D(amount), tariff_version="fixture-tariff",
            fx_version="fixture-all-in-inr-bound")


def state(factory, scope):
    with factory() as db:
        row = db.get(RebalanceSpendScope, scope)
        return row.settled_inr, row.reserved_inr, row.status


def job(sequence=1, portfolio="india", job_id=1):
    return SimpleNamespace(id=job_id, user_id=1, auto_rebalance_portfolio=portfolio,
        auto_rebalance_sequence=sequence, auto_rebalance_label="Synthetic workflow")


def bound(amount="4", actual="3"):
    return policy.RequestBound(D(amount), "fixture", "fixture-all-in-inr",
        datetime.now(timezone.utc) + timedelta(minutes=5),
        lambda evidence: policy.ConfirmedCharge(D(actual), "fixture-receipt"))


def test_sequences_share_allowance_but_markets_and_owners_do_not(cap_db):
    f, _ = cap_db
    india = bind(f)
    assert bind(f, sequence=2) == india
    us, other = bind(f, market="indmoney_us"), bind(f, user=2)
    assert len({india, us, other}) == 3
    reserve(f, india, amount="20")
    with pytest.raises(ledger.SpendCapBlocked, match="allowance"):
        reserve(f, india, key="continuation", job=2, amount="0.01")
    reserve(f, us, job=3, amount="20")
    assert state(f, india)[1] + state(f, us)[1] == D("40")


def test_exact_boundary_and_upward_rounding(cap_db):
    f, _ = cap_db
    scope = bind(f)
    reserve(f, scope, amount="19.99999999")
    reserve(f, scope, key="tiny", amount="0.000000001")
    assert state(f, scope)[1] == D("20")
    with pytest.raises(ledger.SpendCapBlocked):
        reserve(f, scope, key="over", amount="0.000000001")


@pytest.mark.parametrize("value", [None, True, 1.2, "NaN", "Infinity", "-1", "0", "1e9999"])
def test_invalid_or_zero_bounds_fail_closed(value):
    with pytest.raises(ledger.SpendCapBlocked):
        ledger.money(value, positive=True)


def test_owned_job_and_scope_are_required(cap_db):
    f, _ = cap_db
    scope = bind(f)
    for args in ({"job": 4}, {"user": 2}, {"job": 2}):
        with pytest.raises(ledger.SpendCapBlocked):
            reserve(f, scope, **args)
    assert state(f, scope) == (D(0), D(0), "open")


def test_duplicate_admission_and_settlement_are_idempotent(cap_db):
    f, _ = cap_db
    scope = bind(f)
    attempt = reserve(f, scope)
    with pytest.raises(ledger.SpendCapBlocked, match="already admitted"):
        reserve(f, scope)
    for _ in range(2):
        with f() as db:
            ledger.settle(db, scope_id=scope, attempt_id=attempt, confirmed_actual_inr=D("5"), receipt="fixture")
    assert state(f, scope) == (D("5"), D(0), "open")


def test_unknown_timeout_and_cancellation_keep_reservation(cap_db):
    f, _ = cap_db
    scope = bind(f)
    attempt = reserve(f, scope)
    with f() as db:
        ledger.settle(db, scope_id=scope, attempt_id=attempt)
    assert state(f, scope) == (D(0), D("12"), "uncertain")
    with pytest.raises(ledger.SpendCapBlocked, match="suspended"):
        reserve(f, scope, key="retry", amount="1")
    with f() as db:
        ledger.settle(db, scope_id=scope, attempt_id=attempt, confirmed_actual_inr=D("4"), receipt="confirmed")
    assert state(f, scope) == (D("4"), D(0), "open")


def test_tariff_breach_records_actual_and_stops_future_dispatch(cap_db):
    f, _ = cap_db
    scope = bind(f)
    attempt = reserve(f, scope)
    with f() as db:
        ledger.settle(db, scope_id=scope, attempt_id=attempt, confirmed_actual_inr=D("21"), receipt="fixture")
    assert state(f, scope) == (D("21"), D(0), "bound_breach")
    with pytest.raises(ledger.SpendCapBlocked):
        reserve(f, scope, key="next", amount="1")


@pytest.mark.parametrize("provider,model", [("deepseek", "deepseek-v4-flash"), ("openai", "gpt-4o-mini"),
    ("anthropic", "claude"), ("gemini", "gemini-2.5-flash"), ("tavily", None), ("unknown", None)])
def test_unverified_live_adapters_block_before_io(cap_db, provider, model):
    token = runtime.configure_job(job(), 0)
    calls = []
    try:
        with pytest.raises(ledger.SpendCapBlocked, match="No paid request"):
            metered_call(lambda: calls.append(1), provider=provider, meter_model=model)
        assert calls == []
    finally:
        runtime.reset_job(token)


def test_mocked_bounded_calls_reserve_before_io_and_settle(cap_db, monkeypatch):
    f, _ = cap_db
    monkeypatch.setattr(policy, "resolve_bound", lambda **kwargs: bound())
    token = runtime.configure_job(job(), 0)
    scope = bind(f)
    observed = []
    def upstream():
        observed.append(state(f, scope))
        return {"usage": {"input_tokens": 5, "output_tokens": 2}}
    try:
        metered_call(upstream, provider="synthetic", meter_model="fixture")
        assert observed == [(D(0), D("4"), "open")]
        assert state(f, scope) == (D("3"), D(0), "open")
    finally:
        runtime.reset_job(token)


def test_ambiguous_mocked_call_blocks_redelivery_and_continuation(cap_db, monkeypatch):
    f, _ = cap_db
    monkeypatch.setattr(policy, "resolve_bound", lambda **kwargs: bound())
    calls = []
    token = runtime.configure_job(job(), 0)
    try:
        with pytest.raises(TimeoutError):
            with ApiAttempt(provider="synthetic", model="fixture", request={}):
                calls.append(1)
                raise TimeoutError("synthetic")
    finally:
        runtime.reset_job(token)
    for next_job, retry in [(job(), 0), (job(), 1), (job(sequence=2, job_id=2), 0)]:
        token = runtime.configure_job(next_job, retry)
        try:
            with pytest.raises(ledger.SpendCapBlocked):
                metered_call(lambda: calls.append(1), provider="synthetic", meter_model="fixture")
        finally:
            runtime.reset_job(token)
    assert calls == [1]
    assert state(f, bind(f)) == (D(0), D("4"), "uncertain")


def test_expired_or_unknown_fx_policy_blocks_before_io(cap_db, monkeypatch):
    expired = policy.RequestBound(D("1"), "fixture", "", datetime.now(timezone.utc), lambda _: None)
    monkeypatch.setattr(policy, "resolve_bound", lambda **kwargs: expired)
    token = runtime.configure_job(job(), 0)
    try:
        with pytest.raises(ledger.SpendCapBlocked):
            metered_call(lambda: pytest.fail("must not dispatch"), provider="synthetic", meter_model="fixture")
    finally:
        runtime.reset_job(token)


def test_usage_estimate_does_not_release_unconfirmed_spend(cap_db, monkeypatch):
    f, _ = cap_db
    unconfirmed = policy.RequestBound(D("4"), "fixture", "fixture", datetime.now(timezone.utc)
        + timedelta(minutes=5), lambda _: None)
    monkeypatch.setattr(policy, "resolve_bound", lambda **kwargs: unconfirmed)
    token = runtime.configure_job(job(), 0)
    try:
        metered_call(lambda: {"usage": {"input_tokens": 2, "output_tokens": 1}}, provider="synthetic",
            meter_model="fixture", tariff_rates={"input": 0.15, "output": 0.60})
        assert state(f, bind(f)) == (D(0), D("4"), "uncertain")
    finally:
        runtime.reset_job(token)


def test_malformed_settlement_suspends_scope(cap_db, monkeypatch):
    f, _ = cap_db
    invalid = policy.RequestBound(D("4"), "fixture", "fixture", datetime.now(timezone.utc)
        + timedelta(minutes=5), lambda _: policy.ConfirmedCharge(D("NaN"), "bad"))
    monkeypatch.setattr(policy, "resolve_bound", lambda **kwargs: invalid)
    token = runtime.configure_job(job(), 0)
    try:
        with pytest.raises(ledger.SpendCapBlocked, match="reservation retained"):
            metered_call(lambda: {}, provider="synthetic", meter_model="fixture")
        assert state(f, bind(f)) == (D(0), D("4"), "uncertain")
    finally:
        runtime.reset_job(token)


def test_missing_database_cannot_fail_open(monkeypatch):
    def unavailable():
        raise RuntimeError("Synthetic unavailable database")
    monkeypatch.setattr(runtime, "sessions", unavailable)
    with pytest.raises(RuntimeError, match="unavailable database"):
        runtime.configure_job(job(), 0)


@pytest.mark.parametrize("url,ack", [
    ("postgresql://test@remote.example/credx_cap_test_ci", "disposable-local-only"),
    ("postgresql://test@localhost/production", "disposable-local-only"),
    ("postgresql://test@localhost/credx_cap_test_ci", ""),
    ("postgresql://test@localhost/credx_cap_test_ci?host=remote.example", "disposable-local-only"),
])
def test_postgres_test_target_guard_rejects_unsafe_targets(request, monkeypatch, url, ack):
    monkeypatch.setenv("CREDX_CAP_TEST_DATABASE_URL", url)
    monkeypatch.setenv("CREDX_CAP_TEST_DATABASE_ACK", ack)
    with pytest.raises(ValueError, match="disposable local"):
        request.getfixturevalue("cap_db")


def test_non_workflow_context_unchanged_and_cannot_leak(cap_db):
    token = runtime.configure_job(SimpleNamespace(), 0)
    try:
        assert metered_call(lambda: "fixture", provider="synthetic", meter_model="fixture") == "fixture"
    finally:
        runtime.reset_job(token)


def test_parallel_reservations_serialize_in_real_postgres(cap_db):
    f, engine = cap_db
    if engine.dialect.name != "postgresql":
        pytest.skip("requires explicitly configured disposable PostgreSQL")
    scope = bind(f)
    barrier = Barrier(2)
    def contender(key):
        barrier.wait()
        try:
            reserve(f, scope, key=key, amount="12")
            return True
        except ledger.SpendCapBlocked:
            return False
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(contender, ["a", "b"])) == [False, True]
    assert state(f, scope) == (D(0), D("12"), "open")


def test_real_worker_installs_gate_and_cap_denial_is_terminal(cap_db, monkeypatch):
    from app.domains.jobs import tasks
    from app.domains.ai_providers.factory import ProviderFactory
    from app.shared.types import JobStatus
    j = job()
    j.status, j.prompt, j.provider, j.model = JobStatus.PENDING, "Synthetic", "deepseek", "deepseek-v4-flash"
    j.request_context_json = None
    monkeypatch.setattr(tasks, "recovery_mode", lambda: False)
    monkeypatch.setattr(tasks, "SyncSessionLocal", lambda: SimpleNamespace(close=lambda: None))
    monkeypatch.setattr(tasks, "SyncJobRepository", lambda _: SimpleNamespace(get=lambda _: j,
        update_status=lambda *args, **kwargs: None))
    monkeypatch.setattr(tasks, "resolve_job_usage_identity", lambda *args: {})
    monkeypatch.setattr(tasks, "configure_output_context", lambda *args: None)
    monkeypatch.setattr(tasks, "_job_was_cancelled", lambda *args: False)
    monkeypatch.setattr(tasks, "_publish_job_update", lambda *args: None)
    monkeypatch.setattr(tasks, "_refresh_run_status", lambda *args: None)
    failures, calls = [], []
    monkeypatch.setattr(tasks, "_mark_failed", lambda *args, **kwargs: failures.append((args, kwargs)))
    monkeypatch.setattr(ProviderFactory, "create", lambda _: SimpleNamespace(generate=lambda **kwargs:
        metered_call(lambda: calls.append(1), provider="deepseek", meter_model="deepseek-v4-flash")))
    monkeypatch.setattr(tasks.execute_ai_job, "retry", lambda **kwargs: pytest.fail("budget denial must not retry"))
    tasks.execute_ai_job.run(1)
    assert calls == [] and len(failures) == 1
    assert "No paid request was dispatched" in failures[0][0][3]
    assert tasks._classify_exc(ledger.SpendCapBlocked("fixture")) == (False, 0)
    assert runtime.before_call(provider="synthetic", model="fixture", request={}) is None


def test_search_budget_denial_does_not_fall_back_or_become_tool_text(cap_db, monkeypatch):
    from app.domains.ai_providers.tools import web_search
    monkeypatch.setattr(web_search.settings, "tavily_api_key", "synthetic-not-a-key")
    def denied(*args):
        raise ledger.SpendCapBlocked("Synthetic cap denial")
    monkeypatch.setattr(web_search, "_tavily_search", denied)
    monkeypatch.setattr(web_search, "_ddg_search", lambda *args: pytest.fail("no search fallback after cap denial"))
    with pytest.raises(ledger.SpendCapBlocked, match="cap denial"):
        web_search.execute("web_search", {"query": "synthetic"})


def test_concurrent_first_bind_does_not_mint_extra_allowances(cap_db):
    f, engine = cap_db
    if engine.dialect.name != "postgresql":
        pytest.skip("requires explicitly configured disposable PostgreSQL")
    barrier = Barrier(4)
    def contender(sequence):
        barrier.wait()
        return bind(f, sequence=sequence)
    with ThreadPoolExecutor(max_workers=4) as pool:
        ids = list(pool.map(contender, range(1, 5)))
    assert len(set(ids)) == 1
    assert state(f, ids[0]) == (D(0), D(0), "open")


def test_concurrent_duplicate_settlement_counts_charge_once(cap_db):
    f, engine = cap_db
    if engine.dialect.name != "postgresql":
        pytest.skip("requires explicitly configured disposable PostgreSQL")
    scope = bind(f)
    attempt = reserve(f, scope)
    barrier = Barrier(2)
    def contender(_):
        barrier.wait()
        with f() as db:
            ledger.settle(db, scope_id=scope, attempt_id=attempt, confirmed_actual_inr=D("5"), receipt="same")
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(contender, range(2)))
    assert state(f, scope) == (D("5"), D(0), "open")
