import os
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://test:test@localhost:5432/testdb",
)
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

from app.domains.jobs.tasks import _queue_run_completion_email_once
from app.domains.runs.tasks import _build_run_completion_email
from app.shared.types import JobStatus


def test_build_run_completion_email_includes_run_summary_and_jobs():
    job = SimpleNamespace(
        id=10,
        provider="openai",
        model="gpt-4o-mini",
        status=JobStatus.COMPLETED,
        estimated_cost=2.5,
        tokens_in=100,
        tokens_out=50,
        error_message=None,
    )
    run = SimpleNamespace(
        id=7,
        auto_rebalance_label="India Run #7",
        export_title=None,
        status=JobStatus.COMPLETED,
        current_stage=1,
        export_status="completed",
        export_error=None,
        exported_at=None,
        exported_sheet_url="https://docs.google.com/spreadsheets/d/sheet/edit#gid=1",
        run_jobs=[SimpleNamespace(job=job)],
    )

    subject, html_content, text_content = _build_run_completion_email(run)

    assert "India Run #7 completed" in subject
    assert "Jobs: 1 completed, 0 partial, 0 failed, 1 total" in text_content
    assert "openai/gpt-4o-mini: completed" in text_content
    assert "Open exported sheet" in html_content


@patch("app.domains.runs.tasks.send_run_completion_email_task")
@patch("app.domains.jobs.tasks._sync_redis.from_url")
def test_queue_run_completion_email_once_uses_redis_setnx(redis_from_url_mock, task_mock):
    redis_client = MagicMock()
    redis_client.set.return_value = True
    redis_from_url_mock.return_value = redis_client

    _queue_run_completion_email_once(123, JobStatus.COMPLETED)

    redis_client.set.assert_called_once_with(
        "run_completion_email_sent:123:completed",
        "1",
        nx=True,
        ex=60 * 60 * 24 * 30,
    )
    task_mock.delay.assert_called_once_with(123)


@patch("app.domains.runs.tasks.send_run_completion_email_task")
@patch("app.domains.jobs.tasks._sync_redis.from_url")
def test_queue_run_completion_email_once_does_not_queue_duplicate(redis_from_url_mock, task_mock):
    redis_client = MagicMock()
    redis_client.set.return_value = None
    redis_from_url_mock.return_value = redis_client

    _queue_run_completion_email_once(123, JobStatus.COMPLETED)

    task_mock.delay.assert_not_called()


def test_build_auto_rebalance_success_email_includes_stage_summary():
    from datetime import datetime
    from app.domains.runs.tasks import _build_auto_rebalance_success_email

    subject, html_content, text_content = _build_auto_rebalance_success_email(
        label="India Run #8",
        portfolio="india",
        completed_at=datetime(2026, 7, 6, 12, 0, 0),
        total_cost_inr=8.11,
        total_llm_time="00:09:16",
        stages_completed=["Sync Portfolio", "Actionables"],
    )

    assert "India Run #8 completed successfully" in subject
    assert "Zerodha Auto-Rebalance completed successfully" in text_content
    assert "Stages completed: Sync Portfolio, Actionables" in text_content
    assert "₹8.11" in html_content
