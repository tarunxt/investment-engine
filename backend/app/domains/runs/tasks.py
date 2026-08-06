from __future__ import annotations

from datetime import datetime
from html import escape

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.core.config import settings
from app.core.logging import get_logger
from app.domains.auth.models import User
from app.domains.runs.final_actionable_history import backfill_user_history
from app.domains.runs.models import Run, RunJob
from app.infrastructure.database.sync_session import SyncSessionLocal
from app.infrastructure.messaging.celery_app import celery
from app.services.email import EmailService
from app.shared.types import JobStatus

logger = get_logger(__name__)

TERMINAL_RUN_STATUSES = {JobStatus.COMPLETED, JobStatus.PARTIAL, JobStatus.FAILED}


def _status_value(status: object) -> str:
    return status.value if hasattr(status, "value") else str(status)


def _format_cost(value: float | int | None) -> str:
    if value is None:
        return "n/a"
    return f"₹{float(value):.2f}"


def _format_dt(value: datetime | None) -> str:
    if value is None:
        return "n/a"
    return value.isoformat()


def _run_label(run: Run) -> str:
    if run.auto_rebalance_label:
        return run.auto_rebalance_label
    if run.export_title:
        return run.export_title
    return f"Run #{run.id}"


def _build_run_completion_email(run: Run) -> tuple[str, str, str]:
    label = _run_label(run)
    status = _status_value(run.status)
    jobs = [run_job.job for run_job in run.run_jobs if run_job.job]
    completed_jobs = sum(1 for job in jobs if job.status == JobStatus.COMPLETED)
    partial_jobs = sum(1 for job in jobs if job.status == JobStatus.PARTIAL)
    failed_jobs = sum(1 for job in jobs if job.status == JobStatus.FAILED)
    total_cost = sum(float(job.estimated_cost or 0) for job in jobs)
    total_tokens_in = sum(int(job.tokens_in or 0) for job in jobs)
    total_tokens_out = sum(int(job.tokens_out or 0) for job in jobs)
    export_status = run.export_status or "n/a"
    subject = f"{settings.app_name}: {label} {status}"
    run_url = f"{settings.frontend_url.rstrip('/')}/console/runs/{run.id}"

    job_lines = [
        (
            f"- {job.provider}/{job.model}: {_status_value(job.status)}; "
            f"cost {_format_cost(job.estimated_cost)}"
            + (f"; error {job.error_message}" if job.error_message else "")
        )
        for job in sorted(jobs, key=lambda item: item.id)
    ]
    text_content = "\n".join(
        [
            f"{label} is {status}.",
            "",
            f"Run ID: {run.id}",
            f"Current stage: {run.current_stage}",
            (
                f"Jobs: {completed_jobs} completed, {partial_jobs} partial, "
                f"{failed_jobs} failed, {len(jobs)} total"
            ),
            f"Tokens: {total_tokens_in} input, {total_tokens_out} output",
            f"Estimated cost: {_format_cost(total_cost)}",
            f"Export status: {export_status}",
            f"Export error: {run.export_error or 'None'}",
            f"Exported at: {_format_dt(run.exported_at)}",
            f"Sheet URL: {run.exported_sheet_url or 'n/a'}",
            f"Run URL: {run_url}",
            "",
            "Job details:",
            *(job_lines or ["- No jobs found"]),
        ]
    )

    html_job_rows = "".join(
        "<tr>"
        f"<td>{escape(job.provider)}</td>"
        f"<td>{escape(job.model)}</td>"
        f"<td>{escape(_status_value(job.status))}</td>"
        f"<td>{escape(_format_cost(job.estimated_cost))}</td>"
        f"<td>{escape(job.error_message or 'None')}</td>"
        "</tr>"
        for job in sorted(jobs, key=lambda item: item.id)
    ) or '<tr><td colspan="5">No jobs found</td></tr>'
    sheet_link = (
        f'<p><a href="{escape(run.exported_sheet_url)}">Open exported sheet</a></p>'
        if run.exported_sheet_url
        else ""
    )
    html_content = f"""
    <html>
        <body>
            <p>Hello,</p>
            <p><strong>{escape(label)}</strong> is <strong>{escape(status)}</strong>.</p>
            <ul>
                <li>Run ID: {run.id}</li>
                <li>Current stage: {run.current_stage}</li>
                <li>Jobs: {completed_jobs} completed, {partial_jobs} partial, {failed_jobs} failed,
                    {len(jobs)} total</li>
                <li>Tokens: {total_tokens_in} input, {total_tokens_out} output</li>
                <li>Estimated cost: {escape(_format_cost(total_cost))}</li>
                <li>Export status: {escape(export_status)}</li>
                <li>Export error: {escape(run.export_error or 'None')}</li>
            </ul>
            <p><a href="{escape(run_url)}">Open run</a></p>
            {sheet_link}
            <table border="1" cellpadding="6" cellspacing="0">
                <thead>
                    <tr>
                        <th>Provider</th><th>Model</th><th>Status</th><th>Cost</th><th>Error</th>
                    </tr>
                </thead>
                <tbody>{html_job_rows}</tbody>
            </table>
            <p>Best regards,<br>{escape(settings.app_name)} Team</p>
        </body>
    </html>
    """
    return subject, html_content, text_content


def _format_optional_cost_inr(value: float | int | None) -> str:
    if value is None:
        return "n/a"
    return f"₹{float(value):.2f}"


