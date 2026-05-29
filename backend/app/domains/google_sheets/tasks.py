import logging
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import select

from app.domains.google_sheets.crypto import decrypt_token
from app.domains.google_sheets.models import GoogleSheetsCredential
from app.domains.google_sheets.service import GoogleSheetsService
from app.domains.google_sheets.stock_service import (
    format_sheet_title,
    format_stocks_for_sheet,
    normalize_stock_rows,
    parse_stock_recommendations,
)
from app.domains.jobs.models import Job
from app.domains.jobs.repository import SyncJobRepository
from app.domains.runs.models import Run, RunJob
from app.domains.runs.repository import SyncRunRepository
from app.infrastructure.database.sync_session import SyncSessionLocal
from app.infrastructure.messaging.celery_app import celery

logger = logging.getLogger(__name__)
_svc = GoogleSheetsService()
IST = ZoneInfo("Asia/Kolkata")
MIN_EXPECTED_STOCK_ROWS = 5


def _error_text(exc: Exception) -> str:
    text = str(exc).strip()
    if text:
        return text[:500]
    return f"{exc.__class__.__name__}: unknown export error"


def _with_run_metadata_columns(
    headers: list[str],
    rows: list[list[object]],
    run_number: int,
    run_dt_ist: datetime,
    llm_label: str,
) -> tuple[list[str], list[list[object]]]:
    meta_headers = ["Run #", "Run Date", "Run Time", "LLM"]
    run_date = run_dt_ist.strftime("%Y-%m-%d")
    run_time = run_dt_ist.strftime("%H:%M:%S")
    meta = [run_number, run_date, run_time, llm_label]
    return headers + meta_headers, [row + meta for row in rows]


@celery.task(bind=True, max_retries=3, soft_time_limit=120, time_limit=180)
def export_job_to_sheets_task(
    self,
    user_id: int,
    job_id: int,
    spreadsheet_url: str | None,
    sheet_name: str = "Investment Ideas",
    title: str = "Investment Analysis Export",
    investment_amount: str = "INR 10,000",
    run_id: int | None = None,
    stage: int | None = None,
):
    with SyncSessionLocal() as db:
        try:
            run_repo = SyncRunRepository(db)
            job_repo = SyncJobRepository(db)
            from app.domains.jobs.tasks import _publish_job_update, _refresh_run_status
            cred = db.execute(
                select(GoogleSheetsCredential).where(
                    GoogleSheetsCredential.user_id == user_id
                )
            ).scalar_one_or_none()

            if not cred:
                job = db.execute(select(Job).where(Job.id == job_id)).scalar_one_or_none()
                if job:
                    job_repo.update_export_state(
                        job,
                        export_status="failed",
                        export_error="Google Sheets not connected",
                    )
                    _publish_job_update(job)
                    _refresh_run_status(db, job.id)
                return {"status": "failed", "error": "Google Sheets not connected"}

            job = db.execute(
                select(Job).where(Job.id == job_id, Job.user_id == user_id)
            ).scalar_one_or_none()

            if not job:
                return {"status": "failed", "error": "Job not found"}
            job_repo.update_export_state(job, export_status="processing", export_error=None)
            _publish_job_update(job)
            _refresh_run_status(db, job.id)

            if not job.response:
                job_repo.update_export_state(
                    job,
                    export_status="failed",
                    export_error="Job has no response yet",
                )
                _publish_job_update(job)
                _refresh_run_status(db, job.id)
                return {"status": "failed", "error": "Job has no response yet"}

            access_token = decrypt_token(cred.access_token_enc)
            refresh_token = (
                decrypt_token(cred.refresh_token_enc)
                if cred.refresh_token_enc
                else None
            )

            stocks = normalize_stock_rows(parse_stock_recommendations(job.response))

            if not stocks:
                response_preview = " ".join((job.response or "").split())[:220]
                response_hint = (
                    f" Response preview: {response_preview}"
                    if response_preview
                    else ""
                )
                job_repo.update_export_state(
                    job,
                    export_status="failed",
                    export_error=(
                        "No stock recommendations found in job response."
                        f"{response_hint}"
                    )[:500],
                )
                _publish_job_update(job)
                _refresh_run_status(db, job.id)
                return {
                    "status": "failed",
                    "error": (
                        "No stock recommendations found in job response. "
                        f"Parsed rows: {len(stocks)}."
                    )[:500],
                }
            if len(stocks) < MIN_EXPECTED_STOCK_ROWS:
                reason = (
                    f"Insufficient stock recommendations for export: expected at least "
                    f"{MIN_EXPECTED_STOCK_ROWS}, got {len(stocks)}."
                )
                job_repo.update_export_state(
                    job,
                    export_status="failed",
                    export_error=reason[:500],
                )
                _publish_job_update(job)
                _refresh_run_status(db, job.id)
                return {"status": "failed", "error": reason[:500]}

            now_ist = datetime.now(IST)
            formatted_title = format_sheet_title(now_ist, investment_amount)

            headers, rows = format_stocks_for_sheet(stocks)

            if spreadsheet_url:
                spreadsheet_id = _svc.extract_spreadsheet_id(spreadsheet_url)
            else:
                spreadsheet_id = _svc.create_spreadsheet(
                    access_token, refresh_token, formatted_title
                )

            meta_run_number = run_id if run_id else job_id
            headers, rows = _with_run_metadata_columns(
                headers=headers,
                rows=rows,
                run_number=meta_run_number,
                run_dt_ist=now_ist,
                llm_label=f"{job.provider}/{job.model}",
            )

            _, sheet_gid = _svc.append_sheet(
                access_token,
                refresh_token,
                spreadsheet_id,
                headers,
                rows,
                sheet_name,
            )

            sheet_url = f"https://docs.google.com/spreadsheets/d/{spreadsheet_id}/edit#gid={sheet_gid}"
            job_repo.update_export_state(
                job,
                export_status="completed",
                export_error=None,
                exported_at=datetime.now(timezone.utc),
                exported_sheet_url=sheet_url,
            )
            _publish_job_update(job)
            _refresh_run_status(db, job.id)

            if run_id:
                run = run_repo.get(run_id)
                if run:
                    run_repo.update_export_state(
                        run,
                        export_status=run.export_status or "processing",
                        export_error=run.export_error,
                        exported_at=datetime.now(timezone.utc),
                        exported_sheet_url=sheet_url,
                    )
                    _refresh_run_status(db, job.id)
            logger.info(
                "Exported job %d (%d stocks) to Google Sheets for user %d",
                job_id,
                len(stocks),
                user_id,
            )
            return {
                "status": "completed",
                "message": f"Exported {len(stocks)} stock recommendations to Google Sheets",
                "spreadsheet_url": sheet_url,
                "stocks_count": len(stocks),
            }

        except Exception as exc:
            job_repo = SyncJobRepository(db)
            job = db.execute(select(Job).where(Job.id == job_id)).scalar_one_or_none()
            is_last_attempt = self.request.retries >= self.max_retries
            if job:
                job_repo.update_export_state(
                    job,
                    export_status="failed" if is_last_attempt else "queued",
                    export_error=_error_text(exc),
                )
                _publish_job_update(job)
                _refresh_run_status(db, job.id)
            logger.exception(
                "Export job %d to Sheets failed for user %d", job_id, user_id
            )
            if is_last_attempt:
                return {"status": "failed", "error": _error_text(exc)}
            raise self.retry(exc=exc, countdown=10)


