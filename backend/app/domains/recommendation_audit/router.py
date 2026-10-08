import asyncio
import logging
from datetime import timedelta
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import and_, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from app.core.config import settings
from app.core.recovery import recovery_mode, audit_recovery_blocked, require_audit_request_allowed, RecoveryBlocked
from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import User
from app.domains.runs.models import Run
from app.infrastructure.database.session import get_async_db
from .capture import materialize_run
from .models import VerificationRecord, utcnow
from .schemas import CalculationCapture, MaterializeRequest, VerificationCreate
from .service import AuditConflict, comparison_view, create_verification, public_verification

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/runs/recommendation-audit", tags=["recommendation-audit"])


def enabled():
    if not settings.recommendation_audit_enabled: raise HTTPException(404, "Recommendation audit disabled")


def write_enabled():
    enabled()
    if audit_recovery_blocked(settings): raise HTTPException(403, "Recovery mode permits audit reads only")


def request_allowed(request, *, record=None):
    try: require_audit_request_allowed(request, settings, record=record)
    except RecoveryBlocked as exc: raise HTTPException(403, str(exc)) from exc


@router.get("/comparison")
async def get_comparison(run_id: int = Query(ge=1), market: str = Query(pattern="^(india|us)$"), symbol: str = Query(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9&_.-]+$"), exchange: str = Query(min_length=1, max_length=32, pattern=r"^[A-Za-z0-9_.-]+$"), db: AsyncSession = Depends(get_async_db), user: User = Depends(get_current_user)):
    enabled()
    run = await db.scalar(select(Run.id).where(Run.id == run_id, Run.user_id == user.id))
    if not run: raise HTTPException(404, "Run not found")
    view = await db.run_sync(lambda session: comparison_view(session, user.id, run_id, market, symbol, exchange))
    tariff = settings.recommendation_audit_kite_incremental_cost_usd
    view["capabilities"] = {"external_enabled": settings.recommendation_audit_external_enabled and not recovery_mode(), "fundamentals_enabled":settings.recommendation_audit_fundamentals_enabled and not recovery_mode(),"automatic_delivery_recovery":True,"recovery_read_only": audit_recovery_blocked(settings), "recovery_stored_only": recovery_mode() and not audit_recovery_blocked(settings), "daily_cap_usd": settings.recommendation_audit_daily_cap_usd, "kite_request_cost_usd": tariff, "kite_max_requests": 2, "rbi_max_requests": 1,"nse_filing_max_requests":1,"total_max_requests":3}
    return view


@router.post("/calculations")
async def calculation(body: CalculationCapture, db: AsyncSession = Depends(get_async_db), user: User = Depends(get_current_user)):
    write_enabled()
    from .calculation_capture import capture_calculation
    try:
        records = await db.run_sync(lambda session: capture_calculation(session, user.id, body))
        await db.commit()
    except LookupError as exc: raise HTTPException(404, str(exc))
    except ValueError as exc: raise HTTPException(409, str(exc))
    return {"decision_ids": [r.id for r in records], "provenance": "calculation_observed", "original_formula_claimed": False}


@router.post("/materialize")
async def materialize(body: MaterializeRequest, db: AsyncSession = Depends(get_async_db), user: User = Depends(get_current_user)):
    write_enabled()
    run = await db.scalar(select(Run).where(Run.id == body.run_id, Run.user_id == user.id).with_for_update())
    if not run: raise HTTPException(404, "Run not found")
    try:
        decisions = await db.run_sync(lambda session: materialize_run(session, run))
        await db.commit()
    except ValueError as exc: raise HTTPException(422, str(exc))
    return {"captured": len(decisions), "provenance": "legacy_observed", "original_availability_known": False}


@router.post("/verifications")
async def verify(body: VerificationCreate, db: AsyncSession = Depends(get_async_db), user: User = Depends(get_current_user)):
    write_enabled()
    request_allowed(body.model_dump(mode="json"))
    if body.mode == "external_data" and not settings.recommendation_audit_external_enabled: raise HTTPException(403, "External verification disabled")
    try:
        record = await db.run_sync(lambda session: create_verification(session, user.id, body, daily_cap=settings.recommendation_audit_daily_cap_usd))
        request_allowed(record.request, record=record)
        await db.commit()  # request/outbox committed before broker delivery
    except LookupError as exc: raise HTTPException(404, str(exc))
    except AuditConflict as exc: raise HTTPException(409, str(exc))
    record_id=record.id
    dispatch_at=utcnow()
    dispatchable = or_(VerificationRecord.status == "queued", and_(VerificationRecord.status == "processing", VerificationRecord.lease_until < dispatch_at))
    claimed = await db.execute(update(VerificationRecord).where(VerificationRecord.id == record.id, VerificationRecord.user_id == user.id, dispatchable, or_(VerificationRecord.last_dispatch_at.is_(None), VerificationRecord.last_dispatch_at < dispatch_at - timedelta(seconds=15))).values(last_dispatch_at=dispatch_at, dispatch_pending=True).execution_options(synchronize_session=False))
    await db.commit()
    if claimed.rowcount == 1:
        from .outbox import publish_verification
        try:
            await asyncio.wait_for(asyncio.to_thread(publish_verification, record.id), timeout=3)
            await db.execute(update(VerificationRecord).where(VerificationRecord.id == record.id, VerificationRecord.user_id == user.id, VerificationRecord.last_dispatch_at==dispatch_at, VerificationRecord.status.in_(["queued","processing"])).values(dispatch_pending=False).execution_options(synchronize_session=False))
            await db.commit()
            await db.refresh(record)
        except Exception:
            await db.rollback()
            logger.exception("Audit request %s retained for automatic outbox recovery after queue failure", record_id)
    await db.refresh(record)
    return public_verification(record)


@router.get("/verifications/{record_id}")
async def verification(record_id: str, db: AsyncSession = Depends(get_async_db), user: User = Depends(get_current_user)):
    enabled()
    record = await db.scalar(select(VerificationRecord).where(VerificationRecord.id == record_id, VerificationRecord.user_id == user.id))
    if not record: raise HTTPException(404, "Verification not found")
    return public_verification(record)


@router.post("/verifications/{record_id}/cancel")
async def cancel(record_id: str, db: AsyncSession = Depends(get_async_db), user: User = Depends(get_current_user)):
    write_enabled()
    record = await db.scalar(select(VerificationRecord).where(VerificationRecord.id == record_id, VerificationRecord.user_id == user.id).with_for_update())
    if not record: raise HTTPException(404, "Verification not found")
    request_allowed(record.request, record=record)
    if record.status in {"queued", "processing"}:
        record.status = "cancelled"; record.fence += 1; record.dispatch_pending = False; record.completed_at = utcnow()
        # Started/uncertain spend is not released merely because UI cancels.
        await db.commit()
    return public_verification(record)
