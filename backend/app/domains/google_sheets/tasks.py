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
    parse_complete_stock_recommendations,
)
from app.domains.jobs.models import Job
from app.domains.jobs.output_contracts import NormalizationResult, export_tables
from app.domains.jobs.output_contracts.schemas import SWING_COLUMNS
from app.domains.jobs.output_contracts.validation import aliases, header_key
from app.domains.jobs.output_runtime import (
    configure_output_context,
    declares_output_contract,
    normalize_runtime_output,
    reset_output_context,
)
from app.domains.jobs.repository import SyncJobRepository
from app.domains.runs.models import Run, RunJob
from app.domains.runs.repository import SyncRunRepository
from app.domains.runs.run_identity import analysis_run_identity
from app.infrastructure.database.sync_session import SyncSessionLocal
from app.infrastructure.messaging.celery_app import celery

logger = logging.getLogger(__name__)
_svc = GoogleSheetsService()
IST = ZoneInfo("Asia/Kolkata")
MALFORMED_TABLE_ERROR_MARKER = "returned malformed table output"
INSUFFICIENT_RECOMMENDATIONS_ERROR_MARKER = "returned insufficient recommendations"


def _error_text(exc: Exception) -> str:
    text = str(exc).strip()
    if text:
        return text[:500]
    return f"{exc.__class__.__name__}: unknown export error"


def _job_export_block_reason(job: Job) -> str | None:
    error_message = (job.error_message or "").lower()
    if MALFORMED_TABLE_ERROR_MARKER in error_message:
        return (
            "This response is marked as malformed table output and will not be "
            "exported to Google Sheets."
        )
    return None


def _job_status_value(job: Job) -> str:
    status = getattr(job.status, "value", job.status)
    return str(status).lower()


def _extract_exportable_stocks(response: str | None) -> list[dict]:
    if not response:
        return []
    return parse_complete_stock_recommendations(response)


def _job_can_export_partial_rows(job: Job) -> bool:
    return (
        _current_output_kind(job) is None
        and _job_status_value(job) == "failed"
        and INSUFFICIENT_RECOMMENDATIONS_ERROR_MARKER in (job.error_message or "").lower()
        and bool(_extract_exportable_stocks(job.response))
    )


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
    known = aliases(SWING_COLUMNS)
    present = {known.get(header_key(header)) for header in headers}
    additions = [
        (header, value)
        for header, value in zip(meta_headers, meta)
        if known.get(header_key(header)) not in present
    ]
    return (
        headers + [header for header, _ in additions],
        [row + [value for _, value in additions] for row in rows],
    )


def _current_output_kind(job: Job) -> str | None:
    """Opt in only the current, explicitly declared workflow output schema."""
    kind = analysis_run_identity(job).stage
    prompt = getattr(job, "prompt", "") or ""
    return kind if kind in {"swing", "rebalance"} and declares_output_contract(prompt, kind) else None


def _validated_output_for_export(job: Job, run_id: int | None) -> NormalizationResult | None:
    if _current_output_kind(job) is None:
        return None
    token = configure_output_context(job, {"run_id": str(run_id) if run_id is not None else None})
    try:
        result = normalize_runtime_output(job.response or "")
    finally:
        reset_output_context(token)
    if result is None or not result.safe_to_replace:
        detail = "; ".join(
            f"{finding.code}: {finding.message}"
            for finding in result.findings if finding.severity == "error"
        ) if result is not None else "The declared output contract could not be validated."
        raise ValueError(f"Current output contract failed validation; no rows exported. {detail}"[:500])
    return result


