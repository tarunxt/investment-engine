import json
from datetime import date, datetime
import re
from time import monotonic

from celery.exceptions import MaxRetriesExceededError
import redis as _sync_redis

from app.infrastructure.messaging.celery_app import celery
from app.infrastructure.database.sync_session import SyncSessionLocal
import app.infrastructure.database.all_models  # noqa: F401 — registers all ORM models with the mapper
from app.core.config import settings
from app.core.logging import WorkerLogHelper, get_logger
from app.domains.jobs.repository import SyncJobRepository
from app.domains.jobs.models import Job
from app.shared.types import JobStatus

logger = get_logger("app.domains.jobs.tasks")

_EVENT_REFERENCE_DATE_PATTERN = re.compile(r"\[EVENT_SNAPSHOT_DATE=([0-9]{4}-[0-9]{2}-[0-9]{2})\]")
_EVENT_EXACT_DATE_PATTERN = re.compile(r"\b(\d{1,2}\s+[A-Za-z]{3}\s+\d{4})\b")


def _to_markdown_table_from_stocks(stocks: list[dict]) -> str:
    """Build a sheet-safe markdown table from normalized stock rows."""
    if not stocks:
        return ""
    key_order = [
        "llm_name_model",
        "exchange_symbol",
        "stock_symbol",
        "stock_name",
        "technical_setup",
        "entry_range",
        "stop_loss",
        "target",
        "analyst_source",
        "units_to_buy",
        "price_per_unit",
        "total_buy_amount",
        "upside_horizon",
        "weeks",
        "confidence_score",
        "rationale_remarks",
        "rationale_technical_medium_term",
        "rationale_technical_long_term",
        "rationale_fundamentals_short_term",
        "rationale_fundamentals_medium_long_term",
        "rationale_technical_short_term",
        "run_number",
        "run_date",
        "run_time",
    ]
    headers = [k for k in key_order if any(str(row.get(k, "")).strip() for row in stocks)]
    if not headers:
        return ""

    def _label(key: str) -> str:
        labels = {
            "llm_name_model": "LLM Name + Model",
            "upside_horizon": "Upside Horizon (%)",
            "confidence_score": "Confidence Score (0-100)",
            "rationale_technical_medium_term": "Rationale - Technical Setup (Medium Term)",
            "rationale_technical_long_term": "Rationale - Technical Setup (Long Term)",
            "rationale_fundamentals_short_term": "Rationale - Fundamentals Short Term",
            "rationale_fundamentals_medium_long_term": "Rationale - Fundamentals Medium/Long Term",
            "rationale_technical_short_term": "Rationale Technical Setup Short Term 1–3 Months",
            "run_number": "Run #",
            "run_date": "Run Date",
            "run_time": "Run Time",
        }
        return labels.get(key, key.replace("_", " ").title())

    def _cell(value: object) -> str:
        return str(value if value is not None else "").replace("\n", " ").replace("|", "/").strip()

    lines = [
        f"| {' | '.join(_label(h) for h in headers)} |",
        f"| {' | '.join('---' for _ in headers)} |",
    ]
    for row in stocks:
        lines.append(f"| {' | '.join(_cell(row.get(h, '')) for h in headers)} |")
    return "\n".join(lines)


def _repair_stock_table_content(content: str) -> tuple[str, int]:
    """Try to salvage malformed LLM output into valid markdown stock table."""
    from app.domains.google_sheets.stock_service import normalize_stock_rows, parse_stock_recommendations

    parsed_stocks = normalize_stock_rows(parse_stock_recommendations(content))
    if not parsed_stocks:
        return content, 0
    repaired = _to_markdown_table_from_stocks(parsed_stocks)
    return (repaired or content), len(parsed_stocks)


def _count_markdown_table_data_rows(content: str) -> int:
    """Count probable markdown table data rows (excluding header + separator)."""
    lines = [line.strip() for line in (content or "").splitlines() if line.strip()]
    pipe_lines = [line for line in lines if line.count("|") >= 2]
    if not pipe_lines:
        return 0

    def _is_separator(line: str) -> bool:
        normalized = line.replace("|", "").replace(":", "").replace("-", "").replace(" ", "")
        return normalized == ""

    data_rows = 0
    for idx, line in enumerate(pipe_lines):
        if idx == 0:
            continue  # header row
        if _is_separator(line):
            continue
        # Skip repeated header-like rows
        lower = line.lower()
        if "stock symbol" in lower and "technical setup" in lower:
            continue
        data_rows += 1
    return data_rows


