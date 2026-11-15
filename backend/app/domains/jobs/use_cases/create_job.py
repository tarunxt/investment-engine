from __future__ import annotations

from app.domains.jobs.resource_policy import validate_prompt
from app.domains.jobs.resource_validation import validate_model_identifiers

from app.core.recovery import require_equity_analysis

from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import AsyncSession
from uuid import uuid4

from app.domains.jobs.creation_identity import OPERATION, payload_fingerprint, request_key, utc_schedule

from app.domains.jobs.events import JobCreated
from app.domains.jobs.models import Job
from app.domains.jobs.repository import PostgresJobRepository
from app.infrastructure.database.outbox.models import OutboxMessage
from app.infrastructure.messaging.event_bus import EventBus
from app.infrastructure.messaging.idempotency import IdempotencyStore
from app.infrastructure.messaging.task_registry import register_job_task
from app.infrastructure.locks.redis_lock import RedisLock, LockAcquisitionError
from app.shared.exceptions import ConflictException, NotFoundException
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
        require_equity_analysis(cmd.auto_rebalance_portfolio)
        validate_prompt(cmd.prompt)
        validate_model_identifiers(cmd.provider, cmd.model)
        fingerprint = payload_fingerprint(cmd)

        async def owned_cached_result():
            if not cmd.idempotency_key:
                return None
            cached = await self._idempotency.get_for_request(
                cmd.user_id, OPERATION, cmd.idempotency_key, fingerprint,
            )
            if cached is None:
                return None
            job_id = cached.get("job_id")
            if isinstance(job_id, bool) or not isinstance(job_id, int):
                raise NotFoundException("Job not found")
            job = await self._repo.get_for_user(JobId(job_id), cmd.user_id)
            if job is None:
                raise NotFoundException("Job not found")
            if payload_fingerprint(job) != fingerprint:
                raise ConflictException("Cached request does not match the stored job.")
            return CreateJobResult(JobId(job.id), job.status, utc_schedule(job.scheduled_at))

        if replay := await owned_cached_result():
            return replay
        now = datetime.now(timezone.utc)
        scheduled_at = utc_schedule(cmd.scheduled_at)
        is_future = scheduled_at is not None and scheduled_at > now
        initial_status = JobStatus.SCHEDULED if is_future else JobStatus.PENDING

        # ── 3. Atomic write: job + outbox in one transaction ─────────────────
        lock_key = request_key(cmd.user_id, OPERATION, cmd.idempotency_key) if cmd.idempotency_key else f"job:create:{cmd.user_id}:{uuid4()}"
        try:
            async with self._lock.acquire(lock_key, ttl=15, timeout=5):
                if replay := await owned_cached_result():
                    return replay
                job = Job(
                    prompt=cmd.prompt,
                    provider=cmd.provider,
                    model=cmd.model,
                    user_id=cmd.user_id,
                    status=initial_status,
                    scheduled_at=scheduled_at.replace(tzinfo=None) if scheduled_at else None,
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
                if cmd.idempotency_key:
                    await self._idempotency.set_for_request(
                        cmd.user_id, OPERATION, cmd.idempotency_key, fingerprint,
                        {"job_id": int(job.id)},
                    )

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
            task = execute_ai_job.apply_async(args=[job.id], eta=scheduled_at)
        else:
            task = execute_ai_job.delay(job.id)
        await register_job_task(job.id, task.id)

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

        # No cache or Redis lease is a durable creation guarantee. Cache loss or
        # expiry is the deferred A11-001 concern; owner scope never relies on it.
        return result