@celery.task(bind=True, max_retries=3, soft_time_limit=120, time_limit=180)
def export_run_to_sheets_task(
    self,
    user_id: int,
    run_id: int,
    spreadsheet_url: str | None,
    sheet_name: str = "Stock Ideas",
    title: str = "Investment Analysis Export",
    investment_amount: str = "INR 10,000",
):
    with SyncSessionLocal() as db:
        try:
            run_repo = SyncRunRepository(db)
            cred = db.execute(
                select(GoogleSheetsCredential).where(
                    GoogleSheetsCredential.user_id == user_id
                )
            ).scalar_one_or_none()

            if not cred:
                run = run_repo.get(run_id)
                if run:
                    run_repo.update_export_state(
                        run,
                        export_status="failed",
                        export_error="Google Sheets not connected",
                    )
                return {"status": "failed", "error": "Google Sheets not connected"}

            run = db.execute(
                select(Run).where(Run.id == run_id, Run.user_id == user_id)
            ).scalar_one_or_none()

            if not run:
                return {"status": "failed", "error": "Run not found"}

            run_jobs = db.execute(
                select(RunJob).where(RunJob.run_id == run_id)
            ).scalars().all()

            access_token = decrypt_token(cred.access_token_enc)
            refresh_token = (
                decrypt_token(cred.refresh_token_enc)
                if cred.refresh_token_enc
                else None
            )

            all_stocks: list[dict] = []
            model_names = set()

            for run_job in run_jobs:
                job = run_job.job
                if job.response:
                    stocks = normalize_stock_rows(parse_stock_recommendations(job.response))
                    # Add stage info to each stock
                    for stock in stocks:
                        stock["stage"] = f"Stage {run_job.stage}"
                    all_stocks.extend(stocks)
                    model_names.add(f"{job.provider} ({job.model})")

            if not all_stocks:
                terminal_jobs = [
                    rj.job
                    for rj in run_jobs
                    if rj.job
                    and (
                        (getattr(rj.job.status, "value", str(rj.job.status)).lower())
                        in {"completed", "failed"}
                    )
                ]
                sample = next((j for j in terminal_jobs if j.response), None)
                response_preview = " ".join((sample.response or "").split())[:220] if sample else ""
                reason = "No stock recommendations found in run response"
                if response_preview:
                    reason = f"{reason}. Sample response preview: {response_preview}"
                run_repo.update_export_state(
                    run,
                    export_status="failed",
                    export_error=reason[:500],
                )
                return {
                    "status": "failed",
                    "error": reason[:500],
                }
            if len(all_stocks) < MIN_EXPECTED_STOCK_ROWS:
                reason = (
                    f"Insufficient total stock recommendations for export: expected at least "
                    f"{MIN_EXPECTED_STOCK_ROWS}, got {len(all_stocks)}."
                )
                run_repo.update_export_state(
                    run,
                    export_status="failed",
                    export_error=reason[:500],
                )
                return {"status": "failed", "error": reason[:500]}

            now_ist = datetime.now(IST)
            formatted_title = format_sheet_title(now_ist, investment_amount)

            headers, rows = format_stocks_for_sheet(all_stocks)

            if spreadsheet_url:
                spreadsheet_id = _svc.extract_spreadsheet_id(spreadsheet_url)
            else:
                spreadsheet_id = _svc.create_spreadsheet(
                    access_token, refresh_token, formatted_title
                )

            headers, rows = _with_run_metadata_columns(
                headers=headers,
                rows=rows,
                run_number=run.id,
                run_dt_ist=run.created_at.astimezone(IST),
                llm_label="multi-llm",
            )
            _, sheet_gid = _svc.append_sheet(
                access_token,
                refresh_token,
                spreadsheet_id,
                headers,
                rows,
                sheet_name,
            )

            sheet_url = f"https://docs.google.com/spreadsheets/d/{spreadsheet_id}/edit#gid={sheet_gid}"
            run_repo.update_export_state(
                run,
                export_status="completed",
                export_error=None,
                exported_at=datetime.now(timezone.utc),
                exported_sheet_url=sheet_url,
            )
            logger.info(
                "Exported run %d (%d stocks from %d models) to Google Sheets for user %d",
                run_id,
                len(all_stocks),
                len(model_names),
                user_id,
            )
            return {
                "status": "completed",
                "message": f"Exported {len(all_stocks)} stock recommendations from {len(model_names)} models to Google Sheets",
                "spreadsheet_url": sheet_url,
                "stocks_count": len(all_stocks),
                "models_count": len(model_names),
            }

        except Exception as exc:
            run_repo = SyncRunRepository(db)
            run = run_repo.get(run_id)
            is_last_attempt = self.request.retries >= self.max_retries
            if run:
                run_repo.update_export_state(
                    run,
                    export_status="failed" if is_last_attempt else "queued",
                    export_error=_error_text(exc),
                )
            logger.exception(
                "Export run %d to Sheets failed for user %d", run_id, user_id
            )
            if is_last_attempt:
                return {"status": "failed", "error": _error_text(exc)}
            raise self.retry(exc=exc, countdown=10)