def _build_auto_rebalance_success_email(
    *,
    label: str,
    portfolio: str,
    completed_at: datetime,
    total_cost_inr: float | None = None,
    total_llm_time: str | None = None,
    stages_completed: list[str] | None = None,
) -> tuple[str, str, str]:
    portfolio_label = (
        "Zerodha Auto-Rebalance"
        if portfolio == "india"
        else "IndMoney US Auto-Rebalance"
    )
    subject = f"{settings.app_name}: {label} completed successfully"
    dashboard_url = f"{settings.frontend_url.rstrip('/')}/console/dashboard"
    stages = stages_completed or []
    stage_line = ", ".join(stages) if stages else "All selected stages"
    text_content = "\n".join([
        f"{portfolio_label} completed successfully.",
        "",
        f"Run label: {label}",
        f"Completed at: {completed_at.isoformat()}",
        f"Stages completed: {stage_line}",
        f"Cumulative LLM time: {total_llm_time or 'n/a'}",
        f"Total cost: {_format_optional_cost_inr(total_cost_inr)}",
        f"Dashboard: {dashboard_url}",
    ])
    html_stages = (
        "".join(f"<li>{escape(stage)}</li>" for stage in stages)
        or "<li>All selected stages</li>"
    )
    html_content = f"""
    <html>
        <body>
            <p>Hello,</p>
            <p><strong>{escape(portfolio_label)}</strong> completed successfully after the last stage.</p>
            <ul>
                <li>Run label: {escape(label)}</li>
                <li>Completed at: {escape(completed_at.isoformat())}</li>
                <li>Cumulative LLM time: {escape(total_llm_time or 'n/a')}</li>
                <li>Total cost: {escape(_format_optional_cost_inr(total_cost_inr))}</li>
            </ul>
            <p>Completed stages:</p>
            <ul>{html_stages}</ul>
            <p><a href="{escape(dashboard_url)}">Open dashboard</a></p>
            <p>Best regards,<br>{escape(settings.app_name)} Team</p>
        </body>
    </html>
    """
    return subject, html_content, text_content


@celery.task(
    bind=True,
    max_retries=3,
    default_retry_delay=60,
    name="app.domains.runs.tasks.send_auto_rebalance_success_email_task",
    queue="email",
)
def send_auto_rebalance_success_email_task(
    self,
    user_id: int,
    portfolio: str,
    label: str,
    completed_at: str,
    total_cost_inr: float | None = None,
    total_llm_time: str | None = None,
    stages_completed: list[str] | None = None,
) -> None:
    try:
        parsed_completed_at = datetime.fromisoformat(completed_at)
    except ValueError:
        parsed_completed_at = datetime.utcnow()
    with SyncSessionLocal() as db:
        try:
            user = db.execute(select(User).where(User.id == user_id)).scalar_one_or_none()
            if not user or not user.email:
                logger.info(
                    "Auto-rebalance success email skipped: user %s has no email",
                    user_id,
                )
                return
            subject, html_content, text_content = _build_auto_rebalance_success_email(
                label=label,
                portfolio=portfolio,
                completed_at=parsed_completed_at,
                total_cost_inr=total_cost_inr,
                total_llm_time=total_llm_time,
                stages_completed=stages_completed,
            )
            success = EmailService.send_email(
                email_to=user.email,
                subject=subject,
                html_content=html_content,
                text_content=text_content,
            )
            if not success:
                raise RuntimeError("Auto-rebalance success email send returned failure")
            logger.info(
                "Auto-rebalance success email sent to user %s for %s",
                user_id,
                label,
            )
        except Exception as exc:
            logger.exception(
                "Auto-rebalance success email failed for user %s label %s",
                user_id,
                label,
            )
            raise self.retry(exc=exc)


@celery.task(
    bind=True,
    max_retries=3,
    default_retry_delay=60,
    name="app.domains.runs.tasks.send_run_completion_email_task",
    queue="email",
)
def send_run_completion_email_task(self, run_id: int) -> None:
    with SyncSessionLocal() as db:
        try:
            run = db.execute(
                select(Run)
                .where(Run.id == run_id)
                .options(selectinload(Run.run_jobs).selectinload(RunJob.job))
            ).scalar_one_or_none()
            if not run:
                logger.warning("Run completion email skipped: run %s not found", run_id)
                return
            if run.status not in TERMINAL_RUN_STATUSES:
                logger.info(
                    "Run completion email skipped: run %s is not terminal (%s)",
                    run_id,
                    _status_value(run.status),
                )
                return
            if not run.user_id:
                logger.info("Run completion email skipped: run %s has no user", run_id)
                return
            user = db.execute(select(User).where(User.id == run.user_id)).scalar_one_or_none()
            if not user or not user.email:
                logger.info("Run completion email skipped: user %s has no email", run.user_id)
                return

            subject, html_content, text_content = _build_run_completion_email(run)
            success = EmailService.send_email(
                email_to=user.email,
                subject=subject,
                html_content=html_content,
                text_content=text_content,
            )
            if not success:
                raise RuntimeError("Run completion email send returned failure")
            logger.info("Run completion email sent for run %s to user %s", run_id, run.user_id)
        except Exception as exc:
            logger.exception("Run completion email failed for run %s", run_id)
            raise self.retry(exc=exc)


@celery.task(
    bind=True,
    max_retries=1,
    default_retry_delay=120,
    name="app.domains.runs.tasks.backfill_final_actionable_history_task",
    queue="ai",
)
def backfill_final_actionable_history_task(self, user_id: int) -> dict[str, int]:
    with SyncSessionLocal() as db:
        try:
            result = backfill_user_history(db, user_id=user_id)
            logger.info("Final actionable history backfill completed for user %s: %s", user_id, result)
            return result
        except Exception as exc:
            db.rollback()
            logger.exception("Final actionable history backfill failed for user %s", user_id)
            raise self.retry(exc=exc)