def _requires_generic_table_output(prompt: str) -> bool:
    text = (prompt or "").lower()
    return "return only one markdown table" in text or _requires_stock_recommendation_output(prompt)


def _requires_stock_recommendation_output(prompt: str) -> bool:
    text = (prompt or "").lower()
    return "table columns:" in text or ("stock name" in text and "units to buy" in text)


def _has_excessive_placeholder_noise(content: str) -> bool:
    text = content or ""
    dash_runs = re.findall(r"-{40,}", text)
    return len(dash_runs) >= 3


def _parse_normalized_stock_rows(content: str) -> list[dict]:
    from app.domains.google_sheets.stock_service import normalize_stock_rows, parse_stock_recommendations

    return normalize_stock_rows(parse_stock_recommendations(content))


def _is_portfolio_events_job(prompt: str) -> bool:
    text = prompt or ""
    return "[INDMONEY_US_EVENTS]" in text or "[ZERODHA_EVENTS]" in text


def _extract_portfolio_event_reference_date(prompt: str) -> date | None:
    match = _EVENT_REFERENCE_DATE_PATTERN.search(prompt or "")
    if not match:
        return None
    try:
        return date.fromisoformat(match.group(1))
    except ValueError:
        return None


def _is_portfolio_event_fallback_row(row: dict[str, str]) -> bool:
    row_date = (row.get("Date") or "").strip().lower()
    row_holding = (row.get("Holding") or "").strip().lower()
    row_event = (row.get("Event") or "").strip().lower()
    return (
        row_date == "not found"
        or row_holding == "all holdings"
        or "no upcoming scheduled price-sensitive event found" in row_event
    )


def _extract_first_exact_event_date(value: str) -> date | None:
    match = _EVENT_EXACT_DATE_PATTERN.search(value or "")
    if not match:
        return None
    try:
        return datetime.strptime(match.group(1), "%d %b %Y").date()
    except ValueError:
        return None


def _render_portfolio_event_table(rows: list[dict[str, str]]) -> str:
    from app.domains.portfolio_events.common import EVENT_TABLE_COLUMNS

    lines = [
        f"| {' | '.join(EVENT_TABLE_COLUMNS)} |",
        f"| {' | '.join('----' for _ in EVENT_TABLE_COLUMNS)} |",
    ]
    for row in rows:
        cells = [str((row.get(column) or "")).replace("\n", " ").replace("|", "/").strip() for column in EVENT_TABLE_COLUMNS]
        lines.append(f"| {' | '.join(cells)} |")
    return "\n".join(lines)


def _sanitize_portfolio_event_content(prompt: str, content: str) -> str:
    if not _is_portfolio_events_job(prompt):
        return (content or "").strip()

    from app.domains.portfolio_events.common import parse_event_calendar_table

    parsed = parse_event_calendar_table(content)
    rows = list((parsed or {}).get("rows") or [])
    if not rows:
        return (content or "").strip()

    reference_date = _extract_portfolio_event_reference_date(prompt)
    sanitized_rows: list[dict[str, str]] = []
    for row in rows:
        if _is_portfolio_event_fallback_row(row):
            continue
        event_date = _extract_first_exact_event_date(row.get("Date") or "")
        if reference_date and event_date and event_date < reference_date:
            continue
        sanitized_rows.append(row)

    if sanitized_rows:
        return _render_portfolio_event_table(sanitized_rows)

    return (content or "").strip()


def _portfolio_event_retry_reason(prompt: str, content: str) -> str | None:
    if not _is_portfolio_events_job(prompt):
        return None

    from app.domains.portfolio_events.common import parse_event_calendar_table

    parsed = parse_event_calendar_table(content)
    rows = list((parsed or {}).get("rows") or [])
    if not rows:
        return "it did not return any event rows"

    reference_date = _extract_portfolio_event_reference_date(prompt)
    upcoming_rows = 0
    past_rows = 0
    fallback_rows = 0

    for row in rows:
        if _is_portfolio_event_fallback_row(row):
            fallback_rows += 1
            continue
        event_date = _extract_first_exact_event_date(row.get("Date") or "")
        if reference_date and event_date and event_date < reference_date:
            past_rows += 1
            continue
        upcoming_rows += 1

    if upcoming_rows > 0:
        return None
    if past_rows > 0 and fallback_rows > 0:
        return "it mixed only past-dated event rows with the fallback `Not found` row"
    if past_rows > 0:
        return "it returned only past-dated events that are earlier than the reference date"
    if fallback_rows == len(rows):
        return "it used the fallback `Not found` row without listing any upcoming events"
    return None


