"""Atomic admission; unresolved/ambiguous calls never release their allowance."""
from decimal import Decimal, InvalidOperation, ROUND_CEILING
from uuid import UUID

from sqlalchemy import select

from .models import RebalanceSpendAttempt, RebalanceSpendBinding, RebalanceSpendScope, utcnow

CAP_INR = Decimal("20.00000000")
QUANTUM = Decimal("0.00000001")


class SpendCapBlocked(ValueError):
    """A terminal admission failure, not a retryable provider outage."""


def job_table():
    from app.domains.jobs.models import Job
    return Job.__table__


def user_table():
    from app.domains.auth.models import User
    return User.__table__


def money(value, *, positive=False):
    try:
        if isinstance(value, (bool, float)):
            raise ValueError()
        amount = Decimal(value)
        if not amount.is_finite() or amount < 0 or (positive and amount == 0):
            raise ValueError()
        return amount.quantize(QUANTUM, rounding=ROUND_CEILING)
    except (ValueError, TypeError, InvalidOperation):
        raise SpendCapBlocked("Invalid exact INR charge or request upper bound") from None


def validate_identity(user_id, portfolio, sequence):
    if (isinstance(user_id, bool) or not isinstance(user_id, int) or user_id <= 0
            or portfolio not in {"india", "indmoney_us"}
            or isinstance(sequence, bool) or not isinstance(sequence, int) or sequence <= 0):
        raise SpendCapBlocked("Automated rebalance requires an owned market and workflow sequence")


def authorize_workflow(db, *, user_id, portfolio, sequence, request_key, intent, scope_id=None):
    """Explicit new-operation grant or continuation; idempotent across Run retry.

    Called only by the authenticated existing label-reservation route. A worker
    can consume a binding but cannot mint a grant. Caller commits grant, binding
    and workflow label together. No sequence, retry or browser reload is consent.
    """
    validate_identity(user_id, portfolio, sequence)
    try:
        key = str(UUID(str(request_key)))
    except (ValueError, TypeError, AttributeError):
        raise SpendCapBlocked("A stable authorization request UUID is required") from None
    if intent not in {"new_workflow", "continue_workflow"}:
        raise SpendCapBlocked("Choose an explicitly authorized new workflow or an existing continuation")
    if intent == "new_workflow" and scope_id is not None:
        raise SpendCapBlocked("A new workflow cannot replace an existing scope")
    if intent == "continue_workflow" and (isinstance(scope_id, bool) or not isinstance(scope_id, int) or scope_id <= 0):
        raise SpendCapBlocked("Continuation requires its existing spending scope")
    users = user_table()
    if db.scalar(select(users.c.id).where(users.c.id == user_id).with_for_update()) is None:
        raise SpendCapBlocked("Owned spending authorization unavailable")
    replay = db.scalar(select(RebalanceSpendBinding).where(
        RebalanceSpendBinding.user_id == user_id, RebalanceSpendBinding.request_key == key,
    ))
    if replay is not None:
        if (replay.portfolio != portfolio or replay.intent != intent
                or (intent == "continue_workflow" and replay.scope_id != scope_id)):
            raise SpendCapBlocked("Authorization request was already used for different workflow intent")
        return replay
    existing = db.scalar(select(RebalanceSpendBinding.id).where(
        RebalanceSpendBinding.user_id == user_id, RebalanceSpendBinding.portfolio == portfolio,
        RebalanceSpendBinding.sequence == sequence,
    ))
    if existing is not None:
        raise SpendCapBlocked("Sequence already has a spending authorization; cannot reset it")
    if intent == "new_workflow":
        scope = RebalanceSpendScope(user_id=user_id, portfolio=portfolio, authorization_key=key,
            cap_inr=CAP_INR, settled_inr=Decimal(0), reserved_inr=Decimal(0))
        db.add(scope)
        db.flush()
    else:
        scope = db.scalar(select(RebalanceSpendScope).where(RebalanceSpendScope.id == scope_id,
            RebalanceSpendScope.user_id == user_id, RebalanceSpendScope.portfolio == portfolio).with_for_update())
        if scope is None or scope.cap_inr != CAP_INR:
            raise SpendCapBlocked("Continuation scope does not belong to this owner and market")
    binding = RebalanceSpendBinding(user_id=user_id, portfolio=portfolio, sequence=sequence,
        scope_id=scope.id, request_key=key, intent=intent)
    db.add(binding)
    db.flush()
    return binding