def _format_validated_output_for_sheet(
    result: NormalizationResult,
    *,
    job_id: int,
    run_number: int,
    run_dt_ist: datetime,
    llm_label: str,
    stage: int | None = None,
) -> tuple[list[str], list[list[object]]]:
    """Keep ordered source tables/prose and per-row provenance without projection.

    Different table schemas are separate sections in one append operation. JSON
    null is an explicit 'null' cell because Sheets otherwise silently skips it;
    zero, false, and empty strings are kept as supplied.
    """
    tables = {table.fragment: table for table in export_tables(result)}
    headers: list[str] = []
    rows: list[list[object]] = []
    for block in result.blocks:
        table = tables.get(block.index)
        if table is None:
            if block.text:
                rows.append([block.text])
            continue
        table_headers, table_rows = _with_run_metadata_columns(
            list(table.headers),
            [["null" if value is None else value for value in row] for row in table.rows],
            run_number, run_dt_ist, llm_label,
        )
        provenance_headers = ["Export Job ID", "Source Fragment", "Source Row", "Source Line"]
        if stage is not None:
            provenance_headers.append("Export Stage")
        # Source columns may use any name; never overwrite or rename them.
        for label in provenance_headers:
            unique = label
            suffix = 2
            while unique in table_headers:
                unique = f"{label} ({suffix})"
                suffix += 1
            table_headers.append(unique)
        for row, source in zip(table_rows, table.provenance):
            row.extend([job_id, source.fragment, source.row, source.line if source.line is not None else ""])
            if stage is not None:
                row.append(stage)
        if not headers:
            headers = table_headers
            if rows:
                rows.append(table_headers)
        else:
            rows.append(table_headers)
        rows.extend(table_rows)
    if result.findings:
        rows.append(["Validation findings", "Severity", "Code", "Message", "Source Fragment", "Source Row", "Source Line", "Field"])
        rows.extend([
            "", finding.severity, finding.code, finding.message,
            finding.source.fragment if finding.source else "",
            finding.source.row if finding.source else "",
            finding.source.line if finding.source and finding.source.line is not None else "",
            finding.field or "",
        ] for finding in result.findings)
    return headers, rows


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

            partial_export_allowed = _job_can_export_partial_rows(job)

            if _job_status_value(job) != "completed" and not partial_export_allowed:
                export_block_reason = (
                    _job_export_block_reason(job)
                    or "Only completed job responses can be exported to Google Sheets."
                )
                job_repo.update_export_state(
                    job,
                    export_status="failed",
                    export_error=export_block_reason[:500],
                )
                _publish_job_update(job)
                _refresh_run_status(db, job.id)
                return {"status": "failed", "error": export_block_reason[:500]}

            if not job.response:
                job_repo.update_export_state(
                    job,
                    export_status="failed",
                    export_error="Job has no response yet",
                )
                _publish_job_update(job)
                _refresh_run_status(db, job.id)
                return {"status": "failed", "error": "Job has no response yet"}

            export_block_reason = _job_export_block_reason(job)
            if export_block_reason:
                job_repo.update_export_state(
                    job,
                    export_status="failed",
                    export_error=export_block_reason[:500],
                )
                _publish_job_update(job)
                _refresh_run_status(db, job.id)
                return {"status": "failed", "error": export_block_reason[:500]}

            try:
                validated = _validated_output_for_export(job, run_id)
            except ValueError as exc:
                reason = _error_text(exc)
                job_repo.update_export_state(job, export_status="failed", export_error=reason)
                _publish_job_update(job)
                _refresh_run_status(db, job.id)
                return {"status": "failed", "error": reason}

            access_token = decrypt_token(cred.access_token_enc)
            refresh_token = (
                decrypt_token(cred.refresh_token_enc)
                if cred.refresh_token_enc
                else None
            )

            stocks = _extract_exportable_stocks(job.response) if validated is None else []
            stocks_count = validated.coverage.canonical_rows if validated is not None else len(stocks)

            if not stocks_count:
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
                        "No complete stock recommendations found in job response."
                        f"{response_hint}"
                    )[:500],
                )
                _publish_job_update(job)
                _refresh_run_status(db, job.id)
                return {
                    "status": "failed",
                    "error": (
                        "No complete stock recommendations found in job response. "
                        f"Parsed rows: {len(stocks)}."
                    )[:500],
                }

            now_ist = datetime.now(IST)
            formatted_title = format_sheet_title(now_ist, investment_amount)

            meta_run_number = run_id if run_id else job_id
            if validated is not None:
                created = getattr(job, "created_at", None)
                if isinstance(created, datetime):
                    created = created if created.tzinfo else created.replace(tzinfo=timezone.utc)
                export_run_dt = created.astimezone(IST) if isinstance(created, datetime) else now_ist
                headers, rows = _format_validated_output_for_sheet(
                    validated, job_id=job_id, run_number=meta_run_number,
                    run_dt_ist=export_run_dt, llm_label=f"{job.provider}/{job.model}", stage=stage,
                )
            else:
                headers, rows = format_stocks_for_sheet(stocks)
                headers, rows = _with_run_metadata_columns(
                    headers=headers, rows=rows, run_number=meta_run_number,
                    run_dt_ist=now_ist, llm_label=f"{job.provider}/{job.model}",
                )

            if spreadsheet_url:
                spreadsheet_id = _svc.extract_spreadsheet_id(spreadsheet_url)
            else:
                spreadsheet_id = _svc.create_spreadsheet(
                    access_token, refresh_token, formatted_title
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
                stocks_count,
                user_id,
            )
            return {
                "status": "completed",
                "message": f"Exported {stocks_count} stock recommendations to Google Sheets",
                "spreadsheet_url": sheet_url,
                "stocks_count": stocks_count,
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
            output_sections: list[tuple[Job, int, NormalizationResult | None, list[dict]]] = []
            canonical_count = 0
            model_names = set()
            skipped_malformed_jobs = 0

            for run_job in run_jobs:
                job = run_job.job
                if not job.response:
                    continue
                if _job_export_block_reason(job):
                    skipped_malformed_jobs += 1
                    continue
                if _job_status_value(job) != "completed" and not _job_can_export_partial_rows(job):
                    continue
                try:
                    validated = _validated_output_for_export(job, run_id)
                except ValueError as exc:
                    reason = f"Job {job.id}: {_error_text(exc)}"[:500]
                    run_repo.update_export_state(run, export_status="failed", export_error=reason)
                    return {"status": "failed", "error": reason}
                if validated is not None:
                    output_sections.append((job, run_job.stage, validated, []))
                    canonical_count += validated.coverage.canonical_rows
                    model_names.add(f"{job.provider} ({job.model})")
                    continue
                stocks = _extract_exportable_stocks(job.response)
                if not stocks:
                    continue
                # Add stage info to each stock
                for stock in stocks:
                    stock["stage"] = f"Stage {run_job.stage}"
                all_stocks.extend(stocks)
                output_sections.append((job, run_job.stage, None, stocks))
                model_names.add(f"{job.provider} ({job.model})")

            stocks_count = len(all_stocks) + canonical_count
            if not stocks_count:
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
                reason = "No exportable stock recommendations found in run response"
                if skipped_malformed_jobs:
                    reason = (
                        f"{reason}. Skipped {skipped_malformed_jobs} malformed model "
                        f"output{'s' if skipped_malformed_jobs != 1 else ''}"
                    )
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
            now_ist = datetime.now(IST)
            formatted_title = format_sheet_title(now_ist, investment_amount)

            if canonical_count:
                headers, rows = [], []
                for job, stage, validated, stocks in output_sections:
                    if validated is not None:
                        section_headers, section_rows = _format_validated_output_for_sheet(
                            validated, job_id=job.id, run_number=run.id,
                            run_dt_ist=run.created_at.astimezone(IST),
                            llm_label=f"{job.provider}/{job.model}", stage=stage,
                        )
                    else:
                        section_headers, section_rows = format_stocks_for_sheet(stocks)
                        section_headers, section_rows = _with_run_metadata_columns(
                            section_headers, section_rows, run.id, run.created_at.astimezone(IST),
                            f"{job.provider}/{job.model}",
                        )
                    if not headers:
                        headers = section_headers
                    else:
                        rows.extend([[], ["Export Job ID", job.id, "Export Stage", stage], section_headers])
                    rows.extend(section_rows)
            else:
                headers, rows = format_stocks_for_sheet(all_stocks)
                headers, rows = _with_run_metadata_columns(
                    headers=headers, rows=rows, run_number=run.id,
                    run_dt_ist=run.created_at.astimezone(IST), llm_label="multi-llm",
                )

            if spreadsheet_url:
                spreadsheet_id = _svc.extract_spreadsheet_id(spreadsheet_url)
            else:
                spreadsheet_id = _svc.create_spreadsheet(
                    access_token, refresh_token, formatted_title
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
                stocks_count,
                len(model_names),
                user_id,
            )
            return {
                "status": "completed",
                "message": f"Exported {stocks_count} stock recommendations from {len(model_names)} models to Google Sheets",
                "spreadsheet_url": sheet_url,
                "stocks_count": stocks_count,
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
