"""Offline actual ledger + mocked transport evidence; no provider/account calls."""
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from decimal import Decimal as D
from threading import Barrier

import pytest
from sqlalchemy import select

from app.domains.rebalance_budget import ledger, policy, runtime
from app.domains.rebalance_budget.models import RebalanceSpendAttempt, RebalanceSpendRefund
from app.domains.api_usage.metering import metered_call
from test_spend_cap import bind, bound, confirmed_charge, finite_limits, job, reserve, state


@pytest.mark.parametrize("changes", [
    {"input_tokens": None}, {"generated_tokens": True}, {"search_requests": -1},
    {"transport_attempts": 0}, {"transport_attempts": 1.5}, {"duration_seconds": 0},
    {"includes_hidden_reasoning": False}, {"includes_all_tool_charges": False},
    {"enforcement_reference": ""},
])
def test_incomplete_finite_limits_cannot_admit_transport(cap_db, monkeypatch, changes):
    proof = replace(bound(), limits=replace(finite_limits(), **changes))
    monkeypatch.setattr(policy, "resolve_bound", lambda **_: proof)
    token = runtime.configure_job(job(), 0)
    try:
        with pytest.raises(ledger.SpendCapBlocked):
            metered_call(lambda: pytest.fail("no transport with unknown limits"), provider="synthetic", meter_model="fixture")
    finally:
        runtime.reset_job(token)
    assert state(cap_db[0], bind(cap_db[0]))[:2] == (D(0), D(0))


def test_tariff_must_cover_entire_hidden_retry_deadline():
    with pytest.raises(ledger.SpendCapBlocked, match="expire before"):
        replace(bound(), valid_until=datetime.now(timezone.utc) + timedelta(seconds=10)).validate()


@pytest.mark.parametrize("changes", [
    {"transport_receipts": ()}, {"all_transport_attempts_accounted": False},
    {"settlement_reference": None}, {"tariff_version": "unrelated"},
    {"fx_version": "planning-fx"}, {"currency": "USD"}, {"includes_taxes_and_fees": False},
    {"transport_receipts": ("same", "same")},
    {"transport_receipts": ("1", "2", "3", "4")},
])
def test_final_usage_or_incomplete_settlement_retains_full_reservation(cap_db, monkeypatch, changes):
    proof = replace(bound(), confirmed_charge=lambda _: replace(confirmed_charge(), **changes))
    monkeypatch.setattr(policy, "resolve_bound", lambda **_: proof)
    token = runtime.configure_job(job(), 0)
    try:
        with pytest.raises(ledger.SpendCapBlocked, match="reservation retained"):
            metered_call(lambda: {"usage": {"input_tokens": 1, "output_tokens": 1}, "request_id": "last-only"},
                provider="synthetic", meter_model="fixture")
    finally:
        runtime.reset_job(token)
    assert state(cap_db[0], bind(cap_db[0])) == (D(0), D("4"), "uncertain")


def test_all_attempt_inr_evidence_persists_hash_and_actual_charge(cap_db, monkeypatch):
    f, _ = cap_db
    charge = replace(confirmed_charge("2.5"), transport_receipts=("attempt-1", "attempt-2"))
    monkeypatch.setattr(policy, "resolve_bound", lambda **_: replace(bound(), confirmed_charge=lambda _: charge))
    token = runtime.configure_job(job(), 0)
    try:
        metered_call(lambda: {"response": "synthetic"}, provider="synthetic", meter_model="fixture")
    finally:
        runtime.reset_job(token)
    with f() as db:
        row = db.scalar(select(RebalanceSpendAttempt))
        assert row.actual_inr == D("2.5") and row.upper_inr == D("4")
        assert row.settlement_evidence_hash == charge.digest()
        assert row.settlement_reference == charge.settlement_reference
    assert state(f, bind(f))[:2] == (D("2.5"), D(0))


def test_conflicting_late_settlement_preserves_original_and_freezes(cap_db):
    f, _ = cap_db
    scope = bind(f)
    attempt = reserve(f, scope, amount="10")
    with f() as db:
        ledger.settle(db, scope_id=scope, attempt_id=attempt, confirmed_actual_inr=D("7"), receipt="first")
    with f() as db, pytest.raises(ledger.SpendCapBlocked, match="original charge preserved"):
        ledger.settle(db, scope_id=scope, attempt_id=attempt, confirmed_actual_inr=D("1"), receipt="later")
    with f() as db:
        row = db.get(RebalanceSpendAttempt, attempt)
        assert (row.actual_inr, row.receipt) == (D("7"), "first")
    assert state(f, scope) == (D("7"), D(0), "settlement_conflict")
    with pytest.raises(ledger.SpendCapBlocked):
        reserve(f, scope, key="later", amount="1")


def refund(amount="3", key="refund-1"):
    return policy.ConfirmedRefund(D(amount), key, "original", "settled-inr-credit", "INR", True)


