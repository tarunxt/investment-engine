from __future__ import annotations

import asyncio
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query

from app.domains.ai_providers.factory import ProviderFactory
from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import User
from app.domains.bullpen_run_audit.schemas import (
    BullpenRunAuditDetailResponse,
    BullpenRunAuditFeedbackCreateRequest,
    BullpenRunAuditFeedbackDetail,
    BullpenRunAuditFeedbackSummary,
    BullpenRunAuditListResponse,
    BullpenRunAuditManualCheck,
    BullpenRunAuditManualCheckUpdateRequest,
    BullpenRunAuditMaterializeResponse,
    BullpenRunAuditRemark,
    BullpenRunAuditRemarkCreateRequest,
    BullpenRunAuditSectionResponse,
)
from app.domains.bullpen_run_audit.service import (
    add_run_audit_manual_check_sync,
    add_run_audit_remark_sync,
    enqueue_run_audit_feedback_sync,
    export_run_audit_bundle_sync,
    get_run_audit_detail_sync,
    get_run_audit_feedback_detail_sync,
    get_run_audit_section_sync,
    list_run_audit_feedback_sync,
    list_run_audit_summaries_sync,
    materialize_run_audit_snapshot_sync,
)
from app.infrastructure.database.sync_session import SyncSessionLocal

router = APIRouter(prefix="/bullpen-ai/run-audits", tags=["bullpen-ai"])


def _parse_date(value: str | None, *, end_of_day: bool = False) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    if end_of_day:
        parsed = parsed.replace(hour=23, minute=59, second=59, microsecond=999999)
    return parsed.astimezone(UTC)


def _current_user_label(current_user: User) -> str:
    return current_user.full_name or current_user.username or current_user.email


@router.get("", response_model=BullpenRunAuditListResponse)
async def list_run_audits(
    page: int = Query(default=1, ge=1),
    limit: int = Query(default=20, ge=1, le=100),
    status: str | None = Query(default=None),
    triggered_by: str | None = Query(default=None),
    dry_live_mode: str | None = Query(default=None),
    from_date: str | None = Query(default=None),
    to_date: str | None = Query(default=None),
    stage_failure: str | None = Query(default=None),
    audit_status: str | None = Query(default=None),
    finding_severity: str | None = Query(default=None),
    feedback_generated: bool | None = Query(default=None),
    run_id_search: str | None = Query(default=None),
    current_user: User = Depends(get_current_user),
):
    def _load() -> BullpenRunAuditListResponse:
        with SyncSessionLocal() as session:
            response = list_run_audit_summaries_sync(
                session,
                user_id=current_user.id,
                page=page,
                limit=limit,
                run_status=status,
                triggered_by=triggered_by,
                dry_live_mode=dry_live_mode,
                from_date=_parse_date(from_date),
                to_date=_parse_date(to_date, end_of_day=True),
                run_id_search=run_id_search,
                stage_failure=stage_failure,
                audit_status=audit_status,
                finding_severity=finding_severity,
                feedback_generated=feedback_generated,
            )
            session.commit()
            return response

    return await asyncio.to_thread(_load)


@router.post("/{run_id}/materialize", response_model=BullpenRunAuditMaterializeResponse)
async def materialize_run_audit(
    run_id: str,
    current_user: User = Depends(get_current_user),
):
    def _materialize() -> BullpenRunAuditMaterializeResponse:
        with SyncSessionLocal() as session:
            materialized = materialize_run_audit_snapshot_sync(
                session,
                user_id=current_user.id,
                run_id=run_id,
                force=True,
            )
            from app.domains.bullpen_run_audit.service import _snapshot_to_metadata

            session.commit()
            return BullpenRunAuditMaterializeResponse(
                status="materialized",
                snapshot=_snapshot_to_metadata(materialized.snapshot),
            )

    try:
        return await asyncio.to_thread(_materialize)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/{run_id}", response_model=BullpenRunAuditDetailResponse)
async def get_run_audit_detail(
    run_id: str,
    current_user: User = Depends(get_current_user),
):
    def _load() -> BullpenRunAuditDetailResponse:
        with SyncSessionLocal() as session:
            response = get_run_audit_detail_sync(session, user_id=current_user.id, run_id=run_id)
            session.commit()
            return response

    try:
        return await asyncio.to_thread(_load)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/{run_id}/sections/{section}", response_model=BullpenRunAuditSectionResponse)