@celery.task(bind=True, max_retries=3, soft_time_limit=120, time_limit=180)
def import_data_from_sheets_task(
    self, user_id: int, spreadsheet_url: str, sheet_name: str = "Sheet1"
):
    with SyncSessionLocal() as db:
        try:
            cred = db.execute(
                select(GoogleSheetsCredential).where(
                    GoogleSheetsCredential.user_id == user_id
                )
            ).scalar_one_or_none()

            if not cred:
                return {"status": "failed", "error": "Google Sheets not connected"}

            access_token = decrypt_token(cred.access_token_enc)
            refresh_token = (
                decrypt_token(cred.refresh_token_enc)
                if cred.refresh_token_enc
                else None
            )

            spreadsheet_id = _svc.extract_spreadsheet_id(spreadsheet_url)
            records = _svc.read_sheet(
                access_token, refresh_token, spreadsheet_id, sheet_name
            )

            logger.info(
                "Imported %d records from Google Sheets for user %d",
                len(records),
                user_id,
            )
            return {
                "status": "completed",
                "message": f"Imported {len(records)} records",
                "records_count": len(records),
                "records": records,
            }

        except Exception as exc:
            logger.exception(
                "Import from Sheets failed for user %d", user_id
            )
            raise self.retry(exc=exc, countdown=10)
