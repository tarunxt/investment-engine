from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.domains.ai_providers.availability import filter_recently_available_targets
from app.domains.jobs.models import Job
from app.domains.jobs.repository import PostgresJobRepository
from app.domains.runs.models import Run, RunJob
from app.domains.runs.repository import PostgresRunRepository
from app.infrastructure.messaging.task_registry import register_job_task
from app.infrastructure.locks.redis_lock import LockAcquisitionError, RedisLock
from app.shared.exceptions import ConflictException, ValidationException
from app.shared.types import JobStatus, UserId


logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class RunModelTarget:
    provider: str
    model: str


@dataclass(frozen=True)
class CreateRunCommand:
    prompt: str
    targets: list[RunModelTarget]
    user_id: UserId
    polymarket_event_context: dict[str, Any] | None = None
    prompt_id: int | None = None
    scheduled_at: datetime | None = None
    auto_export_enabled: bool = False
    export_spreadsheet_url: str | None = None
    export_sheet_name: str | None = None
    export_investment_amount: str | None = None
    export_title: str | None = None
    allow_parallel: bool = False
    auto_rebalance_portfolio: str | None = None
    auto_rebalance_sequence: int | None = None
    auto_rebalance_label: str | None = None


class CreateRunUseCase:
    def __init__(self, session: AsyncSession, lock: RedisLock) -> None:
        self._session = session
        self._run_repo = PostgresRunRepository(session)
        self._job_repo = PostgresJobRepository(session)
        self._lock = lock

    async def execute(self, cmd: CreateRunCommand) -> Run:
        if not cmd.targets:
            raise ValidationException("At least one (provider, model) target is required.")

        targets: list[RunModelTarget] = []
        seen_targets: set[tuple[str, str]] = set()
        for target in cmd.targets:
            key = (target.provider.strip().lower(), target.model.strip().lower())
            if key in seen_targets:
                continue
            seen_targets.add(key)
            targets.append(target)

        targets, blocked_targets = await filter_recently_available_targets(
            self._session,
            targets,
        )
        if blocked_targets:
            logger.warning(
                "Skipping temporarily unavailable provider targets: %s",
                ", ".join(
                    f"{target.provider}/{target.model}"
                    for target, _availability in blocked_targets
                ),
            )
        if not targets:
            reasons = "; ".join(
                availability.reason
                or f"{target.provider}/{target.model} is unavailable"
                for target, availability in blocked_targets
            )
            raise ValidationException(
                "No selected AI target is currently available. " + reasons
            )

        now = datetime.now(timezone.utc)
        scheduled_at = cmd.scheduled_at
        if scheduled_at is not None and scheduled_at.tzinfo is None:
            scheduled_at = scheduled_at.replace(tzinfo=timezone.utc)
        is_future = scheduled_at is not None and scheduled_at > now
        initial_status = JobStatus.SCHEDULED if is_future else JobStatus.PENDING

        # Auto-generate Google Sheets settings if auto-export is enabled
        export_url = cmd.export_spreadsheet_url
        export_sheet_name = cmd.export_sheet_name or now.strftime("%b %d")  # e.g., "May 22"

        if cmd.auto_export_enabled and not export_url:
            # Try to get user's master sheet, if available
            from sqlalchemy import select
            from app.domains.auth.models import UserProfile

            user_profile_result = await self._session.execute(
                select(UserProfile).where(UserProfile.user_id == cmd.user_id)
            )
            user_profile = user_profile_result.scalar_one_or_none()

            if user_profile and user_profile.google_sheets_master_url:
                export_url = user_profile.google_sheets_master_url

        lock_key = f"run:create:{cmd.user_id}:{cmd.prompt[:40]}"
        try:
            async with self._lock.acquire(lock_key, ttl=15, timeout=5):
                if not cmd.allow_parallel:
                    active_run = await self._run_repo.get_latest_active_for_user(int(cmd.user_id))
                    if active_run is not None:
                        raise ConflictException(
                            f"Run #{active_run.id} is already in progress. Confirm to run multiple jobs."
                        )
                run = Run(
                    user_id=cmd.user_id,
                    prompt=cmd.prompt,
                    prompt_id=cmd.prompt_id,
                    status=initial_status,
                    current_stage=1,
                    auto_export_enabled=cmd.auto_export_enabled,
                    export_spreadsheet_url=export_url,
                    export_sheet_name=export_sheet_name,
                    export_investment_amount=cmd.export_investment_amount,
                    export_title=cmd.export_title,
                    export_status="pending" if cmd.auto_export_enabled else "disabled",
                    auto_rebalance_portfolio=cmd.auto_rebalance_portfolio,
                    auto_rebalance_sequence=cmd.auto_rebalance_sequence,
                    auto_rebalance_label=cmd.auto_rebalance_label,
                )
                await self._run_repo.create(run)  # flush → run.id populated

                jobs: list[Job] = []
                for target in targets:
                    job = Job(
                        prompt=cmd.prompt,
                        provider=target.provider,
                        model=target.model,
                        user_id=cmd.user_id,
                        status=initial_status,
                        request_context_json=cmd.polymarket_event_context,
                        scheduled_at=scheduled_at,
                        auto_rebalance_portfolio=cmd.auto_rebalance_portfolio,
                        auto_rebalance_sequence=cmd.auto_rebalance_sequence,
                        auto_rebalance_label=cmd.auto_rebalance_label,
                    )
                    self._session.add(job)
                    jobs.append(job)

                await self._session.flush()  # populate job IDs

                for job in jobs:
                    self._session.add(RunJob(run_id=run.id, job_id=job.id, stage=1))

                await self._session.commit()

        except LockAcquisitionError:
            raise ConflictException("Another run creation is in progress. Retry shortly.")

        # Fan out one Celery task per job.
        # Stagger Gemini launches to reduce burst quota/rate-limit collisions.
        from app.domains.jobs.tasks import execute_ai_job

        gemini_offset = 0
        for job in jobs:
            countdown = 0
            eta = scheduled_at
            if job.provider.strip().lower() == "gemini":
                countdown = gemini_offset
                gemini_offset += 20
                if eta is not None:
                    eta = eta + timedelta(seconds=countdown)
            if is_future:
                task = execute_ai_job.apply_async(args=[job.id], eta=eta)  # type: ignore
            else:
                task = execute_ai_job.apply_async(args=[job.id], countdown=countdown)  # type: ignore
            await register_job_task(job.id, task.id)

        # Re-fetch with all relationships loaded for the response
        result = await self._run_repo.get(run.id)
        assert result is not None, f"Run {run.id} not found after creation"
        return result
