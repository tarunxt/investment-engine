from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import re

from sqlalchemy import func, select
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.recovery import require_equity_analysis
from app.domains.jobs.events import JobCreated
from app.domains.jobs.models import Job
from app.domains.jobs.repository import PostgresJobRepository
from app.infrastructure.database.outbox.models import OutboxMessage
from app.infrastructure.messaging.event_bus import EventBus
from app.infrastructure.messaging.idempotency import IdempotencyStore, canonical_digest, digest
from app.shared.exceptions import ConflictException, ValidationException
from app.shared.types import JobId, JobStatus, UserId

JOB_DISPATCH_TOPIC = 'job.created.v2'


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
    operation: str = 'jobs.create'  # Server-owned namespace, never a body field.


@dataclass(frozen=True)
class CreateJobResult:
    job_id: JobId
    status: JobStatus
    scheduled_at: datetime | None


class CreateJobUseCase:
    def __init__(self, session: AsyncSession, event_bus: EventBus, lock=None,
                 idempotency: IdempotencyStore | None = None, before_create=None) -> None:
        self._session = session
        self._repo = PostgresJobRepository(session)
        self._event_bus = event_bus
        self._before_create = before_create
        self._idempotency = idempotency or IdempotencyStore(session)
        # The compatibility lock argument is deliberately not used. PostgreSQL
        # uniqueness, not a Redis lease or prompt prefix, arbitrates this write.

    async def _replay(self, cmd, key_hash, request_hash):
        binding = await self._idempotency.get(int(cmd.user_id), cmd.operation, key_hash)
        if binding is None:
            return None
        if binding.request_digest != request_hash:
            raise ConflictException('Idempotency key already used with a different request')
        job = await self._repo.get(binding.job_id, user_id=cmd.user_id)
        if job is None:
            raise ConflictException('Idempotent result is unavailable; key cannot be reused')
        return CreateJobResult(JobId(job.id), job.status, job.scheduled_at)

    async def _create(self, cmd, scheduled_at):
        if self._before_create is not None:
            self._before_create()
        from app.domains.modules.lifecycle import admit_enqueue, analysis_module
        identity = await admit_enqueue(self._session, int(cmd.user_id), analysis_module(cmd.auto_rebalance_portfolio), scheduled=cmd.scheduled_at is not None)
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        job = Job(module_id=identity.module_id, module_version=identity.version, prompt=cmd.prompt, provider=cmd.provider, model=cmd.model,
            user_id=cmd.user_id, status=JobStatus.SCHEDULED if scheduled_at and scheduled_at > now else JobStatus.PENDING,
            scheduled_at=scheduled_at, auto_rebalance_portfolio=cmd.auto_rebalance_portfolio,
            auto_rebalance_sequence=cmd.auto_rebalance_sequence, auto_rebalance_label=cmd.auto_rebalance_label)
        await self._repo.create(job)
        self._session.add(OutboxMessage(topic=JOB_DISPATCH_TOPIC,
            payload={'job_id': job.id, 'user_id': int(cmd.user_id), 'operation': cmd.operation}))
        return job

    async def execute(self, cmd: CreateJobCommand) -> CreateJobResult:
        require_equity_analysis(cmd.auto_rebalance_portfolio)
        if not re.fullmatch(r'[a-z][a-z0-9_.:-]{0,99}', cmd.operation):
            raise ValidationException('Invalid server operation namespace')
        key = cmd.idempotency_key
        if key is not None and (not isinstance(key, str) or not key or len(key) > 200):
            raise ValidationException('Idempotency key must contain 1 to 200 characters')
        scheduled = cmd.scheduled_at
        if scheduled is not None:
            scheduled = scheduled.replace(tzinfo=timezone.utc) if scheduled.tzinfo is None else scheduled.astimezone(timezone.utc)
        payload = asdict(cmd)
        payload.pop('idempotency_key')
        payload['scheduled_at'] = scheduled.isoformat() if scheduled else None
        request_hash, key_hash = canonical_digest(payload), digest(key) if key is not None else None
        if key_hash is not None:
            replay = await self._replay(cmd, key_hash, request_hash)
            if replay is not None:
                return replay
            if self._session.get_bind().dialect.name == 'postgresql':
                await self._session.execute(select(func.set_config('lock_timeout', '5000', True)))
            try:
                # A competing insertion may create a provisional Job, but its
                # losing savepoint rolls back Job/outbox together before dispatch.
                async with self._session.begin_nested():
                    job = await self._create(cmd, scheduled.replace(tzinfo=None) if scheduled else None)
                    await self._idempotency.bind(user_id=int(cmd.user_id), operation=cmd.operation,
                        key_digest=key_hash, request_digest=request_hash, job_id=job.id)
            except IntegrityError:
                replay = await self._replay(cmd, key_hash, request_hash)
                if replay is None:
                    raise ConflictException('Request could not be committed; retry the same key') from None
                return replay
            except DBAPIError as exc:
                if getattr(exc.orig, 'sqlstate', getattr(exc.orig, 'pgcode', None)) == '55P03':
                    raise ConflictException('Request in progress; retry the same key shortly') from None
                raise
        else:
            job = await self._create(cmd, scheduled.replace(tzinfo=None) if scheduled else None)
        await self._session.commit()  # Job + binding + outbox are one durable fact.
        result = CreateJobResult(JobId(job.id), job.status, job.scheduled_at)
        await self._event_bus.publish(JobCreated(job_id=result.job_id, user_id=cmd.user_id,
            provider=cmd.provider, model=cmd.model, scheduled_at=scheduled))
        # Only the recoverable outbox publishes tasks. No direct broker/cache I/O.
        return result
