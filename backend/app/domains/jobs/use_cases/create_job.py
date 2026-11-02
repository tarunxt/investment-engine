from __future__ import annotations

from app.core.recovery import require_equity_analysis

from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from app.domains.jobs.events import JobCreated
from app.domains.jobs.models import Job
from app.domains.jobs.repository import PostgresJobRepository
from app.infrastructure.messaging.event_bus import EventBus
from app.infrastructure.messaging.idempotency import IdempotencyStore
from app.infrastructure.locks.redis_lock import RedisLock
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
        from sqlalchemy.exc import IntegrityError
        from app.domains.jobs.admission import (
            JobAdmission, OPERATION, replay_admission, request_identity, utc_schedule,
        )
        from app.infrastructure.database.outbox.dispatch import obligation, dispatch_one

        identity = request_identity(cmd) if cmd.idempotency_key else None
        if identity:
            existing = await replay_admission(self._session, self._repo, cmd, *identity[:2])
            if existing is not None:
                return CreateJobResult(existing.id, existing.status, existing.scheduled_at)

        now = datetime.now(timezone.utc)
        scheduled_at = utc_schedule(cmd.scheduled_at)
        is_future = scheduled_at is not None and scheduled_at > now
        initial_status = JobStatus.SCHEDULED if is_future else JobStatus.PENDING
        try:
            job = Job(
                prompt=cmd.prompt, provider=cmd.provider, model=cmd.model,
                user_id=cmd.user_id, status=initial_status,
                scheduled_at=scheduled_at.replace(tzinfo=None) if scheduled_at else None,
                auto_rebalance_portfolio=cmd.auto_rebalance_portfolio,
                auto_rebalance_sequence=cmd.auto_rebalance_sequence,
                auto_rebalance_label=cmd.auto_rebalance_label,
            )
            await self._repo.create(job)
            message = obligation(job, scheduled_at if is_future else None)
            self._session.add(message)
            if identity:
                self._session.add(JobAdmission(
                    user_id=cmd.user_id, operation=OPERATION,
                    request_key_hash=identity[0], fingerprint=identity[1], job_id=job.id,
                ))
            await self._session.commit()
        except IntegrityError:
            await self._session.rollback()
            # Only the durable winner can resolve a concurrent uniqueness conflict.
            if identity:
                existing = await replay_admission(self._session, self._repo, cmd, *identity[:2])
                if existing is not None:
                    return CreateJobResult(existing.id, existing.status, existing.scheduled_at)
            raise

        result = CreateJobResult(JobId(job.id), initial_status, scheduled_at)
        await dispatch_one(self._session, message.id)
        await self._event_bus.publish(JobCreated(
            job_id=result.job_id, user_id=cmd.user_id, provider=cmd.provider,
            model=cmd.model, scheduled_at=scheduled_at,
        ))
        if identity:
            # Optional hint only. All replay branches read the durable record and
            # recheck the owner; stale/foreign Redis values are never serialized.
            try:
                await self._idempotency.set(identity[2], {"job_id": int(result.job_id)})
            except Exception:
                import logging
                logging.getLogger(__name__).warning("Optional admission cache unavailable")
        return result
