"""Mandatory budget context for every automated rebalance worker invocation."""
from contextvars import ContextVar
from dataclasses import dataclass

from . import policy
from .ledger import SpendCapBlocked, bind_scope, reserve, settle


def sessions():
    from app.infrastructure.database.sync_session import SyncSessionLocal
    return SyncSessionLocal()


@dataclass
class SpendContext:
    scope_id: int
    user_id: int
    job_id: int
    retry: int
    ordinal: int = 0


_context: ContextVar[SpendContext | None] = ContextVar("rebalance_spend_context", default=None)


def configure_job(job, retry):
    values = [getattr(job, name, None) for name in (
        "auto_rebalance_portfolio", "auto_rebalance_sequence", "auto_rebalance_label")]
    if all(value is None for value in values):
        return _context.set(None)  # unrelated workers keep existing behavior
    portfolio, sequence, label = values
    if not isinstance(label, str) or not label.strip():
        raise SpendCapBlocked("Automated rebalance workflow identity is incomplete")
    user_id, job_id = getattr(job, "user_id", None), getattr(job, "id", None)
    if (isinstance(job_id, bool) or not isinstance(job_id, int) or job_id <= 0
            or isinstance(retry, bool) or not isinstance(retry, int) or retry < 0):
        raise SpendCapBlocked("Automated rebalance dispatch identity is unavailable")
    with sessions() as db:
        scope = bind_scope(db, user_id=user_id, portfolio=portfolio, sequence=sequence)
        scope_id = scope.id
        db.commit()
    return _context.set(SpendContext(scope_id, user_id, job_id, retry))


def reset_job(token):
    if token is not None:
        _context.reset(token)


@dataclass(frozen=True)
class Admission:
    scope_id: int
    attempt_id: int
    bound: policy.RequestBound


def before_call(*, provider, model, request):
    context = _context.get()
    if context is None:
        return None
    bound = policy.resolve_bound(provider=provider, model=model, request=request)
    bound.validate()  # unknown/stale policy fails before external I/O
    ordinal = context.ordinal
    context.ordinal += 1
    # A redelivered task has the same retry counter and repeats the same key.
    # Unknown prior dispatch therefore cannot acquire a second reservation.
    key = f"job:{context.job_id}:retry:{context.retry}:call:{ordinal}"
    with sessions() as db:
        attempt_id = reserve(db, scope_id=context.scope_id, user_id=context.user_id,
            job_id=context.job_id, attempt_key=key, provider=provider, model=model,
            upper_inr=bound.upper_inr, tariff_version=bound.tariff_version, fx_version=bound.fx_version)
    return Admission(context.scope_id, attempt_id, bound)


def after_call(admission, evidence):
    if admission is None:
        return
    # Missing/malformed evidence, exceptions and interrupted streams retain the
    # full durable reservation. Never use AIProviderResponse.cost as an invoice.
    charge = None
    if evidence.get("status") == "success":
        try:
            charge = admission.bound.confirmed_charge(evidence)
        except Exception:
            # Do not release spend on malformed/incomplete provider evidence.
            with sessions() as db:
                settle(db, scope_id=admission.scope_id, attempt_id=admission.attempt_id)
            raise SpendCapBlocked("Provider settlement is unavailable; reservation retained") from None
    if charge is not None:
        try:
            if not isinstance(charge, policy.ConfirmedCharge):
                raise SpendCapBlocked("Unconfirmed receipt")
            charge.validate(admission.bound)
        except SpendCapBlocked:
            with sessions() as db:
                settle(db, scope_id=admission.scope_id, attempt_id=admission.attempt_id)
            raise SpendCapBlocked("Provider settlement is not confirmed; reservation retained") from None
    with sessions() as db:
        settle(db, scope_id=admission.scope_id, attempt_id=admission.attempt_id,
            confirmed_actual_inr=charge.inr if charge else None,
            receipt=charge.receipt if charge else None,
            evidence_hash=charge.digest() if charge else None,
            settlement_reference=charge.settlement_reference if charge else None)
