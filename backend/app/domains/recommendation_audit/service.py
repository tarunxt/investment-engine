from __future__ import annotations
from decimal import Decimal
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from .deterministic import compare, digest
from .models import DecisionRecord, SpendAccount, VerificationRecord, utcnow
from .schemas import POLICY_VERSION


class AuditConflict(ValueError): pass


def owned_decision(session, user_id, record_id):
    return session.scalar(select(DecisionRecord).where(DecisionRecord.id == record_id, DecisionRecord.user_id == user_id))


def bundle(current, previous):
    return digest({"current": current.content_hash, "previous": previous.content_hash if previous else None, "policy_version": POLICY_VERSION})


def comparison_view(session, user_id, run_id, market, symbol, exchange):
    selection = select(DecisionRecord).where(DecisionRecord.user_id == user_id, DecisionRecord.run_id == run_id, DecisionRecord.market == market, DecisionRecord.symbol == symbol.upper(), DecisionRecord.exchange == exchange.upper()).order_by(DecisionRecord.captured_at.desc(), DecisionRecord.id.desc())
    current = session.scalar(selection.where(DecisionRecord.provenance != "calculation_observed").limit(1))
    present = session.scalar(selection.where(DecisionRecord.provenance == "calculation_observed").limit(1))
    def view(r): return {"id": r.id, "content_hash": r.content_hash, "captured_at": r.captured_at.isoformat(), **r.payload} if r else None
    if not current: return {"current": None, "present_calculation":view(present), "previous": None, "comparison": None, "coverage": "No frozen decision for this selection. Legacy capture requires an explicit request."}
    # Different-exchange candidates are shown with an identity gate, never silently merged.
    history = list(session.scalars(select(DecisionRecord).where(DecisionRecord.user_id == user_id, DecisionRecord.market == market, DecisionRecord.symbol == symbol.upper(), DecisionRecord.run_id != run_id, DecisionRecord.provenance != "calculation_observed", DecisionRecord.decision_at < current.decision_at).order_by(DecisionRecord.decision_at.desc(), DecisionRecord.captured_at.desc()).limit(51)))
    previous = history[0] if history else None
    return {"current": view(current), "present_calculation":view(present), "previous": view(previous), "comparison": compare(previous.payload, current.payload) if previous else None, "bundle_hash": bundle(current, previous), "coverage": {"queried_decisions": min(len(history), 50), "has_more": len(history) > 50, "scope": "Frozen decisions; excludes uncaptured and failed-only runs. Absence is not Hold."}}


def create_verification(session, user_id, request, *, daily_cap):
    current = owned_decision(session, user_id, request.current_id)
    previous = owned_decision(session, user_id, request.previous_id) if request.previous_id else None
    if not current or (request.previous_id and not previous): raise LookupError("Decision not found")
    if previous and previous.decision_at >= current.decision_at: raise AuditConflict("Previous decision must precede current")
    if request.bundle_hash != bundle(current, previous): raise AuditConflict("Evidence revision changed; refresh comparison")
    payload = request.model_dump(mode="json", exclude={"idempotency_key"})
    checksum = digest(payload)
    by_key = session.scalar(select(VerificationRecord).where(VerificationRecord.user_id == user_id, VerificationRecord.idempotency_key == request.idempotency_key))
    if by_key and by_key.request_hash != checksum: raise AuditConflict("Idempotency key reused for different evidence or budget")
    existing = by_key or session.scalar(select(VerificationRecord).where(VerificationRecord.user_id == user_id, VerificationRecord.request_hash == checksum))
    if existing: return existing
    record = VerificationRecord(user_id=user_id, current_id=current.id, previous_id=previous.id if previous else None, request_hash=checksum, idempotency_key=request.idempotency_key, request=payload, budget_usd=request.budget_usd, spent_usd=Decimal(0), reserved_usd=Decimal(0), dispatch_pending=True)
    try:
        with session.begin_nested():
            session.add(record); session.flush()
    except IntegrityError:
        existing = session.scalar(select(VerificationRecord).where(VerificationRecord.user_id == user_id, VerificationRecord.idempotency_key == request.idempotency_key)) or session.scalar(select(VerificationRecord).where(VerificationRecord.user_id == user_id, VerificationRecord.request_hash == checksum))
        if not existing or existing.request_hash != checksum: raise AuditConflict("Concurrent idempotency conflict")
        return existing
    day = utcnow().date().isoformat()
    if not session.scalar(select(SpendAccount).where(SpendAccount.user_id == user_id, SpendAccount.day == day)):
        try:
            with session.begin_nested():
                session.add(SpendAccount(user_id=user_id, day=day, cap_usd=Decimal(str(daily_cap)), spent_usd=0, reserved_usd=0)); session.flush()
        except IntegrityError: pass  # other transaction created the shared cap account
    return record


def public_verification(record):
    return {"id": record.id, "status": record.status, "verdict": record.verdict, "result": record.result, "error": record.error, "spent_usd": str(record.spent_usd), "reserved_usd": str(record.reserved_usd), "budget_usd": str(record.budget_usd), "dispatch_pending": record.dispatch_pending, "last_dispatch_at": record.last_dispatch_at.isoformat() if record.last_dispatch_at else None, "retry_dispatch_after_seconds": 15, "created_at": record.created_at.isoformat(), "completed_at": record.completed_at.isoformat() if record.completed_at else None}
