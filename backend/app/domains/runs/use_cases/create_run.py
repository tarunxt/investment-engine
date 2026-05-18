from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from app.domains.jobs.models import Job
from app.domains.jobs.repository import PostgresJobRepository
from app.domains.runs.models import Run, RunJob
from app.domains.runs.repository import PostgresRunRepository
from app.infrastructure.locks.redis_lock import LockAcquisitionError, RedisLock
from app.shared.exceptions import ConflictException, ValidationException
from app.shared.types import JobStatus, UserId


@dataclass(frozen=True)
class RunModelTarget:
    provider: str
    model: str


@dataclass(frozen=True)
class CreateRunCommand:
    prompt: str
    targets: list[RunModelTarget]
    user_id: UserId
    prompt_id: int | None = None
    scheduled_at: datetime | None = None


class CreateRunUseCase:
    def __init__(self, session: AsyncSession, lock: RedisLock) -> None:
        self._session = session
        self._run_repo = PostgresRunRepository(session)
        self._job_repo = PostgresJobRepository(session)
        self._lock = lock

    async def execute(self, cmd: CreateRunCommand) -> Run:
        if not cmd.targets:
            raise ValidationException("At least one (provider, model) target is required.")

        now = datetime.now(timezone.utc)
        scheduled_at = cmd.scheduled_at
        if scheduled_at is not None and scheduled_at.tzinfo is None:
            scheduled_at = scheduled_at.replace(tzinfo=timezone.utc)
        is_future = scheduled_at is not None and scheduled_at > now
        initial_status = JobStatus.SCHEDULED if is_future else JobStatus.PENDING

        lock_key = f"run:create:{cmd.user_id}:{cmd.prompt[:40]}"
        try:
            async with self._lock.acquire(lock_key, ttl=15, timeout=5):
                run = Run(
                    user_id=cmd.user_id,
                    prompt=cmd.prompt,
                    prompt_id=cmd.prompt_id,
                    status=initial_status,
                    current_stage=1,
                )
                await self._run_repo.create(run)  # flush → run.id populated

                jobs: list[Job] = []
                for target in cmd.targets:
                    job = Job(
                        prompt=cmd.prompt,
                        provider=target.provider,
                        model=target.model,
                        user_id=cmd.user_id,
                        status=initial_status,
                        scheduled_at=scheduled_at,
                    )
                    self._session.add(job)
                    jobs.append(job)

                await self._session.flush()  # populate job IDs

                for job in jobs:
                    self._session.add(RunJob(run_id=run.id, job_id=job.id, stage=1))

                await self._session.commit()

        except LockAcquisitionError:
            raise ConflictException("Another run creation is in progress. Retry shortly.")

        # Fan out one Celery task per job
        from app.domains.jobs.tasks import execute_ai_job

        for job in jobs:
            if is_future:
                execute_ai_job.apply_async(args=[job.id], eta=scheduled_at)
            else:
                execute_ai_job.delay(job.id)

        # Re-fetch with all relationships loaded for the response
        return await self._run_repo.get(run.id)