def bind_scope(db, *, user_id, portfolio, sequence):
    """Workers resolve only an explicitly authorized binding; never create one."""
    validate_identity(user_id, portfolio, sequence)
    binding = db.scalar(select(RebalanceSpendBinding).where(
        RebalanceSpendBinding.user_id == user_id, RebalanceSpendBinding.portfolio == portfolio,
        RebalanceSpendBinding.sequence == sequence,
    ))
    if binding is None:
        raise SpendCapBlocked("Workflow has no spending authorization. Explicitly choose New workflow or Continue; no paid call was made")
    scope = db.scalar(select(RebalanceSpendScope).where(RebalanceSpendScope.id == binding.scope_id,
        RebalanceSpendScope.user_id == user_id, RebalanceSpendScope.portfolio == portfolio).with_for_update())
    if scope is None or scope.cap_inr != CAP_INR:
        raise SpendCapBlocked("Workflow spending scope conflicts with its persisted allowance")
    return scope


def reserve(db, *, scope_id, user_id, job_id, attempt_key, provider, model,
            upper_inr, tariff_version, fx_version):
    upper = money(upper_inr, positive=True)
    if not tariff_version or not fx_version or not attempt_key or len(attempt_key) > 128:
        raise SpendCapBlocked("Verified tariff, FX/fee bound and request identity are required")
    scope = db.scalar(select(RebalanceSpendScope).where(
        RebalanceSpendScope.id == scope_id, RebalanceSpendScope.user_id == user_id,
    ).with_for_update())
    if scope is None or scope.status != "open" or scope.cap_inr != CAP_INR:
        raise SpendCapBlocked("₹20 rebalance spending scope is unavailable or suspended")
    jobs = job_table()
    owned = db.scalar(select(jobs.c.id).join(RebalanceSpendBinding,
        (RebalanceSpendBinding.user_id == jobs.c.user_id)
        & (RebalanceSpendBinding.portfolio == jobs.c.auto_rebalance_portfolio)
        & (RebalanceSpendBinding.sequence == jobs.c.auto_rebalance_sequence)).where(
        jobs.c.id == job_id, jobs.c.user_id == user_id, RebalanceSpendBinding.scope_id == scope_id,
    ).limit(1))
    if owned is None:
        raise SpendCapBlocked("Provider job does not belong to this owned spending scope")
    # All mutations lock scope first, then attempt: same order in settlement.
    existing = db.scalar(select(RebalanceSpendAttempt).where(
        RebalanceSpendAttempt.scope_id == scope_id, RebalanceSpendAttempt.attempt_key == attempt_key,
    ))
    if existing is not None:
        raise SpendCapBlocked("Request already admitted; reconcile it instead of repeating paid I/O")
    if scope.settled_inr + scope.reserved_inr + upper > scope.cap_inr:
        raise SpendCapBlocked("₹20 whole-workflow allowance cannot cover this request; no paid call was made")
    scope.reserved_inr += upper
    attempt = RebalanceSpendAttempt(scope_id=scope_id, job_id=job_id, attempt_key=attempt_key,
        provider=provider, model=model, upper_inr=upper, tariff_version=tariff_version, fx_version=fx_version)
    db.add(attempt)
    db.flush()
    db.commit()  # MUST succeed before provider/transport execution
    return attempt.id


def settle(db, *, scope_id, attempt_id, confirmed_actual_inr=None, receipt=None):
    scope = db.scalar(select(RebalanceSpendScope).where(RebalanceSpendScope.id == scope_id).with_for_update())
    attempt = db.scalar(select(RebalanceSpendAttempt).where(
        RebalanceSpendAttempt.id == attempt_id, RebalanceSpendAttempt.scope_id == scope_id,
    ).with_for_update())
    if scope is None or attempt is None:
        raise SpendCapBlocked("Spending reservation is unavailable; further dispatch is blocked")
    if attempt.status in {"settled", "bound_breach"}:
        return  # provider receipt/duplicate settlement never counts twice
    if confirmed_actual_inr is None or not isinstance(receipt, str) or not receipt.strip():
        attempt.status = "uncertain"
        scope.status = "uncertain"
        # No timeout/lease expiry/cancellation releases a possibly billed call.
    else:
        actual = money(confirmed_actual_inr)
        attempt.actual_inr = actual
        attempt.receipt = receipt[:255]
        attempt.finished_at = utcnow()
        scope.reserved_inr -= attempt.upper_inr
        scope.settled_inr += actual
        attempt.status = "settled" if actual <= attempt.upper_inr else "bound_breach"
        if attempt.status == "bound_breach":
            scope.status = "bound_breach"  # preserve actual invoice, never clamp
        elif scope.status == "uncertain":
            # Reconciliation may reopen ONLY when no ambiguous attempts remain.
            db.flush()
            unresolved = db.scalar(select(RebalanceSpendAttempt.id).where(
                RebalanceSpendAttempt.scope_id == scope_id,
                RebalanceSpendAttempt.status.in_(("reserved", "uncertain")),
            ).limit(1))
            if unresolved is None:
                scope.status = "open"
    db.commit()