def _build_portfolio_event_repair_prompt(prompt: str, previous_output: str, reason: str) -> str:
    reference_date = _extract_portfolio_event_reference_date(prompt)
    reference_text = (
        f"on or after {reference_date.isoformat()}"
        if reference_date
        else "that are still upcoming"
    )
    return (
        f"{prompt}\n\n"
        "[PORTFOLIO_EVENTS_REPAIR]\n"
        f"The previous assistant output was invalid because {reason}. "
        f"Re-check live web sources and return ONLY events {reference_text}. "
        "Remove any past-dated rows. "
        "If you find one or more upcoming events, do not include the `Not found` / `All holdings` fallback row. "
        "Use the ticker/symbol as authoritative, search exact scheduled dates, and sort rows nearest to farthest. "
        "Only use the fallback row if there are truly zero upcoming events after checking earnings/results, dividend/ex-date, AGM/shareholder meeting, and investor conference / product event sources.\n\n"
        "Previous assistant output:\n"
        f"{previous_output}"
    ).strip()


def _publish_job_update(job: Job) -> None:
    """Publish job status change to Redis pub/sub for WebSocket relay. Fire-and-forget."""
    r: _sync_redis.Redis | None = None
    try:
        status_val = job.status.value if hasattr(job.status, "value") else str(job.status)
        payload = json.dumps({
            "type": "job.updated",
            "job_id": job.id,
            "provider": job.provider,
            "model": job.model,
            "status": status_val,
            "response": job.response,
            "error_message": job.error_message,
            "tokens_in": job.tokens_in,
            "tokens_out": job.tokens_out,
            "estimated_cost": job.estimated_cost,
            "export_status": job.export_status,
            "export_error": job.export_error,
            "exported_at": job.exported_at.isoformat() if job.exported_at else None,
            "exported_sheet_url": job.exported_sheet_url,
            "updated_at": job.updated_at.isoformat() if job.updated_at else None,
        })
        
        redis_url = settings.redis_url
        logger.info("Publishing WS update for job_id=%s to Redis at %s", job.id, redis_url)
        
        r = _sync_redis.from_url(redis_url, decode_responses=True)
        
        # Publish to job-specific channel
        job_channel = f"job_updates:{job.id}"
        job_receivers = r.publish(job_channel, payload)
        logger.info("Published to %s: %s receiver(s)", job_channel, job_receivers)
        
        # Publish to user channel if user_id exists
        if job.user_id:
            user_channel = f"user_job_updates:{job.user_id}"
            user_receivers = r.publish(user_channel, payload)
            logger.info("Published to %s: %s receiver(s)", user_channel, user_receivers)
        else:
            logger.warning("job.user_id is None, skipping user_job_updates publish for job_id=%s", job.id)
            
    except Exception as e:
        logger.exception("Failed to publish WS update for job_id=%s: %s", job.id, e)
    finally:
        if r is not None:
            try:
                r.close()
            except Exception:
                pass

# ── Error classification ──────────────────────────────────────────────────────

