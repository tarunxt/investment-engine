"""Reserve worst-case spend before I/O. Uncertain outcomes keep reservations."""
from decimal import Decimal, ROUND_CEILING
from datetime import timezone
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from .models import SpendAccount, SpendAttempt, VerificationRecord, utcnow


class BudgetBlocked(ValueError): pass


def reserve(session, verification_id, fence, *, attempt_key, adapter, tariff_version, upper_bound, daily_cap):
    if upper_bound is None or not tariff_version: raise BudgetBlocked("Unknown tariff or request ceiling")
    upper_bound, daily_cap = Decimal(str(upper_bound)), Decimal(str(daily_cap))
    if not upper_bound.is_finite() or upper_bound < 0 or not daily_cap.is_finite() or daily_cap < 0: raise BudgetBlocked("Invalid cost ceiling")
    # Never round a positive priced attempt down to zero in Numeric(18, 8).
    upper_bound = upper_bound.quantize(Decimal("0.00000001"), rounding=ROUND_CEILING)
    verification = session.scalar(select(VerificationRecord).where(VerificationRecord.id == verification_id).with_for_update())
    if not verification or verification.status != "processing" or verification.fence != fence: raise BudgetBlocked("Stale or cancelled verification")
    from .verdict import aware
    if not verification.lease_until or aware(verification.lease_until) <= utcnow(): raise BudgetBlocked("Worker lease expired")
    existing = session.scalar(select(SpendAttempt).where(SpendAttempt.verification_id == verification_id, SpendAttempt.attempt_key == attempt_key))
    if existing: raise BudgetBlocked("Attempt already reserved; do not repeat ambiguous or paid I/O")
    day = utcnow().date().isoformat()
    account = session.scalar(select(SpendAccount).where(SpendAccount.user_id == verification.user_id, SpendAccount.day == day).with_for_update())
    if not account:
        try:
            with session.begin_nested():
                session.add(SpendAccount(user_id=verification.user_id, day=day, cap_usd=daily_cap, spent_usd=0, reserved_usd=0)); session.flush()
        except IntegrityError: pass
        account = session.scalar(select(SpendAccount).where(SpendAccount.user_id == verification.user_id, SpendAccount.day == day).with_for_update())
    if not account: raise BudgetBlocked("Daily account could not be created")
    cap = min(account.cap_usd, daily_cap)
    if verification.spent_usd + verification.reserved_usd + upper_bound > verification.budget_usd: raise BudgetBlocked("Per-verification cap would be exceeded")
    if account.spent_usd + account.reserved_usd + upper_bound > cap: raise BudgetBlocked("Daily cap would be exceeded")
    verification.reserved_usd += upper_bound
    account.reserved_usd += upper_bound
    attempt = SpendAttempt(verification_id=verification.id, user_id=verification.user_id, account_id=account.id, attempt_key=attempt_key, adapter=adapter, tariff_version=tariff_version, upper_bound_usd=upper_bound, status="started")
    session.add(attempt)
    session.flush()
    session.commit()  # durable before external I/O
    return attempt.id


def settle(session, attempt_id, actual=None):
    attempt = session.scalar(select(SpendAttempt).where(SpendAttempt.id == attempt_id).with_for_update())
    if not attempt or attempt.status in {"settled", "tariff_breach"}: return
    # Same lock order as reservation: verification, then account.
    verification = session.scalar(select(VerificationRecord).where(VerificationRecord.id == attempt.verification_id).with_for_update())
    account = session.scalar(select(SpendAccount).where(SpendAccount.id == attempt.account_id).with_for_update())
    if actual is None:
        attempt.status = "uncertain"
    else:
        actual = Decimal(str(actual))
        if not actual.is_finite() or actual < 0: raise BudgetBlocked("Invalid actual cost")
        actual = actual.quantize(Decimal("0.00000001"), rounding=ROUND_CEILING)
        verification.reserved_usd -= attempt.upper_bound_usd
        account.reserved_usd -= attempt.upper_bound_usd
        verification.spent_usd += actual
        account.spent_usd += actual
        attempt.actual_usd = actual
        attempt.status = "settled" if actual <= attempt.upper_bound_usd else "tariff_breach"
        attempt.finished_at = utcnow()
    session.commit()
