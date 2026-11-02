"""Atomic admission; unresolved/ambiguous calls never release their allowance."""
from decimal import Decimal, InvalidOperation, ROUND_CEILING
from uuid import UUID

from sqlalchemy import func, select

from .models import RebalanceSpendAttempt, RebalanceSpendBinding, RebalanceSpendRefund, RebalanceSpendScope, utcnow

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


def authorize_workflow(db, *, user_id, portfolio, sequence, request_key, intent, scope_id=None, observed_revision=None):
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
    if observed_revision is not None:
        current_revision = db.scalar(select(RebalanceSpendBinding.id).where(
            RebalanceSpendBinding.user_id == user_id,
            RebalanceSpendBinding.portfolio == portfolio,
        ).order_by(RebalanceSpendBinding.id.desc()).limit(1)) or 0
        if observed_revision != current_revision:
            raise SpendCapBlocked("Workflow authorization changed in another tab or session; refresh allowance readiness before choosing again")
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


def settle(db, *, scope_id, attempt_id, confirmed_actual_inr=None, receipt=None,
           evidence_hash=None, settlement_reference=None):
    scope = db.scalar(select(RebalanceSpendScope).where(RebalanceSpendScope.id == scope_id).with_for_update())
    attempt = db.scalar(select(RebalanceSpendAttempt).where(
        RebalanceSpendAttempt.id == attempt_id, RebalanceSpendAttempt.scope_id == scope_id,
    ).with_for_update())
    if scope is None or attempt is None:
        raise SpendCapBlocked("Spending reservation is unavailable; further dispatch is blocked")
    if attempt.status in {"settled", "bound_breach"}:
        if confirmed_actual_inr is not None and (
                money(confirmed_actual_inr) != attempt.actual_inr or receipt != attempt.receipt
                or (evidence_hash is not None and evidence_hash != attempt.settlement_evidence_hash)):
            # Preserve the first confirmed history. A conflicting later receipt
            # must not silently pass as successful idempotency or enable dispatch.
            scope.status = "settlement_conflict"
            db.commit()
            raise SpendCapBlocked("Conflicting settlement evidence; original charge preserved and scope suspended")
        return
    if confirmed_actual_inr is None or not isinstance(receipt, str) or not receipt.strip() or len(receipt) > 255:
        attempt.status = "uncertain"
        if scope.status not in {"bound_breach", "settlement_conflict"}:
            scope.status = "uncertain"
        # No timeout/lease expiry/cancellation releases a possibly billed call.
    else:
        actual = money(confirmed_actual_inr)
        attempt.actual_inr = actual
        attempt.receipt = receipt
        attempt.settlement_evidence_hash = evidence_hash
        attempt.settlement_reference = settlement_reference
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


def record_confirmed_refund(db, *, scope_id, attempt_id, user_id, evidence):
    """Record a verified INR credit without replenishing the original allowance.

    No route, setting or provider callback invokes this yet. A future reviewed
    billing reconciler must supply actual settled evidence, never telemetry or
    an estimated refund. Gross incurred cost, reservations and breach/suspension
    states remain immutable; Audit12 may report credits separately.
    """
    from .policy import ConfirmedRefund
    if not isinstance(evidence, ConfirmedRefund):
        raise SpendCapBlocked("Confirmed refund settlement evidence required")
    evidence.validate()
    scope = db.scalar(select(RebalanceSpendScope).where(
        RebalanceSpendScope.id == scope_id, RebalanceSpendScope.user_id == user_id,
    ).with_for_update())
    attempt = db.scalar(select(RebalanceSpendAttempt).where(
        RebalanceSpendAttempt.id == attempt_id, RebalanceSpendAttempt.scope_id == scope_id,
    ).with_for_update())
    if (scope is None or attempt is None or attempt.actual_inr is None
            or attempt.status not in {"settled", "bound_breach"}
            or evidence.original_receipt != attempt.receipt):
        raise SpendCapBlocked("Refund does not match an owned confirmed original charge")
    previous = db.scalar(select(RebalanceSpendRefund).where(
        RebalanceSpendRefund.scope_id == scope_id, RebalanceSpendRefund.refund_key == evidence.refund_key,
    ))
    if previous is not None:
        if previous.attempt_id != attempt_id or previous.evidence_hash != evidence.digest():
            raise SpendCapBlocked("Refund receipt conflicts with immutable recorded credit")
        return previous.id
    refunded = db.scalar(select(func.coalesce(func.sum(RebalanceSpendRefund.amount_inr), 0)).where(
        RebalanceSpendRefund.attempt_id == attempt_id,
    ))
    amount = money(evidence.inr, positive=True)
    if refunded + amount > attempt.actual_inr:
        raise SpendCapBlocked("Confirmed credits cannot exceed the recorded original charge")
    row = RebalanceSpendRefund(scope_id=scope_id, attempt_id=attempt_id,
        refund_key=evidence.refund_key, amount_inr=amount,
        settlement_reference=evidence.settlement_reference, evidence_hash=evidence.digest())
    db.add(row)
    db.flush()
    db.commit()
    return row.id