def _classify_exc(exc: Exception, attempt: int = 0) -> tuple[bool, int]:
    """Return (retryable, countdown_seconds).

    Rate-limit errors use exponential backoff (60 / 120 / 240 s).
    Terminal client errors (bad request, auth) are not retried.
    Everything else retries after 30 s.
    """

    text = str(exc).lower()
    if any(
        marker in text
        for marker in (
            "returned malformed table output",
            "returned insufficient recommendations",
            "returned empty output after generation",
        )
    ):
        return False, 0

    if attempt >= 3:
        return False, 0  # don't retry after max attempts

    try:
        from google.genai.errors import ClientError as GeminiClientError
        if isinstance(exc, GeminiClientError):
            code = getattr(exc, "status_code", None)
            if code == 429:
                return True, 60 * (2 ** attempt)   # 60 → 120 → 240 s
            if code in (400, 401, 403):
                return False, 0                     # bad request / auth — terminal
            return True, 30
    except ImportError:
        pass

    try:
        from openai import (
            AuthenticationError as OpenAIAuthenticationError,
            BadRequestError as OpenAIBadRequest,
            NotFoundError as OpenAINotFoundError,
            PermissionDeniedError as OpenAIPermissionDeniedError,
            RateLimitError as OpenAIRateLimit,
        )
        if isinstance(exc, OpenAIRateLimit):
            if getattr(exc, "code", None) == "insufficient_quota" or "insufficient_quota" in str(exc):
                return False, 0
            return True, 60 * (2 ** attempt)
        if isinstance(
            exc,
            (
                OpenAIAuthenticationError,
                OpenAIBadRequest,
                OpenAINotFoundError,
                OpenAIPermissionDeniedError,
            ),
        ):
            return False, 0
    except ImportError:
        pass

    return True, 30  # default: retryable


def _redis_publish(channel: str, payload: dict) -> None:
    """Publish a single message to a Redis pub/sub channel. Fire-and-forget."""
    r: _sync_redis.Redis | None = None
    try:
        r = _sync_redis.from_url(settings.redis_url, decode_responses=True)
        r.publish(channel, json.dumps(payload))
    except Exception:
        logger.exception("Failed to publish to channel %s", channel)
    finally:
        if r is not None:
            try:
                r.close()
            except Exception:
                pass


def _publish_run_update(
    run_id: int,
    user_id: int | None,
    status: JobStatus,
    current_stage: int,
    export_status: str | None = None,
    export_error: str | None = None,
    exported_at: str | None = None,
    exported_sheet_url: str | None = None,
) -> None:
    """Broadcast a run status change to the user-level and per-run Redis channels."""
    status_val = status.value if hasattr(status, "value") else str(status)
    payload = {
        "type": "run.updated",
        "run_id": run_id,
        "status": status_val,
        "current_stage": current_stage,
        "export_status": export_status,
        "export_error": export_error,
        "exported_at": exported_at,
        "exported_sheet_url": exported_sheet_url,
    }
    # Per-run channel — consumed by the run detail page
    _redis_publish(f"run_updates:{run_id}", payload)
    # User-level channel — consumed by the dashboard list
    if user_id:
        _redis_publish(f"user_run_updates:{user_id}", payload)