def settled_attempt(f, amount="9"):
    scope = bind(f)
    attempt = reserve(f, scope, amount=amount)
    with f() as db:
        ledger.settle(db, scope_id=scope, attempt_id=attempt, confirmed_actual_inr=D(amount), receipt="original")
    return scope, attempt


def record(f, scope, attempt, evidence, owner=1):
    with f() as db:
        return ledger.record_confirmed_refund(db, scope_id=scope, attempt_id=attempt, user_id=owner, evidence=evidence)


def test_refunds_append_once_without_erasing_or_renewing_allowance(cap_db):
    f, _ = cap_db
    scope, attempt = settled_attempt(f, "20")
    first = record(f, scope, attempt, refund())
    assert record(f, scope, attempt, refund()) == first
    assert state(f, scope) == (D("20"), D(0), "open")
    with f() as db:
        assert len(db.scalars(select(RebalanceSpendRefund)).all()) == 1
        row = db.get(RebalanceSpendAttempt, attempt)
        assert (row.actual_inr, row.receipt) == (D("20"), "original")
    with pytest.raises(ledger.SpendCapBlocked, match="allowance"):
        reserve(f, scope, key="refund-cannot-renew", amount="0.01")


@pytest.mark.parametrize("changes", [{"actually_settled": False}, {"currency": "USD"},
    {"original_receipt": "not-original"}, {"inr": D("30")}, {"inr": D("NaN")},
    {"settlement_reference": ""}])
def test_estimated_foreign_or_excess_refunds_cannot_change_usage(cap_db, changes):
    f, _ = cap_db
    scope, attempt = settled_attempt(f)
    with pytest.raises(ledger.SpendCapBlocked):
        record(f, scope, attempt, replace(refund(), **changes))
    assert state(f, scope)[:2] == (D("9"), D(0))
    with f() as db:
        assert db.scalar(select(RebalanceSpendRefund)) is None


def test_refund_wrong_owner_conflicting_replay_and_total_excess_rejected(cap_db):
    f, _ = cap_db
    scope, attempt = settled_attempt(f)
    with pytest.raises(ledger.SpendCapBlocked, match="owned"):
        record(f, scope, attempt, refund(), owner=2)
    record(f, scope, attempt, refund("5"))
    with pytest.raises(ledger.SpendCapBlocked, match="conflicts"):
        record(f, scope, attempt, refund("4"))
    with pytest.raises(ledger.SpendCapBlocked, match="exceed"):
        record(f, scope, attempt, refund("5", "refund-2"))


def test_cancellation_or_partial_failure_never_releases_incurred_usage(cap_db):
    f, _ = cap_db
    scope = bind(f)
    attempt = reserve(f, scope, amount="10")
    with f() as db:
        ledger.settle(db, scope_id=scope, attempt_id=attempt)
    # Later authoritative billing can reconcile a cancelled/partial request.
    with f() as db:
        ledger.settle(db, scope_id=scope, attempt_id=attempt, confirmed_actual_inr=D("6"), receipt="original")
    record(f, scope, attempt, refund("2"))
    assert state(f, scope) == (D("6"), D(0), "open")
    with f() as db:
        assert db.get(RebalanceSpendAttempt, attempt).actual_inr == D("6")
        assert db.scalar(select(RebalanceSpendRefund)).amount_inr == D("2")


def test_concurrent_refund_receipt_counts_once(cap_db):
    f, engine = cap_db
    if engine.dialect.name != "postgresql":
        pytest.skip("requires explicitly configured disposable PostgreSQL")
    scope, attempt = settled_attempt(f)
    barrier = Barrier(2)
    def contender(_):
        barrier.wait()
        return record(f, scope, attempt, refund())
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(contender, [1, 2]))
    assert results[0] == results[1]
    assert state(f, scope)[:2] == (D("9"), D(0))


@pytest.mark.parametrize("terminal", ["bound_breach", "settlement_conflict"])
def test_late_unknown_call_cannot_clear_prior_terminal_scope_freeze(cap_db, terminal):
    f, _ = cap_db
    scope = bind(f)
    bind(f, sequence=2)
    first = reserve(f, scope, amount="8")
    second = reserve(f, scope, key="second", job=2, amount="8")
    with f() as db:
        ledger.settle(db, scope_id=scope, attempt_id=first,
            confirmed_actual_inr=D("9") if terminal == "bound_breach" else D("7"), receipt="first")
    if terminal == "settlement_conflict":
        with f() as db, pytest.raises(ledger.SpendCapBlocked):
            ledger.settle(db, scope_id=scope, attempt_id=first, confirmed_actual_inr=D("1"), receipt="different")
    with f() as db:
        ledger.settle(db, scope_id=scope, attempt_id=second)
    assert state(f, scope)[2] == terminal
    with f() as db:
        ledger.settle(db, scope_id=scope, attempt_id=second, confirmed_actual_inr=D("1"), receipt="second")
    assert state(f, scope)[2] == terminal
    with pytest.raises(ledger.SpendCapBlocked, match="suspended"):
        reserve(f, scope, key="must-still-block", amount="1")
