import logging
from datetime import datetime

from sqlalchemy import select

from app.domains.google_sheets.crypto import decrypt_token
from app.domains.google_sheets.models import GoogleSheetsCredential
from app.domains.google_sheets.service import GoogleSheetsService
from app.domains.google_sheets.stock_service import (
    format_sheet_title,
    format_stocks_for_sheet,
    parse_stock_recommendations,
)
from app.domains.jobs.models import Job
from app.domains.runs.models import Run, RunJob
from app.infrastructure.database.sync_session import SyncSessionLocal
from app.infrastructure.messaging.celery_app import celery

logger = logging.getLogger(__name__)
_svc = GoogleSheetsService()


@celery.task(bind=True, max_retries=3, soft_time_limit=120, time_limit=180)
def export_job_to_sheets_task(
    self,
    user_id: int,
    job_id: int,
    spreadsheet_url: str | None,
    sheet_name: str = "Investment Ideas",
    title: str = "Investment Analysis Export",
    investment_amount: str = "INR 10,000",
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

            job = db.execute(
                select(Job).where(Job.id == job_id, Job.user_id == user_id)
            ).scalar_one_or_none()

            if not job:
                return {"status": "failed", "error": "Job not found"}

            if not job.response:
                return {"status": "failed", "error": "Job has no response yet"}

            access_token = decrypt_token(cred.access_token_enc)
            refresh_token = (
                decrypt_token(cred.refresh_token_enc)
                if cred.refresh_token_enc
                else None
            )

            stocks = parse_stock_recommendations(job.response)

            if not stocks:
                return {
                    "status": "failed",
                    "error": "No stock recommendations found in job response",
                }

            formatted_title = format_sheet_title(datetime.utcnow(), investment_amount)

            headers, rows = format_stocks_for_sheet(stocks)

            if spreadsheet_url:
                spreadsheet_id = _svc.extract_spreadsheet_id(spreadsheet_url)
            else:
                spreadsheet_id = _svc.create_spreadsheet(
                    access_token, refresh_token, formatted_title
                )

            _svc.write_sheet(
                access_token, refresh_token, spreadsheet_id, headers, rows, sheet_name
            )

            sheet_url = f"https://docs.google.com/spreadsheets/d/{spreadsheet_id}"
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
            logger.exception(
                "Export job %d to Sheets failed for user %d", job_id, user_id
            )
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
            cred = db.execute(
                select(GoogleSheetsCredential).where(
                    GoogleSheetsCredential.user_id == user_id
                )
            ).scalar_one_or_none()

            if not cred:
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
                    stocks = parse_stock_recommendations(job.response)
                    # Add stage info to each stock
                    for stock in stocks:
                        stock["stage"] = f"Stage {run_job.stage}"
                    all_stocks.extend(stocks)
                    model_names.add(f"{job.provider} ({job.model})")

            if not all_stocks:
                return {
                    "status": "failed",
                    "error": "No stock recommendations found in any run job response",
                }

            formatted_title = format_sheet_title(datetime.utcnow(), investment_amount)

            headers, rows = format_stocks_for_sheet(all_stocks)

            if spreadsheet_url:
                spreadsheet_id = _svc.extract_spreadsheet_id(spreadsheet_url)
            else:
                spreadsheet_id = _svc.create_spreadsheet(
                    access_token, refresh_token, formatted_title
                )

            _svc.write_sheet(
                access_token, refresh_token, spreadsheet_id, headers, rows, sheet_name
            )

            sheet_url = f"https://docs.google.com/spreadsheets/d/{spreadsheet_id}"
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
            logger.exception(
                "Export run %d to Sheets failed for user %d", run_id, user_id
            )
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
