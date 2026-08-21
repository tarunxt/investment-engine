from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import get_logger
from app.core.config import settings
from app.domains.auth.dependencies import get_current_user, require_admin
from app.domains.auth.models import ActivityLog, User, UserProfile
from app.domains.google_sheets.crypto import decrypt_token, encrypt_token
from app.domains.google_sheets.models import GoogleSheetsCredential
from app.domains.google_sheets.repository import (
    GoogleSheetsAppConfigRepository,
    GoogleSheetsCredentialRepository,
)
from app.domains.google_sheets.schemas import (
    GoogleSheetsAdminConfigResponse,
    GoogleSheetsAdminConfigUpdateRequest,
    GoogleSheetsAuthUrlResponse,
    GoogleSheetsDefaultSheetRequest,
    GoogleSheetsDefaultSheetResponse,
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


def _default_sheet_title(user: User) -> str:
    display_name = (
        (user.full_name or "").strip()
        or user.username.strip()
        or user.email.split("@", 1)[0].strip()
    )
    return f"{display_name} - Investor Engine"


def _get_or_create_profile(current_user: User, db: AsyncSession) -> UserProfile:
    if current_user.profile is not None:
        return current_user.profile

    profile = UserProfile(user_id=current_user.id)
    current_user.profile = profile
    db.add(profile)
    return profile


def _get_sheet_tokens(cred: GoogleSheetsCredential) -> tuple[str, str | None]:
    access_token = decrypt_token(cred.access_token_enc)
    refresh_token = (
        decrypt_token(cred.refresh_token_enc) if cred.refresh_token_enc else None
    )
    return access_token, refresh_token


async def _save_default_sheet_url(
    db: AsyncSession,
    current_user: User,
    *,
    access_token: str,
    refresh_token: str | None,
    spreadsheet_url: str | None = None,
    title: str | None = None,
) -> tuple[str, bool]:
    profile = _get_or_create_profile(current_user, db)
    cleaned_url = spreadsheet_url.strip() if spreadsheet_url else None

    if cleaned_url:
        spreadsheet = await run_in_threadpool(
            _svc.get_spreadsheet,
            access_token,
            refresh_token,
            cleaned_url,
        )
        canonical_url = spreadsheet["spreadsheet_url"]
        created_new = False
    else:
        spreadsheet_id = await run_in_threadpool(
            _svc.create_spreadsheet,
            access_token,
            refresh_token,
            title or _default_sheet_title(current_user),
        )
        canonical_url = _svc.build_spreadsheet_url(spreadsheet_id)
        created_new = True

    profile.google_sheets_master_url = canonical_url
    db.add(profile)
    await db.flush()
    return canonical_url, created_new


@router.get("/auth-url", response_model=GoogleSheetsAuthUrlResponse)
async def get_auth_url(current_user: User = Depends(get_current_user)):
    try:
        configured = await run_in_threadpool(lambda: _svc.is_configured)
        auth_url = await run_in_threadpool(_svc.get_auth_url) if configured else ""
        return GoogleSheetsAuthUrlResponse(
            auth_url=auth_url,
            configured=configured,
            redirect_uri=settings.google_redirect_uri,
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
    configured = await run_in_threadpool(lambda: _svc.is_configured)
    if not configured:
        raise HTTPException(503, detail="Google Sheets is not configured")

    try:
        token_data = await run_in_threadpool(_svc.exchange_code, body.code)

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

        default_spreadsheet_url = (
            current_user.profile.google_sheets_master_url
            if current_user.profile is not None
            else None
        )
        if not default_spreadsheet_url:
            try:
                default_spreadsheet_url, _ = await _save_default_sheet_url(
                    db,
                    current_user,
                    access_token=token_data["access_token"],
                    refresh_token=token_data["refresh_token"],
                )
            except Exception:
                logger.exception(
                    "Failed to create default Google Sheet for user %d",
                    current_user.id,
                )

        await db.commit()

        logger.info("Google Sheets connected for user %d", current_user.id)
        return {
            "status": "connected",
            "message": "Google Sheets connected successfully",
            "default_spreadsheet_url": default_spreadsheet_url,
        }

    except Exception as e:
        logger.exception("Google Sheets token exchange failed for user %d", current_user.id)
        raise HTTPException(500, detail="Failed to exchange authorization code")


@router.get("/admin-config", response_model=GoogleSheetsAdminConfigResponse)
async def get_admin_config(
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(require_admin),
):
    repo = GoogleSheetsAppConfigRepository(db)
    config = await repo.get()
    configured = await run_in_threadpool(lambda: _svc.is_configured)

    return GoogleSheetsAdminConfigResponse(
        configured=configured,
        client_id=config.client_id if config else None,
        has_client_secret=bool(config and config.client_secret_enc),
        redirect_uri=settings.google_redirect_uri,
        updated_at=config.updated_at if config else None,
        updated_by_user_id=config.updated_by_user_id if config else None,
    )


@router.put("/admin-config", response_model=GoogleSheetsAdminConfigResponse)
async def update_admin_config(
    data: GoogleSheetsAdminConfigUpdateRequest,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(require_admin),
):
    repo = GoogleSheetsAppConfigRepository(db)
    existing = await repo.get()

    client_id = data.client_id.strip()
    client_secret = (data.client_secret or "").strip()

    if not client_id:
        raise HTTPException(400, detail="Client ID is required")

    if not client_secret:
        if existing and existing.client_secret_enc:
            client_secret_enc = existing.client_secret_enc
        else:
            raise HTTPException(400, detail="Client secret is required")
    else:
        try:
            client_secret_enc = encrypt_token(client_secret)
        except RuntimeError as exc:
            raise HTTPException(503, detail=str(exc)) from exc

    config = await repo.upsert(
        client_id=client_id,
        client_secret_enc=client_secret_enc,
        updated_by_user_id=current_user.id,
    )
    db.add(
        ActivityLog(
            user_id=current_user.id,
            action="update_google_sheets_app_config",
            details="Updated Google Sheets OAuth app configuration",
        )
    )
    await db.commit()

    logger.info(
        "Google Sheets app config updated by admin user %d", current_user.id
    )
    return GoogleSheetsAdminConfigResponse(
        configured=await run_in_threadpool(lambda: _svc.is_configured),
        client_id=config.client_id,
        has_client_secret=bool(config.client_secret_enc),
        redirect_uri=settings.google_redirect_uri,
        updated_at=config.updated_at,
        updated_by_user_id=config.updated_by_user_id,
    )


@router.get("/status", response_model=GoogleSheetsStatusResponse)
async def get_status(
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    repo = GoogleSheetsCredentialRepository(db)
    cred = await repo.get_by_user(current_user.id)
    default_spreadsheet_url = (
        current_user.profile.google_sheets_master_url
        if current_user.profile is not None
        else None
    )

    if not cred:
        return GoogleSheetsStatusResponse(
            connected=False,
            default_spreadsheet_url=default_spreadsheet_url,
        )

    if cred.token_expiry:
        # Ensure timezone-aware comparison
        expiry = cred.token_expiry
        if expiry.tzinfo is None:
            expiry = expiry.replace(tzinfo=timezone.utc)
        if expiry <= datetime.now(tz=timezone.utc):
            try:
                refresh_token = (
                    decrypt_token(cred.refresh_token_enc)
                    if cred.refresh_token_enc
                    else None
                )
                if not refresh_token:
                    return GoogleSheetsStatusResponse(
                        connected=False,
                        default_spreadsheet_url=default_spreadsheet_url,
                    )
                refreshed = await run_in_threadpool(
                    _svc.refresh_access_token, refresh_token
                )
                cred.access_token_enc = encrypt_token(refreshed["access_token"])
                cred.token_expiry = refreshed["token_expiry"]
                await db.commit()
                await db.refresh(cred)
            except Exception:
                logger.exception("Google Sheets token refresh failed for user %d", current_user.id)
                return GoogleSheetsStatusResponse(
                    connected=False,
                    default_spreadsheet_url=default_spreadsheet_url,
                )

    if not default_spreadsheet_url:
        access_token, refresh_token = _get_sheet_tokens(cred)
        try:
            default_spreadsheet_url, _ = await _save_default_sheet_url(
                db,
                current_user,
                access_token=access_token,
                refresh_token=refresh_token,
            )
            await db.commit()
        except Exception:
            logger.exception(
                "Failed to backfill default Google Sheet for user %d",
                current_user.id,
            )

    return GoogleSheetsStatusResponse(
        connected=True,
        token_expiry=cred.token_expiry,
        default_spreadsheet_url=default_spreadsheet_url,
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


@router.put("/default-sheet", response_model=GoogleSheetsDefaultSheetResponse)
async def save_default_sheet(
    data: GoogleSheetsDefaultSheetRequest,
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    repo = GoogleSheetsCredentialRepository(db)
    cred = await repo.get_by_user(current_user.id)

    if not cred:
        raise HTTPException(
            401, detail="Google Sheets not connected. Please connect first."
        )

    access_token, refresh_token = _get_sheet_tokens(cred)

    try:
        default_spreadsheet_url, created_new = await _save_default_sheet_url(
            db,
            current_user,
            access_token=access_token,
            refresh_token=refresh_token,
            spreadsheet_url=data.spreadsheet_url,
            title=data.title,
        )
        await db.commit()
        logger.info(
            "Updated default Google Sheet for user %d (created_new=%s)",
            current_user.id,
            created_new,
        )
        return GoogleSheetsDefaultSheetResponse(
            spreadsheet_url=default_spreadsheet_url,
            created_new=created_new,
        )
    except Exception:
        logger.exception(
            "Failed to save default Google Sheet for user %d", current_user.id
        )
        raise HTTPException(400, detail="Failed to save Google Sheet URL")


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
        spreadsheet_url=(
            data.spreadsheet_url
            or (
                current_user.profile.google_sheets_master_url
                if current_user.profile is not None
                else None
            )
        ),
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
        spreadsheet_url=(
            data.spreadsheet_url
            or (
                current_user.profile.google_sheets_master_url
                if current_user.profile is not None
                else None
            )
        ),
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