async def get_run_audit_section(
    run_id: str,
    section: str,
    current_user: User = Depends(get_current_user),
):
    def _load() -> BullpenRunAuditSectionResponse:
        with SyncSessionLocal() as session:
            response = get_run_audit_section_sync(
                session,
                user_id=current_user.id,
                run_id=run_id,
                section=section,
            )
            session.commit()
            return response

    try:
        return await asyncio.to_thread(_load)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/{run_id}/findings", response_model=list[dict[str, object]])
async def get_run_audit_findings(
    run_id: str,
    current_user: User = Depends(get_current_user),
):
    detail = await get_run_audit_detail(run_id=run_id, current_user=current_user)
    return [finding.model_dump(mode="json") for finding in detail.findings]


@router.post("/{run_id}/remarks", response_model=BullpenRunAuditRemark, status_code=201)
async def add_run_audit_remark(
    run_id: str,
    request: BullpenRunAuditRemarkCreateRequest,
    current_user: User = Depends(get_current_user),
):
    def _create() -> BullpenRunAuditRemark:
        with SyncSessionLocal() as session:
            remark = add_run_audit_remark_sync(
                session,
                user_id=current_user.id,
                run_id=run_id,
                author_label=_current_user_label(current_user),
                request=request,
            )
            session.commit()
            return remark

    return await asyncio.to_thread(_create)


@router.post("/{run_id}/manual-checks", response_model=BullpenRunAuditManualCheck, status_code=201)
async def add_run_audit_manual_check(
    run_id: str,
    request: BullpenRunAuditManualCheckUpdateRequest,
    current_user: User = Depends(get_current_user),
):
    def _create() -> BullpenRunAuditManualCheck:
        with SyncSessionLocal() as session:
            check = add_run_audit_manual_check_sync(
                session,
                user_id=current_user.id,
                run_id=run_id,
                request=request,
            )
            session.commit()
            return check

    return await asyncio.to_thread(_create)


@router.post("/{run_id}/feedback", response_model=BullpenRunAuditFeedbackSummary, status_code=202)
async def enqueue_run_audit_feedback(
    run_id: str,
    request: BullpenRunAuditFeedbackCreateRequest,
    current_user: User = Depends(get_current_user),
):
    target_health = ProviderFactory.validate_target(request.provider, request.model)
    if not target_health.available:
        raise HTTPException(status_code=400, detail=target_health.reason or "Selected model is unavailable.")

    def _enqueue() -> BullpenRunAuditFeedbackSummary:
        with SyncSessionLocal() as session:
            response = enqueue_run_audit_feedback_sync(
                session,
                user_id=current_user.id,
                run_id=run_id,
                request=request,
            )
            session.commit()
            return response

    try:
        return await asyncio.to_thread(_enqueue)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/{run_id}/feedback", response_model=list[BullpenRunAuditFeedbackSummary])
async def list_run_audit_feedback(
    run_id: str,
    current_user: User = Depends(get_current_user),
):
    def _list() -> list[BullpenRunAuditFeedbackSummary]:
        with SyncSessionLocal() as session:
            response = list_run_audit_feedback_sync(
                session,
                user_id=current_user.id,
                run_id=run_id,
            )
            session.commit()
            return response

    return await asyncio.to_thread(_list)


@router.get("/{run_id}/feedback/{feedback_id}", response_model=BullpenRunAuditFeedbackDetail)
async def get_run_audit_feedback_detail(
    run_id: str,
    feedback_id: int,
    current_user: User = Depends(get_current_user),
):
    del run_id

    def _load() -> BullpenRunAuditFeedbackDetail:
        with SyncSessionLocal() as session:
            response = get_run_audit_feedback_detail_sync(
                session,
                user_id=current_user.id,
                feedback_id=feedback_id,
            )
            session.commit()
            return response

    try:
        return await asyncio.to_thread(_load)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/{run_id}/export")
async def export_run_audit_bundle(
    run_id: str,
    current_user: User = Depends(get_current_user),
):
    def _export() -> dict[str, object]:
        with SyncSessionLocal() as session:
            response = export_run_audit_bundle_sync(
                session,
                user_id=current_user.id,
                run_id=run_id,
            )
            session.commit()
            return response

    try:
        return await asyncio.to_thread(_export)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

