"""Atomic admission; unresolved/ambiguous calls never release their allowance."""
from decimal import Decimal, InvalidOperation, ROUND_CEILING

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from .models import RebalanceSpendAttempt, RebalanceSpendBinding, RebalanceSpendScope, utcnow

CAP_INR = Decimal("20.00000000")
QUANTUM = Decimal("0.00000001")


class SpendCapBlocked(ValueError):
    """A terminal admission failure, not a retryable provider outage."""


def job_table():
    from app.domains.jobs.models import Job
    return Job.__table__


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


def bind_scope(db, *, user_id, portfolio, sequence):
    """One authorized allowance per owner/market; a new sequence is NOT a grant.

    No reset, renewal or billing-configuration API exists here. Exhaustion stays
    blocked until a separately authorized future allowance lifecycle is added.
    """
    if (isinstance(user_id, bool) or not isinstance(user_id, int) or user_id <= 0
            or portfolio not in {"india", "indmoney_us"}
            or isinstance(sequence, bool) or not isinstance(sequence, int) or sequence <= 0):
        raise SpendCapBlocked("Automated rebalance requires an owned market and workflow sequence")
    scope = db.scalar(select(RebalanceSpendScope).where(
        RebalanceSpendScope.user_id == user_id, RebalanceSpendScope.portfolio == portfolio,
    ).with_for_update())
    if scope is None:
        try:
            with db.begin_nested():
                db.add(RebalanceSpendScope(user_id=user_id, portfolio=portfolio,
                    cap_inr=CAP_INR, settled_inr=Decimal(0), reserved_inr=Decimal(0)))
                db.flush()
        except IntegrityError:
            pass  # unique owner/market arbitrates concurrent first workflows
        scope = db.scalar(select(RebalanceSpendScope).where(
            RebalanceSpendScope.user_id == user_id, RebalanceSpendScope.portfolio == portfolio,
        ).with_for_update())
    if scope is None or scope.cap_inr != CAP_INR:
        raise SpendCapBlocked("Verified ₹20 rebalance allowance unavailable")
    binding = db.scalar(select(RebalanceSpendBinding).where(
        RebalanceSpendBinding.user_id == user_id, RebalanceSpendBinding.portfolio == portfolio,
        RebalanceSpendBinding.sequence == sequence,
    ))
    if binding is None:
        db.add(RebalanceSpendBinding(user_id=user_id, portfolio=portfolio, sequence=sequence, scope_id=scope.id))
        db.flush()
    elif binding.scope_id != scope.id:
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