def _refresh_run_status(db, job_id: int) -> None:
    """Recalculate and persist Run.status when a child job reaches a terminal state."""
    try:
        from sqlalchemy import select as sa_select
        from app.domains.runs.models import RunJob
        from app.domains.runs.repository import SyncRunRepository

        run_repo = SyncRunRepository(db)

        rj_rows = db.execute(
            sa_select(RunJob).where(RunJob.job_id == job_id)
        ).scalars().all()

        for rj in rj_rows:
            run = run_repo.get(rj.run_id)
            if not run:
                continue
            run_id = run.id
            user_id = run.user_id
            current_stage = run.current_stage
            auto_export_enabled = run.auto_export_enabled
            export_spreadsheet_url = run.export_spreadsheet_url
            export_sheet_name = run.export_sheet_name
            export_investment_amount = run.export_investment_amount
            export_title = run.export_title

            pairs = run_repo.get_stage_run_jobs(rj.run_id, rj.stage)
            if not pairs:
                continue

            stage_jobs = [job for _, job in pairs]

            # Push the triggering job's full data to the per-run channel so the
            # detail page can update response text, tokens, and cost in real-time.
            updated_job = next((j for j in stage_jobs if j.id == job_id), None)
            if updated_job is not None:
                status_val = (
                    updated_job.status.value
                    if hasattr(updated_job.status, "value")
                    else str(updated_job.status)
                )
                _redis_publish(f"run_updates:{rj.run_id}", {
                    "type": "job.updated",
                    "run_id": rj.run_id,
                    "job_id": updated_job.id,
                    "provider": updated_job.provider,
                    "model": updated_job.model,
                    "status": status_val,
                    "response": updated_job.response,
                    "error_message": updated_job.error_message,
                    "tokens_in": updated_job.tokens_in,
                    "tokens_out": updated_job.tokens_out,
                    "estimated_cost": updated_job.estimated_cost,
                    "export_status": updated_job.export_status,
                    "export_error": updated_job.export_error,
                    "exported_at": updated_job.exported_at.isoformat() if updated_job.exported_at else None,
                    "exported_sheet_url": updated_job.exported_sheet_url,
                    "updated_at": updated_job.updated_at.isoformat() if updated_job.updated_at else None,
                })
                if updated_job.user_id:
                    _redis_publish(f"user_run_updates:{updated_job.user_id}", {
                        "type": "job.updated",
                        "run_id": rj.run_id,
                        "job_id": updated_job.id,
                        "provider": updated_job.provider,
                        "model": updated_job.model,
                        "status": status_val,
                        "response": updated_job.response,
                        "error_message": updated_job.error_message,
                        "tokens_in": updated_job.tokens_in,
                        "tokens_out": updated_job.tokens_out,
                        "estimated_cost": updated_job.estimated_cost,
                        "export_status": updated_job.export_status,
                        "export_error": updated_job.export_error,
                        "exported_at": updated_job.exported_at.isoformat() if updated_job.exported_at else None,
                        "exported_sheet_url": updated_job.exported_sheet_url,
                        "updated_at": updated_job.updated_at.isoformat() if updated_job.updated_at else None,
                    })

            statuses = {j.status for j in stage_jobs}
            active = {JobStatus.PENDING, JobStatus.PROCESSING, JobStatus.SCHEDULED}

            if statuses & active:
                # At least one child job is still running
                new_status = JobStatus.PROCESSING
            elif any(j.status == JobStatus.COMPLETED for j in stage_jobs):
                # All terminal, at least one succeeded
                new_status = JobStatus.COMPLETED
            else:
                # All terminal, all failed
                new_status = JobStatus.FAILED

            if run.status != new_status:
                run_repo.update_status(run, new_status)
                _publish_run_update(
                    run_id,
                    user_id,
                    new_status,
                    current_stage,
                    run.export_status,
                    run.export_error,
                    run.exported_at.isoformat() if run.exported_at else None,
                    run.exported_sheet_url,
                )
                logger.info("Run %s status → %s", run_id, new_status.value)

            # Trigger auto-export per model as soon as a model completes
            if (
                updated_job is not None
                and updated_job.status == JobStatus.COMPLETED
                and auto_export_enabled
                and export_spreadsheet_url
                and (updated_job.export_status or "").lower() not in {"queued", "processing", "completed", "failed"}
            ):
                try:
                    from app.domains.google_sheets.tasks import export_job_to_sheets_task
                    repo = SyncJobRepository(db)
                    repo.update_export_state(
                        updated_job,
                        export_status="queued",
                        export_error=None,
                    )
                    _publish_job_update(updated_job)
                    _publish_run_update(
                        run_id,
                        user_id,
                        run.status,
                        current_stage,
                        run.export_status,
                        run.export_error,
                        run.exported_at.isoformat() if run.exported_at else None,
                        run.exported_sheet_url,
                    )
                    export_job_to_sheets_task.delay(  # type: ignore
                        user_id,
                        updated_job.id,
                        export_spreadsheet_url,
                        export_sheet_name or "Sheet1",
                        export_title or f"Run {run_id}",
                        export_investment_amount or "0",
                        run_id,
                        rj.stage,
                    )
                    logger.info("Queued model export for run %d job %d", run_id, updated_job.id)
                except Exception as e:
                    logger.warning(
                        "Failed to queue model export for run %d job %d: %s",
                        run_id,
                        updated_job.id,
                        str(e),
                    )
            elif (
                updated_job is not None
                and updated_job.status == JobStatus.FAILED
                and auto_export_enabled
                and (updated_job.export_status or "").lower() in {"", "pending"}
            ):
                repo = SyncJobRepository(db)
                repo.update_export_state(
                    updated_job,
                    export_status="failed",
                    export_error=updated_job.error_message or "Model failed before export",
                )
                _publish_job_update(updated_job)

            # Keep run-level export badge in sync with per-model export progress
            if auto_export_enabled:
                run_after = run_repo.get(rj.run_id)
                if run_after:
                    stage_pairs = run_repo.get_stage_run_jobs(rj.run_id, rj.stage)
                    stage_jobs_after = [job for _, job in stage_pairs]
                    terminal = {JobStatus.COMPLETED, JobStatus.FAILED}
                    eligible_jobs = [j for j in stage_jobs_after if j.status in terminal]
                    exports = [str((j.export_status or "pending")).lower() for j in eligible_jobs]
                    completed_count = sum(1 for s in exports if s == "completed")
                    failed_count = sum(1 for s in exports if s == "failed")
                    inflight_count = sum(1 for s in exports if s in {"pending", "queued", "processing", ""})
                    total_count = len(exports)

                    export_state = "pending"
                    export_error = None
                    if total_count == 0:
                        export_state = "pending"
                    elif completed_count == total_count:
                        export_state = "completed"
                    elif failed_count == total_count:
                        export_state = "failed"
                        failed = next(
                            (j for j in eligible_jobs if (j.export_status or "").lower() == "failed"),
                            None,
                        )
                        export_error = failed.export_error if failed else None
                    elif completed_count > 0 and (failed_count > 0 or inflight_count > 0):
                        export_state = "partial"
                        export_error = f"{completed_count}/{total_count} exported"
                    else:
                        export_state = "processing"
                        if failed_count > 0:
                            export_error = f"{completed_count}/{total_count} exported"

                    prev_export_status = (run_after.export_status or "").lower()
                    prev_export_error = run_after.export_error
                    run_repo.update_export_state(
                        run_after,
                        export_status=export_state,
                        export_error=export_error,
                        exported_at=run_after.exported_at,
                        exported_sheet_url=run_after.exported_sheet_url,
                    )
                    if prev_export_status != export_state or prev_export_error != export_error:
                        _publish_run_update(
                            run_after.id,
                            run_after.user_id,
                            run_after.status,
                            run_after.current_stage,
                            run_after.export_status,
                            run_after.export_error,
                            run_after.exported_at.isoformat() if run_after.exported_at else None,
                            run_after.exported_sheet_url,
                        )
    except Exception:
        logger.exception("Failed to refresh run status for job %s", job_id)


