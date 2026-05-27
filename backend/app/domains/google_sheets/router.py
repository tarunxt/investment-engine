import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import get_logger
from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import User
from app.domains.google_sheets.crypto import decrypt_token, encrypt_token
from app.domains.google_sheets.models import GoogleSheetsCredential
from app.domains.google_sheets.repository import GoogleSheetsCredentialRepository
from app.domains.google_sheets.schemas import (
    GoogleSheetsAuthUrlResponse,
    GoogleSheetsExportJobRequest,
    GoogleSheetsExportResponse,
    GoogleSheetsExportRunRequest,
    GoogleSheetsImportRequest,
    GoogleSheetsStatusResponse,
)
from app.domains.google_sheets.service import GoogleSheetsService
from app.domains.google_sheets.tasks import (
    export_job_to_sheets_task,
    export_run_to_sheets_task,
    import_data_from_sheets_task,
)
from app.infrastructure.database.session import get_async_db

logger = get_logger(__name__)
router = APIRouter(prefix="/google-sheets", tags=["google-sheets"])
_svc = GoogleSheetsService()


class ExchangeCodeRequest(BaseModel):
    code: str


@router.get("/auth-url", response_model=GoogleSheetsAuthUrlResponse)
async def get_auth_url(current_user: User = Depends(get_current_user)):
    try:
        auth_url = _svc.get_auth_url() if _svc.is_configured else ""
        return GoogleSheetsAuthUrlResponse(
            auth_url=auth_url, configured=_svc.is_configured
        )
    except Exception as e:
        logger.error("Failed to generate Google Sheets auth URL: %s", str(e))
        raise HTTPException(500, detail="Failed to generate auth URL")


@router.post("/exchange-code")
async def exchange_code(
    body: ExchangeCodeRequest,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    """Exchange authorization code for tokens. Frontend receives code from Google redirect."""
    if not _svc.is_configured:
        raise HTTPException(503, detail="Google Sheets is not configured")

    try:
        token_data = _svc.exchange_code(body.code)

        access_token_enc = encrypt_token(token_data["access_token"])
        refresh_token_enc = (
            encrypt_token(token_data["refresh_token"])
            if token_data["refresh_token"]
            else None
        )

        repo = GoogleSheetsCredentialRepository(db)
        await repo.upsert(
            current_user.id,
            access_token_enc,
            refresh_token_enc,
            token_data["token_expiry"],
        )
        await db.commit()

        logger.info("Google Sheets connected for user %d", current_user.id)
        return {
            "status": "connected",
            "message": "Google Sheets connected successfully",
        }

    except Exception as e:
        logger.exception("Google Sheets token exchange failed for user %d", current_user.id)
        raise HTTPException(500, detail="Failed to exchange authorization code")


@router.get("/status", response_model=GoogleSheetsStatusResponse)
async def get_status(
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    repo = GoogleSheetsCredentialRepository(db)
    cred = await repo.get_by_user(current_user.id)

    if not cred:
        return GoogleSheetsStatusResponse(connected=False)

    if cred.token_expiry:
        # Ensure timezone-aware comparison
        expiry = cred.token_expiry
        if expiry.tzinfo is None:
            expiry = expiry.replace(tzinfo=timezone.utc)
        if expiry <= datetime.now(tz=timezone.utc):
            return GoogleSheetsStatusResponse(connected=False)

    return GoogleSheetsStatusResponse(
        connected=True, token_expiry=cred.token_expiry
    )


@router.delete("/disconnect")
async def disconnect(
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    repo = GoogleSheetsCredentialRepository(db)
    await repo.delete_by_user(current_user.id)
    await db.commit()

    logger.info("Google Sheets disconnected for user %d", current_user.id)
    return {"message": "Disconnected from Google Sheets"}


@router.post("/export/job", response_model=GoogleSheetsExportResponse)
async def export_job(
    data: GoogleSheetsExportJobRequest,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    repo = GoogleSheetsCredentialRepository(db)
    cred = await repo.get_by_user(current_user.id)

    if not cred:
        raise HTTPException(
            401, detail="Google Sheets not connected. Please connect first."
        )

    task = export_job_to_sheets_task.delay(  # type: ignore
        current_user.id,
        data.job_id,
        data.spreadsheet_url,
        data.sheet_name,
        data.title,
        data.investment_amount,
    )

    logger.info(
        "Queued export job %d to Sheets for user %d (task_id=%s)",
        data.job_id,
        current_user.id,
        task.id,
    )
    return GoogleSheetsExportResponse(
        status="queued",
        message="Job export queued",
        task_id=task.id,
    )


@router.post("/export/run", response_model=GoogleSheetsExportResponse)
async def export_run(
    data: GoogleSheetsExportRunRequest,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    repo = GoogleSheetsCredentialRepository(db)
    cred = await repo.get_by_user(current_user.id)

    if not cred:
        raise HTTPException(
            401, detail="Google Sheets not connected. Please connect first."
        )

    task = export_run_to_sheets_task.delay(  # type: ignore
        current_user.id,
        data.run_id,
        data.spreadsheet_url,
        data.sheet_name,
        data.title,
        data.investment_amount,
    )

    logger.info(
        "Queued export run %d to Sheets for user %d (task_id=%s)",
        data.run_id,
        current_user.id,
        task.id,
    )
    return GoogleSheetsExportResponse(
        status="queued",
        message="Run export queued",
        task_id=task.id,
    )


@router.post("/import", response_model=GoogleSheetsExportResponse)
async def import_data(
    data: GoogleSheetsImportRequest,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    repo = GoogleSheetsCredentialRepository(db)
    cred = await repo.get_by_user(current_user.id)

    if not cred:
        raise HTTPException(
            401, detail="Google Sheets not connected. Please connect first."
        )

    task = import_data_from_sheets_task.delay(  # type: ignore
        current_user.id,
        data.spreadsheet_url,
        data.sheet_name,
    )

    logger.info(
        "Queued import from Sheets for user %d (task_id=%s)",
        current_user.id,
        task.id,
    )
    return GoogleSheetsExportResponse(
        status="queued",
        message="Data import queued",
        task_id=task.id,
    )
