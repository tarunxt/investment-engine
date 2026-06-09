from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from app.domains.jobs.events import JobCreated
from app.domains.jobs.models import Job
from app.domains.jobs.repository import PostgresJobRepository
from app.infrastructure.database.outbox.models import OutboxMessage
from app.infrastructure.messaging.event_bus import EventBus
from app.infrastructure.messaging.idempotency import IdempotencyStore
from app.infrastructure.locks.redis_lock import RedisLock, LockAcquisitionError
from app.shared.exceptions import ConflictException, ValidationException
from app.shared.types import JobId, JobStatus, UserId


@dataclass(frozen=True)
class CreateJobCommand:
    prompt: str
    provider: str
    model: str
    user_id: UserId
    scheduled_at: datetime | None = None
    idempotency_key: str | None = None
    auto_rebalance_portfolio: str | None = None
    auto_rebalance_sequence: int | None = None
    auto_rebalance_label: str | None = None


@dataclass(frozen=True)
class CreateJobResult:
    job_id: JobId
    status: JobStatus
    scheduled_at: datetime | None


class CreateJobUseCase:
    def __init__(
        self,
        session: AsyncSession,
        event_bus: EventBus,
        lock: RedisLock,
        idempotency: IdempotencyStore,
    ) -> None:
        self._session = session
        self._repo = PostgresJobRepository(session)
        self._event_bus = event_bus
        self._lock = lock
        self._idempotency = idempotency

    async def execute(self, cmd: CreateJobCommand) -> CreateJobResult:
        # ── 1. Idempotency fast-path ─────────────────────────────────────────
        if cmd.idempotency_key:
            if cached := await self._idempotency.get(cmd.idempotency_key):
                return CreateJobResult(**cached)

        # ── 2. Normalise scheduled_at to UTC-aware ───────────────────────────
        now = datetime.now(timezone.utc)
        scheduled_at = cmd.scheduled_at
        if scheduled_at is not None and scheduled_at.tzinfo is None:
            scheduled_at = scheduled_at.replace(tzinfo=timezone.utc)
        is_future = scheduled_at is not None and scheduled_at > now
        initial_status = JobStatus.SCHEDULED if is_future else JobStatus.PENDING

        # ── 3. Atomic write: job + outbox in one transaction ─────────────────
        lock_key = f"job:create:{cmd.idempotency_key or cmd.prompt[:40]}"
        try:
            async with self._lock.acquire(lock_key, ttl=15, timeout=5):
                job = Job(
                    prompt=cmd.prompt,
                    provider=cmd.provider,
                    model=cmd.model,
                    user_id=cmd.user_id,
                    status=initial_status,
                    scheduled_at=scheduled_at,
                    auto_rebalance_portfolio=cmd.auto_rebalance_portfolio,
                    auto_rebalance_sequence=cmd.auto_rebalance_sequence,
                    auto_rebalance_label=cmd.auto_rebalance_label,
                )
                await self._repo.create(job)

                outbox_msg = OutboxMessage(
                    topic="job.created",
                    payload={
                        "job_id": job.id,
                        "scheduled_at": scheduled_at.isoformat() if scheduled_at else None,
                    },
                )
                self._session.add(outbox_msg)
                await self._session.commit()

        except LockAcquisitionError:
            raise ConflictException("Another request is creating the same job. Retry shortly.")

        result = CreateJobResult(
            job_id=JobId(job.id),
            status=initial_status,
            scheduled_at=scheduled_at,
        )

        # ── 4. Dispatch Celery task (ETA for future jobs) ────────────────────
        from app.domains.jobs.tasks import execute_ai_job
        if is_future:
            execute_ai_job.apply_async(args=[job.id], eta=scheduled_at)
        else:
            execute_ai_job.delay(job.id)

        # ── 5. In-process domain events (non-critical, fire-and-forget) ──────
        await self._event_bus.publish(
            JobCreated(
                job_id=result.job_id,
                user_id=cmd.user_id,
                provider=cmd.provider,
                model=cmd.model,
                scheduled_at=scheduled_at,
            )
        )

        # ── 6. Cache result for idempotency ──────────────────────────────────
        if cmd.idempotency_key:
            await self._idempotency.set(
                cmd.idempotency_key,
                {
                    "job_id": result.job_id,
                    "status": result.status.value,
                    "scheduled_at": result.scheduled_at.isoformat() if result.scheduled_at else None,
                },
            )

        return result