def _mark_failed(
    db,
    repo,
    job_id: int,
    error: str,
    *,
    response: str | None = None,
    tokens_in: int | None = None,
    tokens_out: int | None = None,
    estimated_cost: float | None = None,
) -> None:
    try:
        db.rollback()
        job = repo.get(job_id)
        if job:
            repo.update_status(
                job,
                JobStatus.FAILED,
                response=response,
                error_message=error,
                tokens_in=tokens_in,
                tokens_out=tokens_out,
                estimated_cost=estimated_cost,
            )
            _publish_job_update(job)
            _refresh_run_status(db, job_id)
    except Exception:
        logger.exception("Could not mark job %s as failed", job_id)


# ── Task ─────────────────────────────────────────────────────────────────────

@celery.task(
    name="app.domains.jobs.tasks.execute_ai_job",
    bind=True,
    max_retries=3,
    default_retry_delay=30,
    queue="ai",
)
def execute_ai_job(self, job_id: int) -> None:
    from app.domains.ai_providers.factory import ProviderFactory

    db = SyncSessionLocal()
    repo = SyncJobRepository(db)
    started_at = monotonic()
    content: str | None = None
    tokens_in: int | None = None
    tokens_out: int | None = None
    estimated_cost: float | None = None

    try:
        job = repo.get(job_id)
        if not job:
            logger.warning("Job %s not found", job_id)
            return
        if job.status == JobStatus.FAILED and (job.error_message or "").lower().find("cancelled") >= 0:
            logger.info("Skipping cancelled job %s", job_id)
            return

        WorkerLogHelper.log_task_start("execute_ai_job", "n/a", job_id)
        repo.update_status(job, JobStatus.PROCESSING)
        _publish_job_update(job)
        _refresh_run_status(db, job_id)

        provider = ProviderFactory.create(job.provider)
        result = provider.generate(prompt=job.prompt, model=job.model)
        tokens_in = result.tokens_in
        tokens_out = result.tokens_out
        estimated_cost = result.cost
        content = (result.content or "").strip()
        if not content:
            raise RuntimeError(
                f"{job.provider}/{job.model} returned empty output after generation"
            )
        if _requires_generic_table_output(job.prompt):
            data_rows = _count_markdown_table_data_rows(content)
            if data_rows < 1 and _requires_stock_recommendation_output(job.prompt):
                repaired_content, repaired_rows = _repair_stock_table_content(content)
                if repaired_rows > 0:
                    content = repaired_content.strip()
                    data_rows = _count_markdown_table_data_rows(content)
            if data_rows < 1:
                raise RuntimeError(
                    f"{job.provider}/{job.model} returned malformed table output (no data rows)"
                )
            if _requires_stock_recommendation_output(job.prompt):
                try:
                    parsed_stocks = _parse_normalized_stock_rows(content)
                    if len(parsed_stocks) >= 5:
                        repaired_content = _to_markdown_table_from_stocks(parsed_stocks)
                        if repaired_content:
                            content = repaired_content.strip()
                    else:
                        if _has_excessive_placeholder_noise(content):
                            raise RuntimeError(
                                f"{job.provider}/{job.model} returned malformed table output (placeholder noise)"
                            )
                        raise RuntimeError(
                            f"{job.provider}/{job.model} returned insufficient recommendations "
                            f"(expected 5, got {len(parsed_stocks)})"
                        )
                except RuntimeError:
                    raise
                except Exception:
                    # Keep primary output validation resilient even if parser has issues.
                    logger.warning("Stock parser validation skipped for job_id=%s", job_id, exc_info=True)
        if _is_portfolio_events_job(job.prompt):
            content = _sanitize_portfolio_event_content(job.prompt, content)
            retry_reason = _portfolio_event_retry_reason(job.prompt, content)
            if retry_reason:
                logger.info("Retrying portfolio events job %s because %s", job_id, retry_reason)
                repair_result = provider.generate(
                    prompt=_build_portfolio_event_repair_prompt(job.prompt, content, retry_reason),
                    model=job.model,
                )
                tokens_in = (tokens_in or 0) + repair_result.tokens_in
                tokens_out = (tokens_out or 0) + repair_result.tokens_out
                estimated_cost = round((estimated_cost or 0.0) + repair_result.cost, 6)
                repaired_content = (repair_result.content or "").strip()
                if repaired_content:
                    content = _sanitize_portfolio_event_content(job.prompt, repaired_content)
        latest = repo.get(job_id)
        if latest and latest.status == JobStatus.FAILED and (latest.error_message or "").lower().find("cancelled") >= 0:
            logger.info("Skipping completion update for cancelled job %s", job_id)
            return

        repo.update_status(
            job,
            JobStatus.COMPLETED,
            response=content,
            tokens_in=tokens_in,
            tokens_out=tokens_out,
            estimated_cost=estimated_cost,
        )
        _publish_job_update(job)
        _refresh_run_status(db, job_id)
        WorkerLogHelper.log_task_complete(
            "execute_ai_job", "n/a", (monotonic() - started_at) * 1000, job_id
        )

    except MaxRetriesExceededError:
        _mark_failed(
            db,
            repo,
            job_id,
            "Max retries exceeded",
            response=content,
            tokens_in=tokens_in,
            tokens_out=tokens_out,
            estimated_cost=estimated_cost,
        )
        logger.error("Job %s exhausted all retries", job_id)

    except Exception as exc:
        error_summary = str(exc).split('\n')[0][:200]
        WorkerLogHelper.log_task_error("execute_ai_job", "n/a", error_summary, job_id)

        retryable, countdown = _classify_exc(exc, attempt=self.request.retries)
        logger.info("Error classified as retryable=%s with countdown=%s seconds", retryable, countdown)
        if not retryable:
            _mark_failed(
                db,
                repo,
                job_id,
                str(exc),
                response=content,
                tokens_in=tokens_in,
                tokens_out=tokens_out,
                estimated_cost=estimated_cost,
            )
            return

        try:
            raise self.retry(exc=exc, countdown=countdown, max_retries=self.max_retries)
        except MaxRetriesExceededError:
            _mark_failed(
                db,
                repo,
                job_id,
                str(exc),
                response=content,
                tokens_in=tokens_in,
                tokens_out=tokens_out,
                estimated_cost=estimated_cost,
            )
            logger.error("Job %s exhausted all retries after: %s", job_id, exc)

    finally:
        db.close()
